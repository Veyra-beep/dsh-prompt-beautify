// dsh-prompt-beautify — client half (hand-written lazy-CJS bundle; no build step).
//
// Registers one small button in the composer tool strip. The button reads the
// current draft through the standard `useInput` seat, asks the host for a
// polished rewrite through the `/polish` command, and writes the answer back
// with `inputActions.setDraft`. Nothing is sent to the conversation.
window.__ModuleLoader__.load({
  id: 'dsh-prompt-beautify',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const SLOT = 'conversation.input.left'
    const OWNER = 'dsh-prompt-beautify'
    const B64_PREFIX = '--b64 '
    const BUSY_HINT = '正在美化…'
    const IDLE_HINT = '美化提示词：把草稿改写为更清晰、更完整的提示词（不发送、不计入对话）'
    const ERROR_TTL = 6000

    /** One-shot guard so a composition missing a seat logs once, not per render. */
    let warnedMissingSeats = false

    const CSS = `
      .pp-root { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
      .pp-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 4px;
        height: 24px; padding: 0 8px; border: 1px solid transparent; border-radius: 6px;
        background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; line-height: 1; white-space: nowrap;
        cursor: pointer; transition: background-color .12s ease, color .12s ease;
      }
      .pp-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .pp-btn:disabled { cursor: default; opacity: .55; }
      .pp-btn[data-tone="undo"] { color: var(--dsw-alias-label-tertiary); }
      .pp-icon { width: 13px; height: 13px; flex: none; }
      .pp-spin { animation: pp-spin 1s linear infinite; }
      @keyframes pp-spin { to { transform: rotate(360deg); } }
      .pp-err { font-size: 12px; line-height: 1; color: var(--dsw-alias-state-error-primary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `

    /** UTF-8-safe base64 so the draft keeps its exact whitespace and newlines. */
    function encodeBase64(text) {
      const bytes = new TextEncoder().encode(text)
      let binary = ''
      const CHUNK = 0x8000
      for (let index = 0; index < bytes.length; index += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK))
      }
      return btoa(binary)
    }

    function SparkIcon(props) {
      return React.createElement(
        'svg',
        {
          className: props.busy ? 'pp-icon pp-spin' : 'pp-icon',
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M8 1.9 9.5 6.5 14.1 8 9.5 9.5 8 14.1 6.5 9.5 1.9 8 6.5 6.5Z' }),
      )
    }

    function UndoIcon() {
      return React.createElement(
        'svg',
        { className: 'pp-icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        React.createElement('path', { d: 'M5.5 4.5 2.5 7.5 5.5 10.5' }),
        React.createElement('path', { d: 'M2.5 7.5h6.3a3.7 3.7 0 0 1 0 7.4H8.6' }),
      )
    }

    /**
     * Guarded entry: only renders when the standard seats this build relies on
     * are actually present, so a composition without them degrades to nothing
     * instead of blanking the whole slot.
     */
    function PolishButton(props) {
      const seats = props === undefined || props === null ? {} : props
      const { useInput, inputActions, sessionId, polishExecute } = seats
      const missing =
        typeof useInput !== 'function'
          ? 'useInput'
          : typeof sessionId !== 'string'
            ? 'sessionId'
            : inputActions === undefined || inputActions === null
              ? 'inputActions'
              : typeof polishExecute !== 'function'
                ? 'polishExecute'
                : undefined
      if (missing !== undefined) {
        if (!warnedMissingSeats) {
          warnedMissingSeats = true
          console.warn('[dsh-prompt-beautify] slot props missing: ' + missing + '; button disabled')
        }
        return null
      }
      return React.createElement(PolishControl, {
        useInput,
        inputActions,
        sessionId,
        polishExecute,
      })
    }

    function PolishControl({ useInput, inputActions, sessionId, polishExecute }) {
      const draft = useInput((state) => (state === undefined ? '' : state.draft))
      const phase = useInput((state) => (state === undefined ? 'plain' : state.phase))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [undo, setUndo] = React.useState(null)
      const alive = React.useRef(true)
      const errorTimer = React.useRef(undefined)

      React.useEffect(() => {
        return () => {
          alive.current = false
          if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
        }
      }, [])

      const text = typeof draft === 'string' ? draft : ''
      const locked = phase !== 'plain' && phase !== undefined
      const canUndo = undo !== null && text === undo.after
      const disabled = busy || locked || text.trim() === ''

      const report = React.useCallback((message) => {
        if (!alive.current) return
        setError(message)
        if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
        errorTimer.current = setTimeout(() => {
          if (alive.current) setError(null)
        }, ERROR_TTL)
      }, [])

      const polish = React.useCallback(
        async (event) => {
          event.preventDefault()
          if (disabled) return
          setBusy(true)
          setError(null)
          try {
            const outcome = await polishExecute(sessionId, '/polish ' + B64_PREFIX + encodeBase64(text))
            if (outcome === undefined || outcome.ok !== true) {
              const detail = outcome?.error?.message
              throw new Error(typeof detail === 'string' && detail !== '' ? detail : '宿主没有响应 /polish 命令')
            }
            const payload = outcome.value
            const result = payload === undefined ? undefined : payload.result
            if (result === undefined) throw new Error('宿主没有返回美化结果')
            if (result.kind === 'error') throw new Error(result.text)
            const polished = typeof result.text === 'string' ? result.text : ''
            if (polished.trim() === '') throw new Error('美化结果为空')
            if (!alive.current) return
            setUndo({ before: text, after: polished })
            inputActions.setDraft(polished)
          } catch (failure) {
            report(failure instanceof Error ? failure.message : String(failure))
          } finally {
            if (alive.current) setBusy(false)
          }
        },
        [disabled, polishExecute, sessionId, text, inputActions, report],
      )

      const revert = React.useCallback(
        (event) => {
          event.preventDefault()
          if (undo === null) return
          inputActions.setDraft(undo.before)
          setUndo(null)
          setError(null)
        },
        [undo, inputActions],
      )

      const hint = busy ? BUSY_HINT : error !== null ? error : IDLE_HINT

      return React.createElement(
        'span',
        { className: 'pp-root' },
        React.createElement('style', null, CSS),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'pp-btn',
            title: hint,
            'aria-label': IDLE_HINT,
            disabled,
            onMouseDown: (event) => {
              event.preventDefault()
            },
            onClick: polish,
          },
          React.createElement(SparkIcon, { busy }),
          React.createElement('span', null, busy ? '美化中' : '美化'),
        ),
        canUndo
          ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'pp-btn',
                'data-tone': 'undo',
                title: '撤销美化，恢复美化前的草稿',
                onMouseDown: (event) => {
                  event.preventDefault()
                },
                onClick: revert,
              },
              React.createElement(UndoIcon),
              React.createElement('span', null, '撤销'),
            )
          : null,
        error !== null
          ? React.createElement('span', { className: 'pp-err', title: error }, error)
          : null,
      )
    }

    /**
     * Install the composer button.
     *
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const remote = ctx.remote
      if (remote === undefined || typeof remote.commands?.execute !== 'function') return
      // The owner key must be the slot's own name: `slots.inject` follows that
      // declaration's epoch and only runs the callback for a declared slot.
      slots.inject(SLOT, () =>
        slots.register(
          {
            name: SLOT,
            id: OWNER,
            order: 20,
            inject: () => ({
              polishExecute: (sessionId, line) => remote.commands.execute(sessionId, line, []),
            }),
          },
          PolishButton,
        ),
      )
    }

    exports.apply = apply
    // `slots` is read through ctx.get(); declaring it here would block the
    // plugin on a service name the shell does not publish under that key.
    exports.inject = ['remote', 'remote.commands']
    return exports
  },
})