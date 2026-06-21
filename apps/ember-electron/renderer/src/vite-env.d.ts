/// <reference types="vite/client" />

interface EmberApi {
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
  searchWorkspace(root: string, query: string, opts?: { caseSensitive?: boolean; isRegex?: boolean }): Promise<SearchHit[]>;
  gitStatus(root: string): Promise<GitStatus | null>;
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

interface SearchHit {
  uri: string;
  filename: string;
  line: number;
  preview: string;
}

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

interface Window {
  ember: EmberApi;
}
