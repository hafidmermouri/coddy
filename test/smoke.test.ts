// Smoke test against the real `opencode serve`. Skipped when the binary is not installed.
import { describe, expect, it } from 'vitest';
import { binaryVersion, ServerManager } from '../src/server';

const version = await binaryVersion('opencode').catch(() => undefined);

describe.skipIf(!version)(`real opencode ${version ?? '(absent)'}`, () => {
  it('starts, serves the v2 API with auth, and stops', async () => {
    const m = new ServerManager({ binaryPath: 'opencode', serverUrl: '', cwd: process.cwd(), log: () => {}, onExit: () => {} });
    try {
      const conn = await m.start();
      const res = await fetch(`${conn.baseUrl}/api/agent`, { headers: conn.headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(Array.isArray(body.data)).toBe(true);
      expect((await fetch(`${conn.baseUrl}/api/agent`)).status).toBe(401);
    } finally {
      m.stop();
    }
  });
});
