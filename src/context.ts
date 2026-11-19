// Editor context attached to prompts: active file and selection (automatic, removable),
// pinned selections ("Ask about selection") and diagnostics.
import * as vscode from 'vscode';
import type { Chip } from './shared/protocol';

interface Entry {
  chip: Chip;
  /** Text block sent to the agent. First line is the `[kind] label` header the webview shows. */
  text: string;
}

const MAX_SNIPPET = 20_000;

export class ContextTracker implements vscode.Disposable {
  private pinned: Entry[] = [];
  private dismissed = new Set<string>();
  private nextId = 0;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly onChange: (chips: Chip[]) => void) {
    this.subs = [
      vscode.window.onDidChangeActiveTextEditor((e) => e && this.changed()),
      vscode.window.onDidChangeTextEditorSelection((e) => e.textEditor === vscode.window.activeTextEditor && this.changed()),
    ];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }

  chips(): Chip[] {
    return this.entries().map((e) => e.chip);
  }

  remove(id: string): void {
    const before = this.pinned.length;
    this.pinned = this.pinned.filter((e) => e.chip.id !== id);
    if (this.pinned.length === before) this.dismissed.add(id);
    this.changed();
  }

  /** Returns the context block for the next prompt and clears pinned entries. */
  take(): string {
    const parts = this.entries().map((e) => e.text);
    this.pinned = [];
    this.changed();
    return parts.length ? `<context>\n${parts.join('\n')}\n</context>` : '';
  }

  pinSelection(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): boolean {
    const entry = editor && selectionEntry(editor, `sel-${++this.nextId}`, false);
    if (!entry) return false;
    this.pinned.push(entry);
    this.changed();
    return true;
  }

  pinDiagnostics(): boolean {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return false;
    const diags = vscode.languages.getDiagnostics(doc.uri);
    const path = rel(doc.uri);
    const lines = diags.map(
      (d) => `- L${d.range.start.line + 1}:${d.range.start.character + 1} ${severity(d.severity)}${d.source ? ` (${d.source})` : ''}: ${d.message}`,
    );
    const label = `${path} (${diags.length} problem${diags.length === 1 ? '' : 's'})`;
    this.pinned.push({
      chip: { id: `diag-${++this.nextId}`, kind: 'diagnostics', label, auto: false },
      text: `[diagnostics] ${label}\n${lines.join('\n') || '- no problems reported'}`,
    });
    this.changed();
    return true;
  }

  private entries(): Entry[] {
    const auto: Entry[] = [];
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      const path = rel(editor.document.uri);
      auto.push({ chip: { id: `file:${path}`, kind: 'file', label: path, auto: true }, text: `[file] ${path}` });
      const sel = selectionEntry(editor, '', true);
      if (sel) auto.push(sel);
    }
    return [...auto.filter((e) => !this.dismissed.has(e.chip.id)), ...this.pinned];
  }

  private changed(): void {
    this.onChange(this.chips());
  }
}

function selectionEntry(editor: vscode.TextEditor, id: string, auto: boolean): Entry | undefined {
  const sel = editor.selection;
  if (sel.isEmpty || editor.document.uri.scheme !== 'file') return undefined;
  const path = rel(editor.document.uri);
  const label = `${path}:${sel.start.line + 1}-${sel.end.line + 1}`;
  const code = editor.document.getText(sel).slice(0, MAX_SNIPPET);
  return {
    chip: { id: auto ? `sel:${label}` : id, kind: 'selection', label, auto },
    text: `[selection] ${label}\n\`\`\`${editor.document.languageId}\n${code}\n\`\`\``,
  };
}

const rel = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false);

function severity(s: vscode.DiagnosticSeverity): string {
  return ['error', 'warning', 'info', 'hint'][s] ?? 'info';
}

/** Quick pick over workspace files; returns a workspace-relative path. */
export async function pickWorkspaceFile(): Promise<string | undefined> {
  const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__}/**', 10_000);
  const items = files.map(rel).sort();
  return vscode.window.showQuickPick(items, { placeHolder: 'Mention a file', matchOnDescription: true });
}
