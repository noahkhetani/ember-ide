import { useEffect, useRef, useState } from 'react';
import { EditorState, Annotation, ChangeSet, Text, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  codeFolding,
} from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, gotoLine } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import type { TextEdit } from '@ember/ipc-schema';
import { useEmberStore, type Theme } from '../stores/ember-store';
import { Icon, fileIconColor, fileIconName } from './Icon';

// Compartment lets us swap the editor theme live (without rebuilding the view).
const themeCompartment = new Compartment();

const lightEditorTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#ffffff', color: '#383a42' },
    '.cm-content': { caretColor: '#526fff' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#526fff' },
    '.cm-gutters': { backgroundColor: '#ffffff', color: '#a0a1a7', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.045)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(0,0,0,0.05)', color: '#383a42' },
    '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#d3e2fd' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: '#d3e2fd' },
    '.cm-foldPlaceholder': { backgroundColor: '#eaeaeb', borderColor: '#d0d0d0', color: '#888' },
    '.cm-panels': { backgroundColor: '#f3f3f3', color: '#383a42' },
  },
  { dark: false }
);

function editorTheme(theme: Theme): Extension {
  return theme === 'light' ? lightEditorTheme : oneDark;
}

// Resolve the CodeMirror language extension for a filename's extension. Returns
// undefined for unknown types so they render as plain text.
function languageExtension(filename: string | undefined): Extension | undefined {
  const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true });
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'html':
    case 'htm':
    case 'xml':
    case 'vue':
    case 'svelte':
      return html();
    case 'md':
    case 'markdown':
      return markdown();
    case 'py':
    case 'pyw':
      return python();
    default:
      return undefined;
  }
}

// Marks transactions that originate from canonical state (initial load,
// undo/redo, conflict resync) so the update listener does not echo them back
// to the document store as fresh edits.
const syncAnnotation = Annotation.define<boolean>();

const clientId = crypto.randomUUID();

interface EditSession {
  uri: string;
  baseVersion: number; // last version acknowledged by the document store
  syncedDoc: Text; // editor document matching baseVersion
  pending: ChangeSet | null; // edits not yet sent, relative to syncedDoc
  debounceTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  disposed: boolean;
}

// Convert a CodeMirror ChangeSet (relative to baseDoc) into the line/character
// TextEdit shape the document store expects.
function changeSetToEdits(changes: ChangeSet, baseDoc: Text): TextEdit[] {
  const edits: TextEdit[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const startLine = baseDoc.lineAt(fromA);
    const endLine = baseDoc.lineAt(toA);
    edits.push({
      range: {
        start: { line: startLine.number - 1, character: fromA - startLine.from },
        end: { line: endLine.number - 1, character: toA - endLine.from },
      },
      newText: inserted.toString(),
    });
  });
  return edits;
}

async function syncFromCanonical(session: EditSession, view: EditorView): Promise<void> {
  const snapshot = await window.ember.getDocumentSnapshot(session.uri);
  if (!snapshot || session.disposed || view.dom.isConnected === false) return;
  session.baseVersion = snapshot.version;
  session.syncedDoc = Text.of(snapshot.text.split('\n'));
  session.pending = null;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: snapshot.text },
    annotations: syncAnnotation.of(true),
  });
  useEmberStore.getState().markDirty(session.uri, snapshot.isDirty);
}

// Move the cursor to a 1-based line and scroll it into view (search results,
// go-to-line).
function revealLine(view: EditorView, line: number): void {
  const total = view.state.doc.lines;
  const target = Math.min(Math.max(line, 1), total);
  const lineObj = view.state.doc.line(target);
  view.dispatch({
    selection: { anchor: lineObj.from },
    scrollIntoView: true,
  });
  view.focus();
}

async function flushSession(session: EditSession, view: EditorView): Promise<void> {
  if (session.flushing) return;
  if (!session.pending || session.pending.empty) return;
  session.flushing = true;
  try {
    while (session.pending && !session.pending.empty) {
      const changes = session.pending;
      const baseDoc = session.syncedDoc;
      session.pending = null;
      session.syncedDoc = changes.apply(baseDoc);
      const edits = changeSetToEdits(changes, baseDoc);
      try {
        const result = await window.ember.applyEdits(session.uri, clientId, session.baseVersion, edits);
        session.baseVersion = result.newVersion;
        useEmberStore.getState().markDirty(session.uri, result.isDirty);
      } catch (err) {
        if ((err as { code?: string })?.code === 'stale' && !session.disposed) {
          await syncFromCanonical(session, view);
        } else {
          console.error('applyEdits failed:', err);
        }
        break;
      }
    }
  } finally {
    session.flushing = false;
  }
}

function scheduleFlush(session: EditSession, view: EditorView): void {
  // Short debounce coalesces rapid keystrokes; the long timer guarantees a
  // flush even while the user keeps typing.
  if (session.debounceTimer) clearTimeout(session.debounceTimer);
  session.debounceTimer = setTimeout(() => {
    session.debounceTimer = null;
    void flushSession(session, view);
  }, 60);

  if (!session.flushTimer) {
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      void flushSession(session, view);
    }, 400);
  }
}

const LANGUAGE_LABELS: Record<string, string> = {
  js: 'JavaScript',
  jsx: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  json: 'JSON',
  md: 'Markdown',
  css: 'CSS',
  html: 'HTML',
  txt: 'Plain Text',
};

function languageLabel(filename: string | undefined): string {
  if (!filename) return 'Plain Text';
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_LABELS[ext] ?? (ext ? ext.toUpperCase() : 'Plain Text');
}

export function Editor({ groupId }: { groupId: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sessionRef = useRef<EditSession | null>(null);
  const group = useEmberStore((s) => s.editorGroups.find((g) => g.id === groupId));
  const activeGroupId = useEmberStore((s) => s.activeGroupId);
  const groupCount = useEmberStore((s) => s.editorGroups.length);
  const setActiveUri = useEmberStore((s) => s.setActiveUri);
  const closeFile = useEmberStore((s) => s.closeFile);
  const setActiveGroup = useEmberStore((s) => s.setActiveGroup);
  const splitEditor = useEmberStore((s) => s.splitEditor);
  const closeGroup = useEmberStore((s) => s.closeGroup);
  const documentReloadNonce = useEmberStore((s) => s.documentReloadNonce);
  const revealNonce = useEmberStore((s) => s.revealNonce);
  const theme = useEmberStore((s) => s.theme);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  // Swap the editor theme live when the app theme changes.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(editorTheme(theme)) });
  }, [theme]);

  const openTabs = group?.tabs ?? [];
  const activeUri = group?.activeUri ?? null;
  const activeTab = openTabs.find((t) => t.uri === activeUri);
  const isActiveGroup = activeGroupId === groupId;

  // When main reloads a file from disk (external change), resync the live view.
  useEffect(() => {
    const { reloadTargetUri } = useEmberStore.getState();
    const session = sessionRef.current;
    const view = viewRef.current;
    if (session && view && reloadTargetUri && reloadTargetUri === session.uri) {
      void syncFromCanonical(session, view);
    }
  }, [documentReloadNonce]);

  // Reveal a requested line in the already-open active document.
  useEffect(() => {
    const { revealRequest } = useEmberStore.getState();
    const session = sessionRef.current;
    const view = viewRef.current;
    if (session && view && revealRequest && revealRequest.uri === session.uri) {
      revealLine(view, revealRequest.line);
    }
  }, [revealNonce]);

  useEffect(() => {
    if (!activeUri || !containerRef.current) return;

    let cancelled = false;
    setCursor({ line: 1, col: 1 });

    (async () => {
      try {
        let snapshot = await window.ember.getDocumentSnapshot(activeUri);
        if (!snapshot) {
          await window.ember.openDocument(activeUri);
          snapshot = await window.ember.getDocumentSnapshot(activeUri);
        }
        if (cancelled || !snapshot || !containerRef.current) return;

        const session: EditSession = {
          uri: activeUri,
          baseVersion: snapshot.version,
          syncedDoc: Text.of(snapshot.text.split('\n')),
          pending: null,
          debounceTimer: null,
          flushTimer: null,
          flushing: false,
          disposed: false,
        };
        sessionRef.current = session;

        const filename = useEmberStore
          .getState()
          .editorGroups.find((g) => g.id === groupId)
          ?.tabs.find((t) => t.uri === activeUri)?.filename;
        const lang = languageExtension(filename);

        const state = EditorState.create({
          doc: snapshot.text,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            foldGutter(),
            codeFolding(),
            bracketMatching(),
            closeBrackets(),
            indentOnInput(),
            autocompletion(),
            search({ top: true }),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            ...(lang ? [lang] : []),
            themeCompartment.of(editorTheme(useEmberStore.getState().theme)),
            keymap.of([
              {
                key: 'Mod-g',
                preventDefault: true,
                run: gotoLine,
              },
              {
                key: 'Mod-h',
                preventDefault: true,
                run: openSearchPanel,
              },
              ...closeBracketsKeymap,
              ...searchKeymap,
              ...foldKeymap,
              ...completionKeymap,
              indentWithTab,
              ...defaultKeymap,
              {
                key: 'Mod-z',
                preventDefault: true,
                run: () => {
                  const s = sessionRef.current;
                  const v = viewRef.current;
                  if (!s || !v) return false;
                  void (async () => {
                    await flushSession(s, v);
                    const r = await window.ember.undo(s.uri);
                    if (r) await syncFromCanonical(s, v);
                  })();
                  return true;
                },
              },
              {
                key: 'Mod-Shift-z',
                preventDefault: true,
                run: () => {
                  const s = sessionRef.current;
                  const v = viewRef.current;
                  if (!s || !v) return false;
                  void (async () => {
                    await flushSession(s, v);
                    const r = await window.ember.redo(s.uri);
                    if (r) await syncFromCanonical(s, v);
                  })();
                  return true;
                },
              },
              {
                key: 'Mod-y',
                preventDefault: true,
                run: () => {
                  const s = sessionRef.current;
                  const v = viewRef.current;
                  if (!s || !v) return false;
                  void (async () => {
                    await flushSession(s, v);
                    const r = await window.ember.redo(s.uri);
                    if (r) await syncFromCanonical(s, v);
                  })();
                  return true;
                },
              },
              {
                key: 'Mod-s',
                preventDefault: true,
                run: () => {
                  const s = sessionRef.current;
                  const v = viewRef.current;
                  if (!s || !v) return false;
                  void (async () => {
                    await flushSession(s, v);
                    try {
                      await window.ember.saveDocument(s.uri);
                      useEmberStore.getState().markDirty(s.uri, false);
                    } catch (err) {
                      console.error('Save failed:', err);
                    }
                  })();
                  return true;
                },
              },
            ]),
            EditorView.updateListener.of((update) => {
              const session = sessionRef.current;
              const view = viewRef.current;
              if (!session || !view) return;

              if (update.selectionSet || update.docChanged) {
                const head = update.state.selection.main.head;
                const line = update.state.doc.lineAt(head);
                setCursor({ line: line.number, col: head - line.from + 1 });
              }

              if (!update.docChanged) return;
              // Ignore programmatic syncs from canonical state.
              if (update.transactions.some((tr) => tr.annotation(syncAnnotation))) return;

              session.pending = session.pending
                ? session.pending.compose(update.changes)
                : update.changes;
              scheduleFlush(session, view);
            }),
          ],
        });

        const view = new EditorView({ state, parent: containerRef.current });
        viewRef.current = view;
        useEmberStore.getState().markDirty(activeUri, snapshot.isDirty);

        // Apply a pending reveal request (e.g. opened from a search result).
        const reveal = useEmberStore.getState().revealRequest;
        if (reveal && reveal.uri === activeUri) {
          revealLine(view, reveal.line);
        }
      } catch (err) {
        console.error('Failed to open document:', err);
      }
    })();

    return () => {
      cancelled = true;
      const session = sessionRef.current;
      const view = viewRef.current;
      if (session) {
        session.disposed = true;
        if (session.debounceTimer) clearTimeout(session.debounceTimer);
        if (session.flushTimer) clearTimeout(session.flushTimer);
        // Best-effort flush of any unsent edits before tearing the view down.
        if (view) void flushSession(session, view);
      }
      view?.destroy();
      viewRef.current = null;
      sessionRef.current = null;
    };
  }, [activeUri]);

  const handleCloseTab = (uri: string, isDirty: boolean): void => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    closeFile(uri, groupId);
    // Only release the canonical document if no other group still shows it.
    const stillOpen = useEmberStore
      .getState()
      .editorGroups.some((g) => g.tabs.some((t) => t.uri === uri));
    if (!stillOpen) {
      window.ember.closeDocument(uri).catch((err) => console.error('closeDocument failed:', err));
    }
  };

  if (!activeUri) {
    return (
      <div
        className={`editor-empty ${isActiveGroup && groupCount > 1 ? 'group-active' : ''}`}
        onMouseDown={() => !isActiveGroup && setActiveGroup(groupId)}
      >
        <div className="editor-empty-text">
          <div className="editor-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" x2="20" y1="19" y2="19" />
            </svg>
          </div>
          <h2>Ember</h2>
          <p>Select a file from the sidebar to start editing</p>
          <div className="editor-empty-shortcuts">
            <div className="shortcut-row"><span>Command Palette</span><span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>P</kbd></span></div>
            <div className="shortcut-row"><span>Search Project</span><span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>F</kbd></span></div>
            <div className="shortcut-row"><span>Toggle Terminal</span><span><kbd>Ctrl</kbd><kbd>`</kbd></span></div>
            <div className="shortcut-row"><span>Save</span><span><kbd>Ctrl</kbd><kbd>S</kbd></span></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`editor-container ${isActiveGroup && groupCount > 1 ? 'group-active' : ''}`}
      onMouseDown={() => !isActiveGroup && setActiveGroup(groupId)}
    >
      <div className="editor-tabs">
        <div className="editor-tabs-scroll">
          {openTabs.map((tab) => (
            <div
              key={tab.uri}
              className={`editor-tab ${tab.uri === activeUri ? 'active' : ''}`}
              onClick={() => setActiveUri(tab.uri, groupId)}
              title={tab.uri}
            >
              <span className="tab-icon" style={{ color: fileIconColor(tab.filename) }}>
                <Icon name={fileIconName(tab.filename)} size={15} />
              </span>
              <span className="tab-name">{tab.filename}</span>
              <button
                className={`tab-close ${tab.isDirty ? 'is-dirty' : ''}`}
                aria-label={`Close ${tab.filename}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.uri, tab.isDirty);
                }}
              >
                <span className="tab-dirty-dot" aria-hidden="true" />
                <Icon name="x" size={14} className="tab-close-x" />
              </button>
            </div>
          ))}
        </div>
        <div className="editor-tabs-actions">
          {groupCount < 2 ? (
            <button className="icon-btn" title="Split Editor Right" onClick={splitEditor}>
              <Icon name="split" size={16} />
            </button>
          ) : (
            <button className="icon-btn" title="Close Editor Group" onClick={() => closeGroup(groupId)}>
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="editor-content" ref={containerRef} />
      <div className="status-bar">
        <span className="status-item status-path">{activeTab?.filename ?? ''}</span>
        {activeTab?.isDirty && <span className="status-item status-dirty">● Unsaved</span>}
        <span className="status-spacer" />
        <span className="status-item">Ln {cursor.line}, Col {cursor.col}</span>
        <span className="status-item">{languageLabel(activeTab?.filename)}</span>
      </div>
    </div>
  );
}
