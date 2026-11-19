// Starts `opencode serve`, downloads /openapi.json into spec/, records the binary
// version in spec/VERSION and regenerates src/generated/api.ts.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const bin = process.env.OPENCODE_BIN || 'opencode';
const password = randomBytes(16).toString('hex');
const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().replace(/^opencode\s+v?/, '');

const child = spawn(bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  stdio: ['ignore', 'pipe', 'inherit'],
});

try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('opencode serve did not start within 20s')), 20_000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      const m = /listening on (http:\/\/\S+)/.exec(line);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => reject(new Error(`opencode serve exited with ${code}`)));
  });
  const res = await fetch(`${url}/openapi.json`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') },
  });
  if (!res.ok) throw new Error(`GET /openapi.json -> ${res.status}`);
  writeFileSync('spec/openapi.json', JSON.stringify(await res.json(), null, 1));
  writeFileSync('spec/VERSION', version + '\n');
  execFileSync('npx', ['openapi-typescript', 'spec/openapi.json', '-o', 'src/generated/api.ts'], { stdio: 'inherit' });
  console.log(`spec and types generated for opencode v${version}`);
} finally {
  child.kill();
}
