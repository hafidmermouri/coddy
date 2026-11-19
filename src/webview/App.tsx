import { createSignal, For, Match, onMount, Show, Switch } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Block, Message, ToWebview, ViewState } from '../shared/protocol';
import { emptySession } from '../shared/protocol';
import { renderMarkdown } from './markdown';
import { send } from './vscode';

export function App() {
  const [state, setState] = createStore<ViewState>({ server: { kind: 'starting' }, session: emptySession(), chips: [] });
  let list!: HTMLDivElement;

  onMount(() => {
    window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
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
      <Composer busy={state.session.busy} />
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
        {(m) => <div class="msg user">{m().text}</div>}
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

function Composer(props: { busy: boolean }) {
  const [text, setText] = createSignal('');
  const submit = () => {
    const t = text().trim();
    if (!t || props.busy) return;
    send({ type: 'send', text: t });
    setText('');
  };
  return (
    <div class="composer">
      <textarea
        rows={3}
        placeholder="Ask the agent about this workspace (Enter to send, Shift+Enter for newline)"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div class="actions">
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
