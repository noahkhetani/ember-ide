import { useState, useCallback, useRef } from 'react';
import { useEmberStore } from '../stores/ember-store';
import { Icon, fileIconColor, fileIconName } from './Icon';

interface Hit {
  uri: string;
  filename: string;
  line: number;
  preview: string;
}

interface FileGroup {
  uri: string;
  filename: string;
  hits: Hit[];
}

export function SearchPanel(): JSX.Element {
  const workspaceRoot = useEmberStore((s) => s.workspaceRoot);
  const openFile = useEmberStore((s) => s.openFile);
  const requestReveal = useEmberStore((s) => s.requestReveal);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  const runSearch = useCallback(async () => {
    if (!workspaceRoot || !query.trim()) {
      setGroups([]);
      setTotal(null);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    try {
      const hits: Hit[] = await window.ember.searchWorkspace(workspaceRoot, query, { caseSensitive, isRegex });
      if (mine !== seq.current) return; // a newer search superseded this one
      const byFile = new Map<string, FileGroup>();
      for (const h of hits) {
        let g = byFile.get(h.uri);
        if (!g) {
          g = { uri: h.uri, filename: h.filename, hits: [] };
          byFile.set(h.uri, g);
        }
        g.hits.push(h);
      }
      setGroups([...byFile.values()]);
      setTotal(hits.length);
    } catch (err) {
      console.error('[SearchPanel] search failed', err);
      setGroups([]);
      setTotal(0);
    } finally {
      if (mine === seq.current) setSearching(false);
    }
  }, [workspaceRoot, query, caseSensitive, isRegex]);

  const openHit = useCallback(
    (hit: Hit) => {
      openFile(hit.uri, hit.filename);
      window.ember.openDocument(hit.uri).catch(() => {});
      requestReveal(hit.uri, hit.line);
    },
    [openFile, requestReveal]
  );

  return (
    <div className="panel-view">
      <div className="panel-view-header">Search</div>
      <div className="search-controls">
        <div className="search-input-wrap">
          <Icon name="search" size={14} className="search-input-icon" />
          <input
            className="search-input"
            placeholder="Search project…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
            }}
          />
        </div>
        <div className="search-options">
          <button
            className={`search-toggle ${caseSensitive ? 'active' : ''}`}
            title="Match Case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button
            className={`search-toggle ${isRegex ? 'active' : ''}`}
            title="Use Regular Expression"
            onClick={() => setIsRegex((v) => !v)}
          >
            .*
          </button>
          <button className="search-go" onClick={runSearch} disabled={!workspaceRoot}>
            Go
          </button>
        </div>
      </div>
      {total !== null && (
        <div className="search-summary">
          {searching ? 'Searching…' : `${total} result${total === 1 ? '' : 's'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`}
        </div>
      )}
      <div className="search-results">
        {groups.map((g) => (
          <div key={g.uri} className="search-group">
            <div className="search-group-file" title={decodeURIComponent(g.uri)}>
              <span className="file-icon" style={{ color: fileIconColor(g.filename) }}>
                <Icon name={fileIconName(g.filename)} size={15} />
              </span>
              <span className="file-name">{g.filename}</span>
              <span className="search-count">{g.hits.length}</span>
            </div>
            {g.hits.map((h, i) => (
              <div key={i} className="search-hit" onClick={() => openHit(h)} title={`Line ${h.line}`}>
                <span className="search-hit-line">{h.line}</span>
                <span className="search-hit-text">{h.preview || '(blank line)'}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
