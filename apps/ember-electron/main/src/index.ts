import { app, BrowserWindow, Menu, ipcMain, dialog } from 'electron';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { pathToFileURL, fileURLToPath } from 'url';
import { simpleGit, type SimpleGit } from 'simple-git';
import { z } from 'zod';
import { Vfs } from '@ember/vfs';
import { DocumentStore } from '@ember/document-store';
import {
  ApplyEditsPayloadSchema,
  SaveDocumentPayloadSchema,
  type EmberEvent,
} from '@ember/ipc-schema';

interface GitFileStatus {
  path: string;
  uri: string;
  index: string;
  working: string;
}

interface GitStatus {
  branch: string;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
}

async function getGit(rootHref: string): Promise<{ git: SimpleGit; rootPath: string } | null> {
  let rootPath: string;
  try {
    rootPath = fileURLToPath(rootHref);
  } catch {
    return null;
  }
  const git = simpleGit(rootPath);
  const isRepo = await git.checkIsRepo().catch(() => false);
  return isRepo ? { git, rootPath } : null;
}

async function gitStatus(rootHref: string): Promise<GitStatus | null> {
  const ctx = await getGit(rootHref);
  if (!ctx) return null;
  const status = await ctx.git.status();
  const toEntry = (p: string, index: string, working: string): GitFileStatus => ({
    path: p,
    uri: pathToFileURL(path.join(ctx.rootPath, p)).href,
    index,
    working,
  });

  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  for (const f of status.files) {
    const index = f.index ?? ' ';
    const working = f.working_dir ?? ' ';
    if (index !== ' ' && index !== '?') staged.push(toEntry(f.path, index, working));
    if (working !== ' ') unstaged.push(toEntry(f.path, index === '?' ? '?' : index, working));
  }
  return { branch: status.current ?? '(detached)', staged, unstaged };
}

async function gitDiff(rootHref: string, filePath: string, staged: boolean): Promise<string> {
  const ctx = await getGit(rootHref);
  if (!ctx) return '';
  try {
    const args = staged ? ['--cached', '--', filePath] : ['--', filePath];
    const diff = await ctx.git.diff(args);
    if (diff) return diff;
    // Untracked files have no diff; show their content as additions.
    if (!staged) {
      const abs = path.join(ctx.rootPath, filePath);
      const content = await fs.readFile(abs, 'utf-8').catch(() => '');
      if (content) return content.split('\n').map((l) => '+ ' + l).join('\n');
    }
    return '';
  } catch (err) {
    return `[diff failed] ${(err as Error).message}`;
  }
}

const SEARCH_IGNORE = new Set(['node_modules', '.git', 'dist', '.cache', 'out', 'build']);
const SEARCH_MAX_RESULTS = 2000;
const SEARCH_MAX_FILE_BYTES = 2_000_000;

interface SearchHit {
  uri: string;
  filename: string;
  line: number;
  preview: string;
}

async function searchWorkspace(
  rootHref: string,
  query: string,
  opts: { caseSensitive?: boolean; isRegex?: boolean }
): Promise<SearchHit[]> {
  if (!query) return [];

  let matcher: (line: string) => boolean;
  if (opts.isRegex) {
    let re: RegExp;
    try {
      re = new RegExp(query, opts.caseSensitive ? '' : 'i');
    } catch {
      return [];
    }
    matcher = (line) => re.test(line);
  } else {
    const needle = opts.caseSensitive ? query : query.toLowerCase();
    matcher = (line) => (opts.caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  const results: SearchHit[] = [];
  const rootPath = fileURLToPath(rootHref);

  const walk = async (dir: string): Promise<void> => {
    if (results.length >= SEARCH_MAX_RESULTS) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= SEARCH_MAX_RESULTS) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SEARCH_IGNORE.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
        let content: string;
        try {
          content = await fs.readFile(full, 'utf-8');
        } catch {
          continue;
        }
        if (content.includes(String.fromCharCode(0))) continue; // skip binary files
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matcher(lines[i])) {
            results.push({
              uri: pathToFileURL(full).href,
              filename: entry.name,
              line: i + 1,
              preview: lines[i].slice(0, 200).trim(),
            });
            if (results.length >= SEARCH_MAX_RESULTS) return;
          }
        }
      }
    }
  };

  await walk(rootPath);
  return results;
}

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

let mainWindow: BrowserWindow | null = null;

let chosenWorkspaceRoot: string | null = null;

const vfs = new Vfs();
const docStore = new DocumentStore(vfs);

async function chooseWorkspaceInternal(): Promise<string | null> {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  chosenWorkspaceRoot = path.resolve(res.filePaths[0]);
  return pathToFileURL(chosenWorkspaceRoot).href;
}

function getWorkspaceRoot(): string {
  if (chosenWorkspaceRoot) return chosenWorkspaceRoot;
  const args = process.argv.slice(1);
  const dirArg = args.find(a => !a.startsWith('-') && !a.startsWith('--'));
  if (dirArg) return path.resolve(dirArg);
  return process.cwd();
}

function sendToRenderer(event: EmberEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ember:event', event);
  }
}

let unwatchWorkspace: (() => void) | null = null;

async function handleVfsEvent(event: {
  uri: string;
  changeType: 'created' | 'modified' | 'deleted';
  etag: string;
  mtime: number;
  size: number;
}): Promise<void> {
  // Directory structure changes refresh the file tree.
  if (event.changeType === 'created' || event.changeType === 'deleted') {
    sendToRenderer({
      type: 'vfs.changed',
      payload: {
        uri: event.uri,
        changeType: event.changeType,
        etag: event.etag as any,
        mtime: event.mtime,
        size: event.size,
      },
    });
  }

  // Content changes to an open document mean disk and memory diverged.
  if (event.changeType === 'modified' && docStore.hasDocument(event.uri)) {
    // Ignore the echo of our own save.
    if (docStore.getLastSavedEtag(event.uri) === event.etag) return;

    if (docStore.isDirty(event.uri)) {
      sendToRenderer({
        type: 'document.conflict',
        payload: {
          uri: event.uri,
          localVersion: docStore.getVersion(event.uri) ?? 0,
          diskEtag: event.etag as any,
          diskMtime: event.mtime,
        },
      });
    } else {
      // Clean buffer: silently reload from disk and tell the renderer to resync.
      try {
        const snap = await docStore.reloadFromDisk(event.uri);
        if (snap) {
          sendToRenderer({
            type: 'document.reloaded',
            payload: { uri: event.uri, version: snap.version },
          });
        }
      } catch (err) {
        console.error('[main] reloadFromDisk failed', err);
      }
    }
  }
}

function startWatchingWorkspace(): void {
  if (unwatchWorkspace) {
    unwatchWorkspace();
    unwatchWorkspace = null;
  }
  const rootHref = pathToFileURL(getWorkspaceRoot()).href;
  try {
    unwatchWorkspace = vfs.watch(rootHref, (event) => {
      void handleVfsEvent(event);
    });
  } catch (err) {
    console.error('[main] failed to watch workspace', err);
  }
}

type RpcEnvelope = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; [k: string]: unknown } };

// Wrap a handler so thrown errors are serialized into the { ok, error }
// envelope the preload expects. Electron's structured clone drops custom
// Error properties (like `code`), so they must be copied explicitly here.
function handle(channel: string, fn: (args: any) => Promise<unknown>): void {
  ipcMain.handle(channel, async (_event, args): Promise<RpcEnvelope> => {
    try {
      const result = await fn(args ?? {});
      return { ok: true, result };
    } catch (err) {
      const e = err as { code?: string; message?: string; diskEtag?: unknown; diskMtime?: unknown };
      return {
        ok: false,
        error: {
          code: e?.code ?? 'other',
          message: e?.message ?? String(err),
          ...(e?.diskEtag !== undefined ? { diskEtag: e.diskEtag } : {}),
          ...(e?.diskMtime !== undefined ? { diskMtime: e.diskMtime } : {}),
        },
      };
    }
  });
}

// Like `handle`, but validates the incoming args against a Zod schema first.
// Invalid payloads short-circuit to an { ok: false, error: { code: 'invalid' } }
// envelope (via the thrown error flowing through `handle`'s catch); valid
// payloads are passed to `fn` fully typed.
function handleValidated<S extends z.ZodTypeAny>(
  channel: string,
  schema: S,
  fn: (args: z.infer<S>) => Promise<unknown>
): void {
  handle(channel, async (rawArgs) => {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw Object.assign(new Error(`Invalid payload for ${channel}: ${message}`), { code: 'invalid' });
    }
    return fn(parsed.data);
  });
}

// --- Integrated terminal (child_process based; no native PTY dependency) ---
const terminals = new Map<string, ChildProcessWithoutNullStreams>();

function sendTerminal(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createTerminal(cwd: string | undefined): string {
  const id = randomUUID();
  let cwdPath: string;
  try {
    cwdPath = cwd ? (cwd.startsWith('file:') ? fileURLToPath(cwd) : cwd) : getWorkspaceRoot();
  } catch {
    cwdPath = getWorkspaceRoot();
  }

  const shell =
    process.platform === 'win32'
      ? process.env.COMSPEC || 'cmd.exe'
      : process.env.SHELL || '/bin/bash';
  const args = process.platform === 'win32' ? [] : ['-i'];

  const child = spawn(shell, args, {
    cwd: cwdPath,
    env: process.env,
    windowsHide: true,
  });
  terminals.set(id, child);

  child.stdout.on('data', (d: Buffer) => sendTerminal('ember:terminal-data', { id, data: d.toString('utf-8') }));
  child.stderr.on('data', (d: Buffer) => sendTerminal('ember:terminal-data', { id, data: d.toString('utf-8') }));
  child.on('error', (err) => sendTerminal('ember:terminal-data', { id, data: `\r\n[shell error] ${err.message}\r\n` }));
  child.on('exit', () => {
    terminals.delete(id);
    sendTerminal('ember:terminal-exit', { id });
  });

  return id;
}

function registerTerminalHandlers(): void {
  ipcMain.on('ember:terminal-write', (_event, { id, data }: { id: string; data: string }) => {
    const child = terminals.get(id);
    if (child && child.stdin.writable) child.stdin.write(data);
  });
  ipcMain.on('ember:terminal-kill', (_event, { id }: { id: string }) => {
    const child = terminals.get(id);
    if (child) {
      try { child.kill(); } catch {}
      terminals.delete(id);
    }
  });
  // No real TTY behind the pipe, so resize is accepted but has no effect.
  ipcMain.on('ember:terminal-resize', () => {});
}

function registerIpcHandlers(): void {
  handle('ember:terminal-create', async ({ cwd }) => createTerminal(cwd));
  handle('ember:open-document', ({ uri, options }) => docStore.openDocument(uri, options));
  handleValidated('ember:apply-edits', ApplyEditsPayloadSchema, ({ uri, clientId, baseVersion, edits }) =>
    docStore.applyEdits(uri, clientId, baseVersion, edits));
  handleValidated('ember:save-document', SaveDocumentPayloadSchema, ({ uri, expectedEtag }) =>
    docStore.saveDocument(uri, expectedEtag));
  handle('ember:undo', ({ uri }) => docStore.undo(uri, 'main'));
  handle('ember:redo', ({ uri }) => docStore.redo(uri, 'main'));
  handle('ember:get-document-snapshot', async ({ uri }) => (await docStore.getDocumentSnapshot(uri)) ?? null);
  handle('ember:close-document', async ({ uri }) => {
    await docStore.closeDocument(uri);
    return undefined;
  });
  handle('ember:reload-document', async ({ uri }) => (await docStore.reloadFromDisk(uri)) ?? null);

  handle('ember:vfs-read', ({ uri }) => vfs.read(uri));
  handle('ember:vfs-write', ({ uri, text, expectedEtag }) => vfs.write(uri, text, expectedEtag));
  handle('ember:vfs-stat', ({ uri }) => vfs.stat(uri));
  handle('ember:vfs-list', ({ uri }) => vfs.list(uri));
  handle('ember:vfs-mkdir', async ({ uri }) => {
    await vfs.mkdir(uri);
    return undefined;
  });
  handle('ember:vfs-rename', async ({ fromUri, toUri }) => {
    await vfs.rename(fromUri, toUri);
    return undefined;
  });
  handle('ember:vfs-delete', async ({ uri }) => {
    await vfs.delete(uri);
    return undefined;
  });

  handle('ember:search-workspace', ({ root, query, caseSensitive, isRegex }) =>
    searchWorkspace(root, query, { caseSensitive, isRegex }));

  handle('ember:git-status', ({ root }) => gitStatus(root));
  handle('ember:git-diff', ({ root, filePath, staged }) => gitDiff(root, filePath, !!staged));
  handle('ember:git-stage', async ({ root, filePath }) => {
    const ctx = await getGit(root);
    if (ctx) await ctx.git.add(['--', filePath]);
    return undefined;
  });
  handle('ember:git-unstage', async ({ root, filePath }) => {
    const ctx = await getGit(root);
    if (ctx) await ctx.git.raw(['restore', '--staged', '--', filePath]);
    return undefined;
  });
  handle('ember:git-commit', async ({ root, message }) => {
    const ctx = await getGit(root);
    if (!ctx) return null;
    return ctx.git.commit(message);
  });

  handle('ember:choose-workspace', async () => {
    const root = await chooseWorkspaceInternal();
    if (!root) return null;
    startWatchingWorkspace();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ember:workspace-changed', { root });
    }
    return { root };
  });

  handle('ember:get-workspace', async () => {
    const root = getWorkspaceRoot();
    return { root: pathToFileURL(root).href };
  });
}

function wireDocumentEvents(): void {
  docStore.on('opened', (event) => {
    sendToRenderer({
      type: 'document.opened',
      payload: event.payload as any,
    });
  });

  docStore.on('changed', (event) => {
    sendToRenderer({
      type: 'document.changed',
      payload: event.payload as any,
    });
  });

  docStore.on('saved', (event) => {
    sendToRenderer({
      type: 'document.saved',
      payload: event.payload as any,
    });
  });

  docStore.on('conflict', (event) => {
    sendToRenderer({
      type: 'document.conflict',
      payload: event.payload as any,
    });
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Change Directory...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('ember:invoke-choose-workspace');
            }
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    const devUrl = 'http://127.0.0.1:5173';
    const loadDev = (): void => {
      mainWindow?.loadURL(devUrl).catch(() => {
        // Vite may not be listening yet when both processes start together;
        // retry until the dev server is ready.
        if (isDev && mainWindow && !mainWindow.isDestroyed()) {
          setTimeout(loadDev, 500);
        }
      });
    };
    mainWindow.webContents.on('did-fail-load', () => {
      if (isDev && mainWindow && !mainWindow.isDestroyed()) {
        setTimeout(loadDev, 500);
      }
    });
    loadDev();
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  buildMenu();
}

app.whenReady().then(() => {
  registerIpcHandlers();
  registerTerminalHandlers();
  wireDocumentEvents();
  createWindow();
  startWatchingWorkspace();
});

app.on('will-quit', () => {
  if (unwatchWorkspace) {
    unwatchWorkspace();
    unwatchWorkspace = null;
  }
  for (const child of terminals.values()) {
    try { child.kill(); } catch {}
  }
  terminals.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
