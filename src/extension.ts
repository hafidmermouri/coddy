import * as vscode from 'vscode';
import { ContextTracker } from './context';
import { DiffViewer } from './diff';
import { openTab, SidebarView } from './panel';
import { BinaryNotFoundError, binaryVersion, type Connection, ServerManager } from './server';
import type { ServerStatus } from './shared/protocol';
import { EventStream } from './sse';
import { createSurface, type Shared, type Surface } from './surface';

let server: ServerManager | undefined;
let stream: EventStream | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('OpenPane', { log: true });
  const log = (m: string) => out.info(m);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'openpane.chat.focus';
  status.show();

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const hasFolder = !!vscode.workspace.workspaceFolders?.length;
  const surfaces = new Set<Surface>();
  let conn: Connection | undefined;
  let serverStatus: ServerStatus = { kind: 'starting' };

  const setStatus = (s: ServerStatus) => {
    serverStatus = s;
    showStatus(status, s);
    surfaces.forEach((x) => x.ctl.setServer(s));
  };

  /** Registers a surface: it shares the server, the event stream and the editor context. */
  const add = (surface: Surface): Surface => {
    surfaces.add(surface);
    surface.ctl.setServer(serverStatus);
    if (conn) surface.ctl.connect(conn);
    return surface;
  };

  const context = new ContextTracker((chips) => surfaces.forEach((x) => x.ctl.setChips(chips)));
  const shared: Shared = {
    cwd,
    log,
    context,
    diffs: new DiffViewer(cwd),
    reviewed: new Set(),
    attachDiagnostics: () => {
      if (!context.pinDiagnostics()) void vscode.window.showInformationMessage('OpenPane: open a file to attach its problems.');
    },
    newTab: () => {
      let surface: Surface | undefined;
      const panel = openTab(ctx.extensionUri, (m) => surface?.route(m));
      surface = add(createSurface(shared, { post: (m) => void panel.webview.postMessage(m) }, (s) => {
        panel.title = s.session.title ?? 'OpenPane';
      }));
      panel.onDidDispose(() => surfaces.delete(surface!));
    },
  };

  let sidebar!: Surface;
  const sidebarView = new SidebarView(ctx.extensionUri, (m) => sidebar.route(m));
  sidebar = add(createSurface(shared, sidebarView));

  const start = async () => {
    server?.stop();
    stream?.stop();
    conn = undefined;
    surfaces.forEach((x) => x.ctl.disconnect());
    setStatus({ kind: 'starting' });
    if (!hasFolder) return setStatus({ kind: 'error', message: 'Open a folder to use OpenPane.' });
    const cfg = vscode.workspace.getConfiguration('openpane');
    const binaryPath = cfg.get<string>('binaryPath', 'opencode');
    const serverUrl = cfg.get<string>('serverUrl', '');
    server = new ServerManager({ binaryPath, serverUrl, cwd, log, onExit: (message) => setStatus({ kind: 'error', message }) });
    try {
      const c = await server.start();
      conn = c;
      surfaces.forEach((x) => x.ctl.connect(c));
      // One event stream for all surfaces; each controller ignores other sessions' events.
      stream = new EventStream({
        url: `${c.baseUrl}/api/event`,
        headers: c.headers,
        log,
        onEvent: (e) => surfaces.forEach((x) => x.ctl.onEvent(e)),
        onOpen: (reconnected) => {
          setStatus({ kind: 'connected' });
          if (reconnected) surfaces.forEach((x) => x.ctl.resync());
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
    shared.diffs,
    vscode.window.registerWebviewViewProvider('openpane.chat', sidebarView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('openpane.restartServer', start),
    vscode.commands.registerCommand('openpane.open', () => sidebarView.reveal()),
    vscode.commands.registerCommand('openpane.newTab', shared.newTab),
    vscode.commands.registerCommand('openpane.newSession', () => sidebar.ctl.newSession()),
    vscode.commands.registerCommand('openpane.attachDiagnostics', async () => {
      shared.attachDiagnostics();
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
