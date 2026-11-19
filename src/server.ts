// opencode server lifecycle: reuse a configured server, or spawn `opencode serve`
// on 127.0.0.1 with a free port and a per-session random password.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface Connection {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface ServerOptions {
  binaryPath: string;
  serverUrl: string;
  cwd: string;
  log: (msg: string) => void;
  /** Called when a spawned server exits unexpectedly. */
  onExit: (message: string) => void;
  readyTimeoutMs?: number;
}

export class BinaryNotFoundError extends Error {}

const basicAuth = (user: string, pass: string) =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

/** The opencode installer puts the binary in ~/.opencode/bin, which a GUI-launched VS Code may not have on PATH. */
export function resolveBinary(binaryPath: string): string {
  if (binaryPath !== 'opencode') return binaryPath;
  const fallback = join(homedir(), '.opencode', 'bin', 'opencode');
  return existsSync(fallback) ? fallback : binaryPath;
}

export function binaryVersion(binaryPath: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(resolveBinary(binaryPath), ['--version'], { timeout: 10_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim().replace(/^opencode\s+v?/, '')),
    ),
  );
}

export class ServerManager {
  private child?: ChildProcess;
  private stopping = false;

  constructor(private readonly opts: ServerOptions) {}

  async start(): Promise<Connection> {
    const configured = this.opts.serverUrl.trim();
    const conn = configured ? fromUrl(configured) : await this.spawn();
    await this.healthCheck(conn);
    return conn;
  }

  stop(): void {
    this.stopping = true;
    if (this.child && this.child.exitCode === null) {
      this.opts.log(`stopping opencode serve (pid ${this.child.pid})`);
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
  }

  private spawn(): Promise<Connection> {
    const bin = resolveBinary(this.opts.binaryPath);
    const password = randomBytes(24).toString('base64url');
    this.stopping = false;
    this.opts.log(`spawning ${bin} serve --port 0 --hostname 127.0.0.1 (cwd ${this.opts.cwd})`);
    const child = spawn(bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: this.opts.cwd,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const tail: string[] = [];
    const remember = (line: string) => {
      tail.push(line);
      if (tail.length > 20) tail.shift();
      this.opts.log(`[opencode] ${line}`);
    };
    if (child.stderr) createInterface({ input: child.stderr }).on('line', remember);

    return new Promise<Connection>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error(`opencode serve did not report a listening address within ${this.opts.readyTimeoutMs ?? 20_000}ms`));
        child.kill();
      }, this.opts.readyTimeoutMs ?? 20_000);

      if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => {
        // Never log the password line opencode prints when it generates one itself.
        if (!/password/i.test(line)) remember(line);
        const m = /listening on (http:\/\/\S+)/.exec(line);
        if (m?.[1] && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve({ baseUrl: m[1], headers: { Authorization: basicAuth('opencode', password) } });
        }
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(err.code === 'ENOENT'
          ? new BinaryNotFoundError(`opencode binary not found: "${bin}". Set openpane.binaryPath.`)
          : err);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        const msg = `opencode serve exited (code ${code}, signal ${signal})${tail.length ? ': ' + tail.slice(-3).join(' | ') : ''}`;
        this.opts.log(msg);
        if (!ready) reject(new Error(msg));
        else if (!this.stopping) this.opts.onExit(msg);
      });
    });
  }

  private async healthCheck(conn: Connection): Promise<void> {
    const res = await fetch(`${conn.baseUrl}/api/info`, { headers: conn.headers });
    if (res.status === 401) throw new Error(`opencode server at ${conn.baseUrl} rejected the credentials (401)`);
    if (!res.ok) throw new Error(`opencode server at ${conn.baseUrl} is not healthy: HTTP ${res.status}`);
  }
}

/** openpane.serverUrl may carry credentials: http://user:pass@host:port */
function fromUrl(raw: string): Connection {
  const u = new URL(raw);
  const headers: Record<string, string> = {};
  if (u.username || u.password) {
    headers.Authorization = basicAuth(decodeURIComponent(u.username || 'opencode'), decodeURIComponent(u.password));
  }
  u.username = '';
  u.password = '';
  return { baseUrl: u.toString().replace(/\/$/, ''), headers };
}
