import {
  WorkspaceSessionSchema,
  WORKSPACE_SESSION_VERSION,
  type WorkspaceSession,
} from '@ember/ipc-schema';

// The default editor group id. Shared so a restored session and a freshly
// created one agree on the primary group's identity.
export const PRIMARY_GROUP_ID = 'group-primary';

// A blank session: one empty primary group, nothing open. Used on first launch
// and as the resilient fallback whenever a stored session can't be recovered.
export function createEmptySession(): WorkspaceSession {
  return {
    version: WORKSPACE_SESSION_VERSION,
    activeGroupId: PRIMARY_GROUP_ID,
    groups: [{ id: PRIMARY_GROUP_ID, tabs: [], activeUri: null }],
  };
}

export function serialize(session: WorkspaceSession): string {
  return JSON.stringify(session);
}

// Bring an unknown, already-JSON-parsed value up to the current session shape.
// Returns null if it can't be recovered. Future schema bumps add version-keyed
// upgrade steps here BEFORE the final validate.
export function migrate(data: unknown): WorkspaceSession | null {
  // (no historical versions yet — v1 is the first persisted shape)
  const result = WorkspaceSessionSchema.safeParse(data);
  return result.success ? result.data : null;
}

// Parse stored JSON into a valid session. Never throws: malformed JSON or an
// unrecoverable shape falls back to an empty session, so a corrupt file can
// never block startup.
export function deserialize(raw: string): WorkspaceSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createEmptySession();
  }
  return migrate(parsed) ?? createEmptySession();
}
