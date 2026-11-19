# OpenPane

A code-agent console for [opencode](https://opencode.ai) inside VS Code. It is a thin client: it spawns your existing `opencode` binary as `opencode serve` on `127.0.0.1` and talks to its v2 HTTP API and event stream. Your opencode config (`opencode.json`, providers, OpenRouter routing) is used as-is.

It is for code work in the open workspace only:

- Prompt, stream and interrupt the agent from a sidebar panel.
- Editor context is attached automatically and can be removed: the active file and the current selection. "OpenPane: Ask about selection" (editor context menu, `Cmd+Alt+L` / `Ctrl+Alt+L`) pins a selection. `@` opens a workspace file picker.
- "Attach diagnostics" sends the current file's Problems.
- Tool calls (read, write, shell, grep...) appear as live, collapsible cards. File paths open in the editor.
- Every edit asks first. The proposed change opens in VS Code's native diff, and you Allow, Always or Deny it. The "files changed" list opens a diff of what the agent changed in each file.
- Several sessions run side by side as tabs inside the panel (`+`). The list button resumes an earlier session of this workspace in the current tab.
- Model, effort (model variant) and agent pickers are populated from the server. Your choices are remembered across sessions and restarts.
- Paste images into the prompt (Cmd+V). They are sent inline to the model, which must support image input.
- The footer shows session input/output tokens, cost, and context size against a 100k budget.
- A status bar item shows the server state: starting, connected, reconnecting or error.

## Requirements

- VS Code 1.100 or newer.
- opencode with the v2 API (`/api/*`). Types are generated for the version in `spec/VERSION` (currently 2.3.0). If the running binary differs, you get a warning and the extension keeps going.
- Node 20+ and npm to build.

## Build and install (sideload)

```sh
npm install
npm run package          # builds dist/ and writes openpane-<version>.vsix
code --install-extension openpane-0.2.1.vsix
```

Or in VS Code: Extensions view, `...` menu, "Install from VSIX...".

Development: open this folder in VS Code and press F5 ("Run Extension").

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `openpane.binaryPath` | `opencode` | Binary to spawn. If it is left as `opencode` and that is not on the PATH VS Code sees, `~/.opencode/bin/opencode` is tried. |
| `openpane.serverUrl` | empty | Use a running server instead of spawning one. Put credentials in the URL, e.g. `http://opencode:PASSWORD@127.0.0.1:4096`. |

## How it works

- `src/server.ts` spawns `opencode serve --port 0 --hostname 127.0.0.1` with a random `OPENCODE_SERVER_PASSWORD` per VS Code session, parses the listening URL from stdout, and sends basic auth on every request. The child process is killed on deactivate.
- `src/sse.ts` reads `GET /api/event` with a streaming `fetch`. It reconnects with exponential backoff (0.5s up to 10s) and logs every retry. After a reconnect it refetches the open session, because events may have been missed.
- `src/reducer.ts` is a pure function from events to UI state, unit-tested against recorded fixtures in `test/fixtures/`.
- Sessions created by OpenPane carry the rule `edit -> ask`. Your `opencode.json` is not modified.
- Network traffic goes only to the local opencode server. There is no telemetry.

## Regenerating API types

```sh
npm run gen:api
```

This starts `opencode serve`, downloads `/openapi.json` into `spec/openapi.json`, records `opencode --version` in `spec/VERSION`, and regenerates `src/generated/api.ts` with `openapi-typescript`. Commit all three.

## Tests

```sh
npm run lint   # type-check extension and webview (strict)
npm test       # reducer fixtures, SSE parser, patch, server lifecycle (fake binary), smoke test against real opencode
```

The smoke test is skipped when `opencode` is not installed.

## Known limitations

- Single-root workspaces only. The first folder is used.
- Editor context is sent as a `<context>` text block in the prompt, not as file attachments. The agent reads files itself with its tools.
- Resuming a session loads the newest 200 messages, which is the API's page limit.
- If a permission patch does not apply cleanly to the file on disk (for example, the file changed since), the raw patch is shown instead of a side-by-side diff.
- Only `edit` is forced to ask. Other permissions (shell, etc.) follow your opencode config. When it asks, they appear as Allow/Deny cards.
- Markdown is rendered without syntax highlighting, to keep the bundle small. Code blocks use theme colors.
- No rename/delete of sessions, checkpoints, or inline completions.

## License

MIT. Started from [saffron-health/opencode-gui](https://github.com/saffron-health/opencode-gui) (MIT, Copyright (c) 2025 Tanishq Kancharla). See `LICENSE.md`.
