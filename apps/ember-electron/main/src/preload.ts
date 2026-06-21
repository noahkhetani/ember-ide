import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export interface EmberApi {
  openDocument(uri: string, options?: { createIfNotExists?: boolean; encoding?: 'utf-8' }): Promise<any>;
  applyEdits(uri: string, clientId: string, baseVersion: number | undefined, edits: any[]): Promise<any>;
  saveDocument(uri: string, expectedEtag?: string): Promise<any>;
  undo(uri: string): Promise<any>;
  redo(uri: string): Promise<any>;
  getDocumentSnapshot(uri: string): Promise<any>;
  closeDocument(uri: string): Promise<void>;
  reloadDocument(uri: string): Promise<any>;
  vfsRead(uri: string): Promise<any>;
  vfsWrite(uri: string, text: string, expectedEtag?: string): Promise<any>;
  vfsStat(uri: string): Promise<any>;
  vfsList(uri: string): Promise<any>;
  vfsMkdir(uri: string): Promise<void>;
  vfsRename(fromUri: string, toUri: string): Promise<void>;
  vfsDelete(uri: string): Promise<void>;
  searchWorkspace(root: string, query: string, opts?: { caseSensitive?: boolean; isRegex?: boolean }): Promise<any>;
  gitStatus(root: string): Promise<any>;
  gitDiff(root: string, filePath: string, staged?: boolean): Promise<string>;
  gitStage(root: string, filePath: string): Promise<void>;
  gitUnstage(root: string, filePath: string): Promise<void>;
  gitCommit(root: string, message: string): Promise<any>;
  terminalCreate(cwd: string): Promise<string>;
  terminalWrite(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  terminalKill(id: string): void;
  onTerminalData(callback: (msg: { id: string; data: string }) => void): () => void;
  onTerminalExit(callback: (msg: { id: string }) => void): () => void;
  getWorkspace(): Promise<any>;
  chooseWorkspace(): Promise<any>;
  onEvent(callback: (event: any) => void): () => void;
  onWorkspaceChanged(callback: (workspace: { root: string }) => void): () => void;
}

function invoke(channel: string, args?: any): Promise<any> {
  return ipcRenderer.invoke(channel, args ?? {}).then((res: any) => {
    if (res.ok) return res.result;
    const err = new Error(res.error?.message ?? 'RPC error');
    (err as any).code = res.error?.code;
    throw err;
  });
}

// When the native menu requests the workspace chooser, trigger the dialog in
// main. Main broadcasts "ember:workspace-changed" itself once a folder is
// picked, so there is no need to re-emit it here.
ipcRenderer.on('ember:invoke-choose-workspace', () => {
  invoke('ember:choose-workspace').catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[preload] invoke-choose-workspace failed', err);
  });
});

const api: EmberApi = {
  openDocument: (uri, options?) => invoke('ember:open-document', { uri, options }),
  applyEdits: (uri, clientId, baseVersion, edits) => invoke('ember:apply-edits', { uri, clientId, baseVersion, edits }),
  saveDocument: (uri, expectedEtag?) => invoke('ember:save-document', { uri, expectedEtag }),
  undo: (uri) => invoke('ember:undo', { uri }),
  redo: (uri) => invoke('ember:redo', { uri }),
  getDocumentSnapshot: (uri) => invoke('ember:get-document-snapshot', { uri }),
  closeDocument: (uri) => invoke('ember:close-document', { uri }),
  reloadDocument: (uri) => invoke('ember:reload-document', { uri }),
  vfsRead: (uri) => invoke('ember:vfs-read', { uri }),
  vfsWrite: (uri, text, expectedEtag?) => invoke('ember:vfs-write', { uri, text, expectedEtag }),
  vfsStat: (uri) => invoke('ember:vfs-stat', { uri }),
  vfsList: (uri) => invoke('ember:vfs-list', { uri }),
  vfsMkdir: (uri) => invoke('ember:vfs-mkdir', { uri }),
  vfsRename: (fromUri, toUri) => invoke('ember:vfs-rename', { fromUri, toUri }),
  vfsDelete: (uri) => invoke('ember:vfs-delete', { uri }),
  searchWorkspace: (root, query, opts) =>
    invoke('ember:search-workspace', { root, query, caseSensitive: opts?.caseSensitive, isRegex: opts?.isRegex }),

  gitStatus: (root) => invoke('ember:git-status', { root }),
  gitDiff: (root, filePath, staged) => invoke('ember:git-diff', { root, filePath, staged }),
  gitStage: (root, filePath) => invoke('ember:git-stage', { root, filePath }),
  gitUnstage: (root, filePath) => invoke('ember:git-unstage', { root, filePath }),
  gitCommit: (root, message) => invoke('ember:git-commit', { root, message }),

  terminalCreate: (cwd) => invoke('ember:terminal-create', { cwd }),
  terminalWrite: (id, data) => ipcRenderer.send('ember:terminal-write', { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.send('ember:terminal-resize', { id, cols, rows }),
  terminalKill: (id) => ipcRenderer.send('ember:terminal-kill', { id }),
  onTerminalData: (callback: (msg: { id: string; data: string }) => void): () => void => {
    const handler = (_event: IpcRendererEvent, data: { id: string; data: string }) => callback(data);
    ipcRenderer.on('ember:terminal-data', handler);
    return () => ipcRenderer.removeListener('ember:terminal-data', handler);
  },
  onTerminalExit: (callback: (msg: { id: string }) => void): () => void => {
    const handler = (_event: IpcRendererEvent, data: { id: string }) => callback(data);
    ipcRenderer.on('ember:terminal-exit', handler);
    return () => ipcRenderer.removeListener('ember:terminal-exit', handler);
  },
  getWorkspace: () => invoke('ember:get-workspace'),
  chooseWorkspace: () => invoke('ember:choose-workspace'),

  onEvent: (callback: (event: any) => void): () => void => {
    const handler = (_event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('ember:event', handler);
    return () => {
      ipcRenderer.removeListener('ember:event', handler);
    };
  },

  onWorkspaceChanged: (callback: (workspace: { root: string }) => void): () => void => {
    const handler = (_event: IpcRendererEvent, data: { root: string }) => {
      callback(data);
    };
    ipcRenderer.on('ember:workspace-changed', handler);
    return () => {
      ipcRenderer.removeListener('ember:workspace-changed', handler);
    };
  },
};

contextBridge.exposeInMainWorld('ember', api);
