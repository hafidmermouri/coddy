import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/sse';

describe('SseParser', () => {
  it('parses events split across chunks and ignores comments', () => {
    const p = new SseParser();
    expect(p.push('data: {"a"')).toEqual([]);
    expect(p.push(':1}\n\n: heartbeat\n\ndata: x\r\n\r\n')).toEqual(['{"a":1}', 'x']);
  });

  it('joins multi-line data fields', () => {
    expect(new SseParser().push('data: a\ndata:b\n\n')).toEqual(['a\nb']);
  });
});
