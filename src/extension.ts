import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { ContextTracker, pickWorkspaceFile } from './context';
import { Controller } from './controller';
import { DiffViewer } from './diff';
import { ChatPanel } from './panel';
import { pickAgent, pickModel, pickSession } from './pickers';
import { BinaryNotFoundError, binaryVersion, ServerManager } from './server';
import type { FromWebview, ServerStatus } from './shared/protocol';

let server: ServerManager | undefined;
let controller: Controller | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('OpenPane', { log: true });
  const log = (m: string) => out.info(m);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'openpane.chat.focus';
  status.show();

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const panel = new ChatPanel(ctx.extensionUri, (m) => void route(m).catch((e: unknown) => {
    log(`error: ${String(e)}`);
    void vscode.window.showErrorMessage(`OpenPane: ${e instanceof Error ? e.message : String(e)}`);
  }));
  const diffs = new DiffViewer(cwd ?? process.cwd());
  const reviewed = new Set<string>();
  const ctl = new Controller({
    cwd: cwd ?? process.cwd(),
    log,
    render: (s) => {
      panel.post({ type: 'state', state: s });
      // Open the proposed diff as soon as an edit asks for permission.
      for (const p of s.session.permissions) {
        if (reviewed.has(p.id)) continue;
        reviewed.add(p.id);
        const f = p.files[0];
        if (f) void diffs.showProposed(p.id, f.file, f.patch, f.status);
      }
    },
    onStatus: (s) => showStatus(status, s),
    showError: (m) => void vscode.window.showErrorMessage(`OpenPane: ${m}`),
    takeContext: () => context.take(),
  });
  controller = ctl;
  const context = new ContextTracker((chips) => ctl.setChips(chips));
  ctl.setChips(context.chips());

  function attachDiagnostics(): void {
    if (!context.pinDiagnostics()) void vscode.window.showInformationMessage('OpenPane: open a file to attach its problems.');
  }

  /** Editor-side intents are handled here; session/API intents go to the controller. */
  async function route(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'removeChip': return context.remove(m.id);
      case 'attachDiagnostics': return attachDiagnostics();
      case 'pickModel': return pickModel(ctl);
      case 'pickAgent': return pickAgent(ctl);
      case 'pickSession': return pickSession(ctl);
      case 'mention': {
        const file = await pickWorkspaceFile();
        return panel.post(file ? { type: 'insert', text: `@${file} ` } : { type: 'focus' });
      }
      case 'openFile': {
        const uri = vscode.Uri.file(isAbsolute(m.file) ? m.file : join(cwd ?? '', m.file));
        return void vscode.window.showTextDocument(uri, { preview: true }).then(undefined, (e: unknown) => log(`open failed: ${String(e)}`));
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

  const start = async () => {
    server?.stop();
    ctl.disconnect();
    ctl.setServer({ kind: 'starting' });
    if (!cwd) return ctl.setServer({ kind: 'error', message: 'Open a folder to use OpenPane.' });
    const cfg = vscode.workspace.getConfiguration('openpane');
    const binaryPath = cfg.get<string>('binaryPath', 'opencode');
    const serverUrl = cfg.get<string>('serverUrl', '');
    server = new ServerManager({
      binaryPath,
      serverUrl,
      cwd,
      log,
      onExit: (m) => ctl.setServer({ kind: 'error', message: m }),
    });
    try {
      ctl.connect(await server.start());
      if (!serverUrl) void checkVersion(binaryPath, log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`server start failed: ${message}`);
      ctl.setServer({ kind: 'error', message });
      const action = e instanceof BinaryNotFoundError ? 'Open Settings' : 'Show Log';
      const pick = await vscode.window.showErrorMessage(`OpenPane: ${message}`, action, 'Retry');
      if (pick === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'openpane.binaryPath');
      if (pick === 'Show Log') out.show();
      if (pick === 'Retry') void start();
    }
  };

  ctx.subscriptions.push(
    out,
    status,
    vscode.window.registerWebviewViewProvider('openpane.chat', panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('openpane.restartServer', start),
    vscode.commands.registerCommand('openpane.newSession', () => ctl.newSession()),
    vscode.commands.registerCommand('openpane.attachDiagnostics', async () => {
      attachDiagnostics();
      await panel.reveal();
    }),
    vscode.commands.registerCommand('openpane.askAboutSelection', async () => {
      if (!context.pinSelection()) return void vscode.window.showInformationMessage('OpenPane: select some code first.');
      await panel.reveal();
      panel.post({ type: 'focus' });
    }),
    context,
    diffs,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('openpane') && void start()),
    { dispose: () => { ctl.disconnect(); server?.stop(); } },
  );
  void start();
}

export function deactivate(): void {
  controller?.disconnect();
  server?.stop();
}

function showStatus(item: vscode.StatusBarItem, s: ServerStatus): void {
  const map: Record<ServerStatus['kind'], [string, string]> = {
    starting: ['$(loading~spin) OpenPane', 'Starting opencode server'],
    connected: ['$(check) OpenPane', 'Connected to opencode'],
    reconnecting: ['$(sync~spin) OpenPane', 'Reconnecting to opencode event stream'],
    error: ['$(error) OpenPane', 'opencode server error'],
  };
  const [text, tip] = map[s.kind];
  item.text = text;
  item.tooltip = s.kind === 'error' ? `${tip}: ${s.message}` : s.kind === 'reconnecting' ? `${tip} (attempt ${s.attempt})` : tip;
  item.backgroundColor = s.kind === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
}

/** Non-blocking warning when the running binary differs from the version the API types were generated for. */
declare const __SPEC_VERSION__: string;

async function checkVersion(binaryPath: string, log: (m: string) => void): Promise<void> {
  try {
    const expected = __SPEC_VERSION__;
    const actual = await binaryVersion(binaryPath);
    log(`opencode v${actual} (types generated for v${expected})`);
    if (actual !== expected) {
      void vscode.window.showWarningMessage(`OpenPane: types generated for opencode v${expected}, running v${actual}. Some features may not work.`);
    }
  } catch (e) {
    log(`version check skipped: ${String(e)}`);
  }
}
