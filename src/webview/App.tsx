import { createSignal, For, Match, onMount, Show, Switch } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Block, Chip, Message, PermissionRequest, ToolCall, ToWebview, ViewState } from '../shared/protocol';
import { emptySession } from '../shared/protocol';
import { renderMarkdown } from './markdown';
import { send } from './vscode';

export function App() {
  const [state, setState] = createStore<ViewState>({ server: { kind: 'starting' }, session: emptySession(), chips: [] });
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
        <span class="title">{state.session.title ?? 'New session'}</span>
        <button class="icon" title="Sessions in this workspace" onClick={() => send({ type: 'pickSession' })}>☰</button>
        <button class="icon" title="New session" onClick={() => send({ type: 'newSession' })}>+</button>
      </header>
      <Show when={state.server.kind !== 'connected'}>
        <div class={`banner ${state.server.kind}`}>{serverText(state.server)}</div>
      </Show>
      <div class="messages" ref={list}>
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
      <For each={state.session.permissions}>{(p) => <PermissionCard req={p} />}</For>
      <Composer busy={state.session.busy} chips={state.chips} model={state.model} agent={state.agent} ref={(el) => (input = el)} />
    </div>
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
              <Show when={parsed().labels.length}>
                <div class="chips"><For each={parsed().labels}>{(l) => <span class="chip static">{l}</span>}</For></div>
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

function Composer(props: { busy: boolean; chips: Chip[]; model?: string; agent?: string; ref: (el: HTMLTextAreaElement) => void }) {
  const [text, setText] = createSignal('');
  const submit = () => {
    const t = text().trim();
    if (!t || props.busy) return;
    send({ type: 'send', text: t });
    setText('');
  };
  return (
    <div class="composer">
      <Show when={props.chips.length}>
        <div class="chips"><For each={props.chips}>{(c) => <ChipView chip={c} />}</For></div>
      </Show>
      <textarea
        ref={props.ref}
        rows={3}
        placeholder="Ask the agent about this workspace (Enter to send, Shift+Enter for newline)"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === '@' && /(^|\s)$/.test(el.value.slice(0, el.selectionStart))) {
            e.preventDefault();
            send({ type: 'mention' });
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
        <button class="icon" title="Attach problems (diagnostics) of the current file" onClick={() => send({ type: 'attachDiagnostics' })}>⚠</button>
        <span class="spacer" />
        <button class="icon picker" title="Agent" onClick={() => send({ type: 'pickAgent' })}>{props.agent ?? 'agent'}</button>
        <button class="icon picker" title="Model" onClick={() => send({ type: 'pickModel' })}>{props.model ?? 'model'}</button>
        <Show
          when={props.busy}
          fallback={<button class="primary" disabled={!text().trim()} onClick={submit}>Send</button>}
        >
          <button class="danger" onClick={() => send({ type: 'interrupt' })}>Stop</button>
        </Show>
      </div>
    </div>
  );
}
