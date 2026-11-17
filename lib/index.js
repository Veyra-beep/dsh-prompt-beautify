/**
 * dsh-prompt-polish — host side.
 *
 * Registers one human slash command, `/polish`, that rewrites the given draft
 * into a high-quality prompt through the LLM service. The command creates no
 * model message: its input and its result stay outside the conversation
 * history, so polishing a draft never costs main-conversation tokens.
 *
 * Nothing here appends session events; the plugin owns no durable state at all.
 *
 * @module dsh-prompt-polish
 */

import { appendFileSync } from 'node:fs'

/** Services this plugin needs mounted before it can run. */
export const inject = ['commands', 'llm']

/** Stable host plugin identity. */
export const name = 'prompt-polish'

/** Prefix the Web client uses to hand over an exact, whitespace-preserving draft. */
const B64_PREFIX = '--b64 '

/** Tag used in diagnostics and user-facing messages. */
const PLUGIN_TAG = 'prompt-polish'

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

/** Defaults for the tunable knobs; every one can be overridden per profile row. */
const DEFAULTS = {
  maxInputChars: 8000,
  maxTokens: 2048,
  timeoutMs: 180000,
  idleTimeoutMs: 90000,
}

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
 * Collect every route the auxiliary request may use, in preference order.
 *
 * A provider named by an older request header, or by a model that has since
 * been unmounted, can resolve to a route that has no adapter; keeping the
 * alternatives lets the caller fall through instead of failing outright.
 *
 * @param ctx - Host plugin context.
 * @param agent - The receiving agent, when the adapter supplied one.
 * @param options - Resolved plugin options.
 * @returns Unique provider/model pairs, most preferred first.
 */
function resolveRoutes(ctx, agent, options) {
  const routes = []
  const push = (provider, model) => {
    if (typeof provider !== 'string' || provider === '') return
    if (typeof model !== 'string' || model === '') return
    if (routes.some((route) => route.provider === provider && route.model === model)) return
    routes.push({ provider, model })
  }
  push(options.provider, options.model)
  const header = agent?.session?.requestHeader?.()?.config
  push(header?.provider, header?.model)
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    push(selection?.provider, selection?.model)
  } catch {
    // The default-model service is optional; fall through with what we have.
  }
  return routes
}

/**
 * Build the abort signal for one attempt. Two timers guard the request:
 * a per-chunk idle window (a stalled provider, or one queueing the first
 * token) and a hard ceiling on the whole call.
 *
 * @param signal - Caller abort signal, when present.
 * @param options - Resolved plugin options.
 * @returns The observable signal, an idle-timer reset, the expiry text, and a disposer.
 */
function createBudget(signal, options) {
  const controller = new AbortController()
  let expired = ''
  const forward = () => controller.abort(signal.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', forward, { once: true })
  }
  const expire = (text) => {
    expired = text
    controller.abort(new Error(text))
  }
  let idleTimer
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    if (options.idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        expire(`等待模型响应超时：${Math.round(options.idleTimeoutMs / 1000)} 秒内没有收到新内容`)
      }, options.idleTimeoutMs)
    }
  }
  const hardTimer =
    options.timeoutMs > 0
      ? setTimeout(() => {
          expire(`请求超时：超过 ${Math.round(options.timeoutMs / 1000)} 秒总时长上限`)
        }, options.timeoutMs)
      : undefined
  armIdle()
  return {
    signal: controller.signal,
    touch: armIdle,
    expired: () => expired,
    dispose: () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      if (hardTimer !== undefined) clearTimeout(hardTimer)
      signal?.removeEventListener('abort', forward)
    },
  }
}

/**
 * Run one rewrite request against one route and return the polished prompt.
 *
 * @param ctx - Host plugin context carrying the llm service.
 * @param route - Resolved provider and model.
 * @param text - The draft to rewrite.
 * @param options - Resolved plugin options.
 * @param signal - Caller abort signal, when present.
 * @returns The polished prompt text.
 */
async function attempt(ctx, route, text, options, signal) {
  const budget = createBudget(signal, options)
  const fail = (code, message) => {
    const error = new Error(message)
    error.llmCode = code
    error.route = route
    return error
  }
  try {
    let output = ''
    let reason
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: options.maxTokens,
      purpose: PLUGIN_TAG,
      signal: budget.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        output += chunk.text
        budget.touch()
      } else if (chunk.type === 'finish') {
        reason = chunk.reason
      }
    }
    if (budget.expired() !== '') throw fail('TIMEOUT', budget.expired())
    if (reason !== undefined && reason.kind !== 'stop' && reason.kind !== 'max-tokens') {
      if (reason.kind === 'aborted') {
        throw fail('ABORTED', signal?.aborted === true ? '请求已取消' : '请求被中止（没有收到模型的任何内容）')
      }
      const failure = reason.failure
      const code = typeof failure?.code === 'string' ? failure.code : String(reason.kind)
      const message = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : code
      throw fail(code, `${code}: ${message}`)
    }
    const cleaned = unwrap(output)
    if (cleaned === '') throw fail('EMPTY', '模型返回了空内容')
    return cleaned
  } catch (error) {
    if (budget.expired() !== '') throw fail('TIMEOUT', budget.expired())
    throw error
  } finally {
    budget.dispose()
  }
}

/**
 * Rewrite the draft, walking the route candidates when one has no usable
 * adapter or credential.
 *
 * @param ctx - Host plugin context carrying the llm service.
 * @param routes - Route candidates, most preferred first.
 * @param text - The draft to rewrite.
 * @param options - Resolved plugin options.
 * @param signal - Caller abort signal, when present.
 * @returns The polished prompt text.
 */
async function polish(ctx, routes, text, options, signal) {
  const fallbackCodes = new Set(['NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH'])
  let last
  for (const route of routes) {
    try {
      return await attempt(ctx, route, text, options, signal)
    } catch (error) {
      last = error
      if (routes.length > 1 && fallbackCodes.has(error?.llmCode) && signal?.aborted !== true) continue
      throw error
    }
  }
  throw last ?? new Error('没有可用的模型路由')
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
    maxInputChars: Number.isInteger(config?.maxInputChars) ? config.maxInputChars : DEFAULTS.maxInputChars,
    maxTokens: Number.isInteger(config?.maxTokens) ? config.maxTokens : DEFAULTS.maxTokens,
    timeoutMs: Number.isInteger(config?.timeoutMs) ? config.timeoutMs : DEFAULTS.timeoutMs,
    idleTimeoutMs: Number.isInteger(config?.idleTimeoutMs) ? config.idleTimeoutMs : DEFAULTS.idleTimeoutMs,
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
          text: `草稿太长（${draft.length} 字符），超过上限 ${resolved.maxInputChars}；请在 profile 的 cordis.patch.yml 里调大 ${PLUGIN_TAG} 行的 maxInputChars。`,
        }
      }
      const routes = resolveRoutes(ctx, agent, resolved)
      if (routes.length === 0) {
        return {
          kind: 'error',
          text: `找不到可用模型路由：先在本会话发送一条消息，或在 cordis.patch.yml 的 ${PLUGIN_TAG} 行配置 provider 和 model。`,
        }
      }
      try {
        return { kind: 'success', text: await polish(ctx, routes, draft, resolved, signal) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const route = error?.route
        const suffix = route === undefined ? '' : `（${route.provider}/${route.model}）`
        return { kind: 'error', text: `美化失败：${message}${suffix}` }
      }
    },
  })
}
