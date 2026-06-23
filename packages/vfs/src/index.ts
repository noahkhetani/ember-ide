import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as chokidar from 'chokidar';
import type { ETag } from '@ember/ipc-schema';

function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return fileURLToPath(uri);
  }
  return uri;
}

function computeEtag(mtime: number, size: number): ETag {
  return `mtime:${mtime}|size:${size}` as ETag;
}

async function statEtag(filePath: string): Promise<{ etag: ETag; mtime: number; size: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    // Floor to whole milliseconds: stat.mtimeMs is fractional on some platforms,
    // and the ETag is the canonical change-detector that must satisfy
    // ipc-schema's integer-only ETagSchema (mtime:<ms>|size:<bytes>).
    const mtime = Math.floor(stat.mtimeMs);
    const size = stat.size;
    return { etag: computeEtag(mtime, size), mtime, size };
  } catch {
    return null;
  }
}

export interface VfsEntry {
  name: string;
  uri: string;
  isDirectory: boolean;
  mtime: number;
  size: number;
}

export interface VfsReadResult {
  text: string;
  etag: ETag;
  mtime: number;
  size: number;
}

export interface VfsWriteResult {
  etag: ETag;
  mtime: number;
  size: number;
}

export interface VfsStatResult {
  exists: boolean;
  etag?: ETag;
  mtime?: number;
  size?: number;
}

export type VfsChangeType = 'created' | 'modified' | 'deleted';

export interface VfsChangeEvent {
  uri: string;
  changeType: VfsChangeType;
  etag: ETag;
  mtime: number;
  size: number;
}

export type VfsWatchListener = (event: VfsChangeEvent) => void;

export class Vfs {
  private watchers = new Map<string, chokidar.FSWatcher>();
  private listenerMap = new Map<string, Set<VfsWatchListener>>();

  async read(uri: string): Promise<VfsReadResult> {
    const filePath = uriToPath(uri);
    const text = await fs.readFile(filePath, 'utf-8');
    const info = await statEtag(filePath);
    if (!info) throw new Error(`File not found: ${uri}`);
    return { text, ...info };
  }

  async write(uri: string, text: string, expectedEtag?: string): Promise<VfsWriteResult> {
    const filePath = uriToPath(uri);
    if (expectedEtag) {
      const current = await statEtag(filePath);
      if (current && current.etag !== expectedEtag) {
        throw Object.assign(new Error('Write conflict'), { code: 'conflict', diskEtag: current.etag, diskMtime: current.mtime });
      }
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, 'utf-8');
    const info = await statEtag(filePath);
    if (!info) throw new Error(`Failed to write file: ${uri}`);
    return info;
  }

  async stat(uri: string): Promise<VfsStatResult> {
    const filePath = uriToPath(uri);
    const info = await statEtag(filePath);
    if (!info) return { exists: false };
    return { exists: true, ...info };
  }

  async list(uri: string): Promise<VfsEntry[]> {
    const dirPath = uriToPath(uri);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results: VfsEntry[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      let mtime = 0;
      let size = 0;
      try {
        const stat = await fs.stat(fullPath);
        mtime = stat.mtimeMs;
        size = stat.size;
      } catch {}
      results.push({
        name: entry.name,
        uri: pathToFileURL(fullPath).href,
        isDirectory: entry.isDirectory(),
        mtime,
        size,
      });
    }
    return results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async mkdir(uri: string): Promise<void> {
    const dirPath = uriToPath(uri);
    await fs.mkdir(dirPath, { recursive: true });
  }

  async rename(fromUri: string, toUri: string): Promise<void> {
    const fromPath = uriToPath(fromUri);
    const toPath = uriToPath(toUri);
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
  }

  async delete(uri: string): Promise<void> {
    const target = uriToPath(uri);
    await fs.rm(target, { recursive: true, force: true });
  }

  watch(uri: string, listener: VfsWatchListener): () => void {
    const dirPath = uriToPath(uri);
    if (!this.listenerMap.has(uri)) {
      this.listenerMap.set(uri, new Set());
    }
    this.listenerMap.get(uri)!.add(listener);

    if (!this.watchers.has(uri)) {
      const watcher = chokidar.watch(dirPath, {
        ignoreInitial: true,
        persistent: true,
        // Skip heavy / noisy directories that an editor never needs to react to.
        ignored: /[/\\](node_modules|\.git|dist|\.cache)[/\\]/,
      });
      this.watchers.set(uri, watcher);

      const notify = async (changeType: VfsChangeType, filePath: string) => {
        const fileUri = pathToFileURL(filePath).href;
        let info = await statEtag(filePath);
        if (!info) {
          // Deleted files have no stat; emit a sentinel so listeners still fire.
          if (changeType === 'deleted') {
            info = { etag: computeEtag(0, 0), mtime: 0, size: 0 };
          } else {
            return;
          }
        }
        const listeners = this.listenerMap.get(uri);
        if (!listeners) return;
        const event: VfsChangeEvent = { uri: fileUri, changeType, ...info };
        for (const fn of listeners) {
          try { fn(event); } catch {}
        }
      };

      watcher.on('add', (p) => notify('created', p));
      watcher.on('change', (p) => notify('modified', p));
      watcher.on('unlink', (p) => notify('deleted', p));
    }

    return () => {
      const listeners = this.listenerMap.get(uri);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          const watcher = this.watchers.get(uri);
          if (watcher) {
            watcher.close();
            this.watchers.delete(uri);
          }
          this.listenerMap.delete(uri);
        }
      }
    };
  }
}
