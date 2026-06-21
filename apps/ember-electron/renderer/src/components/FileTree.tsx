import { useEffect, useState, useCallback, useRef } from 'react';
import { useEmberStore, type FileEntry } from '../stores/ember-store';
import { Icon, fileIconColor, fileIconName } from './Icon';

interface DirNode {
  name: string;
  uri: string;
  isDirectory: boolean;
  children: DirNode[];
  expanded: boolean;
  loaded: boolean;
}

interface ContextTarget {
  x: number;
  y: number;
  node: DirNode | null; // null = empty area (root context)
}

function parentDirOf(uri: string): string {
  const i = uri.lastIndexOf('/');
  return i >= 0 ? uri.slice(0, i) : uri;
}

function collectExpanded(nodes: DirNode[], set: Set<string>): void {
  for (const n of nodes) {
    if (n.isDirectory && n.expanded) {
      set.add(n.uri);
      collectExpanded(n.children, set);
    }
  }
}

function findNode(nodes: DirNode[], uri: string): DirNode | null {
  for (const n of nodes) {
    if (n.uri === uri) return n;
    if (n.isDirectory && n.children.length) {
      const found = findNode(n.children, uri);
      if (found) return found;
    }
  }
  return null;
}

export function FileTree(): JSX.Element {
  const { workspaceRoot, openFile, activeUri, isLoading, setLoading, setWorkspaceRoot, workspaceRefreshTrigger } =
    useEmberStore();
  const [rootNodes, setRootNodes] = useState<DirNode[]>([]);
  const [creating, setCreating] = useState<{ parentUri: string; isFile: boolean } | null>(null);
  const [renamingUri, setRenamingUri] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextTarget | null>(null);
  const rootNodesRef = useRef<DirNode[]>([]);
  rootNodesRef.current = rootNodes;

  const loadDir = useCallback(async (uri: string): Promise<DirNode[]> => {
    try {
      const entries: FileEntry[] = await window.ember.vfsList(uri);
      return entries
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => ({
          name: e.name,
          uri: e.uri,
          isDirectory: e.isDirectory,
          children: [],
          expanded: false,
          loaded: false,
        }));
    } catch (err) {
      console.error('[FileTree] loadDir error', err);
      return [];
    }
  }, []);

  // Rebuild the tree from disk while preserving which folders were expanded, so
  // create/rename/delete and external file changes don't collapse the explorer.
  const buildTree = useCallback(
    async (uri: string, expanded: Set<string>): Promise<DirNode[]> => {
      const nodes = await loadDir(uri);
      for (const n of nodes) {
        if (n.isDirectory && expanded.has(n.uri)) {
          n.expanded = true;
          n.loaded = true;
          n.children = await buildTree(n.uri, expanded);
        }
      }
      return nodes;
    },
    [loadDir]
  );

  const refreshRoot = useCallback(
    async (overrideRoot?: string) => {
      const target = overrideRoot ?? workspaceRoot;
      if (!target) return;
      setLoading(true);
      const expanded = new Set<string>();
      collectExpanded(rootNodesRef.current, expanded);
      const nodes = await buildTree(target, expanded);
      setRootNodes(nodes);
      setLoading(false);
    },
    [workspaceRoot, buildTree, setLoading]
  );

  useEffect(() => {
    refreshRoot();
  }, [refreshRoot]);

  useEffect(() => {
    if (!workspaceRoot) return;
    refreshRoot();
  }, [workspaceRefreshTrigger, workspaceRoot, refreshRoot]);

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!contextMenu) return;
    const close = (): void => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [contextMenu]);

  const toggleDir = useCallback(async (node: DirNode) => {
    if (!node.expanded && !node.loaded) {
      node.children = await loadDir(node.uri);
      node.loaded = true;
    }
    node.expanded = !node.expanded;
    setRootNodes([...rootNodesRef.current]);
  }, [loadDir]);

  const handleFileClick = useCallback(async (node: DirNode) => {
    if (node.isDirectory) return;
    openFile(node.uri, node.name);
    try {
      await window.ember.openDocument(node.uri);
    } catch (err) {
      console.error('Failed to open document:', err);
    }
  }, [openFile]);

  const handleChooseWorkspace = useCallback(async () => {
    try {
      const ws = await window.ember.chooseWorkspace();
      if (ws?.root) {
        setWorkspaceRoot(ws.root);
        await refreshRoot(ws.root);
      }
    } catch (err) {
      console.error('[FileTree] chooseWorkspace failed', err);
    }
  }, [setWorkspaceRoot, refreshRoot]);

  // Expand a directory node (loading it if necessary) before creating inside it.
  const expandDir = useCallback(async (uri: string) => {
    const node = findNode(rootNodesRef.current, uri);
    if (node && node.isDirectory && !node.expanded) {
      if (!node.loaded) {
        node.children = await loadDir(node.uri);
        node.loaded = true;
      }
      node.expanded = true;
      setRootNodes([...rootNodesRef.current]);
    }
  }, [loadDir]);

  const startCreate = useCallback(async (parentUri: string, isFile: boolean) => {
    if (parentUri !== workspaceRoot) await expandDir(parentUri);
    setCreating({ parentUri, isFile });
  }, [workspaceRoot, expandDir]);

  // Allow the command palette to start a new file/folder at the workspace root.
  const newEntryNonce = useEmberStore((s) => s.newEntryNonce);
  useEffect(() => {
    if (newEntryNonce === 0) return;
    const { newEntryIsFile, workspaceRoot: root } = useEmberStore.getState();
    if (root) void startCreate(root, newEntryIsFile);
  }, [newEntryNonce, startCreate]);

  const handleCreate = useCallback(async (name: string) => {
    const current = creating;
    setCreating(null);
    const trimmed = name.trim();
    if (!current || !trimmed) return;

    const parentDir = current.parentUri.replace(/\/+$/, '');
    const encoded = trimmed.split('/').map(encodeURIComponent).join('/');
    const newUri = `${parentDir}/${encoded}`;
    try {
      if (current.isFile) {
        await window.ember.vfsWrite(newUri, '');
        await refreshRoot();
        openFile(newUri, trimmed);
        await window.ember.openDocument(newUri);
      } else {
        await window.ember.vfsMkdir(newUri);
        await refreshRoot();
      }
    } catch (err) {
      console.error('Failed to create:', err);
    }
  }, [creating, refreshRoot, openFile]);

  const handleRename = useCallback(async (node: DirNode, name: string) => {
    setRenamingUri(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === node.name) return;
    const newUri = `${parentDirOf(node.uri)}/${trimmed.split('/').map(encodeURIComponent).join('/')}`;
    try {
      await window.ember.vfsRename(node.uri, newUri);
      // Close any open tabs that referenced the old path (file or descendants).
      const { openTabs, closeFile } = useEmberStore.getState();
      for (const tab of openTabs) {
        if (tab.uri === node.uri || tab.uri.startsWith(node.uri + '/')) {
          closeFile(tab.uri);
          window.ember.closeDocument(tab.uri).catch(() => {});
        }
      }
      await refreshRoot();
    } catch (err) {
      console.error('Failed to rename:', err);
    }
  }, [refreshRoot]);

  const handleDelete = useCallback(async (node: DirNode) => {
    if (!window.confirm(`Delete "${node.name}"? This cannot be undone.`)) return;
    try {
      await window.ember.vfsDelete(node.uri);
      const { openTabs, closeFile } = useEmberStore.getState();
      for (const tab of openTabs) {
        if (tab.uri === node.uri || tab.uri.startsWith(node.uri + '/')) {
          closeFile(tab.uri);
          window.ember.closeDocument(tab.uri).catch(() => {});
        }
      }
      await refreshRoot();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  }, [refreshRoot]);

  const openContextMenu = useCallback((e: React.MouseEvent, node: DirNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const renderNode = (node: DirNode, depth: number): JSX.Element => {
    const isActive = activeUri === node.uri;
    const isRenaming = renamingUri === node.uri;
    return (
      <div key={node.uri}>
        <div
          className={`file-tree-item ${isActive ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (node.isDirectory ? toggleDir(node) : handleFileClick(node))}
          onContextMenu={(e) => openContextMenu(e, node)}
        >
          <span className="file-twisty">
            {node.isDirectory && <Icon name={node.expanded ? 'chevron-down' : 'chevron-right'} size={14} />}
          </span>
          <span
            className="file-icon"
            style={node.isDirectory ? { color: 'var(--folder)' } : { color: fileIconColor(node.name) }}
          >
            <Icon name={node.isDirectory ? (node.expanded ? 'folder-open' : 'folder') : fileIconName(node.name)} size={16} />
          </span>
          {isRenaming ? (
            <input
              type="text"
              autoFocus
              defaultValue={node.name}
              className="rename-input"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename(node, (e.target as HTMLInputElement).value);
                if (e.key === 'Escape') setRenamingUri(null);
              }}
              onBlur={(e) => handleRename(node, e.target.value)}
            />
          ) : (
            <span className="file-name">{node.name}</span>
          )}
        </div>
        {node.isDirectory && node.expanded && node.children.length > 0 && (
          <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
        {creating && creating.parentUri === node.uri && (
          <div className="file-tree-rename" style={{ paddingLeft: 30 + depth * 14 }}>
            <input
              type="text"
              autoFocus
              placeholder={creating.isFile ? 'filename.ext' : 'folder name'}
              className="rename-input"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate((e.target as HTMLInputElement).value);
                if (e.key === 'Escape') setCreating(null);
              }}
              onBlur={(e) => handleCreate(e.target.value)}
            />
          </div>
        )}
        {node.isDirectory && node.expanded && node.children.length === 0 && !(creating && creating.parentUri === node.uri) && (
          <div className="file-tree-empty-inline" style={{ paddingLeft: 30 + depth * 14 }}>
            empty
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <div className="file-tree-title">
          <span>Explorer</span>
          <button
            className="workspace-path"
            onClick={handleChooseWorkspace}
            title={workspaceRoot ? `${decodeURIComponent(workspaceRoot)}\nClick to change folder` : 'Click to open a folder'}
          >
            {workspaceRoot ? decodeURIComponent(workspaceRoot.replace(/^file:\/\/\/?/, '')) : 'Open a folder…'}
          </button>
        </div>
        <div className="file-tree-actions">
          <button className="icon-btn" onClick={() => workspaceRoot && startCreate(workspaceRoot, true)} title="New File" disabled={!workspaceRoot}>
            <Icon name="file-plus" size={16} />
          </button>
          <button className="icon-btn" onClick={() => workspaceRoot && startCreate(workspaceRoot, false)} title="New Folder" disabled={!workspaceRoot}>
            <Icon name="folder-plus" size={16} />
          </button>
          <button className="icon-btn" onClick={() => refreshRoot()} title="Refresh" disabled={!workspaceRoot}>
            <Icon name="refresh" size={15} />
          </button>
        </div>
      </div>
      <div className="file-tree-list" onContextMenu={(e) => workspaceRoot && openContextMenu(e, null)}>
        {creating && creating.parentUri === workspaceRoot && (
          <div className="file-tree-rename" style={{ paddingLeft: 12 }}>
            <input
              type="text"
              autoFocus
              placeholder={creating.isFile ? 'filename.ext' : 'folder name'}
              className="rename-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate((e.target as HTMLInputElement).value);
                if (e.key === 'Escape') setCreating(null);
              }}
              onBlur={(e) => handleCreate(e.target.value)}
            />
          </div>
        )}
        {rootNodes.map((node) => renderNode(node, 0))}
        {isLoading && rootNodes.length === 0 && <div className="file-tree-empty">Loading…</div>}
        {!isLoading && !workspaceRoot && <div className="file-tree-empty">No folder opened</div>}
        {!isLoading && workspaceRoot && rootNodes.length === 0 && <div className="file-tree-empty">Empty folder</div>}
      </div>

      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
          {(() => {
            const node = contextMenu.node;
            const parentForNew = !node ? workspaceRoot! : node.isDirectory ? node.uri : parentDirOf(node.uri);
            return (
              <>
                <button className="context-item" onClick={() => { setContextMenu(null); startCreate(parentForNew, true); }}>
                  <Icon name="file-plus" size={15} /> New File
                </button>
                <button className="context-item" onClick={() => { setContextMenu(null); startCreate(parentForNew, false); }}>
                  <Icon name="folder-plus" size={15} /> New Folder
                </button>
                {node && <div className="context-sep" />}
                {node && (
                  <button className="context-item" onClick={() => { setContextMenu(null); setRenamingUri(node.uri); }}>
                    <Icon name="pencil" size={15} /> Rename
                  </button>
                )}
                {node && (
                  <button className="context-item context-danger" onClick={() => { setContextMenu(null); handleDelete(node); }}>
                    <Icon name="trash" size={15} /> Delete
                  </button>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
