import { create } from 'zustand';

export interface OpenTab {
  uri: string;
  filename: string;
  isDirty: boolean;
}

export interface FileEntry {
  name: string;
  uri: string;
  isDirectory: boolean;
}

export interface EditorGroup {
  id: string;
  tabs: OpenTab[];
  activeUri: string | null;
}

export type SidebarView = 'explorer' | 'search' | 'scm';
export type PanelTab = 'terminal' | 'output';
export type Theme = 'dark' | 'light';

function initialTheme(): Theme {
  try {
    return localStorage.getItem('ember-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

interface EmberState {
  workspaceRoot: string | null;
  files: FileEntry[];
  // Split editor groups. `openTabs`/`activeUri` below mirror the active group
  // so single-group consumers keep working unchanged.
  editorGroups: EditorGroup[];
  activeGroupId: string;
  openTabs: OpenTab[];
  activeUri: string | null;
  isLoading: boolean;
  workspaceRefreshTrigger: number;
  documentReloadNonce: number;
  reloadTargetUri: string | null;

  // UI shell
  activeView: SidebarView;
  sidebarVisible: boolean;
  panelVisible: boolean;
  activePanel: PanelTab;
  commandPaletteOpen: boolean;
  gitRefreshNonce: number;
  newEntryNonce: number;
  newEntryIsFile: boolean;
  theme: Theme;

  // Reveal-a-location (from search results / go to line)
  revealRequest: { uri: string; line: number } | null;
  revealNonce: number;

  setWorkspaceRoot: (root: string) => void;
  setWorkspaceRootAndRefresh: (root: string) => void;
  triggerWorkspaceRefresh: () => void;
  setFiles: (files: FileEntry[]) => void;
  openFile: (uri: string, filename: string, groupId?: string) => void;
  closeFile: (uri: string, groupId?: string) => void;
  setActiveUri: (uri: string | null, groupId?: string) => void;
  setActiveGroup: (groupId: string) => void;
  splitEditor: () => void;
  closeGroup: (groupId: string) => void;
  markDirty: (uri: string, dirty: boolean) => void;
  setLoading: (loading: boolean) => void;
  signalDocumentReload: (uri: string) => void;

  setActiveView: (view: SidebarView) => void;
  toggleSidebar: () => void;
  setPanelVisible: (visible: boolean) => void;
  togglePanel: () => void;
  setActivePanel: (tab: PanelTab) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  requestReveal: (uri: string, line: number) => void;
  refreshGit: () => void;
  requestNewEntry: (isFile: boolean) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const PRIMARY_GROUP = 'group-primary';

// Recompute the active-group mirror fields whenever groups change.
function mirror(groups: EditorGroup[], activeGroupId: string) {
  const active = groups.find((g) => g.id === activeGroupId) ?? groups[0];
  return {
    editorGroups: groups,
    activeGroupId: active?.id ?? PRIMARY_GROUP,
    openTabs: active?.tabs ?? [],
    activeUri: active?.activeUri ?? null,
  };
}

export const useEmberStore = create<EmberState>((set) => ({
  workspaceRoot: null,
  files: [],
  editorGroups: [{ id: PRIMARY_GROUP, tabs: [], activeUri: null }],
  activeGroupId: PRIMARY_GROUP,
  openTabs: [],
  activeUri: null,
  isLoading: false,
  workspaceRefreshTrigger: 0,
  documentReloadNonce: 0,
  reloadTargetUri: null,

  activeView: 'explorer',
  sidebarVisible: true,
  panelVisible: false,
  activePanel: 'terminal',
  commandPaletteOpen: false,
  gitRefreshNonce: 0,
  newEntryNonce: 0,
  newEntryIsFile: true,
  theme: initialTheme(),
  revealRequest: null,
  revealNonce: 0,

  setWorkspaceRoot: (root) => set({ workspaceRoot: root }),
  setWorkspaceRootAndRefresh: (root) =>
    set((state) => ({ workspaceRoot: root, workspaceRefreshTrigger: state.workspaceRefreshTrigger + 1 })),
  triggerWorkspaceRefresh: () =>
    set((state) => ({ workspaceRefreshTrigger: state.workspaceRefreshTrigger + 1 })),

  setFiles: (files) => set({ files }),

  openFile: (uri, filename, groupId) =>
    set((state) => {
      const gid = groupId ?? state.activeGroupId;
      const groups = state.editorGroups.map((g) => {
        if (g.id !== gid) return g;
        if (g.tabs.some((t) => t.uri === uri)) return { ...g, activeUri: uri };
        return { ...g, tabs: [...g.tabs, { uri, filename, isDirty: false }], activeUri: uri };
      });
      return mirror(groups, gid);
    }),

  closeFile: (uri, groupId) =>
    set((state) => {
      let groups = state.editorGroups.map((g) => {
        if (groupId && g.id !== groupId) return g;
        if (!g.tabs.some((t) => t.uri === uri)) return g;
        const tabs = g.tabs.filter((t) => t.uri !== uri);
        let activeUri = g.activeUri;
        if (activeUri === uri) activeUri = tabs.length > 0 ? tabs[tabs.length - 1].uri : null;
        return { ...g, tabs, activeUri };
      });

      let activeGroupId = state.activeGroupId;
      if (groups.length > 1) {
        const nonEmpty = groups.filter((g) => g.tabs.length > 0);
        if (nonEmpty.length === 0) groups = [groups[0]];
        else if (nonEmpty.length < groups.length) groups = nonEmpty;
        if (!groups.some((g) => g.id === activeGroupId)) activeGroupId = groups[0].id;
      }
      return mirror(groups, activeGroupId);
    }),

  setActiveUri: (uri, groupId) =>
    set((state) => {
      const gid = groupId ?? state.activeGroupId;
      const groups = state.editorGroups.map((g) => (g.id === gid ? { ...g, activeUri: uri } : g));
      return mirror(groups, gid);
    }),

  setActiveGroup: (groupId) =>
    set((state) => (state.editorGroups.some((g) => g.id === groupId) ? mirror(state.editorGroups, groupId) : {})),

  splitEditor: () =>
    set((state) => {
      if (state.editorGroups.length >= 2) return {};
      const active = state.editorGroups.find((g) => g.id === state.activeGroupId) ?? state.editorGroups[0];
      const newId = 'group-' + Math.random().toString(36).slice(2, 8);
      const current = active.tabs.find((t) => t.uri === active.activeUri);
      const newGroup: EditorGroup = {
        id: newId,
        tabs: current ? [{ ...current }] : [],
        activeUri: current ? current.uri : null,
      };
      return mirror([...state.editorGroups, newGroup], newId);
    }),

  closeGroup: (groupId) =>
    set((state) => {
      if (state.editorGroups.length <= 1) return {};
      const groups = state.editorGroups.filter((g) => g.id !== groupId);
      return mirror(groups, groups[0].id);
    }),

  markDirty: (uri, dirty) =>
    set((state) => {
      const groups = state.editorGroups.map((g) => ({
        ...g,
        tabs: g.tabs.map((t) => (t.uri === uri ? { ...t, isDirty: dirty } : t)),
      }));
      return mirror(groups, state.activeGroupId);
    }),

  setLoading: (loading) => set({ isLoading: loading }),

  signalDocumentReload: (uri) =>
    set((state) => ({ reloadTargetUri: uri, documentReloadNonce: state.documentReloadNonce + 1 })),

  setActiveView: (view) => set({ activeView: view, sidebarVisible: true }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  setPanelVisible: (visible) => set({ panelVisible: visible }),
  togglePanel: () => set((state) => ({ panelVisible: !state.panelVisible })),
  setActivePanel: (tab) => set({ activePanel: tab, panelVisible: true }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  requestReveal: (uri, line) =>
    set((state) => ({ revealRequest: { uri, line }, revealNonce: state.revealNonce + 1 })),
  refreshGit: () => set((state) => ({ gitRefreshNonce: state.gitRefreshNonce + 1 })),
  requestNewEntry: (isFile) =>
    set((state) => ({
      newEntryIsFile: isFile,
      newEntryNonce: state.newEntryNonce + 1,
      activeView: 'explorer',
      sidebarVisible: true,
    })),
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
}));
