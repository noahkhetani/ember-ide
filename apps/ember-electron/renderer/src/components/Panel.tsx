import { useEffect, useRef, useState } from 'react';
import { useEmberStore } from '../stores/ember-store';
import { TerminalView } from './Terminal';
import { Icon } from './Icon';

export function Panel(): JSX.Element {
  const activePanel = useEmberStore((s) => s.activePanel);
  const setActivePanel = useEmberStore((s) => s.setActivePanel);
  const setPanelVisible = useEmberStore((s) => s.setPanelVisible);
  const [height, setHeight] = useState(260);
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return;
      const h = window.innerHeight - e.clientY;
      setHeight(Math.min(Math.max(h, 120), window.innerHeight * 0.8));
    };
    const onUp = (): void => {
      dragging.current = false;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div className="panel" style={{ height }}>
      <div
        className="panel-resize"
        onMouseDown={() => {
          dragging.current = true;
          document.body.style.userSelect = 'none';
        }}
      />
      <div className="panel-tabs">
        <button
          className={`panel-tab ${activePanel === 'terminal' ? 'active' : ''}`}
          onClick={() => setActivePanel('terminal')}
        >
          Terminal
        </button>
        <button
          className={`panel-tab ${activePanel === 'output' ? 'active' : ''}`}
          onClick={() => setActivePanel('output')}
        >
          Output
        </button>
        <button className="panel-close" title="Close Panel (Ctrl+`)" onClick={() => setPanelVisible(false)}>
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className="panel-body">
        {/* Keep the terminal mounted across tab switches to preserve the session. */}
        <div className="panel-pane" style={{ display: activePanel === 'terminal' ? 'block' : 'none' }}>
          <TerminalView />
        </div>
        {activePanel === 'output' && <div className="panel-output">No output to show.</div>}
      </div>
    </div>
  );
}
