import type { DocumentSnapshot, TextEdit, ETag } from '@ember/ipc-schema';
import { Vfs } from '@ember/vfs';

export interface ApplyEditsResult {
  newVersion: number;
  isDirty: boolean;
}

export interface SaveResult {
  version: number;
  etag: ETag;
  mtime: number;
  size: number;
}

export type DocumentEventType = 'opened' | 'changed' | 'saved' | 'closed' | 'conflict';

export interface DocumentEvent {
  type: DocumentEventType;
  uri: string;
  payload: unknown;
}

export type DocumentEventHandler = (event: DocumentEvent) => void;

interface DocState {
  uri: string;
  text: string;
  version: number;
  isDirty: boolean;
  lastSavedEtag?: ETag;
  lastSavedMtime?: number;
  lastSavedSize?: number;
}

interface HistoryEntry {
  forwardEdits: TextEdit[];
  inverseEdits: TextEdit[];
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line)
      return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });

  const lines = text.split('\n');

  for (const edit of sorted) {
    const { start, end } = edit.range;
    const startOffset = offsetAt(lines, start);
    const endOffset = offsetAt(lines, end);
    const before = text.slice(0, startOffset);
    const after = text.slice(endOffset);
    text = before + edit.newText + after;
    const newLines = text.split('\n');
    lines.length = 0;
    lines.push(...newLines);
  }

  return text;
}

function offsetAt(lines: string[], pos: { line: number; character: number }): number {
  let offset = 0;
  for (let i = 0; i < pos.line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset + pos.character;
}

// Build the edits that, when applied to the post-edit text, restore the
// original text. Forward `edits` are expressed in original-text coordinates;
// the returned inverse edits are expressed in the resulting (post-edit) text
// coordinates, accounting for the cumulative length shift of earlier edits.
function computeInverseEdits(originalText: string, edits: TextEdit[]): TextEdit[] {
  if (edits.length === 0) return [];

  const baseLines = originalText.split('\n');
  const newText = applyTextEdits(originalText, edits);
  const newLines = newText.split('\n');

  const ordered = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return a.range.start.line - b.range.start.line;
    }
    return a.range.start.character - b.range.start.character;
  });

  const result: TextEdit[] = [];
  let delta = 0;
  for (const edit of ordered) {
    const startOffset = offsetAt(baseLines, edit.range.start);
    const endOffset = offsetAt(baseLines, edit.range.end);
    const replacedText = originalText.slice(startOffset, endOffset);
    const newStart = startOffset + delta;
    const newEnd = newStart + edit.newText.length;
    result.push({
      range: {
        start: positionAt(newText, newStart, newLines),
        end: positionAt(newText, newEnd, newLines),
      },
      newText: replacedText,
    });
    delta += edit.newText.length - (endOffset - startOffset);
  }
  return result;
}

function positionAt(text: string, offset: number, _lines?: string[]): { line: number; character: number } {
  const lines = _lines ?? text.split('\n');
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    if (remaining <= lines[i].length) {
      return { line: i, character: remaining };
    }
    remaining -= lines[i].length + 1;
  }
  const last = lines.length - 1;
  return { line: last, character: lines[last]?.length ?? 0 };
}

export class DocumentStore {
  private vfs: Vfs;
  private docs = new Map<string, DocState>();
  private undoStacks = new Map<string, HistoryEntry[]>();
  private redoStacks = new Map<string, HistoryEntry[]>();
  private handlers = new Map<string, Set<DocumentEventHandler>>();

  constructor(vfs: Vfs) {
    this.vfs = vfs;
  }

  async openDocument(
    uri: string,
    options?: { createIfNotExists?: boolean; encoding?: 'utf-8' }
  ): Promise<DocumentSnapshot> {
    const existing = this.docs.get(uri);
    if (existing) {
      return this.buildSnapshot(existing);
    }

    let readResult;
    try {
      readResult = await this.vfs.read(uri);
    } catch {
      if (options?.createIfNotExists) {
        await this.vfs.write(uri, '');
        readResult = await this.vfs.read(uri);
      } else {
        throw Object.assign(new Error(`File not found: ${uri}`), { code: 'notFound' });
      }
    }

    const state: DocState = {
      uri,
      text: readResult.text,
      version: 0,
      isDirty: false,
      lastSavedEtag: readResult.etag,
      lastSavedMtime: readResult.mtime,
      lastSavedSize: readResult.size,
    };
    this.docs.set(uri, state);
    this.undoStacks.set(uri, []);
    this.redoStacks.set(uri, []);

    this.emit('opened', uri, {
      uri,
      version: 0,
      text: readResult.text,
      etag: readResult.etag,
      mtime: readResult.mtime,
      size: readResult.size,
    });

    return this.buildSnapshot(state);
  }

  async applyEdits(
    uri: string,
    clientId: string,
    baseVersion: number | undefined,
    edits: TextEdit[]
  ): Promise<ApplyEditsResult> {
    const state = this.docs.get(uri);
    if (!state) {
      throw Object.assign(new Error(`Document not open: ${uri}`), { code: 'notFound' });
    }

    if (baseVersion !== undefined && baseVersion !== state.version) {
      throw Object.assign(new Error('Stale base version'), { code: 'stale' });
    }

    const originalText = state.text;

    const inverseEdits = computeInverseEdits(originalText, edits);

    state.text = applyTextEdits(state.text, edits);
    state.version++;
    state.isDirty = true;

    const undoStack = this.undoStacks.get(uri)!;
    undoStack.push({ forwardEdits: edits, inverseEdits });
    this.redoStacks.get(uri)!.length = 0;

    this.emit('changed', uri, {
      uri,
      version: state.version,
      changes: edits,
      isDirty: state.isDirty,
      originClientId: clientId,
    });

    return { newVersion: state.version, isDirty: state.isDirty };
  }

  async saveDocument(uri: string, expectedEtag?: string): Promise<SaveResult> {
    const state = this.docs.get(uri);
    if (!state) {
      throw Object.assign(new Error(`Document not open: ${uri}`), { code: 'notFound' });
    }

    const etag = expectedEtag ?? state.lastSavedEtag;
    const result = await this.vfs.write(uri, state.text, etag);

    state.isDirty = false;
    state.lastSavedEtag = result.etag;
    state.lastSavedMtime = result.mtime;
    state.lastSavedSize = result.size;

    this.emit('saved', uri, {
      uri,
      version: state.version,
      etag: result.etag,
      mtime: result.mtime,
      size: result.size,
    });

    return { version: state.version, ...result };
  }

  async undo(uri: string, clientId: string): Promise<ApplyEditsResult | undefined> {
    const undoStack = this.undoStacks.get(uri);
    if (!undoStack || undoStack.length === 0) return undefined;
    const state = this.docs.get(uri);
    if (!state) return undefined;

    const entry = undoStack.pop()!;
    state.text = applyTextEdits(state.text, entry.inverseEdits);
    state.version++;
    state.isDirty = true;

    const redoStack = this.redoStacks.get(uri)!;
    redoStack.push(entry);

    this.emit('changed', uri, {
      uri,
      version: state.version,
      changes: entry.inverseEdits,
      isDirty: state.isDirty,
      originClientId: clientId,
    });

    return { newVersion: state.version, isDirty: state.isDirty };
  }

  async redo(uri: string, clientId: string): Promise<ApplyEditsResult | undefined> {
    const redoStack = this.redoStacks.get(uri);
    if (!redoStack || redoStack.length === 0) return undefined;
    const state = this.docs.get(uri);
    if (!state) return undefined;

    const entry = redoStack.pop()!;
    state.text = applyTextEdits(state.text, entry.forwardEdits);
    state.version++;
    state.isDirty = true;

    const undoStack = this.undoStacks.get(uri)!;
    undoStack.push(entry);

    this.emit('changed', uri, {
      uri,
      version: state.version,
      changes: entry.forwardEdits,
      isDirty: state.isDirty,
      originClientId: clientId,
    });

    return { newVersion: state.version, isDirty: state.isDirty };
  }

  async getDocumentSnapshot(uri: string): Promise<DocumentSnapshot | undefined> {
    const state = this.docs.get(uri);
    if (!state) return undefined;
    return this.buildSnapshot(state);
  }

  hasDocument(uri: string): boolean {
    return this.docs.has(uri);
  }

  isDirty(uri: string): boolean {
    return this.docs.get(uri)?.isDirty ?? false;
  }

  getLastSavedEtag(uri: string): ETag | undefined {
    return this.docs.get(uri)?.lastSavedEtag;
  }

  getVersion(uri: string): number | undefined {
    return this.docs.get(uri)?.version;
  }

  // Re-read the file from disk, replacing the in-memory buffer. Used when an
  // external process modified the file while it was open and clean.
  async reloadFromDisk(uri: string): Promise<DocumentSnapshot | undefined> {
    const state = this.docs.get(uri);
    if (!state) return undefined;

    const read = await this.vfs.read(uri);
    state.text = read.text;
    state.version++;
    state.isDirty = false;
    state.lastSavedEtag = read.etag;
    state.lastSavedMtime = read.mtime;
    state.lastSavedSize = read.size;

    // The on-disk content is a new baseline; discard edit history.
    this.undoStacks.set(uri, []);
    this.redoStacks.set(uri, []);

    this.emit('changed', uri, {
      uri,
      version: state.version,
      changes: [],
      isDirty: false,
      originClientId: 'reload',
    });

    return this.buildSnapshot(state);
  }

  async closeDocument(uri: string): Promise<void> {
    const state = this.docs.get(uri);
    if (!state) return;

    this.docs.delete(uri);
    this.undoStacks.delete(uri);
    this.redoStacks.delete(uri);

    this.emit('closed', uri, { uri });
  }

  on(eventType: string, handler: DocumentEventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
  }

  private emit(type: DocumentEventType, uri: string, payload: unknown): void {
    const event: DocumentEvent = { type, uri, payload };
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const fn of handlers) {
        try { fn(event); } catch {}
      }
    }
    const allHandlers = this.handlers.get('*');
    if (allHandlers) {
      for (const fn of allHandlers) {
        try { fn(event); } catch {}
      }
    }
  }

  private buildSnapshot(state: DocState): DocumentSnapshot {
    return {
      uri: state.uri,
      version: state.version,
      text: state.text,
      isDirty: state.isDirty,
      lastSavedEtag: state.lastSavedEtag,
      lastSavedMtime: state.lastSavedMtime,
      lastSavedSize: state.lastSavedSize,
    };
  }
}
