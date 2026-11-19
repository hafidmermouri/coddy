// Pure reducer: opencode v2 events (GET /api/event) -> SessionView.
// Events for other sessions and event types the UI does not show are ignored.
import type { components, paths } from './generated/api';
import type { Block, Message, PermissionFile, PermissionRequest, SessionView, ToolCall } from './shared/protocol';

type S = components['schemas'];
export type ServerEvent = S['V2Event'];
export type HistoryMessage =
  paths['/api/session/{sessionID}/message']['get']['responses'][200]['content']['application/json']['data'][number];
type ToolContent = S['Tool.Content'] | S['Tool.Content_1'];

export function reduce(state: SessionView, ev: ServerEvent): SessionView {
  const data: unknown = ev.data;
  if (!state.id || !isRecord(data) || data.sessionID !== state.id) return state;

  switch (ev.type) {
    case 'session.execution.started':
      return { ...state, busy: true, error: undefined };
    case 'session.execution.succeeded':
      return { ...state, busy: false };
    case 'session.execution.interrupted':
      return { ...state, busy: false, permissions: [] };
    case 'session.execution.failed':
      return { ...state, busy: false, error: ev.data.error.message };
    case 'session.renamed':
      return { ...state, title: ev.data.title };
    case 'session.step.started':
      return ensureAssistant(state, ev.data.assistantMessageID);
    case 'session.step.failed':
      return updateAssistant(state, ev.data.assistantMessageID, (blocks) => blocks, ev.data.error.message);
    case 'session.step.ended': {
      const files = ev.data.files ?? [];
      const changed = [...new Set([...state.changedFiles, ...files])];
      return changed.length === state.changedFiles.length ? state : { ...state, changedFiles: changed };
    }
    case 'session.text.started':
    case 'session.reasoning.started': {
      const kind = ev.type === 'session.text.started' ? 'text' : 'reasoning';
      const { assistantMessageID: mid, ordinal } = ev.data;
      return updateAssistant(state, mid, (b) => [...b, { kind, ordinal, text: '' }]);
    }
    case 'session.text.delta':
    case 'session.reasoning.delta': {
      const kind = ev.type === 'session.text.delta' ? 'text' : 'reasoning';
      const { assistantMessageID: mid, ordinal, delta } = ev.data;
      return updateTextBlock(state, mid, kind, ordinal, (t) => t + delta);
    }
    case 'session.text.ended':
    case 'session.reasoning.ended': {
      const kind = ev.type === 'session.text.ended' ? 'text' : 'reasoning';
      const { assistantMessageID: mid, ordinal, text } = ev.data;
      return updateTextBlock(state, mid, kind, ordinal, () => text);
    }
    case 'session.tool.input.started': {
      const { assistantMessageID: mid, id, name } = ev.data;
      return updateAssistant(state, mid, (b) => [...b, { kind: 'tool', tool: { id, name, status: 'pending' } }]);
    }
    case 'session.tool.called':
      return updateTool(state, ev.data.assistantMessageID, ev.data.id, { status: 'running', input: ev.data.input });
    case 'session.tool.success':
      return updateTool(state, ev.data.assistantMessageID, ev.data.id, {
        status: 'completed',
        output: contentText(ev.data.content),
      });
    case 'session.tool.failed':
      return updateTool(state, ev.data.assistantMessageID, ev.data.id, {
        status: 'error',
        error: ev.data.error.message,
        output: contentText(ev.data.content ?? []),
      });
    case 'permission.asked': {
      const { id, action, resources, metadata } = ev.data;
      if (state.permissions.some((p) => p.id === id)) return state;
      return { ...state, permissions: [...state.permissions, toPermission({ id, action, resources, metadata })] };
    }
    case 'permission.replied':
      return { ...state, permissions: state.permissions.filter((p) => p.id !== ev.data.requestID) };
    default:
      return state;
  }
}

/** Rebuilds a SessionView from GET /api/session/{id}/message (used on resume and after reconnect). */
export function fromHistory(id: string, title: string | undefined, history: HistoryMessage[]): SessionView {
  const messages: Message[] = [];
  const changed = new Set<string>();
  for (const m of history) {
    if (m.type === 'user') messages.push({ role: 'user', id: m.id, text: m.text });
    if (m.type !== 'assistant') continue;
    m.snapshot?.files?.forEach((f) => changed.add(f));
    const blocks: Block[] = m.content.map((c, i): Block => {
      if (c.type === 'text') return { kind: 'text', ordinal: i, text: c.text };
      if (c.type === 'reasoning') return { kind: 'reasoning', ordinal: i, text: c.text };
      const s = c.state;
      const tool: ToolCall = { id: c.id, name: c.name, status: s.status === 'streaming' ? 'pending' : s.status };
      if ('input' in s && isRecord(s.input)) tool.input = s.input;
      if (s.status === 'completed') tool.output = contentText(s.content);
      if (s.status === 'error') tool.error = s.error.message;
      return { kind: 'tool', tool };
    });
    messages.push({ role: 'assistant', id: m.id, blocks, error: m.error?.message });
  }
  return { id, title, busy: false, messages, permissions: [], changedFiles: [...changed] };
}

function ensureAssistant(state: SessionView, id: string): SessionView {
  if (state.messages.some((m) => m.id === id)) return state;
  return { ...state, messages: [...state.messages, { role: 'assistant', id, blocks: [] }] };
}

function updateAssistant(
  state: SessionView,
  id: string,
  fn: (blocks: Block[]) => Block[],
  error?: string,
): SessionView {
  const s = ensureAssistant(state, id);
  return {
    ...s,
    messages: s.messages.map((m) =>
      m.role === 'assistant' && m.id === id ? { ...m, blocks: fn(m.blocks), error: error ?? m.error } : m,
    ),
  };
}

function updateTextBlock(
  state: SessionView,
  mid: string,
  kind: 'text' | 'reasoning',
  ordinal: number,
  fn: (text: string) => string,
): SessionView {
  return updateAssistant(state, mid, (blocks) => {
    const hit = blocks.some((b) => b.kind === kind && b.ordinal === ordinal);
    const list: Block[] = hit ? blocks : [...blocks, { kind, ordinal, text: '' }];
    return list.map((b) => (b.kind === kind && b.ordinal === ordinal ? { ...b, text: fn(b.text) } : b));
  });
}

function updateTool(state: SessionView, mid: string, id: string, patch: Partial<ToolCall>): SessionView {
  return updateAssistant(state, mid, (blocks) => {
    const hit = blocks.some((b) => b.kind === 'tool' && b.tool.id === id);
    const list: Block[] = hit ? blocks : [...blocks, { kind: 'tool', tool: { id, name: 'tool', status: 'pending' } }];
    return list.map((b) => (b.kind === 'tool' && b.tool.id === id ? { kind: 'tool', tool: { ...b.tool, ...patch } } : b));
  });
}

function contentText(content: ToolContent[]): string {
  return content.map((c) => (c.type === 'text' ? c.text : `[file ${'uri' in c ? String(c.uri) : ''}]`)).join('\n');
}

/** Shared by the permission.asked event and GET /api/session/{id}/permission (same Permission.Request shape). */
export function toPermission(p: { id: string; action: string; resources: string[]; metadata?: unknown }): PermissionRequest {
  return { id: p.id, action: p.action, resources: p.resources, files: permissionFiles(p.metadata) };
}

/** permission.asked metadata is untyped in the spec; edit requests carry `files[{file, patch, ...}]`. */
function permissionFiles(metadata: unknown): PermissionFile[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.files)) return [];
  return metadata.files.filter(isRecord).flatMap((f) =>
    typeof f.file === 'string' && typeof f.patch === 'string'
      ? [{
          file: f.file,
          patch: f.patch,
          status: typeof f.status === 'string' ? f.status : 'modified',
          additions: typeof f.additions === 'number' ? f.additions : 0,
          deletions: typeof f.deletions === 'number' ? f.deletions : 0,
        }]
      : [],
  );
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
