import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromHistory, type HistoryMessage, reduce, type ServerEvent } from '../src/reducer';
import { emptySession, type SessionView } from '../src/shared/protocol';

const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')) as T;

/** Replays a recorded fixture against a view bound to the session in its session.created event. */
function replay(name: string, upTo?: (e: ServerEvent) => boolean): SessionView {
  const events = load<ServerEvent[]>(`${name}.events.json`);
  const created = events.find((e) => e.type === 'session.created');
  let s: SessionView = { ...emptySession(), id: (created?.data as { sessionID: string }).sessionID };
  for (const e of events) {
    s = reduce(s, e);
    if (upTo?.(e)) break;
  }
  return s;
}

const assistantBlocks = (s: SessionView) => s.messages.flatMap((m) => (m.role === 'assistant' ? m.blocks : []));

describe('reduce', () => {
  it('ignores events for other sessions', () => {
    const s = { ...emptySession(), id: 'ses_other' };
    for (const e of load<ServerEvent[]>('text.events.json')) expect(reduce(s, e)).toBe(s);
  });

  it('streams plain text and settles idle', () => {
    const s = replay('text');
    expect(s.busy).toBe(false);
    const text = assistantBlocks(s).filter((b) => b.kind === 'text');
    expect(text.map((b) => b.kind === 'text' && b.text).join('')).toMatch(/hello world/i);
  });

  it('is busy while executing', () => {
    expect(replay('text', (e) => e.type === 'session.text.delta').busy).toBe(true);
  });

  it('tracks a write tool through permission ask, reply and success', () => {
    const asked = replay('edit', (e) => e.type === 'permission.asked');
    expect(asked.permissions).toHaveLength(1);
    expect(asked.permissions[0]).toMatchObject({ action: 'edit', resources: ['hello.txt'] });
    expect(asked.permissions[0]!.files[0]).toMatchObject({ file: 'hello.txt', status: 'added', additions: 1 });
    const tool = assistantBlocks(asked).find((b) => b.kind === 'tool');
    expect(tool).toMatchObject({ tool: { name: 'write', status: 'running', input: { path: 'hello.txt' } } });

    const done = replay('edit');
    expect(done.permissions).toEqual([]);
    expect(done.changedFiles).toEqual(['hello.txt']);
    expect(assistantBlocks(done).find((b) => b.kind === 'tool')).toMatchObject({ tool: { status: 'completed' } });
  });

  it('tracks session token totals, cost and context size', () => {
    const s = replay('edit');
    // Totals come from the last session.usage.updated; context from the last step.
    expect(s.usage).toEqual({ input: 4750, cached: 28792, output: 33 + 442, cost: 0, context: 12 + 16968 + 15 + 53 });
  });

  it('captures shell tool output', () => {
    const tool = assistantBlocks(replay('shell')).find((b) => b.kind === 'tool');
    expect(tool).toMatchObject({ tool: { name: 'shell', status: 'completed', input: { command: 'ls' } } });
    expect(tool?.kind === 'tool' && tool.tool.output).toContain('hello.txt');
  });

  it('records failures and interrupts', () => {
    const base: SessionView = { ...emptySession(), id: 's1', busy: true };
    const failed = reduce(base, {
      id: 'e', created: 0, type: 'session.execution.failed',
      data: { sessionID: 's1', error: { type: 'x', message: 'boom' } },
    } as ServerEvent);
    expect(failed).toMatchObject({ busy: false, error: 'boom' });
    const stopped = reduce(base, {
      id: 'e', created: 0, type: 'session.execution.interrupted', data: { sessionID: 's1', reason: 'user' },
    } as ServerEvent);
    expect(stopped.busy).toBe(false);
  });
});

describe('fromHistory', () => {
  it('rebuilds messages and tool calls from the message endpoint', () => {
    const { data } = load<{ data: HistoryMessage[] }>('shell.messages.json');
    const s = fromHistory('s1', 'title', data);
    expect(s.messages.some((m) => m.role === 'user')).toBe(true);
    expect(assistantBlocks(s).find((b) => b.kind === 'tool')).toMatchObject({ tool: { name: 'shell', status: 'completed' } });
  });
});
