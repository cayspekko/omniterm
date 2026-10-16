'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Tab } from '../types';
import { AppIcon, CloseIcon, FileIcon, GlobeIcon, PlusIcon, TerminalIcon } from './icons';

export interface CreateMenuEntry {
  /** Tab type the entry creates (drives its icon). */
  type: string;
  label: string;
  onSelect: () => void;
}

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  alertedTabIds?: ReadonlySet<string>;
  /** Compact tabs (icon + short label) for narrow viewports. */
  compact?: boolean;
  leftAction?: ReactNode;
  rightAction?: ReactNode;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /**
   * Entries of the [+] button. One entry: [+] creates it directly. Two or
   * more: [+] opens a menu (first entry first — the host puts Terminal there).
   */
  createMenu: ReadonlyArray<CreateMenuEntry>;
  /** Integration-provided icon for a tab; `null` falls back to the type default. */
  tabIcon?: (tab: Tab) => ReactNode | null;
  onRename: (tabId: string, name: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

/** Icon for a tab: favicon-style `iconUrl` → integration icon → per-type default. */
export function renderTabIcon(
  tab: Pick<Tab, 'type' | 'id' | 'name' | 'iconUrl'>,
  tabIcon: ((tab: Tab) => ReactNode | null) | undefined,
  size = 14,
): ReactNode {
  if (tab.iconUrl) return <TabImageIcon src={tab.iconUrl} type={tab.type} size={size} />;
  let custom: ReactNode | null = null;
  try {
    custom = tabIcon?.(tab as Tab) ?? null;
  } catch {
    custom = null;
  }
  if (custom) return custom;
  return defaultTabIcon(tab.type, size);
}

export function defaultTabIcon(type: string, size = 14): ReactNode {
  switch (type) {
    case 'terminal':
      return <TerminalIcon size={size} />;
    case 'browser':
      return <GlobeIcon size={size} />;
    case 'file':
      return <FileIcon size={size} />;
    default:
      return <AppIcon size={size} />;
  }
}

/** A favicon that falls back to the type icon when the image fails to load. */
function TabImageIcon({ src, type, size }: { src: string; type: string; size: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <>{defaultTabIcon(type, size)}</>;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export default function TabBar({
  tabs,
  activeTabId,
  alertedTabIds,
  compact,
  leftAction,
  rightAction,
  onSelect,
  onClose,
  createMenu,
  tabIcon,
  onRename,
  onReorder,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view. Manual scrollLeft math rather than
  // scrollIntoView, which would also scroll the overflow:hidden ancestors.
  // Also on strip resize: rotating a phone or narrowing the window can push
  // the active tab out of view without any tab changing.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeTabId) return;
    const reveal = () => {
      const el = strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
      if (!el) return;
      const left = el.offsetLeft;
      const right = left + el.offsetWidth;
      if (left < strip.scrollLeft) strip.scrollLeft = left;
      else if (right > strip.scrollLeft + strip.clientWidth)
        strip.scrollLeft = right - strip.clientWidth;
    };
    reveal();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [activeTabId, tabs.length]);

  // Vertical wheel scrolls the strip sideways (no visible scrollbar).
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  // The menu is portalled to escape the bar's overflow clipping, so it needs
  // absolute coordinates under the [+] button.
  useLayoutEffect(() => {
    if (!menuOpen || !addBtnRef.current) {
      setMenuPos(null);
      return;
    }
    const r = addBtnRef.current.getBoundingClientRect();
    const menuWidth = 180;
    setMenuPos({ top: r.bottom + 2, left: Math.max(4, Math.min(r.left, window.innerWidth - menuWidth - 4)) });
  }, [menuOpen]);

  const showDropdown = createMenu.length >= 2;
  const handleAddClick = () => {
    if (showDropdown) setMenuOpen((v) => !v);
    else createMenu[0]?.onSelect();
  };
  const addTitle = showDropdown
    ? 'New tab'
    : createMenu.length === 1
      ? `New ${createMenu[0].label.toLowerCase()}`
      : 'Select a workspace first';

  // Close the menu on outside click / Escape / resize (its position is stale).
  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addBtnRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onResize = () => setMenuOpen(false);
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [menuOpen]);

  const startRename = (tab: Tab) => {
    setEditingId(tab.id);
    setEditValue(tab.name);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) onRename(editingId, editValue.trim());
    setEditingId(null);
  };

  return (
    <div style={S.container}>
      {leftAction}
      <div ref={stripRef} className="ot-tabstrip" role="tablist">
        {tabs.map((tab, i) => {
          const active = tab.id === activeTabId;
          const renamable = tab.renamable !== false;
          const alerted = !active && !!alertedTabIds?.has(tab.id);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={active}
              className={compact ? 'ot-tab ot-tab-compact' : 'ot-tab'}
              data-dragging={dragIndex === i ? 'true' : undefined}
              data-drop-target={
                dropIndex === i && dragIndex !== null && dragIndex !== i ? 'true' : undefined
              }
              draggable={editingId !== tab.id}
              onDragStart={(e) => {
                setDragIndex(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropIndex(i);
              }}
              onDragLeave={() => setDropIndex(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== i) onReorder(dragIndex, i);
                setDragIndex(null);
                setDropIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDropIndex(null);
              }}
              onClick={() => onSelect(tab.id)}
              // Middle-click closes; preventDefault on mousedown stops autoscroll.
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onClose(tab.id);
              }}
              onDoubleClick={(e) => {
                if (!renamable) return;
                e.stopPropagation();
                startRename(tab);
              }}
              title={tab.title ?? tab.name}
            >
              <span className="ot-tab-icon">
                {renderTabIcon(tab, tabIcon, 14)}
                {alerted && <span className="ot-tab-alert" aria-label="Needs attention" />}
              </span>
              {editingId === tab.id ? (
                <input
                  ref={inputRef}
                  className="ot-tab-rename"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span className="ot-tab-label">{tab.name}</span>
              )}
              <button
                className="ot-tab-close"
                data-dirty={tab.dirty ? 'true' : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                title={tab.dirty ? 'Unsaved changes — close tab' : 'Close tab'}
                aria-label={`Close ${tab.name}`}
              >
                {tab.dirty && <span className="ot-dirty-dot" />}
                <span className="ot-close-glyph">
                  <CloseIcon size={12} />
                </span>
              </button>
            </div>
          );
        })}
      </div>
      <button
        ref={addBtnRef}
        className="ot-icon-btn"
        onClick={handleAddClick}
        title={addTitle}
        aria-label={addTitle}
        aria-haspopup={showDropdown ? 'menu' : undefined}
        aria-expanded={showDropdown ? menuOpen : undefined}
        disabled={createMenu.length === 0}
        style={createMenu.length === 0 ? S.disabled : undefined}
      >
        <PlusIcon size={16} />
      </button>
      <div style={S.spacer} />
      {rightAction}
      {showDropdown &&
        menuOpen &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ ...S.addMenu, top: menuPos.top, left: menuPos.left }}
          >
            {createMenu.map((opt) => (
              <button
                key={`${opt.type}:${opt.label}`}
                role="menuitem"
                className="ot-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  opt.onSelect();
                }}
              >
                <span style={S.menuIcon}>
                  {renderTabIcon({ type: opt.type, id: '', name: opt.label }, tabIcon, 14)}
                </span>
                {opt.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    height: 'var(--tab-height)',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    overflow: 'hidden',
    minWidth: 0,
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  disabled: {
    opacity: 0.3,
    cursor: 'default',
  },
  addMenu: {
    position: 'fixed',
    minWidth: '160px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    padding: '4px 0',
    zIndex: 1000,
  },
  menuIcon: {
    display: 'flex',
    width: '14px',
    height: '14px',
    color: 'var(--text-muted)',
  },
};
