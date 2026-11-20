// Native diff views for agent edits.
// Before an edit: left = file on disk, right = proposed content rebuilt from the permission patch.
// After an edit:  left = original rebuilt by reverse-applying the session diff, right = file on disk.
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { applyPatch } from './patch';

const SCHEME = 'coddy';

export class DiffViewer implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docs = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly reg: vscode.Disposable;

  constructor(private readonly cwd: string) {
    this.reg = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  }

  dispose(): void {
    this.reg.dispose();
    this.changed.dispose();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  /** Shows what a pending edit would do. `tag` groups the tabs so they can be closed after the reply. */
  async showProposed(tag: string, file: string, patch: string, status: string): Promise<void> {
    const disk = this.fileUri(file);
    const current = status === 'added' ? '' : await this.read(disk);
    const proposed = applyPatch(current ?? '', patch);
    if (proposed === undefined) return this.showPatch(tag, file, patch);
    const left = status === 'added' ? this.virtual(`${tag}/empty/${file}`, '') : disk;
    const right = this.virtual(`${tag}/proposed/${file}`, proposed);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file} (proposed edit)`, { preview: false });
  }

  /** Shows what the agent already changed in this file. */
  async showApplied(file: string, patch: string, status: string): Promise<void> {
    const disk = this.fileUri(file);
    const current = status === 'deleted' ? '' : await this.read(disk);
    const original = applyPatch(current ?? '', patch, true);
    if (original === undefined) return this.showPatch('applied', file, patch);
    const left = this.virtual(`applied/original/${file}`, original);
    const right = status === 'deleted' ? this.virtual(`applied/deleted/${file}`, '') : disk;
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file} (agent changes)`, { preview: true });
  }

  /** Closes the diff tabs opened for a permission request once it has been answered. */
  async close(tag: string): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => {
      const input = t.input;
      return input instanceof vscode.TabInputTextDiff && input.modified.scheme === SCHEME && input.modified.path.startsWith(`/${tag}/`);
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    for (const key of [...this.docs.keys()]) if (key.includes(`/${tag}/`)) this.docs.delete(key);
  }

  /** Fallback when the patch does not apply to the file on disk: show the raw patch. */
  private async showPatch(tag: string, file: string, patch: string): Promise<void> {
    const uri = this.virtual(`${tag}/patch/${file}.diff`, patch);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'diff');
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private virtual(path: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${path}` });
    this.docs.set(uri.toString(), content);
    this.changed.fire(uri);
    return uri;
  }

  private fileUri(file: string): vscode.Uri {
    return vscode.Uri.file(isAbsolute(file) ? file : join(this.cwd, file));
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }
}
