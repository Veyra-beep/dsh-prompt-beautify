// Offline smoke test for the client bundle: no browser and no DSH runtime.
//
// It fakes window.__ModuleLoader__, feeds the factory a real React, fakes the
// slots/remote services, and renders the button through react-dom/server to
// check the guard, the registration contract and the disabled states.
//
// Needs react@18 + react-dom@18 resolvable from here:
//   npm i --no-save react@18 react-dom@18 && node test/client.smoke.mjs
// Exits 0 with a SKIP line when React is not installed.

let React
let renderToStaticMarkup
try {
  React = (await import('react')).default
  ;({ renderToStaticMarkup } = await import('react-dom/server'))
} catch {
  console.log('SKIP client smoke: react@18 / react-dom@18 not installed next to this package')
  process.exit(0)
}

const CLIENT = new URL('../lib/client.js', import.meta.url).href

let loadArgs
globalThis.window = {
  __ModuleLoader__: {
    load: (args) => {
      loadArgs = args
    },
  },
}
await import(CLIENT)
if (!loadArgs) throw new Error('module did not call __ModuleLoader__.load')
if (loadArgs.id !== 'dsh-prompt-beautify') throw new Error('bad module id: ' + loadArgs.id)

const exports = loadArgs.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected external module requested: ' + name)
})
if (typeof exports.apply !== 'function') throw new Error('no apply export')
const injected = JSON.stringify(exports.inject)
if (injected !== JSON.stringify(['remote', 'remote.commands'])) throw new Error('bad inject list: ' + injected)

// --- fake slots: the owner key of inject() must be the slot name itself ---
let ownerKey
let registration
let Component
const slotsApi = {
  inject(owner, factory) {
    ownerKey = owner
    factory()
  },
  register(options, component) {
    registration = options
    Component = component
    return () => {}
  },
}
const calls = []
const remote = {
  commands: {
    execute: async (sessionId, line, attachments) => {
      calls.push({ sessionId, line, attachments })
      return { ok: true, value: { commandId: 'c1', result: { kind: 'success', text: 'POLISHED TEXT' } } }
    },
  },
}
exports.apply({ get: (key) => (key === 'slots' ? slotsApi : undefined), remote })

if (ownerKey !== 'conversation.input.left') throw new Error('inject() owner key must be the slot name, got ' + ownerKey)
if (registration.name !== 'conversation.input.left' || registration.id !== 'dsh-prompt-beautify' || registration.order !== 20) {
  throw new Error('bad registration: ' + JSON.stringify(registration))
}
const injectedProps = registration.inject()
if (typeof injectedProps.polishExecute !== 'function') throw new Error('inject() must supply polishExecute')
const outcome = await injectedProps.polishExecute('session-1', '/polish --b64 aGk=')
if (!outcome.ok || calls.length !== 1) throw new Error('remote.commands.execute not wired')
if (calls[0].sessionId !== 'session-1' || calls[0].line !== '/polish --b64 aGk=' || calls[0].attachments.length !== 0) {
  throw new Error('bad execute arguments: ' + JSON.stringify(calls[0]))
}

// --- render: missing seats degrade to nothing, warning once ---
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))
const empty = renderToStaticMarkup(React.createElement(Component, {}))
console.warn = originalWarn
if (empty !== '') throw new Error('missing seats should render nothing, got ' + JSON.stringify(empty))
if (warnings.length !== 1 || !warnings[0].includes('slot props missing: useInput')) {
  throw new Error('expected one diagnostic warning, got ' + JSON.stringify(warnings))
}

// --- render: full seats ---
const seats = (draft, phase) => ({
  useInput: (selector) => selector({ draft, phase }),
  inputActions: { setDraft: () => {} },
  sessionId: 'session-1',
  polishExecute: async () => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: 'POLISHED TEXT' } } }),
})
const ready = renderToStaticMarkup(React.createElement(Component, seats('hello', 'plain')))
if (!ready.includes('pp-btn')) throw new Error('button should render')
if (ready.includes('disabled=""')) throw new Error('ready button must not be disabled')
if (!renderToStaticMarkup(React.createElement(Component, seats('   ', 'plain'))).includes('disabled=""')) {
  throw new Error('blank draft must be disabled')
}
if (!renderToStaticMarkup(React.createElement(Component, seats('hello', 'submitting'))).includes('disabled=""')) {
  throw new Error('non-plain phase must be disabled')
}

console.log('client smoke test OK')