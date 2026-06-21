import { useEffect } from 'react';
import { FileTree } from './components/FileTree';
import { Editor } from './components/Editor';
import { ActivityBar } from './components/ActivityBar';
import { SearchPanel } from './components/SearchPanel';
import { SourceControlPanel } from './components/SourceControlPanel';
import { Panel } from './components/Panel';
import { CommandPalette } from './components/CommandPalette';
import { useEmberStore } from './stores/ember-store';

export function App(): JSX.Element {
  const { setWorkspaceRoot, setWorkspaceRootAndRefresh } = useEmberStore();
  const activeView = useEmberStore((s) => s.activeView);
  const sidebarVisible = useEmberStore((s) => s.sidebarVisible);
  const panelVisible = useEmberStore((s) => s.panelVisible);
  const editorGroups = useEmberStore((s) => s.editorGroups);
  const theme = useEmberStore((s) => s.theme);

  // Apply + persist the color theme on the document root.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('ember-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Global shortcuts: command palette and panel toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        const s = useEmberStore.getState();
        s.setCommandPaletteOpen(!s.commandPaletteOpen);
      } else if (mod && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        useEmberStore.getState().togglePanel();
      } else if (mod && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault();
        useEmberStore.getState().setActiveView('explorer');
      } else if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        useEmberStore.getState().setActiveView('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const ws = await window.ember.getWorkspace();
        if (ws?.root) {
          setWorkspaceRoot(ws.root);
        }
      } catch (err) {
        console.error('Failed to get workspace:', err);
      }
    })();
  }, [setWorkspaceRoot]);

  useEffect(() => {
    const unsub = window.ember.onEvent((event) => {
      const store = useEmberStore.getState();
      switch (event.type) {
        case 'document.saved':
          store.markDirty(event.payload.uri, false);
          store.refreshGit();
          break;
        case 'document.reloaded':
          // Main auto-reloaded a clean buffer from disk; resync the editor view.
          store.markDirty(event.payload.uri, false);
          store.signalDocumentReload(event.payload.uri);
          break;
        case 'document.conflict': {
          const uri = event.payload.uri;
          const tab = store.openTabs.find((t) => t.uri === uri);
          if (!tab) break;
          const ok = window.confirm(
            `"${tab.filename}" changed on disk. Reload and discard your unsaved changes?`
          );
          if (ok) {
            window.ember
              .reloadDocument(uri)
              .then(() => {
                const s = useEmberStore.getState();
                s.markDirty(uri, false);
                s.signalDocumentReload(uri);
              })
              .catch((err) => console.error('reloadDocument failed', err));
          }
          break;
        }
        case 'vfs.changed':
          store.triggerWorkspaceRefresh();
          store.refreshGit();
          break;
        default:
          break;
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = window.ember.onWorkspaceChanged((ws) => {
      if (ws?.root) {
        setWorkspaceRootAndRefresh(ws.root);
      }
    });
    return unsub;
  }, [setWorkspaceRootAndRefresh]);

  return (
    <div className="app">
      <ActivityBar />
      {sidebarVisible && (
        <div className="sidebar">
          {activeView === 'explorer' && <FileTree />}
          {activeView === 'search' && <SearchPanel />}
          {activeView === 'scm' && <SourceControlPanel />}
        </div>
      )}
      <div className="main-area">
        <div className="editor-region">
          {editorGroups.map((g) => (
            <div className="editor-group" key={g.id}>
              <Editor groupId={g.id} />
            </div>
          ))}
        </div>
        {panelVisible && <Panel />}
      </div>
      <CommandPalette />
    </div>
  );
}
