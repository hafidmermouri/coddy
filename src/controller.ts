// Extension-host state owner for one chat surface: API client, session state and webview intents.
// Events arrive from the shared stream in extension.ts via onEvent().
import createClient, { type Client } from 'openapi-fetch';
import type { components, paths } from './generated/api';
import { fromHistory, type HistoryMessage, isRecord, reduce, type ServerEvent, toPermission, totals } from './reducer';
import { type Connection } from './server';
import { emptySession, type FromWebview, type ImageAttachment, type PermissionDecision, type ServerStatus, type ViewState } from './shared/protocol';

type Api = Client<paths>;
type ModelRef = components['schemas']['Model.Ref'];
export type ModelInfo = components['schemas']['Model.Info'];
export type AgentInfo = components['schemas']['Agent.Info'];
export type SessionInfo = components['schemas']['Session.Info'];

/** OpenPane sessions always ask before editing, so every edit goes through the diff review. */
const SESSION_PERMISSIONS: components['schemas']['Permission.Ruleset'] = [
  { action: 'edit', resource: '*', effect: 'ask' },
];

/** Model (with variant, i.e. effort) and agent choices, remembered across sessions and restarts. */
export interface Prefs {
  model?: ModelRef & { name: string };
  agent?: { id: string; name: string };
}

/** What one controller owns; the surface adds the tab list. */
export type ChatState = Omit<ViewState, 'tabs' | 'activeTab'>;

export interface ControllerHost {
  cwd: string;
  log: (msg: string) => void;
  render: (state: ChatState) => void;
  prefs: () => Prefs;
  savePrefs: (prefs: Prefs) => void;
  showError: (msg: string) => void;
  /** Context block for the next prompt (consumes pinned chips). */
  takeContext: () => string;
}

export class Controller {
  state: ChatState = { server: { kind: 'starting' }, session: emptySession(), chips: [] };
  private api?: Api;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private localId = 0;
  /** This tab's model and agent; start from the saved prefs, a resumed session may override them. */
  private model?: Prefs['model'];
  private agent?: Prefs['agent'];
  private defaultModel?: ModelInfo;

  constructor(private readonly host: ControllerHost) {
    ({ model: this.model, agent: this.agent } = host.prefs());
    this.updateLabels();
  }

  connect(conn: Connection): void {
    this.api = createClient<paths>({ baseUrl: conn.baseUrl, headers: conn.headers });
    void this.loadDefaultModel().catch((e: unknown) => this.host.log(`default model lookup failed: ${String(e)}`));
  }

  private get location() {
    return { directory: this.host.cwd };
  }

  private async loadDefaultModel(): Promise<void> {
    const res = await this.requireApi().GET('/api/model/default', { params: { query: { location: this.location } } });
    this.defaultModel = res.data?.data ?? undefined;
    this.updateLabels();
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

  /** The model this tab uses: its own choice, else the server default. */
  async currentModel(): Promise<ModelInfo | undefined> {
    if (!this.model) return this.defaultModel;
    const { id, providerID } = this.model;
    return (await this.listModels()).find((m) => m.id === id && m.providerID === providerID);
  }

  async setModel(model: ModelInfo): Promise<void> {
    // Keep the chosen effort if the new model supports it.
    const variant = model.variants.some((v) => v.id === this.model?.variant) ? this.model?.variant : undefined;
    await this.applyModel({ id: model.id, providerID: model.providerID, variant, name: model.name });
  }

  async setVariant(variant: string | undefined): Promise<void> {
    const base = this.model ?? (this.defaultModel && { id: this.defaultModel.id, providerID: this.defaultModel.providerID, name: this.defaultModel.name });
    if (!base) throw new Error('no model to set the effort on');
    await this.applyModel({ ...base, variant });
  }

  private async applyModel(model: NonNullable<Prefs['model']>): Promise<void> {
    const sessionID = this.state.session.id;
    if (sessionID) {
      const { name: _name, ...ref } = model;
      const res = await this.requireApi().POST('/api/session/{sessionID}/model', { params: { path: { sessionID } }, body: { model: ref } });
      if (res.error) throw new Error(`could not switch model: ${errorText(res.error)}`);
    }
    this.model = model;
    this.host.savePrefs({ ...this.host.prefs(), model });
    this.updateLabels();
  }

  async setAgent(agent: AgentInfo): Promise<void> {
    const sessionID = this.state.session.id;
    if (sessionID) {
      const res = await this.requireApi().POST('/api/session/{sessionID}/agent', { params: { path: { sessionID } }, body: { agent: agent.id } });
      if (res.error) throw new Error(`could not switch agent: ${errorText(res.error)}`);
    }
    this.agent = { id: agent.id, name: agent.name };
    this.host.savePrefs({ ...this.host.prefs(), agent: this.agent });
    this.updateLabels();
  }

  private updateLabels(): void {
    this.state = {
      ...this.state,
      model: this.model?.name ?? this.defaultModel?.name,
      variant: this.model?.variant,
      agent: this.agent?.name,
    };
    this.render();
  }

  disconnect(): void {
    this.api = undefined;
  }

  setServer(server: ServerStatus): void {
    this.state = { ...this.state, server };
    this.render();
  }

  /** Fallback path after the shared stream reconnects: events may have been missed, so refetch. */
  resync(): void {
    if (this.state.session.id) void this.resume(this.state.session.id).catch((e: unknown) => this.fail(e));
  }

  async handle(msg: FromWebview): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': return this.render(true);
        case 'send': return await this.send(msg.text, msg.images);
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
    ({ model: this.model, agent: this.agent } = this.host.prefs());
    this.state = { ...this.state, session: emptySession() };
    this.updateLabels();
  }

  async resume(id: string): Promise<void> {
    const api = this.requireApi();
    const [info, history, perms] = await Promise.all([
      api.GET('/api/session/{sessionID}', { params: { path: { sessionID: id } } }),
      api.GET('/api/session/{sessionID}/message', { params: { path: { sessionID: id }, query: { order: 'desc', limit: '200' } } }),
      api.GET('/api/session/{sessionID}/permission', { params: { path: { sessionID: id } } }),
    ]);
    if (!history.data) throw new Error(`could not load session ${id}: ${errorText(history.error)}`);
    // openapi-fetch rewrites empty-object schemas ({} vs Record<string, never>); the payload is the spec type.
    const meta = info.data?.data;
    if (meta?.model) this.model = { ...meta.model, name: `${meta.model.providerID}/${meta.model.id}` };
    if (meta?.agent) this.agent = { id: meta.agent, name: meta.agent };
    // The API caps a page at 200 messages: load the newest page and show it oldest-first.
    const base = fromHistory(id, meta?.title, (history.data.data as HistoryMessage[]).slice().reverse());
    const session = {
      ...base,
      permissions: (perms.data?.data ?? []).map(toPermission),
      // Session totals from the server also cover messages beyond the 200 loaded.
      usage: meta ? { ...base.usage, ...totals(meta.tokens, meta.cost) } : base.usage,
    };
    this.state = { ...this.state, session };
    this.updateLabels();
  }

  setChips(chips: ChatState['chips']): void {
    this.state = { ...this.state, chips };
    this.render();
  }

  private async send(text: string, images: ImageAttachment[]): Promise<void> {
    const api = this.requireApi();
    const sessionID = await this.ensureSession(api);
    const context = this.host.takeContext();
    const full = context ? `${context}\n\n${text}` : text;
    const user = { role: 'user' as const, id: `local-${++this.localId}`, text: full, images: images.map((i) => i.name) };
    this.patchSession({ busy: true, error: undefined, messages: [...this.state.session.messages, user] });
    // Pasted images go inline as data: URIs (verified against opencode 2.3.0).
    const files = images.map((i) => ({ uri: i.dataUrl, name: i.name, source: { type: 'inline' as const } }));
    const res = await api.POST('/api/session/{sessionID}/prompt', { params: { path: { sessionID } }, body: { text: full, files } });
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
      body: {
        location: { directory: this.host.cwd },
        permissions: SESSION_PERMISSIONS,
        agent: this.agent?.id,
        model: this.model && { id: this.model.id, providerID: this.model.providerID, variant: this.model.variant },
      },
    });
    if (!res.data) throw new Error(`could not create session: ${errorText(res.error)}`);
    this.patchSession({ id: res.data.data.id, title: res.data.data.title });
    return res.data.data.id;
  }

  onEvent(payload: unknown): void {
    if (!isRecord(payload) || typeof payload.type !== 'string') return;
    const next = reduce(this.state.session, payload as ServerEvent);
    if (next !== this.state.session) {
      this.state = { ...this.state, session: next };
      this.render();
    }
  }

  private patchSession(patch: Partial<ChatState['session']>): void {
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
