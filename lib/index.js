/**
 * dsh-prompt-beautify — host side.
 *
 * Registers one human slash command, `/polish`, that rewrites the given draft
 * into a high-quality prompt through the LLM service. The command creates no
 * model message: its input and its result stay outside the conversation
 * history, so polishing a draft never costs main-conversation tokens.
 *
 * Nothing here appends session events; the plugin owns no durable state at all.
 *
 * @module dsh-prompt-beautify
 */

import { appendFileSync } from 'node:fs'

/** Services this plugin needs mounted before it can run. */
export const inject = ['commands', 'llm']

/** Stable host plugin identity. */
export const name = 'prompt-beautify'

/** Prefix the Web client uses to hand over an exact, whitespace-preserving draft. */
const B64_PREFIX = '--b64 '

/**
 * Rewrite instruction. Kept in one place so `/polish` and the client button
 * cannot drift apart.
 */
const SYSTEM_PROMPT = [
  '你是提示词工程师。用户会给你一段草稿，请把它改写为一条高质量提示词，供编程智能体（DeepSeek Harness）执行。',
  '',
  '规则：',
  '1. 只输出改写后的提示词本身：不要解释、不要前言后语、不要用代码块包裹整段输出。',
  '2. 保留原文的意图、目标、约束，以及所有具体标识符（文件路径、函数/类名、命令、变量名、URL、报错文本、版本号）原样不变。',
  '3. 补齐草稿里隐含但缺失的结构：任务目标与背景、要交付的产物、验收标准、边界与禁止项；必要时用简短小标题或分点。',
  '4. 不要编造原文没有的事实、需求或数据；信息不足时保持开放，不要虚构细节。',
  '5. 使用与原文相同的语言：中文草稿产出中文提示词，英文草稿产出英文提示词。',
  '6. 结构服从需要，不写空话：不要整段重复原文，不要堆砌礼貌用语或对仗的废话；短草稿也可以只补一两句关键约束。',
  '7. 纯文本输出（可用 Markdown 的小标题与分点），不要添加任何元信息（如“以下是改写后的提示词：”）。',
].join('\n')

/**
 * Decode a command line payload. The Web client sends `--b64 <base64>` so the
 * draft keeps its exact whitespace, markdown and newlines; a human typing
 * `/polish some text` sends plain text.
 *
 * @param rawInput - Everything after the command name.
 * @returns The draft text, or undefined when the payload is not usable.
 */
function decodePayload(rawInput) {
  const raw = typeof rawInput === 'string' ? rawInput : ''
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (!trimmed.startsWith(B64_PREFIX)) {
    const plain = raw.replace(/^\s+/, '')
    return plain.trim() === '' ? undefined : plain
  }
  const encoded = trimmed.slice(B64_PREFIX.length).trim()
  if (encoded === '') return undefined
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    return decoded.trim() === '' ? undefined : decoded
  } catch {
    return undefined
  }
}

/**
 * Strip wrapping the model may still add despite the instruction: one leading
 * fenced block or one pair of triple quotes.
 *
 * @param text - Assembled model output.
 * @returns The bare prompt text.
 */
function unwrap(text) {
  let out = text.trim()
  const fenced = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/.exec(out)
  if (fenced !== null) out = fenced[1].trim()
  if (out.length >= 6 && out.startsWith('"""') && out.endsWith('"""')) out = out.slice(3, -3).trim()
  return out
}

/**
 * Resolve the route the auxiliary request should use, preferring the current
 * session's own last request so polishing inherits the model in use.
 *
 * @param ctx - Host plugin context.
 * @param agent - The receiving agent, when the adapter supplied one.
 * @param options - Resolved plugin options.
 * @returns A provider/model pair, or undefined when nothing is known.
 */
function resolveRoute(ctx, agent, options) {
  if (options.provider !== '' && options.model !== '') {
    return { provider: options.provider, model: options.model }
  }
  const header = agent?.session?.requestHeader?.()?.config
  if (typeof header?.provider === 'string' && typeof header?.model === 'string') {
    return { provider: header.provider, model: header.model }
  }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    // The default-model service is optional; fall through to the error below.
  }
  return undefined
}

/**
 * Join a terminal abort signal with the plugin's own deadline.
 *
 * @param signal - Caller abort signal, when present.
 * @param timeoutMs - Deadline in milliseconds; 0 disables the deadline.
 * @returns A signal the stream can observe, plus a disposer.
 */
function deadlineSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const forward = () => controller.abort(signal.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', forward, { once: true })
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`prompt-beautify: timed out after ${timeoutMs} ms`)), timeoutMs)
      : undefined
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    },
  }
}

/**
 * Run one rewrite request and return the polished prompt.
 *
 * @param ctx - Host plugin context carrying the llm service.
 * @param route - Resolved provider and model.
 * @param text - The draft to rewrite.
 * @param options - Resolved plugin options.
 * @param signal - Caller abort signal, when present.
 * @returns The polished prompt text.
 */
async function polish(ctx, route, text, options, signal) {
  const budget = deadlineSignal(signal, options.timeoutMs)
  try {
    let output = ''
    let reason
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: options.maxTokens,
      purpose: 'prompt-beautify',
      signal: budget.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') output += chunk.text
      else if (chunk.type === 'finish') reason = chunk.reason
    }
    if (reason !== undefined && reason.kind !== 'stop' && reason.kind !== 'max-tokens') {
      const failure = reason.failure
      const detail = failure?.code !== undefined ? `${failure.code}: ${failure.message ?? ''}` : String(reason.kind)
      throw new Error(detail)
    }
    const cleaned = unwrap(output)
    if (cleaned === '') throw new Error('模型返回了空内容')
    return cleaned
  } finally {
    budget.dispose()
  }
}

/**
 * Install the `/polish` command.
 *
 * @param ctx - Host plugin context.
 * @param config - Optional row configuration from the profile patch.
 */
export function apply(ctx, config) {
  const resolved = {
    provider: typeof config?.provider === 'string' ? config.provider : '',
    model: typeof config?.model === 'string' ? config.model : '',
    maxInputChars: Number.isInteger(config?.maxInputChars) ? config.maxInputChars : 8000,
    maxTokens: Number.isInteger(config?.maxTokens) ? config.maxTokens : 2048,
    timeoutMs: Number.isInteger(config?.timeoutMs) ? config.timeoutMs : 45000,
  }

  if (typeof config?.traceFile === 'string' && config.traceFile !== '') {
    try {
      appendFileSync(config.traceFile, `apply ${new Date().toISOString()}\n`)
    } catch {
      // Diagnostics only.
    }
  }

  ctx.commands.register({
    name: 'polish',
    description: '一键美化提示词：把当前草稿改写为更清晰、更完整的提示词（不发送、不计入对话）',
    note: 'Web 客户端按钮用 --b64 传草稿；手工输入时直接跟在命令后。',
    input: {
      hint: '<要美化的提示词>',
    },
    handler: async ({ agent, rawInput, signal }) => {
      const draft = decodePayload(rawInput)
      if (draft === undefined) {
        return { kind: 'error', text: '用法：/polish <要美化的提示词>（也可以直接在输入框点「美化」按钮）' }
      }
      if (draft.length > resolved.maxInputChars) {
        return {
          kind: 'error',
          text: `草稿太长（${draft.length} 字符），超过上限 ${resolved.maxInputChars}；请在 profile 的 cordis.patch.yml 里调大 prompt-beautify 行的 maxInputChars。`,
        }
      }
      const route = resolveRoute(ctx, agent, resolved)
      if (route === undefined) {
        return {
          kind: 'error',
          text: '找不到可用模型路由：先在本会话发送一条消息，或在 cordis.patch.yml 的 prompt-beautify 行配置 provider 和 model。',
        }
      }
      try {
        const polished = await polish(ctx, route, draft, resolved, signal)
        return { kind: 'success', text: polished }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `美化失败：${message}` }
      }
    },
  })
}
