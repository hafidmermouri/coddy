// The chat panel: a set of session tabs, each a Controller with its own session, plus the
// routing of editor-side intents (diffs, files, pickers, context) to the active tab.
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { type ContextTracker, pickWorkspaceFile } from './context';
import { type ChatState, Controller, type Prefs } from './controller';
import type { DiffViewer } from './diff';
import type { ChatWebview } from './panel';
import type { Connection } from './server';
import type { FromWebview, ServerStatus } from './shared/protocol';

export interface Shared {
  cwd: string;
  log: (m: string) => void;
  context: ContextTracker;
  diffs: DiffViewer;
  prefs: () => Prefs;
  savePrefs: (p: Prefs) => void;
  connection: () => Connection | undefined;
  serverStatus: () => ServerStatus;
  attachDiagnostics: () => void;
}

export class Surface {
  private readonly tabs = new Map<string, Controller>();
  private active = '';
  private nextKey = 0;
  /** Permission ids whose diff was already opened. */
  private readonly reviewed = new Set<string>();

  constructor(private readonly shared: Shared, private readonly view: ChatWebview) {
    this.newTab();
  }

  controllers(): Controller[] {
    return [...this.tabs.values()];
  }

  activeController(): Controller {
    return this.tabs.get(this.active)!;
  }

  newTab(): void {
    const key = `t${++this.nextKey}`;
    const { cwd, log, context } = this.shared;
    const ctl = new Controller({
      cwd,
      log,
      render: (s) => this.render(key, s),
      prefs: this.shared.prefs,
      savePrefs: this.shared.savePrefs,
      showError: (m) => void vscode.window.showErrorMessage(`Coddy: ${m}`),
      takeContext: () => context.take(),
    });
    this.tabs.set(key, ctl);
    this.active = key;
    ctl.setChips(context.chips());
    ctl.setServer(this.shared.serverStatus());
    const conn = this.shared.connection();
    if (conn) ctl.connect(conn);
    this.render(key, ctl.state);
  }

  route(m: FromWebview): void {
    void this.handle(m).catch((e: unknown) => {
      this.shared.log(`error: ${String(e)}`);
      void vscode.window.showErrorMessage(`Coddy: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private render(key: string, s: ChatState): void {
    // Open the proposed diff as soon as an edit asks for permission, whichever tab it is in.
    for (const p of s.session.permissions) {
      if (this.reviewed.has(p.id)) continue;
      this.reviewed.add(p.id);
      const f = p.files[0];
      if (f) void this.shared.diffs.showProposed(p.id, f.file, f.patch, f.status);
    }
    const active = key === this.active ? s : this.tabs.get(this.active)?.state;
    if (!active) return;
    const tabs = [...this.tabs].map(([k, c]) => ({
      key: k,
      title: c.state.session.title ?? 'New session',
      busy: c.state.session.busy || c.state.session.permissions.length > 0 || c.state.session.forms.length > 0,
    }));
    this.view.post({ type: 'state', state: { ...active, tabs, activeTab: this.active } });
  }

  private renderActive(): void {
    this.activeController().render(true);
  }

  private async handle(m: FromWebview): Promise<void> {
    const ctl = this.activeController();
    const { context, diffs, cwd } = this.shared;
    switch (m.type) {
      case 'newTab': return this.newTab();
      case 'selectTab':
        if (this.tabs.has(m.key)) this.active = m.key;
        return this.renderActive();
      case 'closeTab': {
        this.tabs.delete(m.key);
        if (!this.tabs.size) return this.newTab();
        if (this.active === m.key) this.active = [...this.tabs.keys()].at(-1)!;
        return this.renderActive();
      }
      case 'removeChip': return context.remove(m.id);
      case 'attachDiagnostics': return this.shared.attachDiagnostics();
      case 'menu': return this.view.post({ type: 'menu', kind: m.kind, items: await ctl.menu(m.kind) });
      case 'pick': return ctl.pick(m.kind, m.key);
      case 'mention': {
        const file = await pickWorkspaceFile();
        return this.view.post(file ? { type: 'insert', text: `@${file} ` } : { type: 'focus' });
      }
      case 'openFile': {
        await vscode.window.showTextDocument(vscode.Uri.file(isAbsolute(m.file) ? m.file : join(cwd, m.file)), { preview: true });
        return;
      }
      case 'openPermissionDiff': {
        const f = ctl.state.session.permissions.find((p) => p.id === m.id)?.files.find((x) => x.file === m.file);
        return f && diffs.showProposed(m.id, f.file, f.patch, f.status);
      }
      case 'openChangedDiff': {
        const d = (await ctl.sessionDiff()).find((x) => x.file === m.file || m.file.endsWith(x.file));
        if (!d) return void vscode.window.showInformationMessage(`Coddy: no recorded changes for ${m.file}`);
        return diffs.showApplied(d.file, d.patch, d.status);
      }
      case 'permission':
        await ctl.handle(m);
        return diffs.close(m.id);
      default: return ctl.handle(m);
    }
  }
}
