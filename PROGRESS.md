# Progress

## Done
- Phase 1: server lifecycle (spawn on 127.0.0.1 with `--port 0` and a random `OPENCODE_SERVER_PASSWORD`, or reuse `openpane.serverUrl`), status bar, SSE stream with backoff and resync, prompt / stream / interrupt in a minimal panel. `npm run gen:api`, version-mismatch warning.

- Phase 2: context chips (active file + selection, automatic and removable), "OpenPane: Ask about selection" (command, context menu, Cmd+Alt+L), `@` file mentions via quick pick. Context is sent as a `<context>` block in the prompt text.

- Phase 3: collapsible tool-call cards (name, path/command, live status, input, output capped at 200 lines); file paths open in the editor.

- Phase 4: OpenPane sessions are created with `edit -> ask`. On `permission.asked` the proposed diff opens in `vscode.diff` (patch from permission metadata applied to the file on disk); Allow / Always / Deny reply via `/permission/{id}/reply` and close the diff tabs. Changed-files list opens "agent changes" diffs via `/api/session/{id}/diff`. If a patch does not apply, the raw patch is shown.

- Phase 5: "Attach diagnostics" (composer button + command) pins the current file's Problems as a context chip.

- Phase 6: model and agent quick picks from `/api/model` (enabled) and `/api/agent` (primary, not hidden); current model shown in the composer (server default until changed). Session list (new / resume) from `/api/session?directory=<workspace>`.

## Next
- README, packaging, clean-window install check.

## Open questions
- None.
