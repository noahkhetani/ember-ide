import { useEffect, useMemo, useRef, useState } from 'react';
import { useEmberStore } from '../stores/ember-store';
import { Icon } from './Icon';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

function buildCommands(): Command[] {
  const get = useEmberStore.getState;
  return [
    {
      id: 'file.open-folder',
      label: 'Open Folder…',
      hint: 'Ctrl+Shift+O',
      run: () => {
        window.ember.chooseWorkspace().catch((err) => console.error(err));
      },
    },
    { id: 'file.new', label: 'New File', run: () => get().requestNewEntry(true) },
    { id: 'file.new-folder', label: 'New Folder', run: () => get().requestNewEntry(false) },
    {
      id: 'file.save',
      label: 'Save',
      hint: 'Ctrl+S',
      run: () => {
        const { activeUri, markDirty } = get();
        if (activeUri) {
          window.ember
            .saveDocument(activeUri)
            .then(() => markDirty(activeUri, false))
            .catch((err) => console.error('Save failed', err));
        }
      },
    },
    {
      id: 'file.save-all',
      label: 'Save All',
      run: () => {
        const { openTabs, markDirty } = get();
        for (const tab of openTabs) {
          if (tab.isDirty) {
            window.ember
              .saveDocument(tab.uri)
              .then(() => markDirty(tab.uri, false))
              .catch((err) => console.error('Save failed', err));
          }
        }
      },
    },
    {
      id: 'file.close',
      label: 'Close Editor',
      run: () => {
        const { activeUri, closeFile } = get();
        if (activeUri) {
          closeFile(activeUri);
          window.ember.closeDocument(activeUri).catch(() => {});
        }
      },
    },
    {
      id: 'edit.go-to-line',
      label: 'Go to Line…',
      hint: 'Ctrl+G',
      run: () => {
        const { activeUri, requestReveal } = get();
        if (!activeUri) return;
        const input = window.prompt('Go to line:');
        const line = input ? parseInt(input, 10) : NaN;
        if (!Number.isNaN(line) && line > 0) requestReveal(activeUri, line);
      },
    },
    { id: 'view.explorer', label: 'View: Explorer', hint: 'Ctrl+Shift+E', run: () => get().setActiveView('explorer') },
    { id: 'view.search', label: 'View: Search', hint: 'Ctrl+Shift+F', run: () => get().setActiveView('search') },
    { id: 'view.scm', label: 'View: Source Control', run: () => get().setActiveView('scm') },
    { id: 'view.toggle-sidebar', label: 'Toggle Sidebar', run: () => get().toggleSidebar() },
    { id: 'view.toggle-panel', label: 'Toggle Panel', hint: 'Ctrl+`', run: () => get().togglePanel() },
    { id: 'view.split', label: 'Split Editor Right', run: () => get().splitEditor() },
    { id: 'view.theme', label: 'Toggle Color Theme (Dark / Light)', run: () => get().toggleTheme() },
    { id: 'terminal.new', label: 'Terminal: Show', run: () => get().setActivePanel('terminal') },
    {
      id: 'git.refresh',
      label: 'Source Control: Refresh',
      run: () => {
        get().setActiveView('scm');
        get().refreshGit();
      },
    },
    { id: 'app.reload', label: 'Reload Window', run: () => window.location.reload() },
  ];
}

function score(label: string, query: string): boolean {
  if (!query) return true;
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  // Subsequence match (fuzzy): every query char appears in order.
  let i = 0;
  for (const ch of l) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return l.includes(q);
}

export function CommandPalette(): JSX.Element | null {
  const open = useEmberStore((s) => s.commandPaletteOpen);
  const setOpen = useEmberStore((s) => s.setCommandPaletteOpen);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo(() => buildCommands(), []);
  const filtered = useMemo(() => commands.filter((c) => score(c.label, query)), [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      // Focus after the modal mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const run = (cmd: Command | undefined): void => {
    setOpen(false);
    cmd?.run();
  };

  return (
    <div className="command-palette-overlay" onClick={() => setOpen(false)}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-search">
          <Icon name="search" size={16} className="command-palette-search-icon" />
          <input
            ref={inputRef}
            className="command-palette-input"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(filtered[selected]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
            }
          }}
          />
        </div>
        <div className="command-palette-list">
          {filtered.length === 0 && <div className="command-palette-empty">No matching commands</div>}
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`command-palette-item ${i === selected ? 'selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(cmd)}
            >
              <span className="command-label">{cmd.label}</span>
              {cmd.hint && <span className="command-hint">{cmd.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
