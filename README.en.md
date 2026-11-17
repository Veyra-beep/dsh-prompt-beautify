# dsh-prompt-beautify

A DeepSeek Harness plugin that rewrites a rough composer draft into a clear, structured prompt in place, from a button next to the input box or from the host-side `/polish` command.

[中文](./README.md)

- **Never sends, never logs**: neither the button nor the command creates a model message. The draft and the rewrite stay out of the conversation history and cost no main-conversation tokens.
- **Follows the live model**: the auxiliary request uses whatever provider/model the session is currently pointed at — the one the composer's model picker shows — so a model switch takes effect on the next beautify without sending a message first. It reads the session's `modelSelection` projection first, then the last request header, then the profile's `agent-default-model`; candidate routes are tried in order, so an unusable route falls through to the next one.
- **Reads the conversation**: by default the last few exchanges ride along as background — only the text of user and assistant messages, never images, tool calls or tool output — so the rewrite can resolve references like "this" or "the one above" and pick up constraints you just stated. Six exchanges and 6000 characters by default; turn it off with `useContext: false`.
- **Zero third-party dependencies**: the host half only needs the `commands` and `llm` services; the client half is a hand-written lazy CJS bundle that imports no `@deepseek-ai/dsh-client-*` package.

## Usage

Write a draft, then either:

- Click **✨ 美化 / Beautify** in the toolbar at the bottom-left of the composer: the draft is rewritten in place and never sent. An **Undo** button appears afterwards; the editor's own Ctrl/Cmd-Z also works.
- Or type the command:

  ```
  /polish review this function for edge cases
  ```

  The command result is not appended to the conversation.

The button passes the draft through `--b64 <base64>`, so newlines, indentation and Markdown survive intact; when typing by hand, put the text directly after the command.

## Configuration

Override per-row options in the profile's `cordis.patch.yml` (survives upgrades):

```yaml
- id: prompt-beautify
  config:
    # Pin a route (omit to follow the live session model)
    # provider: ds
    # model: deepseek-v4.1-flash-1017
    maxInputChars: 8000   # reject longer drafts instead of requesting
    maxTokens: 2048       # cap for the rewrite
    timeoutMs: 180000     # hard ceiling for one rewrite, in ms
    idleTimeoutMs: 90000  # after output starts, how long with no new text counts as stalled
    useContext: true      # include the last few exchanges as background
    contextRounds: 6      # how many exchanges to include (one exchange = user + assistant)
    contextChars: 6000    # character budget; the oldest text is dropped first
    # traceFile: C:\path\to\polish.log   # diagnostics: append one line per apply()
```

The context excerpt keeps only text blocks of `user` and `assistant` messages; images, tool calls and tool output are never sent. It is trimmed from the oldest end to fit `contextChars`, so a long session cannot blow up the request.

Time to first token depends on the relay's queue: the same key has been measured anywhere between 0.9s and 78s, so the default ceiling is deliberately generous. `timeoutMs` bounds the whole request; `idleTimeoutMs` only fires when output has started but then goes quiet. Either way you get a readable reason (`请求超时：超过 N 秒总时长上限` / `等待模型响应超时：N 秒内没有收到新内容`) instead of a bare `ABORTED`.

Failures name the route that was used, e.g. `美化失败：携带无效凭据（ds/deepseek-v4.1-flash-1017）`. The codes `NO_ADAPTER`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL` and `AUTH` first fall through to the next candidate; the command only reports an error once every candidate has failed.

## Layout

| File | Role |
|---|---|
| `lib/index.js` | Host: registers `/polish`, resolves candidate routes, streams `ctx.llm.stream` |
| `lib/client.js` | Client: the button in the `conversation.input.left` slot (read draft / write back / undo) |
| `cordis.patch.yml` | Inserts one `prompt-beautify` row into the profile composition |
| `test/host.test.mjs` | node:test cases for the command (26, no real model needed) |
| `test/client.smoke.mjs` | Offline smoke test of the client bundle (needs react@18) |

Required host services are `commands` (slash command registry) and `llm` (provider-neutral completion service); both ship in the default DSH composition.

## Install

```powershell
dsh plugin --profile <profile> add <absolute path to this directory>
```

This adds the package to the profile's `dsh.profile.bundles` and lets the bundled `cordis.patch.yml` insert the `prompt-beautify` row.

Once the package is published to npm, installing by name also works:

```powershell
dsh plugin --profile <profile> add dsh-prompt-beautify
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Fails after ~45s with `美化失败：ABORTED: Request aborted` | 0.1.0's hard 45s timeout versus a relay queue that needs 50–80s to first token | Upgrade to 0.1.1+ (default `timeoutMs` is 180000) or raise it in the config |
| `美化失败：…（provider/model）` | The candidate route failed; the parentheses hold the last route tried | Read the code: switch keys for `AUTH` / `INVALID_CREDENTIAL`; `NO_ADAPTER` means that provider has no registered adapter |
| `请求超时：超过 N 秒总时长上限` | The model never produced output | Raise `timeoutMs`, or pin a faster `provider`/`model` |
| No ✨ button next to the composer | The client bundle did not load with the page | Reload the Web page; restart DeepSeek Harness if it still does not appear |
| Beautify still uses the old model after a switch | 0.1.2 and earlier only read the last request header, so the switch lands one message later | Upgrade to 0.1.3+ (reads the session `modelSelection` projection and follows immediately) |
| Beautify sent context you did not want to resend | 0.1.3+ reads the last six exchanges by default | Set `useContext: false` in the profile, or lower `contextRounds` / `contextChars` |
| Editing `lib/*.js` changes nothing | Neither the host module nor the client bundle hot-reloads | Restart the app and reload the page |

## Compatibility

Verified against DSH `0.2.0-rc.2` with the Web client; `dsh.compatibility` in `package.json` declares the same floor and the verified release. The plugin imports no Harness core package and only talks to cordis services (`commands`, `llm`, `slots`, `remote.commands`), so it tolerates version drift.

## Reload semantics (measured)

- Editing the **profile's `cordis.patch.yml`** (including this plugin's config) makes HMR recompose immediately, no restart.
- Editing **this package's `lib/index.js` / `lib/client.js`** does not hot-reload: the host module is not re-imported and the client bundle is not rebuilt. Restart DeepSeek Harness (host) and reload the Web page (client).
- Comment-only edits do not trigger recomposition.

## Tests

```powershell
node --test test/host.test.mjs              # host command logic, 26 cases, no real model
node test/client.smoke.mjs     # client bundle: fake slots/remote + react-dom/server
```

`client.smoke.mjs` needs `react@18` / `react-dom@18` resolvable next to this package; if they are missing it prints `SKIP` and exits 0. It covers: the module id and `inject` list, the rule that `slots.inject`'s owner key must be the slot name, the registration options, the `remote.commands.execute` wiring, the degrade-to-nothing path (one warning) when slot props are incomplete, and disabled states for empty drafts / non-`plain` phases.

## License

MIT, see [LICENSE](./LICENSE).
