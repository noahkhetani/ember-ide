import { useEmberStore, type SidebarView } from '../stores/ember-store';
import { Icon } from './Icon';

interface Item {
  view: SidebarView;
  label: string;
  icon: string;
}

const ITEMS: Item[] = [
  { view: 'explorer', label: 'Explorer', icon: 'explorer' },
  { view: 'search', label: 'Search', icon: 'search' },
  { view: 'scm', label: 'Source Control', icon: 'git-branch' },
];

export function ActivityBar(): JSX.Element {
  const activeView = useEmberStore((s) => s.activeView);
  const sidebarVisible = useEmberStore((s) => s.sidebarVisible);
  const panelVisible = useEmberStore((s) => s.panelVisible);
  const setActiveView = useEmberStore((s) => s.setActiveView);
  const toggleSidebar = useEmberStore((s) => s.toggleSidebar);
  const togglePanel = useEmberStore((s) => s.togglePanel);
  const theme = useEmberStore((s) => s.theme);
  const toggleTheme = useEmberStore((s) => s.toggleTheme);

  const handleClick = (view: SidebarView): void => {
    if (view === activeView && sidebarVisible) {
      toggleSidebar();
    } else {
      setActiveView(view);
    }
  };

  return (
    <div className="activity-bar">
      <div className="activity-top">
        {ITEMS.map((item) => (
          <button
            key={item.view}
            className={`activity-btn ${activeView === item.view && sidebarVisible ? 'active' : ''}`}
            title={item.label}
            aria-label={item.label}
            onClick={() => handleClick(item.view)}
          >
            <Icon name={item.icon} size={22} />
          </button>
        ))}
      </div>
      <div className="activity-bottom">
        <button
          className={`activity-btn ${panelVisible ? 'active' : ''}`}
          title="Toggle Panel (Ctrl+`)"
          aria-label="Toggle Panel"
          onClick={togglePanel}
        >
          <Icon name="terminal" size={22} />
        </button>
        <button
          className="activity-btn"
          title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          aria-label="Toggle Theme"
          onClick={toggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={20} />
        </button>
      </div>
    </div>
  );
}
