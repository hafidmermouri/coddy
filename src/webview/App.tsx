import { createSignal, createUniqueId, For, type JSX, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Block, Chip, ImageAttachment, MenuItem, MenuKind, Message, FormField, FormRequest, FormValue, PermissionRequest, ToolCall, ToWebview, Usage, ViewState } from '../shared/protocol';
import { effortLabel, emptySession } from '../shared/protocol';
import { renderMarkdown } from './markdown';
import { send } from './vscode';

export function App() {
  const [state, setState] = createStore<ViewState>({ tabs: [], activeTab: '', server: { kind: 'starting' }, session: emptySession(), chips: [] });
  let list!: HTMLDivElement;
  let input!: HTMLTextAreaElement;

  onMount(() => {
    window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
      if (e.data?.type === 'focus') return input.focus();
      if (e.data?.type === 'insert') return insertAtCursor(input, e.data.text);
      if (e.data?.type !== 'state') return;
      const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      setState(reconcile(e.data.state, { key: 'id' }));
      if (stick) queueMicrotask(() => (list.scrollTop = list.scrollHeight));
    });
    send({ type: 'ready' });
  });

  return (
    <div class="app">
      <header class="bar">
        <div class="tabs">
          <For each={state.tabs}>
            {(t) => (
              <div class="tab" classList={{ active: t.key === state.activeTab }} title={t.title}>
                <button class="tab-title" onClick={() => send({ type: 'selectTab', key: t.key })}>
                  <Show when={t.busy} fallback={<Logo />}><span class="dot" /></Show>
                  {t.title}
                </button>
                <button class="icon" title="Close tab" onClick={() => send({ type: 'closeTab', key: t.key })}>×</button>
              </div>
            )}
          </For>
        </div>
        <button class="icon" title="New session tab" onClick={() => send({ type: 'newTab' })}>+</button>
        <MenuButton kind="session" down title="Session history" label={<svg class="clock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9" /><path d="M2.4 2.4v2.8h2.8" /><path d="M8 5v3.2l2.1 1.3" /></svg>} />
      </header>
      <Show when={state.server.kind !== 'connected'}>
        <div class={`banner ${state.server.kind}`}>{serverText(state.server)}</div>
      </Show>
      <div class="messages" ref={list}>
        <Show when={!state.session.messages.length && !state.session.error}>
          <Welcome agent={state.agent} model={state.model} variant={state.variant} />
        </Show>
        <For each={state.session.messages}>{(m) => <MessageView msg={m} />}</For>
        <Show when={state.session.error}>
          <div class="error">{state.session.error}</div>
        </Show>
      </div>
      <Show when={state.session.changedFiles.length}>
        <details class="changed">
          <summary>{state.session.changedFiles.length} file(s) changed</summary>
          <For each={state.session.changedFiles}>
            {(f) => <button class="link" title="Show agent changes" onClick={() => send({ type: 'openChangedDiff', file: f })}>{f}</button>}
          </For>
        </details>
      </Show>
      <For each={state.session.forms}>{(f) => <FormCard form={f} />}</For>
      <For each={state.session.permissions}>{(p) => <PermissionCard req={p} />}</For>
      <Composer busy={state.session.busy} chips={state.chips} model={state.model} variant={state.variant} agent={state.agent} ref={(el) => (input = el)} />
      <UsageBar usage={state.session.usage} />
    </div>
  );
}

const AGENTS = [
  { id: 'build', label: 'Build', hint: 'Can edit files and run commands' },
  { id: 'plan', label: 'Plan', hint: 'Read-only: explores and proposes a plan' },
];

/** Shown in an empty session. Everything is optional: just type a question below to ignore it. */
function Welcome(props: { agent?: string; model?: string; variant?: string }) {
  const current = () => (props.agent ?? 'build').toLowerCase();
  return (
    <div class="welcome">
      <Logo />
      <h2>What can I help with?</h2>
      <div class="muted">Type a question below, or set things up first.</div>
      <div class="welcome-row">
        <span class="muted">Mode</span>
        <div class="seg">
          <For each={AGENTS}>
            {(a) => (
              <button classList={{ active: current() === a.id }} title={a.hint} onClick={() => send({ type: 'pick', kind: 'agent', key: a.id })}>
                {a.label}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="welcome-row">
        <span class="muted">Model</span>
        <button class="picker badge" title="Change model and effort" onClick={() => send({ type: 'menu', kind: 'model' })}>
          {[props.model ?? 'model', props.variant && effortLabel(props.variant)].filter(Boolean).join(' - ')}
        </button>
      </div>
    </div>
  );
}

/** Same mark as media/icon.svg, drawn in the current text color. */
function Logo() {
  const id = createUniqueId();
  return (
    <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
      <mask id={id}>
        <rect width="24" height="24" fill="#fff" />
        <path d="M7 8l3.5 3.5L7 15" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M12.5 15h4.5" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" />
      </mask>
      <path mask={`url(#${id})`} fill="currentColor" d="M5.5 2h13A4.5 4.5 0 0 1 23 6.5v8a4.5 4.5 0 0 1-4.5 4.5H12l-5 3.5V19h-1.5A4.5 4.5 0 0 1 1 14.5v-8A4.5 4.5 0 0 1 5.5 2z" />
    </svg>
  );
}

function serverText(s: ViewState['server']): string {
  switch (s.kind) {
    case 'starting': return 'Starting opencode server...';
    case 'reconnecting': return `Connection lost, reconnecting (attempt ${s.attempt})...`;
    case 'error': return s.message;
    default: return '';
  }
}

function MessageView(props: { msg: Message }) {
  return (
    <Switch>
      <Match when={props.msg.role === 'user' && props.msg}>
        {(m) => {
          const parsed = () => splitContext(m().text);
          return (
            <div class="msg user">
              <Show when={parsed().labels.length + (m().images?.length ?? 0)}>
                <div class="chips">
                  <For each={parsed().labels}>{(l) => <span class="chip static">{l}</span>}</For>
                  <For each={m().images}>{(n) => <span class="chip static">📎 {n}</span>}</For>
                </div>
              </Show>
              {parsed().text}
            </div>
          );
        }}
      </Match>
      <Match when={props.msg.role === 'assistant' && props.msg}>
        {(m) => (
          <div class="msg assistant">
            <For each={m().blocks}>{(b) => <BlockView block={b} />}</For>
            <Show when={m().error}><div class="error">{m().error}</div></Show>
          </div>
        )}
      </Match>
    </Switch>
  );
}

const ofKind = <K extends Block['kind']>(b: Block, k: K) => (b.kind === k ? (b as Extract<Block, { kind: K }>) : undefined);

function BlockView(props: { block: Block }) {
  return (
    <Switch>
      <Match when={ofKind(props.block, 'text')}>
        {(t) => <div class="md" innerHTML={renderMarkdown(t().text)} />}
      </Match>
      <Match when={ofKind(props.block, 'reasoning')}>
        {(t) => (
          <details class="reasoning">
            <summary>Thinking</summary>
            <div class="md" innerHTML={renderMarkdown(t().text)} />
          </details>
        )}
      </Match>
      <Match when={ofKind(props.block, 'tool')}>
        {(t) => <ToolCard tool={t().tool} />}
      </Match>
    </Switch>
  );
}

/** Prompts carry a `<context>` block whose `[kind] label` lines become labels in the transcript. */
function splitContext(text: string): { labels: string[]; text: string } {
  const m = /^<context>\n([\s\S]*?)\n<\/context>\n*/.exec(text);
  if (!m) return { labels: [], text };
  const labels = [...(m[1] ?? '').matchAll(/^\[(?:file|selection|diagnostics)\] (.+)$/gm)].map((x) => x[1] ?? '');
  return { labels, text: text.slice(m[0].length) };
}

function insertAtCursor(el: HTMLTextAreaElement, text: string): void {
  el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
}

function ChipView(props: { chip: Chip }) {
  return (
    <span class={`chip ${props.chip.kind}`} classList={{ auto: props.chip.auto }} title={props.chip.auto ? 'Attached automatically' : 'Attached'}>
      {props.chip.label}
      <button class="icon" title="Remove" onClick={() => send({ type: 'removeChip', id: props.chip.id })}>×</button>
    </span>
  );
}

/** Context budget the bar measures against. */
const CONTEXT_BUDGET = 100_000;

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

function UsageBar(props: { usage: Usage }) {
  const pct = () => Math.min(100, (props.usage.context / CONTEXT_BUDGET) * 100);
  const level = () => (pct() >= 90 ? 'high' : pct() >= 70 ? 'mid' : 'low');
  return (
    <div class="usage" title={`Session totals. In: ${props.usage.input} fresh input tokens, plus ${props.usage.cached} read from cache (billed at a much lower rate). Every agent step resends the system prompt, tool definitions and conversation, so input grows faster than your prompts. Out: ${props.usage.output} tokens (incl. reasoning). Context: ${props.usage.context} tokens of the ${fmt(CONTEXT_BUDGET)} budget.`}>
      <span>in {fmt(props.usage.input)}<Show when={props.usage.cached}> (+{fmt(props.usage.cached)} cached)</Show></span>
      <span>out {fmt(props.usage.output)}</span>
      <span>${props.usage.cost.toFixed(4)}</span>
      <span class="spacer" />
      <span>ctx {fmt(props.usage.context)} / {fmt(CONTEXT_BUDGET)}</span>
      <div class={`meter ${level()}`}><div style={{ width: `${pct()}%` }} /></div>
    </div>
  );
}

function PermissionCard(props: { req: PermissionRequest }) {
  const reply = (decision: 'once' | 'always' | 'reject') => send({ type: 'permission', id: props.req.id, decision });
  return (
    <div class="permission">
      <div class="head">Agent wants to <b>{props.req.action}</b></div>
      <Show
        when={props.req.files.length}
        fallback={<div class="resources">{props.req.resources.join(', ')}</div>}
      >
        <For each={props.req.files}>
          {(f) => (
            <div class="pfile">
              <button class="link" title="Review diff" onClick={() => send({ type: 'openPermissionDiff', id: props.req.id, file: f.file })}>
                {f.file}
              </button>
              <span class="add">+{f.additions}</span>
              <span class="del">-{f.deletions}</span>
              <span class="muted">{f.status}</span>
            </div>
          )}
        </For>
      </Show>
      <div class="actions">
        <button class="primary" onClick={() => reply('once')}>Allow</button>
        <button title="Allow this kind of request for the rest of the session" onClick={() => reply('always')}>Always</button>
        <span class="spacer" />
        <button onClick={() => reply('reject')}>Deny</button>
      </div>
    </div>
  );
}

function FormCard(props: { form: FormRequest }) {
  const [answer, setAnswer] = createStore<Record<string, FormValue | undefined>>(
    Object.fromEntries(props.form.fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])),
  );
  const visible = (f: FormField) =>
    !f.hidden && (f.when ?? []).every((w) => (w.op === 'eq') === (answer[w.key] === w.value));
  const missing = () =>
    props.form.fields.some((f) => f.required && f.type !== 'external' && visible(f) && (answer[f.key] === undefined || answer[f.key] === ''));
  const submit = () => {
    const out: Record<string, FormValue> = {};
    for (const f of props.form.fields) {
      const v = answer[f.key];
      if (visible(f) && v !== undefined && v !== '') out[f.key] = v;
    }
    send({ type: 'form', id: props.form.id, answer: out });
  };
  const shown = () => props.form.fields.filter(visible);
  const [tab, setTab] = createSignal(0);
  const idx = () => Math.min(tab(), shown().length - 1);
  const done = (f: FormField) => answer[f.key] !== undefined && answer[f.key] !== '';
  return (
    <div class="form">
      <div class="head">{props.form.title}</div>
      <Show when={shown().length > 1}>
        <div class="tabs" role="tablist">
          <For each={shown()}>
            {(f, i) => (
              <button role="tab" classList={{ active: i() === idx(), done: done(f) }} onClick={() => setTab(i())}>
                {f.title ?? `Question ${i() + 1}`}{done(f) ? ' ✓' : ''}
              </button>
            )}
          </For>
        </div>
      </Show>
      <For each={shown()}>
        {(f, i) => (
          <Show when={i() === idx()}>
            <FormFieldInput field={f} value={answer[f.key]} set={(v) => setAnswer(f.key, v)} />
          </Show>
        )}
      </For>
      <div class="actions">
        <Show when={idx() > 0}><button onClick={() => setTab(idx() - 1)}>Back</button></Show>
        <Show when={idx() < shown().length - 1} fallback={<button class="primary" disabled={missing()} onClick={submit}>Submit</button>}>
          <button class="primary" onClick={() => setTab(idx() + 1)}>Next</button>
        </Show>
        <span class="spacer" />
        <button onClick={() => send({ type: 'form', id: props.form.id, answer: null })}>Skip</button>
      </div>
    </div>
  );
}

function FormFieldInput(props: { field: FormField; value: FormValue | undefined; set: (v: FormValue | undefined) => void }) {
  const f = () => props.field;
  const name = createUniqueId();
  const options = () => f().options ?? [];
  const picked = (v: string) => (Array.isArray(props.value) ? props.value.includes(v) : props.value === v);
  const toggle = (v: string) => {
    const cur = Array.isArray(props.value) ? props.value : [];
    props.set(cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  };
  const isOther = () => typeof props.value === 'string' && !options().some((o) => o.value === props.value);
  return (
    <div class="field">
      <Show when={f().title}><div class="label">{f().title}{f().required ? ' *' : ''}</div></Show>
      <Show when={f().description}><div class="muted">{f().description}</div></Show>
      <Switch>
        <Match when={f().type === 'external'}>
          <a href={f().url}>{f().url}</a>
        </Match>
        <Match when={f().type === 'boolean'}>
          <label class="opt"><input type="checkbox" checked={props.value === true} onChange={(e) => props.set(e.currentTarget.checked)} /><span>Yes</span></label>
        </Match>
        <Match when={f().type === 'multiselect' || (f().type === 'string' && options().length)}>
          <For each={options()}>
            {(o) => (
              <label class="opt" classList={{ on: picked(o.value) }}>
                <input
                  type={f().type === 'multiselect' ? 'checkbox' : 'radio'}
                  name={name}
                  checked={picked(o.value)}
                  onChange={() => (f().type === 'multiselect' ? toggle(o.value) : props.set(o.value))}
                />
                <span><span class="olabel">{o.label}</span><Show when={o.description}><span class="muted odesc">{o.description}</span></Show></span>
              </label>
            )}
          </For>
          <Show when={f().custom && f().type === 'string'}>
            <input
              class="text" placeholder="Other…" value={isOther() ? String(props.value) : ''}
              onInput={(e) => props.set(e.currentTarget.value || undefined)}
            />
          </Show>
        </Match>
        <Match when={f().type === 'number' || f().type === 'integer'}>
          <input class="text" type="number" step={f().type === 'integer' ? 1 : 'any'} value={props.value === undefined ? '' : String(props.value)}
            onInput={(e) => props.set(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
        </Match>
        <Match when={true}>
          <input class="text" placeholder={f().placeholder} value={typeof props.value === 'string' ? props.value : ''}
            onInput={(e) => props.set(e.currentTarget.value)} />
        </Match>
      </Switch>
    </div>
  );
}

const STATUS_ICON: Record<ToolCall['status'], string> = { pending: '○', running: '◌', completed: '✓', error: '✗' };
const MAX_OUTPUT_LINES = 200;

/** Most file and search tools carry a path; shell carries a command. */
function toolTarget(input: ToolCall['input']): { text: string; file?: string } {
  if (!input) return { text: '' };
  for (const k of ['path', 'filePath', 'file']) {
    const v = input[k];
    if (typeof v === 'string') return { text: v, file: v };
  }
  for (const k of ['command', 'pattern', 'query', 'url', 'description']) {
    const v = input[k];
    if (typeof v === 'string') return { text: v };
  }
  return { text: '' };
}

function ToolCard(props: { tool: ToolCall }) {
  const target = () => toolTarget(props.tool.input);
  const output = () => {
    const lines = (props.tool.output ?? '').split('\n');
    return lines.length > MAX_OUTPUT_LINES
      ? `${lines.slice(0, MAX_OUTPUT_LINES).join('\n')}\n… ${lines.length - MAX_OUTPUT_LINES} more lines`
      : lines.join('\n');
  };
  return (
    <details class={`tool ${props.tool.status}`} open={props.tool.status === 'error'}>
      <summary>
        <span class="status" title={props.tool.status}>{STATUS_ICON[props.tool.status]}</span>
        <span class="name">{props.tool.name}</span>
        <Show when={target().file} fallback={<span class="target">{target().text}</span>}>
          <button class="link target" title="Open file" onClick={(e) => { e.preventDefault(); send({ type: 'openFile', file: target().file! }); }}>
            {target().text}
          </button>
        </Show>
      </summary>
      <Show when={props.tool.input}>
        <pre class="io">{JSON.stringify(props.tool.input, null, 2)}</pre>
      </Show>
      <Show when={props.tool.error}><pre class="io error">{props.tool.error}</pre></Show>
      <Show when={props.tool.output}><pre class="io">{output()}</pre></Show>
    </details>
  );
}

const readFile = (f: File, i: number): Promise<ImageAttachment> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name && f.name !== 'image.png' ? f.name : `pasted-${Date.now()}-${i}.png`, dataUrl: String(r.result) });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

const TOP_USED = 10;

/** Filterable list. The model list shows only the top most-used entries until you type a filter. */
function MenuList(props: { items: MenuItem[]; search?: string; top?: number; detail?: boolean; class?: string; onPick: (key: string) => void; onClose: () => void }) {
  const [filter, setFilter] = createSignal('');
  const shown = () => {
    const q = filter().toLowerCase();
    if (q) return props.items.filter((i) => `${i.label} ${i.detail ?? ''}`.toLowerCase().includes(q)).slice(0, 50);
    return props.top ? props.items.slice(0, props.top) : props.items;
  };
  return (
    <div class={`menu ${props.class ?? ''}`} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
      <Show when={props.search}>
        <input class="menu-filter" placeholder={props.search} ref={(el) => queueMicrotask(() => el.focus())} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
      </Show>
      <For each={shown()} fallback={<div class="muted menu-empty">No match</div>}>
        {(i) => (
          <button class="menu-item" classList={{ active: i.active }} title={i.detail} onClick={() => props.onPick(i.key)}>
            <span class="check">{i.active ? '✓' : ''}</span>
            <span class="menu-text">
              <span class="menu-label">{i.label}</span>
              <Show when={props.detail && i.detail}><span class="muted menu-detail">{i.detail}</span></Show>
            </span>
          </button>
        )}
      </For>
    </div>
  );
}

/** Receives the extension's answer to a `menu` request of this kind. */
function useMenu(kind: MenuKind) {
  const [items, setItems] = createSignal<MenuItem[]>();
  onMount(() => {
    const onMsg = (e: MessageEvent<ToWebview>) => e.data?.type === 'menu' && e.data.kind === kind && setItems(e.data.items);
    const onDown = (e: MouseEvent) => !(e.target as Element).closest?.(`.menu-wrap.${kind}`) && setItems(undefined);
    window.addEventListener('message', onMsg);
    window.addEventListener('mousedown', onDown);
    onCleanup(() => {
      window.removeEventListener('message', onMsg);
      window.removeEventListener('mousedown', onDown);
    });
  });
  return [items, () => setItems(undefined)] as const;
}

/** Button with a dropdown opening above it. */
function MenuButton(props: { kind: 'agent' | 'model' | 'session'; label: JSX.Element; title: string; badge?: boolean; down?: boolean }) {
  const [items, close] = useMenu(props.kind);
  return (
    <div class={`menu-wrap ${props.kind}`}>
      <button class="picker" classList={{ badge: props.badge, icon: !props.badge }} title={props.title} onClick={() => (items() ? close() : send({ type: 'menu', kind: props.kind }))}>
        {props.label}
      </button>
      <Show when={items()}>
        {(list) => (
          <MenuList
            items={list()}
            class={props.down ? 'down' : ''}
            search={props.kind === 'model' ? 'Search all models...' : props.kind === 'session' ? 'Search sessions...' : undefined}
            top={props.kind === 'model' ? TOP_USED : undefined}
            detail
            onPick={(key) => { send({ type: 'pick', kind: props.kind, key }); close(); }}
            onClose={close}
          />
        )}
      </Show>
    </div>
  );
}

function Composer(props: { busy: boolean; chips: Chip[]; model?: string; variant?: string; agent?: string; ref: (el: HTMLTextAreaElement) => void }) {
  const [text, setText] = createSignal('');
  const [images, setImages] = createSignal<ImageAttachment[]>([]);
  const [slash, closeSlash] = useMenu('slash');
  let fileInput!: HTMLInputElement;
  let textarea!: HTMLTextAreaElement;
  const attach = async (files: File[]) => files.length && setImages([...images(), ...(await Promise.all(files.map(readFile)))]);
  const submit = () => {
    const t = text().trim();
    if (!t || props.busy) return;
    send({ type: 'send', text: t, images: images() });
    setText('');
    setImages([]);
  };
  return (
    <div class="composer">
      <Show when={props.chips.length}>
        <div class="chips"><For each={props.chips}>{(c) => <ChipView chip={c} />}</For></div>
      </Show>
      <Show when={images().length}>
        <div class="chips">
          <For each={images()}>
            {(img) => (
              <Show
                when={img.dataUrl.startsWith('data:image/')}
                fallback={
                  <span class="chip" title={img.name}>
                    📎 {img.name}
                    <button class="icon" title="Remove file" onClick={() => setImages(images().filter((x) => x !== img))}>×</button>
                  </span>
                }
              >
                <span class="thumb" title={img.name}>
                  <img src={img.dataUrl} alt={img.name} />
                  <button class="icon" title="Remove image" onClick={() => setImages(images().filter((x) => x !== img))}>×</button>
                </span>
              </Show>
            )}
          </For>
        </div>
      </Show>
      <div class="menu-wrap slash">
        <Show when={slash()}>
          {(list) => (
            <MenuList
              class="left"
              items={list()}
              search="Search commands and skills..."
              detail
              onClose={() => { closeSlash(); insertAtCursor(textarea, '/'); }}
              onPick={(name) => { closeSlash(); insertAtCursor(textarea, `/${name} `); }}
            />
          )}
        </Show>
      </div>
      <textarea
        ref={(el) => { textarea = el; props.ref(el); }}
        rows={3}
        placeholder="Ask the agent about this workspace (/ for commands and skills, Enter to send, Shift+Enter for newline)"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onPaste={(e) => {
          const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
          if (!files.length) return;
          e.preventDefault();
          void attach(files);
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === '@' && /(^|\s)$/.test(el.value.slice(0, el.selectionStart))) {
            e.preventDefault();
            send({ type: 'mention' });
            return;
          }
          if (e.key === '/' && /(^|\s)$/.test(el.value.slice(0, el.selectionStart))) {
            e.preventDefault();
            send({ type: 'menu', kind: 'slash' });
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div class="actions">
        <button class="icon" title="Mention a file (@)" onClick={() => send({ type: 'mention' })}>@</button>
        <button class="icon" title="Attach files (images, PDF, ...)" onClick={() => fileInput.click()}>+</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void attach([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ''; }} />
        <button class="icon" title="Attach problems (diagnostics) of the current file" onClick={() => send({ type: 'attachDiagnostics' })}>⚠</button>
        <span class="spacer" />
        <MenuButton kind="agent" label={props.agent ?? 'agent'} title="Agent (build / plan)" />
        <MenuButton kind="model" label={[props.model ?? 'model', props.variant && effortLabel(props.variant)].filter(Boolean).join(' - ')} title="Model and effort" badge />
        <Show
          when={props.busy}
          fallback={
            <button class="send" title="Send" aria-label="Send" disabled={!text().trim()} onClick={submit}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
            </button>
          }
        >
          <button class="stop" title="Stop" aria-label="Stop" onClick={() => send({ type: 'interrupt' })}>
            <svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg>
          </button>
        </Show>
      </div>
    </div>
  );
}
