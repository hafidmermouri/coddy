// Applies a single-file unified diff (as sent by opencode in permission metadata and /diff).
// reverse=true turns the new content back into the old one.
export function applyPatch(source: string, patch: string, reverse = false): string | undefined {
  const add = reverse ? '-' : '+';
  const del = reverse ? '+' : '-';
  const src = splitLines(source);
  const out: string[] = [];
  let pos = 0;
  let noNewline = false;
  const lines = patch.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i] ?? '');
    if (!header) continue;
    const start = Number(reverse ? header[2] : header[1]);
    const from = Math.max(start - 1, 0);
    if (from < pos) return undefined;
    out.push(...src.slice(pos, from));
    pos = from;
    let lastTarget = false;
    for (i++; i < lines.length && !(lines[i] ?? '').startsWith('@@'); i++) {
      const l = lines[i] ?? '';
      const tag = l[0];
      const text = l.slice(1);
      if (tag === ' ' || (tag === undefined && i < lines.length - 1)) {
        if (src[pos] !== text) return undefined;
        out.push(text);
        pos++;
        lastTarget = true;
      } else if (tag === del) {
        if (src[pos] !== text) return undefined;
        pos++;
        lastTarget = false;
      } else if (tag === add) {
        out.push(text);
        lastTarget = true;
      } else if (tag === '\\') {
        noNewline = lastTarget;
      }
    }
    i--;
  }
  out.push(...src.slice(pos));
  const body = out.join('\n');
  return out.length === 0 || noNewline ? body : body + '\n';
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
