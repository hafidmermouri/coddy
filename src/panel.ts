// Webview hosting for chat surfaces (sidebar view and editor tabs):
// strict CSP with a nonce, local bundle only, typed messages.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { FromWebview, ToWebview } from './shared/protocol';

export interface ChatWebview {
  post(msg: ToWebview): void;
}

export function setupWebview(webview: vscode.Webview, extensionUri: vscode.Uri, onMessage: (m: FromWebview) => void): vscode.Disposable {
  const dist = vscode.Uri.joinPath(extensionUri, 'dist');
  webview.options = { enableScripts: true, localResourceRoots: [dist] };
  const nonce = randomBytes(16).toString('base64');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');
  webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}"></head>
<body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  return webview.onDidReceiveMessage((m: FromWebview) => onMessage(m));
}

/** The sidebar view. VS Code creates its webview lazily, so messages before that are dropped. */
export class SidebarView implements vscode.WebviewViewProvider, ChatWebview {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (msg: FromWebview) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.onDidDispose(() => (this.view = undefined));
    setupWebview(view.webview, this.extensionUri, this.onMessage);
  }

  post(msg: ToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('openpane.chat.focus');
  }
}
