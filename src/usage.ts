// Usage dashboard shown from the activity bar: totals, context per session, cost over time.
import createClient from 'openapi-fetch';
import * as vscode from 'vscode';
import type { paths } from './generated/api';
import { setupWebview } from './panel';
import { fromHistory, type HistoryMessage, totals } from './reducer';
import type { Connection } from './server';
import type { UsageData, UsageFromWebview, UsageToWebview } from './shared/protocol';

/** Context size needs one message request per session, so only the newest sessions get a bar. */
const CONTEXT_SESSIONS = 30;

export class UsageView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connection: () => Connection | undefined,
    private readonly cwd: string,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.onDidDispose(() => (this.view = undefined));
    view.onDidChangeVisibility(() => view.visible && void this.refresh());
    setupWebview<UsageFromWebview>(view.webview, this.extensionUri, (m) => m.type === 'refresh' && void this.refresh(), 'usage');
  }

  private post(msg: UsageToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  async refresh(): Promise<void> {
    const conn = this.connection();
    if (!conn) return this.post({ type: 'usage', error: 'The opencode server is not connected yet.' });
    try {
      this.post({ type: 'usage', data: await this.load(conn) });
    } catch (e) {
      this.post({ type: 'usage', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async load(conn: Connection): Promise<UsageData> {
    const api = createClient<paths>({ baseUrl: conn.baseUrl, headers: conn.headers });
    const res = await api.GET('/api/session', { params: { query: { directory: this.cwd, order: 'desc', limit: '200', parentID: 'null' } } });
    if (!res.data) throw new Error('could not list sessions');
    const all = res.data.data;
    const recent = all.slice(0, CONTEXT_SESSIONS);
    const contexts = await Promise.all(
      recent.map(async (s) => {
        const h = await api.GET('/api/session/{sessionID}/message', { params: { path: { sessionID: s.id }, query: { order: 'desc', limit: '20' } } });
        return h.data ? fromHistory(s.id, s.title, (h.data.data as HistoryMessage[]).slice().reverse()).usage.context : 0;
      }),
    );
    const sum = { input: 0, cached: 0, output: 0, cost: 0, sessions: all.length };
    for (const s of all) {
      const t = totals(s.tokens, s.cost);
      sum.input += t.input;
      sum.cached += t.cached;
      sum.output += t.output;
      sum.cost += t.cost;
    }
    return {
      totals: sum,
      sessions: recent.map((s, i) => ({ id: s.id, title: s.title || s.id, context: contexts[i] ?? 0 })).filter((s) => s.context > 0).reverse(),
      costs: all.map((s) => ({ t: s.time.created, cost: s.cost })),
    };
  }
}
