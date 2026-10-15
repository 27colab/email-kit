import { describe, expect, it } from 'vitest';
import { batchAttachments, type Attachment } from '../src/index.js';

const file = (name: string, bytes: number): Attachment => ({ filename: name, content: new Uint8Array(bytes) });

describe('batchAttachments', () => {
  it('packs by size preserving order', () => {
    const { batches, oversized } = batchAttachments([file('a', 6), file('b', 6), file('c', 3), file('d', 9)], { maxBytes: 10 });
    expect(batches.map((b) => b.map((x) => x.filename))).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(oversized).toEqual([]);
  });

  it('packs by count', () => {
    const { batches } = batchAttachments([file('a', 1), file('b', 1), file('c', 1)], { maxCount: 2 });
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
  });

  it('reports oversized files instead of dropping them', () => {
    const { batches, oversized } = batchAttachments([file('big', 50), file('ok', 1)], { maxBytes: 10 });
    expect(oversized.map((x) => x.filename)).toEqual(['big']);
    expect(batches).toHaveLength(1);
  });

  it('sizes base64 strings by decoded length', () => {
    const { batches } = batchAttachments([{ filename: 'x', content: 'aGVsbG8gd29ybGQ=' }], { maxBytes: 11 });
    expect(batches).toHaveLength(1);
  });

  it('returns nothing for no input', () => {
    expect(batchAttachments([])).toEqual({ batches: [], oversized: [] });
  });
});
