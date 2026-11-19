// Sidebar webview host: strict CSP with a nonce, local bundle only, typed messages.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { FromWebview, ToWebview, ViewState } from './shared/protocol';

export class ChatPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (msg: FromWebview) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const nonce = randomBytes(16).toString('base64');
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${view.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${view.webview.cspSource}`,
      `img-src ${view.webview.cspSource} data:`,
    ].join('; ');
    view.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}"></head>
<body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
  }

  render(state: ViewState): void {
    const msg: ToWebview = { type: 'state', state };
    void this.view?.webview.postMessage(msg);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('openpane.chat.focus');
  }
}
