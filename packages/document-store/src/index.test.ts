import { describe, it, expect } from 'vitest';
import { DocumentStore } from './index';
import type { Vfs } from '@ember/vfs';
import type { TextEdit } from '@ember/ipc-schema';

const URI = 'file:///tmp/doc.txt';

// Minimal in-memory Vfs so these stay true unit tests (no disk I/O). Only the
// methods DocumentStore actually calls (read/write) are implemented.
function makeStore(initialText: string): DocumentStore {
  let current = initialText;
  const size = (): number => Buffer.byteLength(current);
  const fakeVfs = {
    read: async () => ({ text: current, etag: `mtime:1|size:${size()}`, mtime: 1, size: size() }),
    write: async (_uri: string, text: string) => {
      current = text;
      return { etag: `mtime:2|size:${size()}`, mtime: 2, size: size() };
    },
  } as unknown as Vfs;
  return new DocumentStore(fakeVfs);
}

function replace(line: number, startCh: number, endCh: number, newText: string): TextEdit {
  return { range: { start: { line, character: startCh }, end: { line, character: endCh } }, newText };
}

describe('DocumentStore undo/redo', () => {
  it('applies an edit, then undo and redo restore the exact text', async () => {
    const store = makeStore('hello world');
    await store.openDocument(URI);

    const applied = await store.applyEdits(URI, 'c1', 0, [replace(0, 6, 11, 'there')]);
    expect(applied.newVersion).toBe(1);
    expect(applied.isDirty).toBe(true);
    expect((await store.getDocumentSnapshot(URI))?.text).toBe('hello there');

    expect(await store.undo(URI, 'c1')).toBeDefined();
    expect((await store.getDocumentSnapshot(URI))?.text).toBe('hello world');

    expect(await store.redo(URI, 'c1')).toBeDefined();
    expect((await store.getDocumentSnapshot(URI))?.text).toBe('hello there');
  });

  it('round-trips a multi-line edit through undo', async () => {
    const store = makeStore('line1\nline2\nline3');
    await store.openDocument(URI);

    // Replace "line2\nline3" with "X" -> collapses three lines into two.
    await store.applyEdits(URI, 'c1', 0, [replace(1, 0, 5 + 1 + 5, 'X')]);
    expect((await store.getDocumentSnapshot(URI))?.text).toBe('line1\nX');

    await store.undo(URI, 'c1');
    expect((await store.getDocumentSnapshot(URI))?.text).toBe('line1\nline2\nline3');
  });

  it('returns undefined when there is nothing to undo', async () => {
    const store = makeStore('abc');
    await store.openDocument(URI);
    expect(await store.undo(URI, 'c1')).toBeUndefined();
  });
});

describe('DocumentStore version guarding', () => {
  it('rejects edits made against a stale base version', async () => {
    const store = makeStore('hello world');
    await store.openDocument(URI);
    await store.applyEdits(URI, 'c1', 0, [replace(0, 0, 0, 'X')]); // version 0 -> 1

    await expect(
      store.applyEdits(URI, 'c1', 0, [replace(0, 0, 0, 'Y')]) // baseVersion 0 is now stale
    ).rejects.toMatchObject({ code: 'stale' });
  });

  it('accepts edits when baseVersion is omitted (no guard)', async () => {
    const store = makeStore('hello world');
    await store.openDocument(URI);
    await store.applyEdits(URI, 'c1', 0, [replace(0, 0, 0, 'X')]); // version -> 1
    const r = await store.applyEdits(URI, 'c1', undefined, [replace(0, 0, 0, 'Y')]);
    expect(r.newVersion).toBe(2);
  });
});
