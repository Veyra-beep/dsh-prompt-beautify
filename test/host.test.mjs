// Host-side behaviour tests: run with `node --test test/` from this package.
// Not shipped (package.json files[] lists only lib, cordis.patch.yml, README).
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** Capture the registered command and drive its handler with a stubbed LLM. */
function harness(options = {}) {
  const registrations = []
  const calls = []
  const ctx = {
    commands: {
      register: (definition) => {
        registrations.push(definition)
        return () => {}
      },
    },
    get: (service) => {
      if (service === 'agentDefaultModel') return options.defaultModel
      if (service === 'sessionProjections') {
        if (options.projection === undefined) return undefined
        return { stateOf: (session, key) => (key === 'modelSelection' ? options.projection(session) : undefined) }
      }
      return undefined
    },
    llm: {
      stream: (request) => {
        calls.push(request)
        if (options.stream !== undefined) return options.stream(request)
        const chunks = options.chunks ?? [
          { type: 'text-delta', text: '改写后的提示词' },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
        return {
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk
          },
        }
      },
    },
  }
  apply(ctx, options.config)
  assert.equal(registrations.length, 1)
  return { command: registrations[0], calls }
}

const agent = { session: { requestHeader: () => ({ config: { provider: 'ds', model: 'deepseek-v4.1-flash-1017' } }) } }

/** An agent whose session also derives a conversation log. */
function agentWithContext(messages) {
  return {
    session: {
      requestHeader: () => ({ config: { provider: 'ds', model: 'deepseek-v4.1-flash-1017' } }),
      deriveMessages: () => messages,
    },
  }
}

/** A minimal text message shaped like a derived session message. */
function textMessage(role, text) {
  return { role, content: [{ type: 'text', text }] }
}

test('plain text after the command name is the draft', async () => {
  const { command, calls } = harness()
  const result = await command.handler({ agent, rawInput: '帮我看下这段代码有什么问题' })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, '改写后的提示词')
  assert.equal(calls[0].messages[0].content[0].text, '帮我看下这段代码有什么问题')
  assert.equal(calls[0].provider, 'ds')
  assert.equal(calls[0].model, 'deepseek-v4.1-flash-1017')
  assert.equal(calls[0].purpose, 'prompt-beautify')
})

test('base64 payload preserves newlines and indentation', async () => {
  const draft = '第一行\n\n   缩进代码\n第三行'
  const encoded = Buffer.from(draft, 'utf8').toString('base64')
  const { command, calls } = harness()
  const result = await command.handler({ agent, rawInput: '--b64 ' + encoded })
  assert.equal(result.kind, 'success')
  assert.equal(calls[0].messages[0].content[0].text, draft)
})

test('empty payload is rejected without calling the model', async () => {
  const { command, calls } = harness()
  const result = await command.handler({ agent, rawInput: '   ' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/)
  assert.equal(calls.length, 0)
})

test('oversized draft is rejected without calling the model', async () => {
  const { command, calls } = harness({ config: { maxInputChars: 5 } })
  const result = await command.handler({ agent, rawInput: '一二三四五六' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /太长/)
  assert.equal(calls.length, 0)
})

test('configured provider/model wins over the session route', async () => {
  const { command, calls } = harness({ config: { provider: 'other', model: 'other-model' } })
  await command.handler({ agent, rawInput: '测试' })
  assert.equal(calls[0].provider, 'other')
  assert.equal(calls[0].model, 'other-model')
})

test('falls back to the default-model service when the session has no request yet', async () => {
  const { command, calls } = harness({ defaultModel: { currentSelection: () => ({ provider: 'ds', model: 'fallback-model' }) } })
  const result = await command.handler({ agent: undefined, rawInput: '测试' })
  assert.equal(result.kind, 'success')
  assert.equal(calls[0].model, 'fallback-model')
})

test('no resolvable route is reported as an error', async () => {
  const { command, calls } = harness()
  const result = await command.handler({ agent: undefined, rawInput: '测试' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /模型路由/)
  assert.equal(calls.length, 0)
})

test('a failed finish reason becomes an error result', async () => {
  const { command } = harness({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }],
  })
  const result = await command.handler({ agent, rawInput: '测试' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /RATE_LIMIT/)
})

test('an empty model answer becomes an error result', async () => {
  const { command } = harness({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  const result = await command.handler({ agent, rawInput: '测试' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /空内容/)
})

test('one wrapping code fence is stripped from the answer', async () => {
  const { command } = harness({
    chunks: [
      { type: 'text-delta', text: '```markdown\n# 目标\n做点什么\n```' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  const result = await command.handler({ agent, rawInput: '测试' })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, '# 目标\n做点什么')
})

test('the failing route is named in the error text', async () => {
  const { command } = harness({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }],
  })
  const result = await command.handler({ agent, rawInput: '测试' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /ds\/deepseek-v4\.1-flash-1017/)
})

test('a route without an adapter falls back to the next candidate', async () => {
  const seen = []
  const { command } = harness({
    defaultModel: { currentSelection: () => ({ provider: 'ds-wen', model: 'fast-model' }) },
    stream: () => {
      const first = seen.push(1) === 1
      const chunks = first
        ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter registered for provider "dsh"' } } }]
        : [
            { type: 'text-delta', text: '改写后的提示词' },
            { type: 'finish', reason: { kind: 'stop' } },
          ]
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }
    },
  })
  const routes = []
  const original = command.handler
  const result = await original({ agent, rawInput: '测试' })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, '改写后的提示词')
  routes.push(seen.length)
  assert.deepEqual(routes, [2])
})

test('a stalled provider expires with a readable timeout instead of ABORTED', async () => {
  const { command } = harness({
    config: { idleTimeoutMs: 20, timeoutMs: 5000 },
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => setTimeout(resolve, 120))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } }
      },
    }),
  })
  const result = await command.handler({ agent, rawInput: '测试' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /超时/)
  assert.doesNotMatch(result.text, /ABORTED/)
})

test('a caller abort is reported as cancelled', async () => {
  const controller = new AbortController()
  const { command } = harness({
    config: { idleTimeoutMs: 0, timeoutMs: 0 },
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        controller.abort()
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted' } } }
      },
    }),
  })
  const result = await command.handler({ agent, rawInput: '测试', signal: controller.signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /取消/)
})
test('a rejected credential falls back to the next candidate', async () => {
  const seen = []
  const { command } = harness({
    defaultModel: { currentSelection: () => ({ provider: 'ds', model: 'slow-model' }) },
    stream: () => {
      const first = seen.push(1) === 1
      const chunks = first
        ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'invalid api key' } } }]
        : [
            { type: 'text-delta', text: '回退成功' },
            { type: 'finish', reason: { kind: 'stop' } },
          ]
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }
    },
  })
  const result = await command.handler({ agent, rawInput: '测试' })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, '回退成功')
  assert.equal(seen.length, 2)
})

test('the model picked in the composer wins over the last request header', async () => {
  const { command, calls } = harness({
    projection: () => ({
      lastUsed: { provider: 'ds', model: 'deepseek-v4.1-flash-1017' },
      pending: { provider: 'ds', model: 'deepseek-v4-pro' },
    }),
  })
  await command.handler({ agent, rawInput: '测试' })
  assert.equal(calls[0].provider, 'ds')
  assert.equal(calls[0].model, 'deepseek-v4-pro')
})

test('the last used model is followed once the switch was sent', async () => {
  const { command, calls } = harness({
    projection: () => ({
      lastUsed: { provider: 'ds', model: 'deepseek-v4-pro' },
      pending: null,
    }),
  })
  await command.handler({ agent, rawInput: '测试' })
  assert.equal(calls[0].model, 'deepseek-v4-pro')
})

test('an empty projection falls back to the last request header', async () => {
  const { command, calls } = harness({
    projection: () => ({ lastUsed: null, pending: null }),
  })
  await command.handler({ agent, rawInput: '测试' })
  assert.equal(calls[0].model, 'deepseek-v4.1-flash-1017')
})

test('a configured provider/model still wins over the live selection', async () => {
  const { command, calls } = harness({
    config: { provider: 'other', model: 'other-model' },
    projection: () => ({ lastUsed: { provider: 'ds', model: 'deepseek-v4-pro' }, pending: null }),
  })
  await command.handler({ agent, rawInput: '测试' })
  assert.equal(calls[0].provider, 'other')
  assert.equal(calls[0].model, 'other-model')
})

test('a missing projection service falls back to the last request header', async () => {
  const { command, calls } = harness()
  await command.handler({ agent, rawInput: '测试' })
  assert.equal(calls[0].model, 'deepseek-v4.1-flash-1017')
})

test('the conversation is sent as background context by default', async () => {
  const { command, calls } = harness()
  const contextAgent = agentWithContext([
    textMessage('system', 'system prompt is not background'),
    textMessage('user', '我在排查 resolveRoutes 为什么回退失败'),
    textMessage('assistant', '先看 requestHeader 和 project 的选择'),
  ])
  const result = await command.handler({ agent: contextAgent, rawInput: '再补一版更稳的回退' })
  assert.equal(result.kind, 'success')
  const sent = calls[0].messages[0].content[0].text
  assert.match(sent, /【会话上下文/)
  assert.match(sent, /resolveRoutes/)
  assert.match(sent, /project/)
  assert.match(sent, /【需要改写的草稿】/)
  assert.match(sent, /再补一版更稳的回退/)
  assert.doesNotMatch(sent, /system prompt is not background/)
})

test('useContext: false sends only the draft', async () => {
  const { command, calls } = harness({ config: { useContext: false } })
  const contextAgent = agentWithContext([textMessage('user', '上一轮说过的话')])
  await command.handler({ agent: contextAgent, rawInput: '草稿' })
  assert.equal(calls[0].messages[0].content[0].text, '草稿')
})

test('only text blocks of user and assistant messages become context', async () => {
  const { command, calls } = harness()
  const contextAgent = agentWithContext([
    { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', data: 'x' }] },
    { role: 'tool', content: [{ type: 'text', text: 'tool output should be skipped' }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'read', input: {} }] },
    { role: 'assistant', content: [{ type: 'text', text: '结论是超时' }] },
  ])
  await command.handler({ agent: contextAgent, rawInput: '草稿' })
  const sent = calls[0].messages[0].content[0].text
  assert.match(sent, /看这张图/)
  assert.match(sent, /结论是超时/)
  assert.doesNotMatch(sent, /tool output should be skipped/)
})

test('contextRounds keeps only the last N exchanges', async () => {
  const { command, calls } = harness({ config: { contextRounds: 1 } })
  const messages = []
  for (let i = 1; i <= 5; i++) {
    messages.push(textMessage('user', '第' + i + '轮问题'))
    messages.push(textMessage('assistant', '第' + i + '轮回答'))
  }
  await command.handler({ agent: agentWithContext(messages), rawInput: '草稿' })
  const sent = calls[0].messages[0].content[0].text
  assert.match(sent, /第5轮问题/)
  assert.doesNotMatch(sent, /第4轮问题/)
})

test('contextChars trims the excerpt from the front', async () => {
  const { command, calls } = harness({ config: { contextChars: 40 } })
  const contextAgent = agentWithContext([
    textMessage('user', 'A'.repeat(200)),
    textMessage('assistant', 'B'.repeat(200) + '本次报错是 AUTH'),
  ])
  await command.handler({ agent: contextAgent, rawInput: '草稿' })
  const sent = calls[0].messages[0].content[0].text
  const contextPart = sent.slice(sent.indexOf('【会话上下文'), sent.indexOf('【需要改写的草稿】'))
  assert.ok(contextPart.length <= 120, 'context part grew beyond its budget: ' + contextPart.length)
  assert.match(contextPart, /AUTH/)
})

test('a session without deriveMessages sends only the draft', async () => {
  const { command, calls } = harness()
  await command.handler({ agent, rawInput: '草稿' })
  assert.equal(calls[0].messages[0].content[0].text, '草稿')
})
