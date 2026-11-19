// One chat surface (sidebar or editor tab): a Controller with its own session, plus the
// routing of editor-side intents (diffs, files, pickers, context) for that surface.
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { type ContextTracker, pickWorkspaceFile } from './context';
import { Controller } from './controller';
import type { DiffViewer } from './diff';
import type { ChatWebview } from './panel';
import { pickAgent, pickModel, pickSession } from './pickers';
import type { FromWebview, ViewState } from './shared/protocol';

export interface Shared {
  cwd: string;
  log: (m: string) => void;
  context: ContextTracker;
  diffs: DiffViewer;
  /** Permission ids whose diff was already opened (shared so two surfaces never open it twice). */
  reviewed: Set<string>;
  attachDiagnostics: () => void;
  newTab: () => void;
}

export interface Surface {
  ctl: Controller;
  route: (m: FromWebview) => void;
}

export function createSurface(shared: Shared, view: ChatWebview, onRender?: (s: ViewState) => void): Surface {
  const { cwd, log, context, diffs, reviewed } = shared;
  const ctl = new Controller({
    cwd,
    log,
    render: (s) => {
      view.post({ type: 'state', state: s });
      onRender?.(s);
      // Open the proposed diff as soon as an edit asks for permission.
      for (const p of s.session.permissions) {
        if (reviewed.has(p.id)) continue;
        reviewed.add(p.id);
        const f = p.files[0];
        if (f) void diffs.showProposed(p.id, f.file, f.patch, f.status);
      }
    },
    showError: (m) => void vscode.window.showErrorMessage(`OpenPane: ${m}`),
    takeContext: () => context.take(),
  });
  ctl.setChips(context.chips());

  async function handle(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'removeChip': return context.remove(m.id);
      case 'attachDiagnostics': return shared.attachDiagnostics();
      case 'newTab': return shared.newTab();
      case 'pickModel': return pickModel(ctl);
      case 'pickAgent': return pickAgent(ctl);
      case 'pickSession': return pickSession(ctl);
      case 'mention': {
        const file = await pickWorkspaceFile();
        return view.post(file ? { type: 'insert', text: `@${file} ` } : { type: 'focus' });
      }
      case 'openFile': {
        const uri = vscode.Uri.file(isAbsolute(m.file) ? m.file : join(cwd, m.file));
        await vscode.window.showTextDocument(uri, { preview: true });
        return;
      }
      case 'openPermissionDiff': {
        const f = ctl.state.session.permissions.find((p) => p.id === m.id)?.files.find((x) => x.file === m.file);
        return f && diffs.showProposed(m.id, f.file, f.patch, f.status);
      }
      case 'openChangedDiff': {
        const d = (await ctl.sessionDiff()).find((x) => x.file === m.file || m.file.endsWith(x.file));
        if (!d) return void vscode.window.showInformationMessage(`OpenPane: no recorded changes for ${m.file}`);
        return diffs.showApplied(d.file, d.patch, d.status);
      }
      case 'permission':
        await ctl.handle(m);
        return diffs.close(m.id);
      default: return ctl.handle(m);
    }
  }

  return {
    ctl,
    route: (m) => void handle(m).catch((e: unknown) => {
      log(`error: ${String(e)}`);
      void vscode.window.showErrorMessage(`OpenPane: ${e instanceof Error ? e.message : String(e)}`);
    }),
  };
}
