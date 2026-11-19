// Extension-host state owner: API client, event stream, session state and webview intents.
import createClient, { type Client } from 'openapi-fetch';
import type { components, paths } from './generated/api';
import { fromHistory, type HistoryMessage, isRecord, reduce, type ServerEvent } from './reducer';
import { type Connection } from './server';
import { EventStream } from './sse';
import { emptySession, type FromWebview, type ServerStatus, type ViewState } from './shared/protocol';

type Api = Client<paths>;
type ModelRef = components['schemas']['Model.Ref'];

/** OpenPane sessions always ask before editing, so every edit goes through the diff review. */
const SESSION_PERMISSIONS: components['schemas']['Permission.Ruleset'] = [
  { action: 'edit', resource: '*', effect: 'ask' },
];

export interface ControllerHost {
  cwd: string;
  log: (msg: string) => void;
  render: (state: ViewState) => void;
  onStatus: (status: ServerStatus) => void;
  showError: (msg: string) => void;
}

export class Controller {
  state: ViewState = { server: { kind: 'starting' }, session: emptySession(), chips: [] };
  private api?: Api;
  private stream?: EventStream;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private localId = 0;
  protected model?: ModelRef;
  protected agent?: string;

  constructor(protected readonly host: ControllerHost) {}

  connect(conn: Connection): void {
    this.api = createClient<paths>({ baseUrl: conn.baseUrl, headers: conn.headers });
    this.stream?.stop();
    this.stream = new EventStream({
      url: `${conn.baseUrl}/api/event`,
      headers: conn.headers,
      log: this.host.log,
      onEvent: (e) => this.onEvent(e),
      onOpen: (reconnected) => {
        this.setServer({ kind: 'connected' });
        // Fallback path: events may have been missed while disconnected, so refetch the session.
        if (reconnected && this.state.session.id) void this.resume(this.state.session.id, this.state.session.title);
      },
      onRetry: (attempt) => this.setServer({ kind: 'reconnecting', attempt }),
    });
    this.stream.start();
  }

  disconnect(): void {
    this.stream?.stop();
    this.stream = undefined;
    this.api = undefined;
  }

  setServer(server: ServerStatus): void {
    this.state = { ...this.state, server };
    this.host.onStatus(server);
    this.render();
  }

  async handle(msg: FromWebview): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': return this.render(true);
        case 'send': return await this.send(msg.text);
        case 'interrupt': return await this.interrupt();
        case 'newSession': return this.newSession();
        default: return this.handleMore(msg);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** Extension point for later features; keeps the core switch small. */
  protected async handleMore(_msg: FromWebview): Promise<void> {}

  newSession(): void {
    this.state = { ...this.state, session: emptySession() };
    this.render();
  }

  async resume(id: string, title?: string): Promise<void> {
    const api = this.requireApi();
    const [history, perms] = await Promise.all([
      api.GET('/api/session/{sessionID}/message', { params: { path: { sessionID: id }, query: { order: 'asc', limit: '500' } } }),
      api.GET('/api/session/{sessionID}/permission', { params: { path: { sessionID: id } } }),
    ]);
    if (!history.data) throw new Error(`could not load session ${id}: ${errorText(history.error)}`);
    // openapi-fetch rewrites empty-object schemas ({} vs Record<string, never>); the payload is the spec type.
    let session = fromHistory(id, title, history.data.data as HistoryMessage[]);
    for (const p of perms.data?.data ?? []) {
      session = reduce(session, { type: 'permission.asked', id: p.id, created: 0, data: p } as ServerEvent);
    }
    this.state = { ...this.state, session };
    this.render();
  }

  protected async send(text: string, context = ''): Promise<void> {
    const api = this.requireApi();
    const sessionID = await this.ensureSession(api);
    const full = context ? `${context}\n\n${text}` : text;
    const user = { role: 'user' as const, id: `local-${++this.localId}`, text: full };
    this.patchSession({ busy: true, error: undefined, messages: [...this.state.session.messages, user] });
    const res = await api.POST('/api/session/{sessionID}/prompt', { params: { path: { sessionID } }, body: { text: full } });
    if (res.error) throw new Error(`prompt failed: ${errorText(res.error)}`);
  }

  private async interrupt(): Promise<void> {
    const sessionID = this.state.session.id;
    if (!sessionID) return;
    const res = await this.requireApi().POST('/api/session/{sessionID}/interrupt', { params: { path: { sessionID } } });
    if (res.error) throw new Error(`interrupt failed: ${errorText(res.error)}`);
  }

  private async ensureSession(api: Api): Promise<string> {
    if (this.state.session.id) return this.state.session.id;
    const res = await api.POST('/api/session', {
      body: { location: { directory: this.host.cwd }, permissions: SESSION_PERMISSIONS, agent: this.agent, model: this.model },
    });
    if (!res.data) throw new Error(`could not create session: ${errorText(res.error)}`);
    this.patchSession({ id: res.data.data.id, title: res.data.data.title });
    return res.data.data.id;
  }

  private onEvent(payload: unknown): void {
    if (!isRecord(payload) || typeof payload.type !== 'string') return;
    const next = reduce(this.state.session, payload as ServerEvent);
    if (next !== this.state.session) {
      this.state = { ...this.state, session: next };
      this.render();
    }
    this.afterEvent(payload as ServerEvent);
  }

  /** Hook for side effects on events (e.g. opening a diff when a permission arrives). */
  protected afterEvent(_ev: ServerEvent): void {}

  protected patchSession(patch: Partial<ViewState['session']>): void {
    this.state = { ...this.state, session: { ...this.state.session, ...patch } };
    this.render();
  }

  protected requireApi(): Api {
    if (!this.api) throw new Error('not connected to the opencode server');
    return this.api;
  }

  protected fail(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.host.log(`error: ${msg}`);
    this.patchSession({ busy: false, error: msg });
    this.host.showError(msg);
  }

  /** Coalesces renders: streaming deltas arrive much faster than the UI needs. */
  render(now = false): void {
    if (now) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.host.render(this.state);
      return;
    }
    this.renderTimer ??= setTimeout(() => {
      this.renderTimer = undefined;
      this.host.render(this.state);
    }, 30);
  }
}

export function errorText(err: unknown): string {
  if (isRecord(err)) {
    const m = err.message ?? (isRecord(err.data) ? err.data.message : undefined);
    if (typeof m === 'string') return m;
  }
  return JSON.stringify(err);
}
