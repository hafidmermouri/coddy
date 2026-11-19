import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinaryNotFoundError, ServerManager, type ServerOptions } from '../src/server';
import { EventStream } from '../src/sse';

const fake = resolve(__dirname, 'fake-opencode.mjs');
const managers: ServerManager[] = [];

function manager(over: Partial<ServerOptions> = {}): ServerManager {
  const m = new ServerManager({ binaryPath: fake, serverUrl: '', cwd: __dirname, log: () => {}, onExit: () => {}, ...over });
  managers.push(m);
  return m;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = async (c: { baseUrl: string; headers: Record<string, string> }) =>
  ((await (await fetch(`${c.baseUrl}/api/info`, { headers: c.headers })).json()) as { pid: number }).pid;

afterEach(() => { managers.splice(0).forEach((m) => m.stop()); delete process.env.FAKE_DROP_MS; });

describe('ServerManager', () => {
  it('spawns, waits for ready, authenticates, and kills on stop', async () => {
    const log = vi.fn();
    const m = manager({ log });
    const conn = await m.start();
    expect(conn.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${conn.baseUrl}/api/info`)).status).toBe(401);
    const pid = await pidOf(conn);
    m.stop();
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/password/);
  });

  it('kills the server when the extension host goes away without calling stop', async () => {
    const m = manager();
    const conn = await m.start();
    const pid = await pidOf(conn);
    // Simulate the host dying: its end of the watchdog pipe closes.
    (m as unknown as { child: { stdin: { destroy(): void } } }).child.stdin.destroy();
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it('reports a missing binary clearly', async () => {
    await expect(manager({ binaryPath: '/nope/opencode' }).start()).rejects.toBeInstanceOf(BinaryNotFoundError);
  });

  it('reports an unexpected exit after startup', async () => {
    const onExit = vi.fn();
    const conn = await manager({ onExit }).start();
    process.kill(await pidOf(conn), 'SIGKILL');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });

  it('reuses a configured server with credentials from the URL', async () => {
    const conn = await manager().start();
    const pass = /Basic (.+)/.exec(conn.headers.Authorization!)![1]!;
    const [, password] = Buffer.from(pass, 'base64').toString().split(':');
    const url = conn.baseUrl.replace('http://', `http://opencode:${encodeURIComponent(password!)}@`);
    const reused = await manager({ serverUrl: url, binaryPath: '/nope' }).start();
    expect(reused.baseUrl).toBe(conn.baseUrl);
  });
});

describe('EventStream', () => {
  it('reconnects with backoff after the stream drops and logs retries', async () => {
    process.env.FAKE_DROP_MS = '50';
    const conn = await manager().start();
    const opens: boolean[] = [];
    const events: unknown[] = [];
    const log = vi.fn();
    const onRetry = vi.fn();
    const s = new EventStream({
      url: `${conn.baseUrl}/api/event`, headers: conn.headers, log, onRetry, maxDelayMs: 100,
      onOpen: (r) => opens.push(r), onEvent: (e) => events.push(e),
    });
    s.start();
    await vi.waitFor(() => expect(opens.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    s.stop();
    expect(opens.slice(0, 2)).toEqual([false, true]);
    expect(onRetry).toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toMatch(/retry #1/);
    expect(events[0]).toMatchObject({ type: 'server.connected' });
  });

  it('keeps retrying and reports failures when the server is down', async () => {
    const onRetry = vi.fn();
    const s = new EventStream({
      url: 'http://127.0.0.1:1/api/event', headers: {}, log: () => {}, onRetry, maxDelayMs: 20,
      onOpen: () => {}, onEvent: () => {},
    });
    s.start();
    await vi.waitFor(() => expect(onRetry.mock.calls.length).toBeGreaterThanOrEqual(3));
    s.stop();
    expect(onRetry.mock.calls[2]![0]).toBe(3);
  });
});
