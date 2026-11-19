// Extension-host state owner: API client, event stream, session state and webview intents.
import createClient, { type Client } from 'openapi-fetch';
import type { components, paths } from './generated/api';
import { fromHistory, type HistoryMessage, isRecord, reduce, type ServerEvent } from './reducer';
import { type Connection } from './server';
import { EventStream } from './sse';
import { emptySession, type FromWebview, type PermissionDecision, type ServerStatus, type ViewState } from './shared/protocol';

type Api = Client<paths>;
type ModelRef = components['schemas']['Model.Ref'];
export type ModelInfo = components['schemas']['Model.Info'];
export type AgentInfo = components['schemas']['Agent.Info'];
export type SessionInfo = components['schemas']['Session.Info'];

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
  /** Context block for the next prompt (consumes pinned chips). */
  takeContext: () => string;
}

export class Controller {
  state: ViewState = { server: { kind: 'starting' }, session: emptySession(), chips: [] };
  private api?: Api;
  private stream?: EventStream;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private localId = 0;
  private model?: ModelRef;
  private agent?: string;

  constructor(private readonly host: ControllerHost) {}

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
        if (reconnected && this.state.session.id) void this.resume(this.state.session.id).catch((e: unknown) => this.fail(e));
      },
      onRetry: (attempt) => this.setServer({ kind: 'reconnecting', attempt }),
    });
    this.stream.start();
    void this.loadDefaultModel().catch((e: unknown) => this.host.log(`default model lookup failed: ${String(e)}`));
  }

  private get location() {
    return { directory: this.host.cwd };
  }

  private async loadDefaultModel(): Promise<void> {
    const res = await this.requireApi().GET('/api/model/default', { params: { query: { location: this.location } } });
    const m = res.data?.data;
    if (m && !this.model) this.setLabels(m.name, this.state.agent);
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.requireApi().GET('/api/model', { params: { query: { location: this.location } } });
    if (!res.data) throw new Error(`could not list models: ${errorText(res.error)}`);
    return res.data.data.filter((m) => m.enabled);
  }

  async listAgents(): Promise<AgentInfo[]> {
    const res = await this.requireApi().GET('/api/agent', { params: { query: { location: this.location } } });
    if (!res.data) throw new Error(`could not list agents: ${errorText(res.error)}`);
    return res.data.data.filter((a) => a.mode !== 'subagent' && !a.hidden);
  }

  /** Top-level sessions for this workspace folder, newest first. */
  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.requireApi().GET('/api/session', {
      params: { query: { directory: this.host.cwd, order: 'desc', limit: '50', parentID: 'null' } },
    });
    if (!res.data) throw new Error(`could not list sessions: ${errorText(res.error)}`);
    return res.data.data.filter((s) => !s.parentID);
  }

  async setModel(model: ModelInfo): Promise<void> {
    this.model = { id: model.id, providerID: model.providerID };
    const sessionID = this.state.session.id;
    if (sessionID) {
      const res = await this.requireApi().POST('/api/session/{sessionID}/model', { params: { path: { sessionID } }, body: { model: this.model } });
      if (res.error) throw new Error(`could not switch model: ${errorText(res.error)}`);
    }
    this.setLabels(model.name, this.state.agent);
  }

  async setAgent(agent: AgentInfo): Promise<void> {
    this.agent = agent.id;
    const sessionID = this.state.session.id;
    if (sessionID) {
      const res = await this.requireApi().POST('/api/session/{sessionID}/agent', { params: { path: { sessionID } }, body: { agent: agent.id } });
      if (res.error) throw new Error(`could not switch agent: ${errorText(res.error)}`);
    }
    this.setLabels(this.state.model, agent.name);
  }

  private setLabels(model: string | undefined, agent: string | undefined): void {
    this.state = { ...this.state, model, agent };
    this.render();
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
        case 'permission': return await this.replyPermission(msg.id, msg.decision);
        default: return;
      }
    } catch (e) {
      this.fail(e);
    }
  }

  newSession(): void {
    this.state = { ...this.state, session: emptySession() };
    this.render();
  }

  async resume(id: string): Promise<void> {
    const api = this.requireApi();
    const [info, history, perms] = await Promise.all([
      api.GET('/api/session/{sessionID}', { params: { path: { sessionID: id } } }),
      api.GET('/api/session/{sessionID}/message', { params: { path: { sessionID: id }, query: { order: 'asc', limit: '500' } } }),
      api.GET('/api/session/{sessionID}/permission', { params: { path: { sessionID: id } } }),
    ]);
    if (!history.data) throw new Error(`could not load session ${id}: ${errorText(history.error)}`);
    // openapi-fetch rewrites empty-object schemas ({} vs Record<string, never>); the payload is the spec type.
    const meta = info.data?.data;
    if (meta?.model) this.model = meta.model;
    if (meta?.agent) this.agent = meta.agent;
    let session = fromHistory(id, meta?.title, history.data.data as HistoryMessage[]);
    for (const p of perms.data?.data ?? []) {
      session = reduce(session, { type: 'permission.asked', id: p.id, created: 0, data: p } as ServerEvent);
    }
    this.state = { ...this.state, session, agent: this.agent ?? this.state.agent, model: this.model ? `${this.model.providerID}/${this.model.id}` : this.state.model };
    this.render();
  }

  setChips(chips: ViewState['chips']): void {
    this.state = { ...this.state, chips };
    this.render();
  }

  private async send(text: string): Promise<void> {
    const api = this.requireApi();
    const sessionID = await this.ensureSession(api);
    const context = this.host.takeContext();
    const full = context ? `${context}\n\n${text}` : text;
    const user = { role: 'user' as const, id: `local-${++this.localId}`, text: full };
    this.patchSession({ busy: true, error: undefined, messages: [...this.state.session.messages, user] });
    const res = await api.POST('/api/session/{sessionID}/prompt', { params: { path: { sessionID } }, body: { text: full } });
    if (res.error) throw new Error(`prompt failed: ${errorText(res.error)}`);
  }

  private async replyPermission(requestID: string, decision: PermissionDecision): Promise<void> {
    const sessionID = this.state.session.id;
    if (!sessionID) return;
    const res = await this.requireApi().POST('/api/session/{sessionID}/permission/{requestID}/reply', {
      params: { path: { sessionID, requestID } },
      body: { decision },
    });
    if (res.error) throw new Error(`permission reply failed: ${errorText(res.error)}`);
    // permission.replied will also arrive on the stream; drop it now so the card disappears immediately.
    this.patchSession({ permissions: this.state.session.permissions.filter((p) => p.id !== requestID) });
  }

  /** Files changed by the agent in this session, with patches (GET /api/session/{id}/diff). */
  async sessionDiff(): Promise<components['schemas']['FileDiff.Info'][]> {
    const sessionID = this.state.session.id;
    if (!sessionID) return [];
    const res = await this.requireApi().GET('/api/session/{sessionID}/diff', { params: { path: { sessionID } } });
    if (!res.data) throw new Error(`could not load session diff: ${errorText(res.error)}`);
    return res.data.data;
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
  }

  private patchSession(patch: Partial<ViewState['session']>): void {
    this.state = { ...this.state, session: { ...this.state.session, ...patch } };
    this.render();
  }

  private requireApi(): Api {
    if (!this.api) throw new Error('not connected to the opencode server');
    return this.api;
  }

  private fail(e: unknown): void {
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
