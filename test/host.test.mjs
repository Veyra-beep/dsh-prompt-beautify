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
    get: (service) => (service === 'agentDefaultModel' ? options.defaultModel : undefined),
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
