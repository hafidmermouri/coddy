import * as vscode from 'vscode';
import { ContextTracker } from './context';
import type { Prefs } from './controller';
import { DiffViewer } from './diff';
import { SidebarView } from './panel';
import { BinaryNotFoundError, binaryVersion, type Connection, ServerManager } from './server';
import type { ServerStatus } from './shared/protocol';
import { EventStream } from './sse';
import { Surface } from './surface';

let server: ServerManager | undefined;
let stream: EventStream | undefined;

const PREFS_KEY = 'openpane.prefs';

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('OpenPane', { log: true });
  const log = (m: string) => out.info(m);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'openpane.chat.focus';
  status.show();

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const hasFolder = !!vscode.workspace.workspaceFolders?.length;
  let conn: Connection | undefined;
  let serverStatus: ServerStatus = { kind: 'starting' };

  const context = new ContextTracker((chips) => panel.controllers().forEach((c) => c.setChips(chips)));
  const diffs = new DiffViewer(cwd);
  const attachDiagnostics = () => {
    if (!context.pinDiagnostics()) void vscode.window.showInformationMessage('OpenPane: open a file to attach its problems.');
  };
  const sidebarView = new SidebarView(ctx.extensionUri, (m) => panel.route(m));
  const panel: Surface = new Surface({
    cwd,
    log,
    context,
    diffs,
    attachDiagnostics,
    // Model, effort and agent choices are remembered across windows and restarts.
    prefs: () => ctx.globalState.get<Prefs>(PREFS_KEY, {}),
    savePrefs: (p) => void ctx.globalState.update(PREFS_KEY, p),
    connection: () => conn,
    serverStatus: () => serverStatus,
  }, sidebarView);

  const setStatus = (s: ServerStatus) => {
    serverStatus = s;
    showStatus(status, s);
    panel.controllers().forEach((c) => c.setServer(s));
  };

  const start = async () => {
    server?.stop();
    stream?.stop();
    conn = undefined;
    panel.controllers().forEach((c) => c.disconnect());
    setStatus({ kind: 'starting' });
    if (!hasFolder) return setStatus({ kind: 'error', message: 'Open a folder to use OpenPane.' });
    const cfg = vscode.workspace.getConfiguration('openpane');
    const binaryPath = cfg.get<string>('binaryPath', 'opencode');
    const serverUrl = cfg.get<string>('serverUrl', '');
    server = new ServerManager({ binaryPath, serverUrl, cwd, log, onExit: (message) => setStatus({ kind: 'error', message }) });
    try {
      const c = await server.start();
      conn = c;
      panel.controllers().forEach((x) => x.connect(c));
      // One event stream for all surfaces; each controller ignores other sessions' events.
      stream = new EventStream({
        url: `${c.baseUrl}/api/event`,
        headers: c.headers,
        log,
        onEvent: (e) => panel.controllers().forEach((x) => x.onEvent(e)),
        onOpen: (reconnected) => {
          setStatus({ kind: 'connected' });
          if (reconnected) panel.controllers().forEach((x) => x.resync());
        },
        onRetry: (attempt) => setStatus({ kind: 'reconnecting', attempt }),
      });
      stream.start();
      if (!serverUrl) void checkVersion(binaryPath, log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`server start failed: ${message}`);
      setStatus({ kind: 'error', message });
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
    context,
    diffs,
    vscode.window.registerWebviewViewProvider('openpane.chat', sidebarView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('openpane.restartServer', start),
    vscode.commands.registerCommand('openpane.open', () => sidebarView.reveal()),
    vscode.commands.registerCommand('openpane.newTab', async () => {
      panel.newTab();
      await sidebarView.reveal();
    }),
    vscode.commands.registerCommand('openpane.newSession', () => panel.activeController().newSession()),
    vscode.commands.registerCommand('openpane.attachDiagnostics', async () => {
      attachDiagnostics();
      await sidebarView.reveal();
    }),
    vscode.commands.registerCommand('openpane.askAboutSelection', async () => {
      if (!context.pinSelection()) return void vscode.window.showInformationMessage('OpenPane: select some code first.');
      await sidebarView.reveal();
      sidebarView.post({ type: 'focus' });
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('openpane') && void start()),
    { dispose: deactivate },
  );
  void start();
}

export function deactivate(): void {
  stream?.stop();
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
