# dsh-prompt-beautify

A DeepSeek Harness plugin that rewrites a rough composer draft into a clear, structured prompt in place, from a button next to the input box or from the host-side `/polish` command.

[中文](./README.md)

- **Never sends, never logs**: neither the button nor the command creates a model message. The draft and the rewrite stay out of the conversation history and cost no main-conversation tokens.
- **Inherits the current model**: the auxiliary request uses the provider/model of the session's most recent request, falling back to the profile's `agent-default-model` selection.
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
    # Pin a route (omit to inherit the current session model)
    # provider: ds
    # model: deepseek-v4.1-flash-1017
    maxInputChars: 8000   # reject longer drafts instead of requesting
    maxTokens: 2048       # cap for the rewrite
    timeoutMs: 45000      # per-request timeout
    # traceFile: C:\path\to\polish.log   # diagnostics: append one line per apply()
```

## Layout

| File | Role |
|---|---|
| `lib/index.js` | Host: registers `/polish`, resolves the route, streams `ctx.llm.stream` |
| `lib/client.js` | Client: the button in the `conversation.input.left` slot (read draft / write back / undo) |
| `cordis.patch.yml` | Inserts one `prompt-beautify` row into the profile composition |
| `test/host.test.mjs` | node:test cases for the command (10, no real model needed) |
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

## Compatibility

Verified against DSH `0.2.0-rc.2` with the Web client; `dsh.compatibility` in `package.json` declares the same floor and the verified release. The plugin imports no Harness core package and only talks to cordis services (`commands`, `llm`, `slots`, `remote.commands`), so it tolerates version drift.

## Reload semantics (measured)

- Editing the **profile's `cordis.patch.yml`** (including this plugin's config) makes HMR recompose immediately, no restart.
- Editing **this package's `lib/index.js` / `lib/client.js`** does not hot-reload: the host module is not re-imported and the client bundle is not rebuilt. Restart DeepSeek Harness (host) and reload the Web page (client).
- Comment-only edits do not trigger recomposition.

## Tests

```powershell
node --test test/              # host command logic, 10 cases, no real model
node test/client.smoke.mjs     # client bundle: fake slots/remote + react-dom/server
```

`client.smoke.mjs` needs `react@18` / `react-dom@18` resolvable next to this package; if they are missing it prints `SKIP` and exits 0. It covers: the module id and `inject` list, the rule that `slots.inject`'s owner key must be the slot name, the registration options, the `remote.commands.execute` wiring, the degrade-to-nothing path (one warning) when slot props are incomplete, and disabled states for empty drafts / non-`plain` phases.

## License

MIT, see [LICENSE](./LICENSE).