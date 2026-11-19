// Minimal SSE client for GET /api/event: streaming fetch with auth header,
// incremental parser, reconnect with exponential backoff. Every retry is logged.

/** Incremental text/event-stream parser. Returns the `data` payload of each complete event. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line === '') {
        if (this.data.length) out.push(this.data.join('\n'));
        this.data = [];
      } else if (line.startsWith('data:')) {
        this.data.push(line.slice(line[5] === ' ' ? 6 : 5));
      } // comments (": heartbeat"), event:, id:, retry: are not used by opencode payloads
    }
    return out;
  }
}

export interface EventStreamOptions {
  url: string;
  headers: Record<string, string>;
  onEvent: (payload: unknown) => void;
  /** Called after the stream (re)connects. `reconnected` is true when events may have been missed. */
  onOpen: (reconnected: boolean) => void;
  onRetry: (attempt: number, delayMs: number, reason: string) => void;
  log: (msg: string) => void;
  maxDelayMs?: number;
}

export class EventStream {
  private abort?: AbortController;
  private stopped = false;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: EventStreamOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect(false);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort?.abort();
  }

  private async connect(reconnected: boolean): Promise<void> {
    this.abort = new AbortController();
    let reason = 'stream ended';
    try {
      const res = await fetch(this.opts.url, {
        headers: { ...this.opts.headers, Accept: 'text/event-stream' },
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.attempt = 0;
      this.opts.log(`event stream connected${reconnected ? ' (reconnected)' : ''}`);
      this.opts.onOpen(reconnected);
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        for (const payload of parser.push(decoder.decode(chunk, { stream: true }))) {
          try {
            this.opts.onEvent(JSON.parse(payload));
          } catch (e) {
            this.opts.log(`dropped malformed event: ${String(e)}: ${payload.slice(0, 200)}`);
          }
        }
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (this.stopped) return;
    this.attempt++;
    const delay = Math.min(500 * 2 ** (this.attempt - 1), this.opts.maxDelayMs ?? 10_000);
    this.opts.log(`event stream lost (${reason}); retry #${this.attempt} in ${delay}ms`);
    this.opts.onRetry(this.attempt, delay, reason);
    this.timer = setTimeout(() => void this.connect(true), delay);
  }
}
