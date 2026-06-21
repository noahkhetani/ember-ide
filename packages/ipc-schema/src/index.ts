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
  code: z.enum(["conflict", "stale", "notFound", "other"]),
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
