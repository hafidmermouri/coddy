import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatch } from '../src/patch';

const patch = `Index: a.txt
===================================================================
--- a.txt
+++ a.txt
@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
 four
@@ -8,2 +8,3 @@
 eight
 nine
+ten
`;
const before = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n';
const after = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';

describe('applyPatch', () => {
  it('applies forward and reverse', () => {
    expect(applyPatch(before, patch)).toBe(after);
    expect(applyPatch(after, patch, true)).toBe(before);
  });

  it('returns undefined when context does not match', () => {
    expect(applyPatch('something else\n', patch)).toBeUndefined();
  });

  it('reverse-applies a git-format patch from /api/session/{id}/diff (added file)', () => {
    const git = 'diff --git a/hello.txt b/hello.txt\nnew file mode 100644\nindex 0000000..32f95c0\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hi\n\\ No newline at end of file\n';
    expect(applyPatch('hi', git, true)).toBe('');
  });

  it('applies the recorded add-file patch, honouring "no newline at end of file"', () => {
    const events = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/edit.events.json'), 'utf8')) as {
      type: string; data: { metadata?: { files?: { patch: string }[] } };
    }[];
    const asked = events.find((e) => e.type === 'permission.asked')!;
    expect(applyPatch('', asked.data.metadata!.files![0]!.patch)).toBe('hi');
  });
});
