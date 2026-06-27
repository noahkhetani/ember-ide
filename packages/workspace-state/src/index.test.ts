import { describe, it, expect } from 'vitest';
import { WorkspaceSessionSchema, WORKSPACE_SESSION_VERSION } from '@ember/ipc-schema';
import {
  createEmptySession,
  serialize,
  deserialize,
  migrate,
  PRIMARY_GROUP_ID,
} from './index';

const sampleSession = {
  version: WORKSPACE_SESSION_VERSION,
  activeGroupId: PRIMARY_GROUP_ID,
  groups: [
    {
      id: PRIMARY_GROUP_ID,
      activeUri: 'file:///a.ts',
      tabs: [
        { uri: 'file:///a.ts', filename: 'a.ts', cursor: { line: 2, character: 4 }, scrollTop: 80 },
        { uri: 'file:///b.ts', filename: 'b.ts' },
      ],
    },
  ],
};

describe('createEmptySession', () => {
  it('produces a schema-valid session with one empty primary group', () => {
    const s = createEmptySession();
    expect(WorkspaceSessionSchema.safeParse(s).success).toBe(true);
    expect(s.activeGroupId).toBe(PRIMARY_GROUP_ID);
    expect(s.groups).toEqual([{ id: PRIMARY_GROUP_ID, tabs: [], activeUri: null }]);
  });
});

describe('serialize / deserialize', () => {
  it('round-trips a non-trivial session', () => {
    expect(deserialize(serialize(sampleSession))).toEqual(sampleSession);
  });

  it('falls back to an empty session on malformed JSON', () => {
    expect(deserialize('{not valid json')).toEqual(createEmptySession());
  });

  it('falls back to an empty session on a wrong-shaped object', () => {
    expect(deserialize(JSON.stringify({ hello: 'world' }))).toEqual(createEmptySession());
  });

  it('falls back to an empty session on an unrecognized version', () => {
    expect(deserialize(JSON.stringify({ ...sampleSession, version: 999 }))).toEqual(
      createEmptySession()
    );
  });
});

describe('migrate', () => {
  it('returns the session for a valid current-version document', () => {
    expect(migrate(sampleSession)).toEqual(sampleSession);
  });

  it('returns null for an unrecoverable document', () => {
    expect(migrate({ version: 'nope' })).toBeNull();
    expect(migrate(null)).toBeNull();
  });
});
