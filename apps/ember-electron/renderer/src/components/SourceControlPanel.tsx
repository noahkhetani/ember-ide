import { useCallback, useEffect, useState } from 'react';
import { useEmberStore } from '../stores/ember-store';
import { Icon, fileIconColor, fileIconName } from './Icon';

interface FileStatus {
  path: string;
  uri: string;
  index: string;
  working: string;
}

interface Status {
  branch: string;
  staged: FileStatus[];
  unstaged: FileStatus[];
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

function badge(letter: string): { ch: string; cls: string } {
  switch (letter) {
    case 'M':
      return { ch: 'M', cls: 'git-badge-m' };
    case 'A':
      return { ch: 'A', cls: 'git-badge-a' };
    case 'D':
      return { ch: 'D', cls: 'git-badge-d' };
    case 'R':
      return { ch: 'R', cls: 'git-badge-m' };
    case '?':
      return { ch: 'U', cls: 'git-badge-a' };
    default:
      return { ch: letter || '•', cls: 'git-badge-m' };
  }
}

export function SourceControlPanel(): JSX.Element {
  const workspaceRoot = useEmberStore((s) => s.workspaceRoot);
  const openFile = useEmberStore((s) => s.openFile);
  const gitRefreshNonce = useEmberStore((s) => s.gitRefreshNonce);
  const [status, setStatus] = useState<Status | null>(null);
  const [notRepo, setNotRepo] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diffText, setDiffText] = useState('');

  const load = useCallback(async () => {
    if (!workspaceRoot) return;
    try {
      const s: Status | null = await window.ember.gitStatus(workspaceRoot);
      if (s === null) {
        setNotRepo(true);
        setStatus(null);
      } else {
        setNotRepo(false);
        setStatus(s);
      }
    } catch (err) {
      console.error('[SCM] status failed', err);
      setNotRepo(true);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    load();
  }, [load, gitRefreshNonce]);

  const openEntry = useCallback(
    (f: FileStatus) => {
      openFile(f.uri, basename(f.path));
      window.ember.openDocument(f.uri).catch(() => {});
    },
    [openFile]
  );

  const toggleDiff = useCallback(
    async (f: FileStatus, staged: boolean) => {
      const key = (staged ? 'S:' : 'U:') + f.path;
      if (diffFor === key) {
        setDiffFor(null);
        return;
      }
      if (!workspaceRoot) return;
      const text = await window.ember.gitDiff(workspaceRoot, f.path, staged);
      setDiffText(text);
      setDiffFor(key);
    },
    [workspaceRoot, diffFor]
  );

  const stage = useCallback(
    async (f: FileStatus) => {
      if (!workspaceRoot) return;
      setBusy(true);
      try {
        await window.ember.gitStage(workspaceRoot, f.path);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [workspaceRoot, load]
  );

  const unstage = useCallback(
    async (f: FileStatus) => {
      if (!workspaceRoot) return;
      setBusy(true);
      try {
        await window.ember.gitUnstage(workspaceRoot, f.path);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [workspaceRoot, load]
  );

  const stageAll = useCallback(async () => {
    if (!workspaceRoot || !status) return;
    setBusy(true);
    try {
      for (const f of status.unstaged) await window.ember.gitStage(workspaceRoot, f.path);
      await load();
    } finally {
      setBusy(false);
    }
  }, [workspaceRoot, status, load]);

  const commit = useCallback(async () => {
    if (!workspaceRoot || !message.trim()) return;
    setBusy(true);
    try {
      await window.ember.gitCommit(workspaceRoot, message.trim());
      setMessage('');
      await load();
    } catch (err) {
      console.error('[SCM] commit failed', err);
      window.alert('Commit failed: ' + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [workspaceRoot, message, load]);

  const renderRow = (f: FileStatus, staged: boolean): JSX.Element => {
    const key = (staged ? 'S:' : 'U:') + f.path;
    const b = badge(staged ? f.index : f.working);
    return (
      <div key={key}>
        <div className="git-row">
          <span className="git-row-name" title={f.path} onClick={() => openEntry(f)}>
            <span className="file-icon" style={{ color: fileIconColor(basename(f.path)) }}>
              <Icon name={fileIconName(basename(f.path))} size={15} />
            </span>
            <span className="file-name">{basename(f.path)}</span>
          </span>
          <button className="git-action" title="Show diff" onClick={() => toggleDiff(f, staged)}>
            <Icon name="diff" size={15} />
          </button>
          {staged ? (
            <button className="git-action" title="Unstage" onClick={() => unstage(f)} disabled={busy}>
              <Icon name="minus" size={15} />
            </button>
          ) : (
            <button className="git-action" title="Stage" onClick={() => stage(f)} disabled={busy}>
              <Icon name="plus" size={15} />
            </button>
          )}
          <span className={`git-badge ${b.cls}`}>{b.ch}</span>
        </div>
        {diffFor === key && (
          <pre className="git-diff">
            {diffText.split('\n').map((l, i) => (
              <div
                key={i}
                className={
                  l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : l.startsWith('@') ? 'diff-hunk' : ''
                }
              >
                {l || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    );
  };

  return (
    <div className="panel-view">
      <div className="panel-view-header">
        Source Control
        <button className="scm-refresh" title="Refresh" onClick={load}>
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {!workspaceRoot && <div className="scm-empty">Open a folder to use source control</div>}
      {workspaceRoot && notRepo && <div className="scm-empty">No Git repository in this folder</div>}

      {status && (
        <div className="scm-body">
          <div className="scm-branch">
            <Icon name="git-branch" size={14} />
            <span>{status.branch}</span>
          </div>
          <div className="scm-commit">
            <textarea
              className="scm-message"
              placeholder="Message (commit staged changes)"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button className="scm-commit-btn" onClick={commit} disabled={busy || !message.trim() || status.staged.length === 0}>
              <Icon name="check" size={15} />
              Commit {status.staged.length > 0 ? `(${status.staged.length})` : ''}
            </button>
          </div>

          {status.staged.length > 0 && (
            <div className="scm-section">
              <div className="scm-section-header">Staged Changes <span className="scm-count">{status.staged.length}</span></div>
              {status.staged.map((f) => renderRow(f, true))}
            </div>
          )}

          <div className="scm-section">
            <div className="scm-section-header">
              Changes <span className="scm-count">{status.unstaged.length}</span>
              {status.unstaged.length > 0 && (
                <button className="git-action scm-stage-all" title="Stage All" onClick={stageAll} disabled={busy}>
                  <Icon name="plus" size={15} />
                </button>
              )}
            </div>
            {status.unstaged.map((f) => renderRow(f, false))}
            {status.unstaged.length === 0 && status.staged.length === 0 && (
              <div className="scm-empty">No changes</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
