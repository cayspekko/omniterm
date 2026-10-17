'use client';

/**
 * Files as a plugin integration of the unified tab strip.
 *
 * One store per workspace (reset + rehydrated whenever `activePath` changes)
 * holds the open files, the tree, git status and the changes-only filter. Two
 * surfaces render from it:
 *   - `sidebarPanels[files]` — the tree, in the left sidebar;
 *   - `iframeTabsLayer`      — keep-alive viewer panes, one per open file,
 *                              shown only while that file's host tab is visible
 *                              (in the host's pane box: `paneStyleFor`).
 *
 * The store is the source of truth for which files are open; the host tab
 * strip is a mirror kept in step by one reconcile effect (see planReconcile).
 * User opens only touch the store; the reconcile opens the host tab (and
 * activates it when the open came from the user).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { track } from '../telemetryClient';
import {
  paneStyleResolver,
  type HostApi,
  type IframeTabsLayerState,
  type PluginIntegration,
  type Tab,
} from '../types';
import { FileIcon, FolderIcon, ImageIcon, PreviewIcon } from '../components/icons';
import ConfirmDialog from '../components/ConfirmDialog';
import { detectViewerKind } from '../../lib/previewable';
import FileTree, { type DirEntry } from './FileTree';
import FilePane, { type OpenFile } from './FilePane';
import {
  FILE_TAB_TYPE,
  desiredHostTabs,
  fileTabId,
  orderByHost,
  parseFileTabId,
  parsePersisted,
  planReconcile,
  serializePersisted,
  type FileRef,
  type FileTabKind,
} from './fileTabs';

interface FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
}

export interface UseFilesIntegrationArgs {
  activePath: string | null;
  isMobile: boolean;
  settingsHydrated: boolean;
  tabs: ReadonlyArray<Tab>;
  activeTabId: string | null;
  host: HostApi;
  fileHandlers?: PluginIntegration['fileHandlers'];
  fileIndicatorPaths?: ReadonlySet<string>;
}

/** How long a closed/removed id is shielded from reconcile re-adds while the
 *  host and the store commit their halves of the close. */
const SUPPRESS_MS = 3000;

function blankFile(root: string, kind: FileTabKind, path: string): OpenFile {
  return {
    id: fileTabId(root, kind, path),
    path,
    kind,
    content: '',
    language: '',
    size: 0,
    originalContent: null,
    isDirty: false,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export function useFilesIntegration(args: UseFilesIntegrationArgs): { integration: PluginIntegration } {
  const {
    activePath,
    isMobile,
    settingsHydrated,
    tabs,
    activeTabId,
    host,
    fileHandlers,
    fileIndicatorPaths,
  } = args;

  // ----- store -----
  const [files, setFiles] = useState<OpenFile[]>([]);
  /** activePath the current `files` were hydrated for (guards persistence and
   *  stale-tab pruning against the workspace-switch race). */
  const [hydratedPath, setHydratedPath] = useState<string | null>(null);
  const [tree, setTree] = useState<DirEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, DirEntry[]>>({});
  const [gitStatus, setGitStatus] = useState<Record<string, string>>({});
  const [changesOnly, setChangesOnly] = useState(false);
  /** Per-preview-tab reload nonce, keyed by tab id. */
  const [previewReload, setPreviewReload] = useState<Record<string, number>>({});
  const [closePrompt, setClosePrompt] = useState<{
    id: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [changesOnlyConfirm, setChangesOnlyConfirm] = useState(false);

  const editorContentRefs = useRef<Map<string, string>>(new Map());
  const filesRef = useRef(files);
  filesRef.current = files;
  const hostRef = useRef(host);
  hostRef.current = host;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  /** Ids the user just closed (or we just removed): never re-added by reconcile. */
  const suppressedRef = useRef<Map<string, number>>(new Map());
  /** Ids whose next reconcile open should activate (a user-initiated open). */
  const activateOnOpenRef = useRef<Set<string>>(new Set());
  /** Last file tab the host showed as active (persisted as `active`). */
  const lastActiveRef = useRef<FileRef | null>(null);

  const suppress = (id: string) => suppressedRef.current.set(id, Date.now());

  const activeFile = useMemo(
    () => (activeTabId ? (files.find((f) => f.id === activeTabId) ?? null) : null),
    [files, activeTabId],
  );
  if (activeFile) lastActiveRef.current = { path: activeFile.path, kind: activeFile.kind };

  // ----- fetching -----

  const fetchDir = useCallback(
    async (subPath: string): Promise<DirEntry[]> => {
      if (!activePath) return [];
      const fullPath = subPath ? `${activePath}/${subPath}` : activePath;
      try {
        const res = await fetch(`/api/fs?path=${encodeURIComponent(fullPath)}&mode=list`);
        if (res.ok) return ((await res.json()).entries as DirEntry[]) ?? [];
      } catch {}
      return [];
    },
    [activePath],
  );

  /** Read one file as a source tab; with `withDiff`, also its HEAD version. */
  const fetchSource = useCallback(
    async (filePath: string, withDiff: boolean): Promise<OpenFile | null> => {
      if (!activePath) return null;
      const fullPath = `${activePath}/${filePath}`;
      try {
        const [fileRes, origRes] = await Promise.all([
          fetch(`/api/fs?path=${encodeURIComponent(fullPath)}&mode=read`),
          withDiff
            ? fetch(
                `/api/git/show?cwd=${encodeURIComponent(activePath)}&path=${encodeURIComponent(filePath)}`,
              )
            : Promise.resolve(null),
        ]);
        if (!fileRes.ok) return null;
        const data: FileContent = await fileRes.json();
        let originalContent: string | null = null;
        if (origRes?.ok) originalContent = (await origRes.json()).content;
        return {
          ...blankFile(activePath, 'source', filePath),
          content: data.content,
          language: data.language,
          size: data.size,
          originalContent,
        };
      } catch {
        return null;
      }
    },
    [activePath],
  );

  const fetchGitStatus = useCallback(async () => {
    if (!activePath) return;
    try {
      const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(activePath)}`);
      if (res.ok && activePathRef.current === activePath) setGitStatus(await res.json());
    } catch {}
  }, [activePath]);

  // ----- workspace switch: reset, then hydrate persisted tabs -----

  useEffect(() => {
    // Drop the previous workspace's tabs from the strip (a no-op when the host
    // already cleared its list on the switch).
    for (const f of filesRef.current) {
      suppress(f.id);
      hostRef.current.removeTab(f.id);
    }
    setFiles([]);
    setTree([]);
    setExpandedDirs({});
    setGitStatus({});
    setPreviewReload({});
    setHydratedPath(null);
    editorContentRefs.current.clear();
    activateOnOpenRef.current.clear();
    lastActiveRef.current = null;
    if (!activePath || !settingsHydrated) return;

    const root = activePath;
    let cancelled = false;
    fetchDir('').then((entries) => !cancelled && setTree(entries));
    void fetchGitStatus();

    (async () => {
      try {
        const settings = await fetch('/api/settings').then((r) => r.json());
        if (cancelled) return;
        const persisted = parsePersisted(settings?.filePanelTabs?.[root]);
        // Hydrate is always non-diff: changes-only is an explicit per-session
        // toggle, so stale diffs are never restored.
        const sources = await Promise.all(
          persisted.open
            .filter((e) => e.kind === 'source' && !detectViewerKind(e.path))
            .map((e) => fetchSource(e.path, false)),
        );
        if (cancelled) return;
        const byPath = new Map(sources.flatMap((t) => (t ? [[t.path, t] as const] : [])));
        const restored: OpenFile[] = [];
        for (const e of persisted.open) {
          if (e.kind === 'preview' || detectViewerKind(e.path)) {
            // Previews and dedicated viewers fetch their own content on mount.
            restored.push(blankFile(root, e.kind, e.path));
          } else {
            const t = byPath.get(e.path);
            if (t) restored.push(t);
          }
        }
        for (const f of restored) suppressedRef.current.delete(f.id);
        setFiles(restored);
        const active = persisted.active
          ? (persisted.open.find((o) => `${o.kind}::${o.path}` === persisted.active) ?? null)
          : null;
        lastActiveRef.current = active;
      } catch {
        // fall through: an unreadable settings file just means no restored tabs
      }
      if (!cancelled) setHydratedPath(root);
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the workspace; fetchers are derived from activePath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, settingsHydrated]);

  // ----- reconcile store → host strip -----

  useEffect(() => {
    const now = Date.now();
    for (const [id, at] of suppressedRef.current) {
      if (now - at > SUPPRESS_MS) suppressedRef.current.delete(id);
    }
    // Until the store is hydrated for THIS workspace, `files` may still be the
    // previous workspace's (the render that switches activePath runs this
    // effect before the reset lands) — touch nothing then.
    const ready = activePath !== null && hydratedPath === activePath;
    if (activePath !== null && !ready) return;
    const desired = ready ? desiredHostTabs(activePath, files) : [];
    const plan = planReconcile({
      desired,
      hostTabs: tabs,
      suppressed: new Set(suppressedRef.current.keys()),
      pruneStale: true,
    });
    const h = hostRef.current;
    for (const id of plan.remove) h.removeTab(id);
    for (const { tab, after } of plan.open) {
      const activate = activateOnOpenRef.current.delete(tab.id);
      h.openTab(tab, after ? { activate, after } : { activate });
    }
    for (const { id, patch } of plan.update) h.updateTab(id, patch);
  }, [files, tabs, activePath, hydratedPath]);

  // ----- persistence (per workspace) -----

  const persistKey = useMemo(() => {
    if (!activePath || hydratedPath !== activePath) return null;
    const ordered = orderByHost(files, (f) => f.id, tabs);
    return JSON.stringify(
      serializePersisted(
        ordered.map((f) => ({ path: f.path, kind: f.kind })),
        lastActiveRef.current,
      ),
    );
    // activeTabId: re-evaluate the persisted `active` when the user switches tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, hydratedPath, files, tabs, activeTabId]);

  const lastPersistedRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!persistKey || !activePath) return;
    if (lastPersistedRef.current[activePath] === persistKey) return;
    lastPersistedRef.current[activePath] = persistKey;
    const dir = activePath;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePanelTabs: { [dir]: JSON.parse(persistKey) } }),
    })
      .then((res) => {
        if (!res.ok && lastPersistedRef.current[dir] === persistKey) delete lastPersistedRef.current[dir];
      })
      .catch(() => {
        if (lastPersistedRef.current[dir] === persistKey) delete lastPersistedRef.current[dir];
      });
  }, [persistKey, activePath]);

  // ----- tree refresh: SSE files-changed, window focus -----

  const refreshTree = useCallback(async () => {
    if (!activePath) return;
    const root = activePath;
    const rootEntries = await fetchDir('');
    if (activePathRef.current !== root) return;
    setTree(rootEntries);
    void fetchGitStatus();
    setExpandedDirs((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      Promise.all(keys.map((d) => fetchDir(d).then((entries) => [d, entries] as const))).then(
        (results) => {
          if (activePathRef.current !== root) return;
          setExpandedDirs((p) => {
            const next = { ...p };
            // Only refresh dirs that are still expanded.
            for (const [d, entries] of results) if (d in next) next[d] = entries;
            return next;
          });
        },
      );
      return prev;
    });
  }, [activePath, fetchDir, fetchGitStatus]);

  useEffect(() => {
    if (!activePath) return;
    window.addEventListener('focus', refreshTree);
    return () => window.removeEventListener('focus', refreshTree);
  }, [activePath, refreshTree]);

  useEffect(() => {
    if (!activePath) return;
    let es: EventSource | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function resetWatchdog() {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (closed) return;
        console.warn('[files] SSE watchdog timeout, reconnecting');
        es?.close();
        connect();
      }, 45_000);
    }

    function connect() {
      if (closed) return;
      es = new EventSource('/api/events');
      es.onopen = () => resetWatchdog();
      es.onerror = () => resetWatchdog();
      es.onmessage = (e) => {
        resetWatchdog();
        try {
          const { type } = JSON.parse(e.data);
          if (type === 'files-changed') void refreshTree();
        } catch {}
      };
    }

    connect();
    return () => {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      es?.close();
    };
  }, [activePath, refreshTree]);

  // Auto-expand directories holding changed files when entering changes mode.
  useEffect(() => {
    if (!changesOnly) return;
    const dirs = new Set<string>();
    for (const p of Object.keys(gitStatus)) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const dir of dirs) {
      if (expandedDirs[dir] === undefined) {
        void fetchDir(dir).then((entries) => setExpandedDirs((prev) => ({ ...prev, [dir]: entries })));
      }
    }
  }, [changesOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDir = useCallback(
    (dir: string) => {
      if (expandedDirs[dir]) {
        setExpandedDirs((prev) => {
          const next = { ...prev };
          delete next[dir];
          return next;
        });
      } else {
        setExpandedDirs((prev) => ({ ...prev, [dir]: [] }));
        void fetchDir(dir).then((entries) => setExpandedDirs((prev) => ({ ...prev, [dir]: entries })));
      }
    },
    [expandedDirs, fetchDir],
  );

  // ----- open / close / save -----

  /** Add a file to the store and have reconcile open + activate its host tab;
   *  if it is already open, just focus it. */
  const showFile = useCallback((f: OpenFile) => {
    suppressedRef.current.delete(f.id);
    const existing = filesRef.current.some((x) => x.id === f.id);
    if (existing) {
      hostRef.current.activateTab(f.id);
      return;
    }
    activateOnOpenRef.current.add(f.id);
    setFiles((prev) => {
      if (prev.some((x) => x.id === f.id)) return prev;
      if (f.kind !== 'preview') return [...prev, f];
      // Previews sit right after their source in the store too (persist order).
      const srcIdx = prev.findIndex((x) => x.kind === 'source' && x.path === f.path);
      return srcIdx === -1 ? [...prev, f] : [...prev.slice(0, srcIdx + 1), f, ...prev.slice(srcIdx + 1)];
    });
  }, []);

  const openFile = useCallback(
    async (filePath: string) => {
      const root = activePathRef.current;
      if (!root) return;
      const id = fileTabId(root, 'source', filePath);
      if (filesRef.current.some((f) => f.id === id)) {
        showFile(blankFile(root, 'source', filePath));
        return;
      }
      // Image/PDF/CSV open in a dedicated viewer that streams the raw route
      // itself — skip the text read (garbage for binary files).
      const viewerKind = detectViewerKind(filePath);
      if (viewerKind) {
        showFile(blankFile(root, 'source', filePath));
        track('file_opened_viewer', { kind: viewerKind });
        return;
      }
      const tab = await fetchSource(filePath, changesOnly);
      if (activePathRef.current !== root) return;
      if (!tab) {
        console.error(`[files] failed to open ${filePath}`);
        return;
      }
      showFile(tab);
      track('file_opened_editor', { language: tab.language || 'plaintext' });
    },
    [fetchSource, changesOnly, showFile],
  );

  const openPreview = useCallback(
    (filePath: string) => {
      const root = activePathRef.current;
      if (!root) return;
      showFile(blankFile(root, 'preview', filePath));
    },
    [showFile],
  );

  const dropFromStore = useCallback((id: string) => {
    setFiles((prev) => (prev.some((f) => f.id === id) ? prev.filter((f) => f.id !== id) : prev));
    editorContentRefs.current.delete(id);
    activateOnOpenRef.current.delete(id);
    setPreviewReload((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    setFiles((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      if (idx === -1 || prev[idx].isDirty === dirty) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], isDirty: dirty };
      return next;
    });
  }, []);

  const save = useCallback(
    async (id: string, filePath: string, content: string) => {
      const root = activePathRef.current;
      if (!root) throw new Error('no workspace');
      const res = await fetch('/api/fs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `${root}/${filePath}`, content }),
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      // FileViewer clears its own dirty flag after onSave resolves, but the
      // close dialog's "Save & Close" calls this directly.
      setDirty(id, false);
      // Re-fetch any open preview of the same file.
      const previewId = fileTabId(root, 'preview', filePath);
      setPreviewReload((prev) => ({ ...prev, [previewId]: (prev[previewId] ?? 0) + 1 }));
    },
    [setDirty],
  );

  const rememberContent = useCallback((id: string, content: string) => {
    editorContentRefs.current.set(id, content);
  }, []);

  const reloadPreview = useCallback((id: string) => {
    setPreviewReload((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  // Toggling changes-only drops every file tab: diff and edit views need
  // different server data and we don't silently reload them all.
  const performChangesOnlyToggle = useCallback(() => {
    setChangesOnly((v) => !v);
    for (const f of filesRef.current) {
      suppress(f.id);
      hostRef.current.removeTab(f.id);
    }
    setFiles([]);
    editorContentRefs.current.clear();
    activateOnOpenRef.current.clear();
    setPreviewReload({});
  }, []);

  const toggleChangesOnly = useCallback(() => {
    if (filesRef.current.some((f) => f.isDirty)) setChangesOnlyConfirm(true);
    else performChangesOnlyToggle();
  }, [performChangesOnlyToggle]);

  // ----- host-facing slots -----

  const beforeCloseTab = useCallback((tab: Tab): boolean | Promise<boolean> => {
    if (tab.type !== FILE_TAB_TYPE) return true;
    const f = filesRef.current.find((x) => x.id === tab.id);
    if (!f?.isDirty) {
      suppress(tab.id);
      return true;
    }
    return new Promise<boolean>((resolve) => {
      setClosePrompt((cur) => {
        cur?.resolve(false); // a second prompt supersedes (cancels) the first
        return {
          id: tab.id,
          resolve: (ok) => {
            if (ok) suppress(tab.id);
            resolve(ok);
          },
        };
      });
    });
  }, []);

  const onCloseTab = useCallback(
    (tab: Tab) => {
      if (tab.type !== FILE_TAB_TYPE) return;
      suppress(tab.id);
      dropFromStore(tab.id);
    },
    [dropFromStore],
  );

  const tabIcon = useCallback(
    (tab: Tab) => {
      if (tab.type !== FILE_TAB_TYPE) return null;
      const parsed = parseFileTabId(tab.id);
      if (!parsed) return <FileIcon size={14} />;
      if (parsed.kind === 'preview') return <PreviewIcon size={14} />;
      if (detectViewerKind(parsed.absPath)) return <ImageIcon size={14} />;
      return <FileIcon size={14} />;
    },
    [],
  );

  const closePromptFile = closePrompt ? files.find((f) => f.id === closePrompt.id) : undefined;

  const dialogs = (
    <>
      {closePrompt &&
        createPortal(
          <ConfirmDialog
            title="Unsaved Changes"
            message={`"${closePromptFile?.path ?? parseFileTabId(closePrompt.id)?.absPath ?? closePrompt.id}" has unsaved changes.`}
            buttons={[
              {
                label: 'Save & Close',
                primary: true,
                action: async () => {
                  const p = closePrompt;
                  const f = filesRef.current.find((x) => x.id === p.id);
                  if (!f) {
                    p.resolve(true);
                    return;
                  }
                  const content = editorContentRefs.current.get(f.id) ?? f.content;
                  try {
                    await save(f.id, f.path, content);
                  } catch (err) {
                    // Keep the tab — closing it now would lose the edits.
                    console.error('[files] save failed:', err);
                    return; // onClose below resolves false
                  }
                  p.resolve(true);
                },
              },
              {
                label: 'Discard',
                danger: true,
                action: () => closePrompt.resolve(true),
              },
              { label: 'Cancel', action: () => closePrompt.resolve(false) },
            ]}
            // ConfirmDialog calls onClose after every button too; resolving an
            // already-settled promise is a no-op, so this only lands for
            // Cancel / backdrop / failed save.
            onClose={() => {
              closePrompt.resolve(false);
              setClosePrompt(null);
            }}
          />,
          document.body,
        )}
      {changesOnlyConfirm &&
        createPortal(
          <ConfirmDialog
            title="Unsaved Changes"
            message={`Switching mode will discard unsaved changes in ${files.filter((f) => f.isDirty).length} file(s).`}
            buttons={[
              { label: 'Discard & Switch', danger: true, action: performChangesOnlyToggle },
              { label: 'Cancel', action: () => {} },
            ]}
            onClose={() => setChangesOnlyConfirm(false)}
          />,
          document.body,
        )}
    </>
  );

  const iframeTabsLayer = (state: IframeTabsLayerState) => {
    if (!activePath && !closePrompt && !changesOnlyConfirm) return null;
    const styleFor = paneStyleResolver(state);
    return (
      <Fragment key="files-layer">
        {activePath &&
          hydratedPath === activePath &&
          files.map((f) => (
            <FilePane
              key={f.id}
              file={f}
              dirPath={activePath}
              paneStyle={styleFor(f.id)}
              diff={changesOnly && f.originalContent !== null}
              reloadKey={previewReload[f.id]}
              onDirty={setDirty}
              onSave={save}
              onContentChange={rememberContent}
              onOpenPreview={openPreview}
              onReloadPreview={reloadPreview}
            />
          ))}
        {dialogs}
      </Fragment>
    );
  };

  const sidebarPanels = [
    {
      id: 'files',
      label: 'Files',
      icon: <FolderIcon size={16} />,
      render: ({ isMobile: mobile, closeSidebar }: { isMobile: boolean; closeSidebar: () => void }) => (
        <FileTree
          rootPath={activePath}
          tree={tree}
          expandedDirs={expandedDirs}
          gitStatus={gitStatus}
          changesOnly={changesOnly}
          activeRelPath={activeFile?.path ?? null}
          fileHandlers={fileHandlers}
          fileIndicatorPaths={fileIndicatorPaths ?? EMPTY_SET}
          host={host}
          onToggleDir={toggleDir}
          onOpenFile={(p) => {
            void openFile(p);
            if (mobile || isMobile) closeSidebar();
          }}
          onOpenPreview={(p) => {
            openPreview(p);
            if (mobile || isMobile) closeSidebar();
          }}
          onToggleChangesOnly={toggleChangesOnly}
          onRefresh={() => void refreshTree()}
        />
      ),
    },
  ];

  return {
    integration: {
      beforeCloseTab,
      onCloseTab,
      tabIcon,
      iframeTabsLayer,
      paneAware: true,
      sidebarPanels,
      // Files restore themselves from `filePanelTabs`; the host must not.
      ephemeralTabTypes: FILE_EPHEMERAL,
    },
  };
}

const FILE_EPHEMERAL: ReadonlySet<string> = new Set([FILE_TAB_TYPE]);
