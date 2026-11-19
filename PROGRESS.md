# Progress

## Done
- Phase 1: server lifecycle (spawn on 127.0.0.1 with `--port 0` and a random `OPENCODE_SERVER_PASSWORD`, or reuse `openpane.serverUrl`), status bar, SSE stream with backoff and resync, prompt / stream / interrupt in a minimal panel. `npm run gen:api`, version-mismatch warning.

- Phase 2: context chips (active file + selection, automatic and removable), "OpenPane: Ask about selection" (command, context menu, Cmd+Alt+L), `@` file mentions via quick pick. Context is sent as a `<context>` block in the prompt text.

- Phase 3: collapsible tool-call cards (name, path/command, live status, input, output capped at 200 lines); file paths open in the editor.

## Next
- Phase 4: edit review via `vscode.diff` + permission approve/deny, changed-files list.

## Open questions
- None.
