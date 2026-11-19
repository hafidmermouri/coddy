#!/usr/bin/env node
// Fake `opencode` binary for lifecycle tests. FAKE_DROP_MS closes each event stream after N ms.
import { createServer } from 'node:http';

if (process.argv.includes('--version')) {
  console.log('opencode v9.9.9');
  process.exit(0);
}
const expected = 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64');
const server = createServer((req, res) => {
  if (req.headers.authorization !== expected) return res.writeHead(401).end();
  if (req.url === '/api/info') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pid: process.pid }));
  if (req.url === '/api/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"e1","type":"server.connected","data":{}}\n\n: heartbeat\n\n');
    const drop = Number(process.env.FAKE_DROP_MS || 0);
    if (drop) setTimeout(() => res.destroy(), drop);
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => {
  console.log('server password generated, not printed');
  console.log(`server listening on http://127.0.0.1:${server.address().port}`);
});
process.on('SIGTERM', () => process.exit(0));
