import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useEmberStore } from '../stores/ember-store';

const BACKSPACE = String.fromCharCode(127);
const CTRL_C = String.fromCharCode(3);

// A line-buffered terminal backed by a child-process shell. Because there is no
// real PTY, input is echoed locally and sent line-by-line on Enter.
export function TerminalView(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const workspaceRoot = useEmberStore.getState().workspaceRoot;
    let disposed = false;
    let backendId: string | null = null;
    let line = '';

    const term = new XTerm({
      convertEol: true,
      fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#1e1e1e', foreground: '#cccccc', cursor: '#cccccc' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      /* container not measured yet */
    }

    term.writeln('\x1b[90mEmber terminal — line-buffered shell. Type a command and press Enter.\x1b[0m');

    const dataUnsub = window.ember.onTerminalData(({ id, data }) => {
      if (id === backendId) term.write(data);
    });
    const exitUnsub = window.ember.onTerminalExit(({ id }) => {
      if (id === backendId) term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
    });

    term.onData((data: string) => {
      if (!backendId) return;
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          term.write('\r\n');
          window.ember.terminalWrite(backendId, line + '\n');
          line = '';
        } else if (ch === BACKSPACE || ch === '\b') {
          if (line.length > 0) {
            line = line.slice(0, -1);
            term.write('\b \b');
          }
        } else if (ch === CTRL_C) {
          window.ember.terminalWrite(backendId, CTRL_C);
          term.write('^C\r\n');
          line = '';
        } else if (ch >= ' ') {
          line += ch;
          term.write(ch);
        }
      }
    });

    window.ember
      .terminalCreate(workspaceRoot ?? '')
      .then((id) => {
        if (disposed) {
          window.ember.terminalKill(id);
          return;
        }
        backendId = id;
        term.focus();
      })
      .catch((err) => term.write(`\r\n\x1b[31m[failed to start terminal] ${err}\x1b[0m\r\n`));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      dataUnsub();
      exitUnsub();
      if (backendId) window.ember.terminalKill(backendId);
      term.dispose();
    };
  }, []);

  return (
    <div
      className="terminal-host"
      ref={containerRef}
      onClick={() => containerRef.current?.querySelector('textarea')?.focus()}
    />
  );
}
