import { z } from 'zod';

export const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
export type Position = z.infer<typeof PositionSchema>;

export const RangeSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});
export type Range = z.infer<typeof RangeSchema>;

export const TextEditSchema = z.object({
  range: RangeSchema,
  newText: z.string(),
});
export type TextEdit = z.infer<typeof TextEditSchema>;

export const ETagSchema = z
  .string()
  .regex(/^mtime:\d+\|size:\d+$/);
export type ETag = z.infer<typeof ETagSchema>;

export const DocumentSnapshotSchema = z.object({
  uri: z.string(),
  version: z.number().int().nonnegative(),
  text: z.string(),
  isDirty: z.boolean(),
  lastSavedEtag: ETagSchema.optional(),
  lastSavedMtime: z.number().optional(),
  lastSavedSize: z.number().optional(),
});
export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;

export const RpcErrorSchema = z.object({
  code: z.enum(["conflict", "stale", "notFound", "invalid", "other"]),
  message: z.string(),
  diskEtag: ETagSchema.optional(),
  diskMtime: z.number().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const OpenDocumentRequestSchema = z.object({
  requestId: z.string().uuid(),
  uri: z.string(),
  options: z.object({
    createIfNotExists: z.boolean().optional(),
    encoding: z.enum(["utf-8"]).optional(),
  }).optional(),
});

export const ApplyEditsRequestSchema = z.object({
  requestId: z.string().uuid(),
  uri: z.string(),
  clientId: z.string(),
  baseVersion: z.number().int().nonnegative().optional(),
  edits: z.array(TextEditSchema),
});

export const SaveDocumentRequestSchema = z.object({
  requestId: z.string().uuid(),
  uri: z.string(),
  expectedEtag: ETagSchema.optional(),
});

// Wire-format payloads. The renderer correlates calls via ipcRenderer.invoke and
// does NOT send the requestId present in the *Request schemas, so the actual IPC
// args omit it. These are what the main-process boundary validates against.
export const ApplyEditsPayloadSchema = ApplyEditsRequestSchema.omit({ requestId: true });
export type ApplyEditsPayload = z.infer<typeof ApplyEditsPayloadSchema>;

export const SaveDocumentPayloadSchema = SaveDocumentRequestSchema.omit({ requestId: true });
export type SaveDocumentPayload = z.infer<typeof SaveDocumentPayloadSchema>;

export const UndoRedoRequestSchema = z.object({
  requestId: z.string().uuid(),
  uri: z.string(),
});

export const GetDocumentSnapshotRequestSchema = z.object({
  requestId: z.string().uuid(),
  uri: z.string(),
});

export const VfsReadRequestSchema = z.object({
  requestId: z.string().uuid(),
  uri: z.string(),
});

export const VfsWriteRequestSchema = z.object({
  requestId: z.string().uuid(),
  uri: z.string(),
  text: z.string(),
  expectedEtag: ETagSchema.optional(),
});

export const VfsRenameRequestSchema = z.object({
  requestId: z.string().uuid(),
  fromUri: z.string(),
  toUri: z.string(),
});

export const VfsDeleteRequestSchema = z.object({
  requestId: z.string().uuid(),
  uri: z.string(),
});

export const SearchWorkspaceRequestSchema = z.object({
  requestId: z.string().uuid(),
  root: z.string(),
  query: z.string(),
  caseSensitive: z.boolean().optional(),
  isRegex: z.boolean().optional(),
});

export const DocumentOpenedEventSchema = z.object({
  type: z.literal("document.opened"),
  payload: z.object({
    uri: z.string(),
    version: z.number().int().nonnegative(),
    text: z.string(),
    etag: ETagSchema,
    mtime: z.number(),
    size: z.number(),
  }),
});

export const DocumentChangedEventSchema = z.object({
  type: z.literal("document.changed"),
  payload: z.object({
    uri: z.string(),
    version: z.number().int().nonnegative(),
    changes: z.array(TextEditSchema),
    isDirty: z.boolean(),
    originClientId: z.string().optional(),
  }),
});

export const DocumentSavedEventSchema = z.object({
  type: z.literal("document.saved"),
  payload: z.object({
    uri: z.string(),
    version: z.number().int().nonnegative(),
    etag: ETagSchema,
    mtime: z.number(),
    size: z.number(),
  }),
});

export const DocumentConflictEventSchema = z.object({
  type: z.literal("document.conflict"),
  payload: z.object({
    uri: z.string(),
    localVersion: z.number().int().nonnegative(),
    diskEtag: ETagSchema,
    diskMtime: z.number(),
  }),
});

export const DocumentReloadedEventSchema = z.object({
  type: z.literal("document.reloaded"),
  payload: z.object({
    uri: z.string(),
    version: z.number().int().nonnegative(),
  }),
});

export const VfsChangedEventSchema = z.object({
  type: z.literal("vfs.changed"),
  payload: z.object({
    uri: z.string(),
    changeType: z.enum(["created", "modified", "deleted"]),
    etag: ETagSchema,
    mtime: z.number(),
    size: z.number(),
  }),
});

export const EmberEventSchema = z.discriminatedUnion("type", [
  DocumentOpenedEventSchema,
  DocumentChangedEventSchema,
  DocumentSavedEventSchema,
  DocumentConflictEventSchema,
  DocumentReloadedEventSchema,
  VfsChangedEventSchema,
]);
export type EmberEvent = z.infer<typeof EmberEventSchema>;

// --- Workspace session persistence (M1) ---
// Per-workspace, restorable editor state. Persisted by main (keyed by workspace
// path) and exchanged with the renderer, so it lives here with the other IPC
// shapes. Unsaved-buffer contents are journaled separately, not in this doc.

// Bump when the persisted shape changes incompatibly; @ember/workspace-state
// migrates older documents up to this version.
export const WORKSPACE_SESSION_VERSION = 1;

export const TabStateSchema = z.object({
  uri: z.string(),
  filename: z.string(),
  // 0-based caret position (reuses the canonical Position shape).
  cursor: PositionSchema.optional(),
  // CodeMirror scrollDOM.scrollTop in pixels.
  scrollTop: z.number().nonnegative().optional(),
});
export type TabState = z.infer<typeof TabStateSchema>;

export const EditorGroupStateSchema = z.object({
  id: z.string(),
  tabs: z.array(TabStateSchema),
  activeUri: z.string().nullable(),
});
export type EditorGroupState = z.infer<typeof EditorGroupStateSchema>;

export const WorkspaceSessionSchema = z.object({
  version: z.literal(WORKSPACE_SESSION_VERSION),
  groups: z.array(EditorGroupStateSchema),
  activeGroupId: z.string(),
});
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;
