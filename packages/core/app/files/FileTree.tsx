'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BranchIcon, FileIcon, FolderIcon } from '../components/icons';
import { isPreviewable } from '../../lib/previewable';
import type { HostApi, PluginIntegration } from '../types';
import { buildDirStatus, changedSets, gitStatusColor, matchesGlob } from './fileTabs';

export interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

interface Props {
  /** Workspace root (absolute). `null` → "Select a workspace" placeholder. */
  rootPath: string | null;
  tree: DirEntry[];
  expandedDirs: Record<string, DirEntry[]>;
  gitStatus: Record<string, string>;
  changesOnly: boolean;
  /** Workspace-relative path of the active tab's file (highlighted). */
  activeRelPath: string | null;
  fileHandlers?: PluginIntegration['fileHandlers'];
  fileIndicatorPaths?: ReadonlySet<string>;
  host: HostApi;
  onToggleDir: (relPath: string) => void;
  /** Opens (or focuses) a file. Also called for the context menu's preview. */
  onOpenFile: (relPath: string) => void;
  onOpenPreview: (relPath: string) => void;
  onToggleChangesOnly: () => void;
  onRefresh: () => void;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function ContextMenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="menuitem"
      style={{
        ...S.contextMenuItem,
        background: hover ? 'var(--accent)' : 'transparent',
        color: hover ? 'var(--text-bright)' : 'var(--text)',
      }}
      onClick={onClick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {children}
    </div>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.1s' }}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const RefreshIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

/**
 * The workspace file tree, rendered as the left sidebar's "Files" section.
 * Pure view over the files store (useFilesIntegration) — only the context
 * menu and long-press bookkeeping are local.
 */
export default function FileTree({
  rootPath,
  tree,
  expandedDirs,
  gitStatus,
  changesOnly,
  activeRelPath,
  fileHandlers,
  fileIndicatorPaths,
  host,
  onToggleDir,
  onOpenFile,
  onOpenPreview,
  onToggleChangesOnly,
  onRefresh,
}: Props) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    absPath: string;
    relPath: string;
  } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const openContextMenu = useCallback(
    (clientX: number, clientY: number, relPath: string) => {
      if (!rootPath) return;
      const absPath = relPath ? `${rootPath}/${relPath}` : rootPath;
      const MENU_W = 180;
      // Estimate height from the visible item count so the menu isn't clipped
      // off the bottom when a file matches several plugin handlers.
      const basename = absPath.split('/').pop() ?? '';
      const matching = (fileHandlers ?? []).filter((h) => matchesGlob(h.pattern, basename)).length;
      const previewable = relPath && isPreviewable(relPath) ? 1 : 0;
      const menuH = (1 + previewable + matching) * 32 + 8;
      const x = Math.min(clientX, window.innerWidth - MENU_W - 8);
      const y = Math.min(clientY, window.innerHeight - menuH - 8);
      setContextMenu({ x: Math.max(0, x), y: Math.max(0, y), absPath, relPath });
    },
    [rootPath, fileHandlers],
  );

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  // Memoized on gitStatus so editor keystrokes (dirty-state re-renders) don't
  // rebuild these.
  const { files: changedPaths, dirs: changedDirPaths } = useMemo(
    () => changedSets(gitStatus),
    [gitStatus],
  );
  const dirStatusColors = useMemo(() => buildDirStatus(gitStatus), [gitStatus]);

  if (!rootPath) {
    return (
      <div style={S.container}>
        <div style={S.empty}>Select a workspace</div>
      </div>
    );
  }

  const folderName = rootPath.split('/').filter(Boolean).pop() ?? rootPath;

  const renderEntries = (entries: DirEntry[], parentPath: string, depth: number): React.ReactNode =>
    entries
      .filter((entry) => {
        if (!changesOnly) return true;
        const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
        return entry.type === 'directory' ? changedDirPaths.has(fullPath) : changedPaths.has(fullPath);
      })
      .map((entry) => {
        const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
        const isExpanded = expandedDirs[fullPath] !== undefined;
        const isDir = entry.type === 'directory';
        const isSelected = !isDir && activeRelPath === fullPath;
        const statusColor = isDir ? dirStatusColors[fullPath] : gitStatusColor(gitStatus[fullPath]);
        const hasIndicator = !isDir && fileIndicatorPaths?.has(`${rootPath}/${fullPath}`);

        return (
          <div key={fullPath}>
            <div
              role="treeitem"
              aria-expanded={isDir ? isExpanded : undefined}
              aria-selected={isSelected}
              title={fullPath}
              style={{
                ...S.entry,
                paddingLeft: `${4 + depth * 12}px`,
                background: isSelected ? 'var(--accent)' : undefined,
                color: isSelected ? 'var(--text-bright)' : statusColor || 'var(--text)',
              }}
              onClick={() => {
                if (longPressFiredRef.current) {
                  longPressFiredRef.current = false;
                  return;
                }
                if (isDir) onToggleDir(fullPath);
                else onOpenFile(fullPath);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openContextMenu(e.clientX, e.clientY, fullPath);
              }}
              onTouchStart={(e) => {
                longPressFiredRef.current = false;
                const t = e.touches[0];
                if (!t) return;
                const cx = t.clientX;
                const cy = t.clientY;
                cancelLongPress();
                longPressTimerRef.current = setTimeout(() => {
                  longPressFiredRef.current = true;
                  openContextMenu(cx, cy, fullPath);
                }, 500);
              }}
              onTouchMove={cancelLongPress}
              onTouchEnd={cancelLongPress}
              onTouchCancel={cancelLongPress}
            >
              <span style={S.chevron}>{isDir && <Chevron open={isExpanded} />}</span>
              <span
                style={{
                  ...S.entryIcon,
                  color: isSelected ? 'inherit' : statusColor || 'var(--text-muted)',
                }}
              >
                {isDir ? <FolderIcon size={14} /> : <FileIcon size={14} />}
              </span>
              <span style={S.entryName}>{entry.name}</span>
              {hasIndicator && <span title="Open in plugin tab" style={S.indicator} />}
            </div>
            {isDir && isExpanded && expandedDirs[fullPath] && (
              <div role="group">{renderEntries(expandedDirs[fullPath], fullPath, depth + 1)}</div>
            )}
          </div>
        );
      });

  return (
    <div style={S.container}>
      <div style={S.header}>
        <span style={S.title} title={rootPath}>
          {changesOnly ? `${folderName} · changes` : folderName}
        </span>
        <button
          type="button"
          style={{ ...S.headerBtn, color: changesOnly ? 'var(--warning)' : undefined }}
          onClick={onToggleChangesOnly}
          title={changesOnly ? 'Show all files' : 'Show changes only'}
          aria-label={changesOnly ? 'Show all files' : 'Show changes only'}
          aria-pressed={changesOnly}
        >
          <BranchIcon size={14} />
        </button>
        <button
          type="button"
          style={S.headerBtn}
          onClick={onRefresh}
          title="Refresh"
          aria-label="Refresh files"
        >
          <RefreshIcon />
        </button>
      </div>
      <div style={S.treeContent} role="tree">
        {tree.length > 0 ? (
          renderEntries(tree, '', 0)
        ) : (
          <div style={S.empty}>{changesOnly ? 'No changes' : 'No files'}</div>
        )}
      </div>

      {contextMenu &&
        createPortal(
          <>
            <div
              style={S.contextMenuBackdrop}
              onClick={() => setContextMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu(null);
              }}
            />
            <div role="menu" style={{ ...S.contextMenu, left: contextMenu.x, top: contextMenu.y }}>
              <ContextMenuItem
                onClick={async () => {
                  await copyToClipboard(contextMenu.absPath);
                  setContextMenu(null);
                }}
              >
                Copy path
              </ContextMenuItem>
              {contextMenu.relPath && isPreviewable(contextMenu.relPath) && (
                <ContextMenuItem
                  onClick={() => {
                    onOpenPreview(contextMenu.relPath);
                    setContextMenu(null);
                  }}
                >
                  Open Preview
                </ContextMenuItem>
              )}
              {fileHandlers?.map((handler, i) => {
                const basename = contextMenu.absPath.split('/').pop() ?? '';
                if (!matchesGlob(handler.pattern, basename)) return null;
                return (
                  <ContextMenuItem
                    key={`${i}-${handler.pattern}-${handler.label}`}
                    onClick={() => {
                      void handler.onSelect(contextMenu.absPath, host);
                      setContextMenu(null);
                    }}
                  >
                    {handler.label}
                  </ContextMenuItem>
                );
              })}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    height: 'var(--tab-height)',
    padding: '0 4px 0 12px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    border: 'none',
    borderRadius: 4,
    background: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  treeContent: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '4px 0',
  },
  entry: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    height: 26,
    paddingRight: 8,
    cursor: 'pointer',
    fontSize: '13px',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  },
  chevron: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    flexShrink: 0,
    color: 'var(--text-muted)',
  },
  entryIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  entryName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  indicator: {
    display: 'inline-block',
    width: 6,
    height: 6,
    marginLeft: 6,
    borderRadius: '50%',
    background: 'var(--link)',
    flexShrink: 0,
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    padding: 16,
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
  contextMenuBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
  },
  contextMenu: {
    position: 'fixed',
    zIndex: 1001,
    minWidth: 180,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '4px 0',
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    fontSize: '13px',
  },
  contextMenuItem: {
    padding: '6px 12px',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
};
