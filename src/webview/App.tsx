import { createSignal, For, Match, onMount, Show, Switch } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Block, Chip, Message, ToWebview, ViewState } from '../shared/protocol';
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
      <Composer busy={state.session.busy} chips={state.chips} ref={(el) => (input = el)} />
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
        {(t) => <div class="tool-line">{t().tool.name} · {t().tool.status}</div>}
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

function Composer(props: { busy: boolean; chips: Chip[]; ref: (el: HTMLTextAreaElement) => void }) {
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
        <span class="spacer" />
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
