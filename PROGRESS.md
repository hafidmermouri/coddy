# Progress

## Done
- Phase 1: server lifecycle (spawn on 127.0.0.1 with `--port 0` and a random `OPENCODE_SERVER_PASSWORD`, or reuse `openpane.serverUrl`), status bar, SSE stream with backoff and resync, prompt / stream / interrupt in a minimal panel. `npm run gen:api`, version-mismatch warning.

- Phase 2: context chips (active file + selection, automatic and removable), "OpenPane: Ask about selection" (command, context menu, Cmd+Alt+L), `@` file mentions via quick pick. Context is sent as a `<context>` block in the prompt text.

- Phase 3: collapsible tool-call cards (name, path/command, live status, input, output capped at 200 lines); file paths open in the editor.

- Phase 4: OpenPane sessions are created with `edit -> ask`. On `permission.asked` the proposed diff opens in `vscode.diff` (patch from permission metadata applied to the file on disk); Allow / Always / Deny reply via `/permission/{id}/reply` and close the diff tabs. Changed-files list opens "agent changes" diffs via `/api/session/{id}/diff`. If a patch does not apply, the raw patch is shown.

- Phase 5: "Attach diagnostics" (composer button + command) pins the current file's Problems as a context chip.

- Phase 6: model and agent quick picks from `/api/model` (enabled) and `/api/agent` (primary, not hidden); current model shown in the composer (server default until changed). Session list (new / resume) from `/api/session?directory=<workspace>`.

- README, `.vsix` packaging (58 KB), install + activation verified in a clean VS Code profile (server spawned via `~/.opencode/bin` fallback, event stream connected, version check matched).
- POSIX watchdog: opencode is killed even when VS Code dies without calling `deactivate` (verified with a force kill: 0 orphans).
- Live round trip verified against the real server via the controller: edit permission with patch -> approve -> file changed, `/diff`, resume, interrupt.

## Next
- Manual UI pass in your own VS Code (see "Not verified" below).

## Not verified
- Webview UI interactions (clicking, chips, diff tabs opening/closing, pickers) were not driven by automation; only build/type-check and the extension-host logic were exercised.
- Windows (no watchdog there; plain kill on deactivate).

## v2 API notes (differences from docs/first prompt)
- Spec is at `/openapi.json` (`/doc` is the web UI). v1 routes (`/session`, `/event`) now return the web UI HTML.
- `opencode serve` honours `OPENCODE_SERVER_PASSWORD` and `--port 0`; it generates and prints a password if none is set.
- `GET /api/session/{id}/message` rejects `limit > 200` although the spec does not state a maximum.
- Permission requests for edits carry `metadata.files[{file, patch, status, additions, deletions}]`; the spec types metadata as an empty object.
- Permission action is `edit` even when the tool is `write`.
- Default model on this machine resolves to `opencode/tidepool-alpha-free`, not an OpenRouter model; pick one in the model picker if needed.

## Open questions
- None.
