import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { Vfs } from './index';
import { ETagSchema } from '@ember/ipc-schema';

// vfs floors stat.mtimeMs, so etags are integer-only and satisfy ipc-schema's
// ETagSchema. This regex is the strict integer form (no decimal allowed).
const ETAG_RE = /^mtime:\d+\|size:\d+$/;

let tmpDir: string;
let vfs: Vfs;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-vfs-'));
  vfs = new Vfs();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function uri(name: string): string {
  return pathToFileURL(path.join(tmpDir, name)).href;
}

describe('Vfs read/write + ETag', () => {
  it('writes then reads back the same text', async () => {
    const u = uri('a.txt');
    await vfs.write(u, 'hello');
    expect((await vfs.read(u)).text).toBe('hello');
  });

  it('produces an ETag of the form mtime:<ms>|size:<bytes> with byte-accurate size', async () => {
    const u = uri('b.txt');
    const text = 'héllo'; // multi-byte char so size != string length
    const res = await vfs.write(u, text);
    expect(res.etag).toMatch(ETAG_RE);
    expect(res.size).toBe(Buffer.byteLength(text));
    expect(res.etag).toBe(`mtime:${res.mtime}|size:${res.size}`);
  });

  it('creates missing parent directories on write', async () => {
    const u = uri('nested/deep/c.txt');
    await vfs.write(u, 'x');
    expect((await vfs.read(u)).text).toBe('x');
  });

  it('changes the ETag when content changes', async () => {
    const u = uri('g.txt');
    const first = await vfs.write(u, 'one');
    const second = await vfs.write(u, 'longer content');
    expect(second.etag).not.toBe(first.etag);
  });

  it('emits an integer-mtime ETag that satisfies ipc-schema ETagSchema', async () => {
    const u = uri('h.txt');
    const res = await vfs.write(u, 'content');
    expect(Number.isInteger(res.mtime)).toBe(true);
    expect(ETagSchema.safeParse(res.etag).success).toBe(true);
    // read() must produce the same schema-valid etag shape
    expect(ETagSchema.safeParse((await vfs.read(u)).etag).success).toBe(true);
  });
});

describe('Vfs write-conflict detection', () => {
  it('succeeds when expectedEtag matches the current on-disk etag', async () => {
    const u = uri('d.txt');
    const first = await vfs.write(u, 'one');
    await vfs.write(u, 'two', first.etag);
    expect((await vfs.read(u)).text).toBe('two');
  });

  it('throws code "conflict" (with diskEtag) when expectedEtag is stale, leaving content intact', async () => {
    const u = uri('e.txt');
    const first = await vfs.write(u, 'one');
    await expect(
      vfs.write(u, 'two', 'mtime:1|size:1')
    ).rejects.toMatchObject({ code: 'conflict', diskEtag: first.etag });
    expect((await vfs.read(u)).text).toBe('one');
  });
});

describe('Vfs stat', () => {
  it('reports exists:false for a missing file', async () => {
    expect(await vfs.stat(uri('missing.txt'))).toEqual({ exists: false });
  });

  it('reports exists:true with an etag for an existing file', async () => {
    const u = uri('f.txt');
    await vfs.write(u, 'data');
    const s = await vfs.stat(u);
    expect(s.exists).toBe(true);
    expect(s.etag).toMatch(ETAG_RE);
  });
});
