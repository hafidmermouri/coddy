import * as vscode from 'vscode';
import { Controller } from './controller';
import { ChatPanel } from './panel';
import { BinaryNotFoundError, binaryVersion, ServerManager } from './server';
import type { ServerStatus } from './shared/protocol';

let server: ServerManager | undefined;
let controller: Controller | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('OpenPane', { log: true });
  const log = (m: string) => out.info(m);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'openpane.chat.focus';
  status.show();

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const panel = new ChatPanel(ctx.extensionUri, (m) => void controller?.handle(m));
  const ctl = new Controller({
    cwd: cwd ?? process.cwd(),
    log,
    render: (s) => panel.render(s),
    onStatus: (s) => showStatus(status, s),
    showError: (m) => void vscode.window.showErrorMessage(`OpenPane: ${m}`),
  });
  controller = ctl;

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
