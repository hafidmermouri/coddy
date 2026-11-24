// Typed contract between the extension host and the webview.
// The extension host owns all state; the webview renders ViewState and sends intents.

export type ToolStatus = 'pending' | 'running' | 'completed' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  status: ToolStatus;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

export type Block =
  | { kind: 'text'; ordinal: number; text: string }
  | { kind: 'reasoning'; ordinal: number; text: string }
  | { kind: 'tool'; tool: ToolCall };

export type Message =
  | { role: 'user'; id: string; text: string; images?: string[] }
  | { role: 'assistant'; id: string; blocks: Block[]; error?: string };

export interface PermissionFile {
  file: string;
  patch: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PermissionRequest {
  id: string;
  action: string;
  resources: string[];
  files: PermissionFile[];
}

export type FormValue = string | number | boolean | string[];

export interface FormField {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  options?: { value: string; label: string; description?: string }[];
  /** Allows a free-text answer besides the options. */
  custom?: boolean;
  placeholder?: string;
  url?: string;
  default?: FormValue;
  when?: { key: string; op: 'eq' | 'neq'; value: string | number | boolean }[];
}

/** A question the agent asked (opencode "form"). */
export interface FormRequest {
  id: string;
  title: string;
  fields: FormField[];
}

export interface Usage {
  /** Session totals. input = fresh prompt tokens (incl. cache writes); cached = cache reads, billed far lower. */
  input: number;
  cached: number;
  output: number;
  cost: number;
  /** Tokens in the context window as of the last model step. */
  context: number;
}

export interface SessionView {
  id?: string;
  title?: string;
  busy: boolean;
  messages: Message[];
  permissions: PermissionRequest[];
  forms: FormRequest[];
  changedFiles: string[];
  usage: Usage;
  error?: string;
}

export type ServerStatus =
  | { kind: 'starting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'error'; message: string };

export interface Chip {
  id: string;
  kind: 'file' | 'selection' | 'diagnostics';
  label: string;
  /** Auto chips follow the active editor; pinned chips stay until the prompt is sent. */
  auto: boolean;
}

export interface SessionTab {
  key: string;
  title: string;
  busy: boolean;
}

/** An image pasted into the composer, sent inline as a data: URI. */
export interface ImageAttachment {
  name: string;
  dataUrl: string;
}

export interface ViewState {
  /** Session tabs of this panel; `session` below is the active one. */
  tabs: SessionTab[];
  activeTab: string;
  server: ServerStatus;
  session: SessionView;
  chips: Chip[];
  model?: string;
  /** Model variant ("effort"), e.g. low / high. Undefined = model default. */
  variant?: string;
  agent?: string;
}

export type MenuKind = 'agent' | 'model' | 'slash' | 'session';

/** "medium" -> "Medium" */
export const effortLabel = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

export interface MenuItem {
  key: string;
  label: string;
  detail?: string;
  active: boolean;
}

export type PermissionDecision = 'once' | 'always' | 'reject';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; images: ImageAttachment[] }
  | { type: 'interrupt' }
  | { type: 'permission'; id: string; decision: PermissionDecision }
  | { type: 'form'; id: string; answer: Record<string, FormValue> | null }
  | { type: 'openPermissionDiff'; id: string; file: string }
  | { type: 'openFile'; file: string }
  | { type: 'openChangedDiff'; file: string }
  | { type: 'removeChip'; id: string }
  | { type: 'mention' }
  | { type: 'attachDiagnostics' }
  | { type: 'menu'; kind: MenuKind }
  | { type: 'pick'; kind: MenuKind; key: string }
  | { type: 'selectTab'; key: string }
  | { type: 'closeTab'; key: string }
  | { type: 'newSession' }
  | { type: 'newTab' };

export type ToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'insert'; text: string }
  | { type: 'menu'; kind: MenuKind; items: MenuItem[] }
  | { type: 'focus' };

export const emptySession = (): SessionView => ({
  busy: false,
  messages: [],
  permissions: [],
  forms: [],
  changedFiles: [],
  usage: { input: 0, cached: 0, output: 0, cost: 0, context: 0 },
});

/** Usage dashboard (activity bar view). Costs are attributed to each session's creation time. */
export interface UsageData {
  totals: { input: number; cached: number; output: number; cost: number; sessions: number };
  /** Newest-last; the last sessions with their final context size. */
  sessions: { id: string; title: string; context: number }[];
  costs: { t: number; cost: number }[];
}

export type UsageToWebview = { type: 'usage'; data?: UsageData; error?: string };
export type UsageFromWebview = { type: 'refresh' };
