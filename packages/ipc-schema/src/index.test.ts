import { describe, it, expect } from 'vitest';
import {
  ETagSchema,
  DocumentSnapshotSchema,
  ApplyEditsPayloadSchema,
  SaveDocumentPayloadSchema,
  WorkspaceSessionSchema,
  WORKSPACE_SESSION_VERSION,
} from './index';

describe('ETagSchema', () => {
  it('accepts the canonical "mtime:<ms>|size:<bytes>" form', () => {
    expect(ETagSchema.safeParse('mtime:123|size:45').success).toBe(true);
  });

  it('rejects malformed etags', () => {
    expect(ETagSchema.safeParse('not-an-etag').success).toBe(false);
    expect(ETagSchema.safeParse('mtime:123|size:').success).toBe(false);
    expect(ETagSchema.safeParse('size:45|mtime:123').success).toBe(false);
  });
});

describe('DocumentSnapshotSchema', () => {
  it('parses a valid snapshot and round-trips its fields', () => {
    const snapshot = {
      uri: 'file:///tmp/example.ts',
      version: 3,
      text: 'const x = 1;\n',
      isDirty: true,
      lastSavedEtag: 'mtime:1000|size:12',
      lastSavedMtime: 1000,
      lastSavedSize: 12,
    };
    const parsed = DocumentSnapshotSchema.parse(snapshot);
    expect(parsed).toEqual(snapshot);
  });

  it('rejects a snapshot with a negative version', () => {
    expect(
      DocumentSnapshotSchema.safeParse({
        uri: 'file:///tmp/example.ts',
        version: -1,
        text: '',
        isDirty: false,
      }).success
    ).toBe(false);
  });
});

describe('ApplyEditsPayloadSchema (wire format, no requestId)', () => {
  const edit = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    newText: 'x',
  };

  it('accepts the payload the renderer actually sends', () => {
    expect(
      ApplyEditsPayloadSchema.safeParse({
        uri: 'file:///a.ts',
        clientId: 'c1',
        baseVersion: 0,
        edits: [edit],
      }).success
    ).toBe(true);
  });

  it('accepts an omitted baseVersion and an empty edit list', () => {
    expect(
      ApplyEditsPayloadSchema.safeParse({ uri: 'file:///a.ts', clientId: 'c1', edits: [] }).success
    ).toBe(true);
  });

  it('rejects missing edits, wrong edit type, and malformed edits', () => {
    expect(ApplyEditsPayloadSchema.safeParse({ uri: 'file:///a.ts', clientId: 'c1' }).success).toBe(false);
    expect(
      ApplyEditsPayloadSchema.safeParse({ uri: 'file:///a.ts', clientId: 'c1', edits: 'nope' }).success
    ).toBe(false);
    expect(
      ApplyEditsPayloadSchema.safeParse({
        uri: 'file:///a.ts',
        clientId: 'c1',
        edits: [{ newText: 'x' }],
      }).success
    ).toBe(false);
  });
});

describe('SaveDocumentPayloadSchema', () => {
  it('accepts { uri } and { uri, expectedEtag }', () => {
    expect(SaveDocumentPayloadSchema.safeParse({ uri: 'file:///a.ts' }).success).toBe(true);
    expect(
      SaveDocumentPayloadSchema.safeParse({ uri: 'file:///a.ts', expectedEtag: 'mtime:1|size:2' }).success
    ).toBe(true);
  });

  it('rejects a malformed expectedEtag', () => {
    expect(
      SaveDocumentPayloadSchema.safeParse({ uri: 'file:///a.ts', expectedEtag: 'not-an-etag' }).success
    ).toBe(false);
  });
});

describe('WorkspaceSessionSchema', () => {
  const validSession = {
    version: WORKSPACE_SESSION_VERSION,
    activeGroupId: 'group-primary',
    groups: [
      {
        id: 'group-primary',
        activeUri: 'file:///a.ts',
        tabs: [
          { uri: 'file:///a.ts', filename: 'a.ts', cursor: { line: 3, character: 5 }, scrollTop: 120 },
          { uri: 'file:///b.ts', filename: 'b.ts' }, // cursor/scroll optional
        ],
      },
    ],
  };

  it('parses a full session and round-trips it', () => {
    const parsed = WorkspaceSessionSchema.parse(validSession);
    expect(parsed).toEqual(validSession);
  });

  it('accepts an empty group with a null activeUri', () => {
    expect(
      WorkspaceSessionSchema.safeParse({
        version: WORKSPACE_SESSION_VERSION,
        activeGroupId: 'group-primary',
        groups: [{ id: 'group-primary', activeUri: null, tabs: [] }],
      }).success
    ).toBe(true);
  });

  it('rejects a mismatched version (forces migration upstream)', () => {
    expect(WorkspaceSessionSchema.safeParse({ ...validSession, version: 0 }).success).toBe(false);
  });

  it('rejects a negative scrollTop and a malformed cursor', () => {
    expect(
      WorkspaceSessionSchema.safeParse({
        ...validSession,
        groups: [{ id: 'g', activeUri: null, tabs: [{ uri: 'file:///a', filename: 'a', scrollTop: -1 }] }],
      }).success
    ).toBe(false);
    expect(
      WorkspaceSessionSchema.safeParse({
        ...validSession,
        groups: [
          { id: 'g', activeUri: null, tabs: [{ uri: 'file:///a', filename: 'a', cursor: { line: 1 } }] },
        ],
      }).success
    ).toBe(false);
  });
});
