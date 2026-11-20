// Extension-host state owner for one chat surface: API client, session state and webview intents.
// Events arrive from the shared stream in extension.ts via onEvent().
import createClient, { type Client } from 'openapi-fetch';
import type { components, paths } from './generated/api';
import { fromHistory, type HistoryMessage, isRecord, reduce, type ServerEvent, toPermission, totals } from './reducer';
import { type Connection } from './server';
import { effortLabel, emptySession, type FromWebview, type MenuItem, type MenuKind, type ImageAttachment, type PermissionDecision, type ServerStatus, type ViewState } from './shared/protocol';

type Api = Client<paths>;
type ModelRef = components['schemas']['Model.Ref'];
export type ModelInfo = components['schemas']['Model.Info'];
export type AgentInfo = components['schemas']['Agent.Info'];
export type SessionInfo = components['schemas']['Session.Info'];
export type SlashItem = { kind: 'command'; name: string; description?: string } | { kind: 'skill'; name: string; id: string; description?: string };

/** Coddy sessions always ask before editing, so every edit goes through the diff review. */
const SESSION_PERMISSIONS: components['schemas']['Permission.Ruleset'] = [
  { action: 'edit', resource: '*', effect: 'ask' },
];

/** Model (with variant, i.e. effort) and agent choices, remembered across sessions and restarts. */
export interface Prefs {
  model?: ModelRef & { name: string };
  agent?: { id: string; name: string };
  /** Pick counts per model/effort combo, to list the most used first. */
  usage?: Record<string, number>;
}

const usageKey = (providerID: string, id: string, variant?: string) => `${providerID}/${id}/${variant ?? ''}`;

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

  /** Slash entries: server commands and skills, both invoked as `/name`. */
  async listSlash(): Promise<SlashItem[]> {
    const api = this.requireApi();
    const query = { location: this.location };
    const [cmds, skills] = await Promise.all([api.GET('/api/command', { params: { query } }), api.GET('/api/skill', { params: { query } })]);
    return [
      ...(cmds.data?.data ?? []).map((c) => ({ kind: 'command' as const, name: c.name, description: c.description })),
      ...(skills.data?.data ?? []).map((s) => ({ kind: 'skill' as const, name: s.name, id: s.id, description: s.description })),
    ];
  }

  /** Top-level sessions for this workspace folder, newest first. */
  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.requireApi().GET('/api/session', {
      params: { query: { directory: this.host.cwd, order: 'desc', limit: '50', parentID: 'null' } },
    });
    if (!res.data) throw new Error(`could not list sessions: ${errorText(res.error)}`);
    return res.data.data.filter((s) => !s.parentID);
  }

  /** Model/effort combos, most used first; filtering and the top-10 cut happen in the webview. */
  async menu(kind: MenuKind): Promise<MenuItem[]> {
    if (kind === 'slash') {
      return (await this.listSlash()).map((s) => ({ key: s.name, label: `/${s.name}`, detail: s.description ?? s.kind, active: false }));
    }
    if (kind === 'session') {
      const sessions = await this.listSessions();
      return [
        { key: '', label: 'New session', active: false },
        ...sessions.map((s) => ({ key: s.id, label: s.title || s.id, detail: new Date(s.time.updated).toLocaleString(), active: s.id === this.state.session.id })),
      ];
    }
    if (kind === 'agent') {
      return (await this.listAgents()).map((a) => ({ key: a.id, label: a.name, detail: a.description, active: a.id === this.agent?.id || a.name === this.agent?.name }));
    }
    // Counts from picks made here, plus the models of earlier sessions so favorites show up from day one.
    const usage = { ...this.host.prefs().usage };
    for (const s of await this.listSessions().catch(() => [])) {
      if (!s.model) continue;
      const k = usageKey(s.model.providerID, s.model.id, s.model.variant ?? undefined);
      usage[k] = (usage[k] ?? 0) + 1;
    }
    const cur = this.model ?? this.defaultModel;
    const items = (await this.listModels()).flatMap((m) =>
      [undefined, ...m.variants.map((v) => v.id)].map((variant) => {
        const uses = usage[usageKey(m.providerID, m.id, variant)] ?? 0;
        return {
          uses,
          item: {
            key: JSON.stringify([m.providerID, m.id, variant ?? null, m.name]),
            label: variant ? `${m.name} - ${effortLabel(variant)}` : m.name,
            detail: m.providerID,
            active: cur?.id === m.id && cur.providerID === m.providerID && (this.model?.variant ?? undefined) === variant,
          },
        };
      }),
    );
    return items.sort((x, y) => y.uses - x.uses).map((x) => x.item);
  }

  async pick(kind: MenuKind, key: string): Promise<void> {
    if (kind === 'slash') return;
    if (kind === 'session') {
      if (key) await this.resume(key);
      else this.newSession();
      return;
    }
    if (kind === 'agent') {
      const agent = (await this.listAgents()).find((a) => a.id === key);
      if (agent) await this.setAgent(agent);
      return;
    }
    const [providerID, id, variant, name] = JSON.parse(key) as [string, string, string | null, string];
    const prefs = this.host.prefs();
    const k = usageKey(providerID, id, variant ?? undefined);
    this.host.savePrefs({ ...prefs, usage: { ...prefs.usage, [k]: (prefs.usage?.[k] ?? 0) + 1 } });
    await this.applyModel({ id, providerID, variant: variant ?? undefined, name });
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
    if (meta?.model) {
      const { id, providerID } = meta.model;
      const found = (await this.listModels().catch(() => [])).find((m) => m.id === id && m.providerID === providerID);
      this.model = { ...meta.model, name: found?.name ?? id };
    }
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
    const tokens = [...text.matchAll(/(?:^|\s)\/(\S+)/g)].map((m) => m[1]);
    const items = tokens.length ? await this.listSlash() : [];
    const lead = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
    const cmd = lead && items.find((s) => s.kind === 'command' && s.name === lead[1]);
    if (cmd && lead) {
      const res = await api.POST('/api/session/{sessionID}/command', { params: { path: { sessionID } }, body: { name: cmd.name, text: lead[2] ?? '', files } });
      if (res.error) throw new Error(`command failed: ${errorText(res.error)}`);
      return;
    }
    const picked = items.flatMap((s) => (s.kind === 'skill' && tokens.includes(s.name) ? [{ id: s.id }] : []));
    const skills = picked.length ? picked : undefined;
    const res = await api.POST('/api/session/{sessionID}/prompt', { params: { path: { sessionID } }, body: { text: full, files, skills } });
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
