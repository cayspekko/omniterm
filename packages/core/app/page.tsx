'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import WorkspacePanel, { WorkspaceHeaderActions } from './components/WorkspacePanel';
import TabBar, { renderTabIcon, type CreateMenuEntry } from './components/TabBar';
import Sidebar, { WORKSPACES_SECTION } from './components/Sidebar';
import SettingsPanel from './components/SettingsPanel';
import ConfirmDialog from './components/ConfirmDialog';
import { SettingsIcon, SidebarIcon } from './components/icons';
import type { HostApi, MainContentContext, SidebarPanel, Tab } from './types';
import { shouldResetWorkspaceTabs } from './workspaceSelection';
import { worktreeDeleteUrl, worktreeStatusUrl, probeIsDirty } from './worktreeDelete';
import { initClientTelemetry, track } from './telemetryClient';
import { MOBILE_MAX_WIDTH } from './breakpoints';
import {
  mergeTabOrder,
  neighbourAfterRemoval,
  parseTabOrders,
  placeBySavedOrder,
  type TabOrders,
} from './workspacePanelState';
import type { WorkspacesPanelMode, BrowserInspectorPosition } from '../lib/settings';

export type {
  HostApi,
  Tab,
  PluginIntegration,
  MainContentContext,
  SidebarPanel,
} from './types';
export { composeIntegrations } from './types';
export type {
  WorkspacesPanelMode,
  FilesPanelMode,
  BrowserPanelMode,
  BrowserInspectorPosition,
} from '../lib/settings';

// =========================================================================
// Host state — owned by `useHomeState`. Consumers thread this object into
// their plugin integrations AND into `<Home state={...} />` so both sides
// see the same instance of the state.
// =========================================================================

interface WorktreeInfo {
  id: string;
  repoId: string;
  branch: string;
  path: string;
  name: string;
  sessionCount: number;
  isMain?: boolean;
}

interface RepoInfo {
  id: string;
  name: string;
  remoteUrl: string;
  path: string;
  addedAt: string;
}

/**
 * Public surface of the host's state — the part integrations read/write.
 * Internal-only fields used by Home's own UI live on the same object but
 * aren't part of the documented contract for plugin authors.
 */
export interface HomeState {
  // Plugin-facing
  activePath: string | null;
  activeTabId: string | null;
  tabs: Tab[];
  /** Replace/update the tab list. Tabs that newly appear and have a saved
   *  position for this workspace are slotted back into it (see
   *  `placeBySavedOrder`), so integrations can restore asynchronously in any
   *  order without fighting the user's arrangement. */
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;
  hostApi: HostApi;
  isMobile: boolean;
  settingsHydrated: boolean;
  /** Placement of the DevTools inspector inside browser tabs. */
  browserInspectorPosition: BrowserInspectorPosition;
  refreshWorkspaces: () => Promise<void>;

  // Host-internal (consumed by Home itself; integrations should ignore)
  repos: RepoInfo[];
  worktreesByRepo: Record<string, WorktreeInfo[]>;
  activeWorktree: WorktreeInfo | null;
  workspacesOpen: boolean;
  workspacesPanelMode: WorkspacesPanelMode;
  workspacesPanelDockedOpen: boolean;
  /** Selected left-sidebar section ("workspaces" or a plugin panel id). */
  sidebarSection: string;
  workspaceFilterActiveOnly: boolean;
  workspacesWidth: number;
  settingsOpen: boolean;
  settingsPanelWidth: number;
  isResizing: boolean;
  pendingDeleteRepo: { id: string; label: string } | null;
  pendingDeleteWorktree: { wt: WorktreeInfo; dirty: boolean } | null;
  worktreeDeleteError: string | null;
  setWorkspacesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkspacesPanelMode: React.Dispatch<React.SetStateAction<WorkspacesPanelMode>>;
  setWorkspacesPanelDockedOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSidebarSection: React.Dispatch<React.SetStateAction<string>>;
  setBrowserInspectorPosition: React.Dispatch<React.SetStateAction<BrowserInspectorPosition>>;
  setWorkspaceFilterActiveOnly: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkspacesWidth: React.Dispatch<React.SetStateAction<number>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  setIsResizing: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingDeleteRepo: React.Dispatch<
    React.SetStateAction<{ id: string; label: string } | null>
  >;
  setPendingDeleteWorktree: React.Dispatch<
    React.SetStateAction<{ wt: WorktreeInfo; dirty: boolean } | null>
  >;
  setWorktreeDeleteError: React.Dispatch<React.SetStateAction<string | null>>;
  handleSelectWorktree: (wt: WorktreeInfo | null) => void;
  handleSelectDirectory: (cwd: string) => void;
  handleCreateWorktree: (repoId: string) => Promise<void>;
  handleDeleteWorktree: (wt: WorktreeInfo) => Promise<void>;
  handleRenameBranch: (wtId: string, newName: string) => Promise<void>;
  handleCloneRepo: (url: string, destination: string) => Promise<Response>;
  handleAddLocalRepo: (localPath: string) => Promise<void>;
  handleDeleteRepo: (repoId: string, label: string) => void;
  confirmDeleteRepo: () => Promise<void>;
  confirmDeleteWorktree: () => Promise<void>;
  handleRemoveDir: (dir: string) => Promise<void>;
}

/**
 * Options for `useHomeState`. Currently just a hook for plugins to
 * participate in the host's workspace refresh — the testbox composer
 * passes the aggregated `composeIntegrations(...).onWorkspaceRefresh`
 * here so that every refresh path (panel ⟳ button + internal callers
 * like delete-repo) refreshes plugin-owned state too.
 */
export interface UseHomeStateOptions {
  /** Runs after repos+worktrees are fetched, on every `refreshWorkspaces()`.
   *  Identity is snapshot via a ref each render, so callers don't need to
   *  ref-stabilize themselves; pass any inline closure. */
  onRefreshWorkspaces?: () => void | Promise<void>;
}

export function useHomeState(options?: UseHomeStateOptions): HomeState {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [worktreesByRepo, setWorktreesByRepo] = useState<Record<string, WorktreeInfo[]>>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeWorktree, setActiveWorktree] = useState<WorktreeInfo | null>(null);
  const [tabs, setTabsRaw] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [workspacesPanelMode, setWorkspacesPanelMode] = useState<WorkspacesPanelMode>('docked');
  const [workspacesPanelDockedOpen, setWorkspacesPanelDockedOpen] = useState(true);
  const [sidebarSection, setSidebarSection] = useState<string>(WORKSPACES_SECTION);
  const [browserInspectorPosition, setBrowserInspectorPosition] =
    useState<BrowserInspectorPosition>('hidden');
  const [workspaceFilterActiveOnly, setWorkspaceFilterActiveOnly] = useState(false);
  const [workspacesWidth, setWorkspacesWidth] = useState(280);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(420);
  const [isResizing, setIsResizing] = useState(false);
  const [pendingDeleteRepo, setPendingDeleteRepo] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [pendingDeleteWorktree, setPendingDeleteWorktree] = useState<{
    wt: WorktreeInfo;
    dirty: boolean;
  } | null>(null);
  const [worktreeDeleteError, setWorktreeDeleteError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_MAX_WIDTH);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // ----- per-workspace tab order -----
  // `tabOrderRef[path]` is the saved left-to-right id order (including ids of
  // tabs not restored yet). Read synchronously by the tab setters below, so it
  // lives in a ref; persisted by the effect further down.
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const tabOrderRef = useRef<TabOrders>({});
  const persistedTabOrderRef = useRef<TabOrders>({});

  const setTabs = useCallback<React.Dispatch<React.SetStateAction<Tab[]>>>((update) => {
    setTabsRaw((prev) => {
      const next = typeof update === 'function' ? update(prev) : update;
      if (next === prev) return prev;
      const path = activePathRef.current;
      return path ? placeBySavedOrder(prev, next, tabOrderRef.current[path]) : next;
    });
  }, []);

  /** Forget a closed tab's slot so reopening something with the same id
   *  doesn't jump back to where the old one was. */
  const forgetTabPosition = useCallback((id: string) => {
    const path = activePathRef.current;
    const saved = path ? tabOrderRef.current[path] : undefined;
    if (!path || !saved?.includes(id)) return;
    tabOrderRef.current = { ...tabOrderRef.current, [path]: saved.filter((x) => x !== id) };
  }, []);

  /** Drop a tab; if it was active, activate its right neighbour, else left. */
  const removeTabInternal = useCallback(
    (id: string) => {
      setTabsRaw((prev) => {
        // Unknown id → silent no-op (integrations call this speculatively), and
        // its saved slot is kept: it may be a tab that is about to be restored.
        if (!prev.some((t) => t.id === id)) return prev;
        forgetTabPosition(id);
        const neighbour = neighbourAfterRemoval(prev, id);
        setActiveTabId((cur) => (cur === id ? neighbour : cur));
        return prev.filter((t) => t.id !== id);
      });
    },
    [forgetTabPosition],
  );
  const fetchRepos = useCallback(async () => {
    const res = await fetch('/api/repos');
    if (res.ok) {
      const data: RepoInfo[] = await res.json();
      setRepos(data);
      return data;
    }
    return [];
  }, []);

  const fetchAllWorktrees = useCallback(async (repoList: RepoInfo[]) => {
    // Fetch concurrently — serial awaits made refresh latency scale with repo count.
    const entries = await Promise.all(
      repoList.map(async (repo) => {
        const res = await fetch(`/api/repos/${repo.id}/worktrees`);
        return res.ok ? ([repo.id, await res.json()] as const) : null;
      }),
    );
    const byRepo: Record<string, WorktreeInfo[]> = {};
    for (const entry of entries) {
      if (entry) byRepo[entry[0]] = entry[1];
    }
    setWorktreesByRepo(byRepo);
  }, []);

  // Snapshot via ref so refreshWorkspaces' identity stays stable even if
  // the consumer passes a fresh closure each render (composeIntegrations
  // does, since its aggregated handler list changes shape over time).
  const onRefreshWorkspacesRef = useRef(options?.onRefreshWorkspaces);
  onRefreshWorkspacesRef.current = options?.onRefreshWorkspaces;

  const refreshWorkspaces = useCallback(async () => {
    const repoList = await fetchRepos();
    await Promise.all([fetchAllWorktrees(repoList), onRefreshWorkspacesRef.current?.()]);
  }, [fetchRepos, fetchAllWorktrees]);

  // Initial hydration from /api/settings + repos/worktrees.
  useEffect(() => {
    refreshWorkspaces();
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        if (data.activePath) setActivePath(data.activePath);
        if (data.activeTabId) setActiveTabId(data.activeTabId);
        // Legacy `workspacePanelState` / `filesPanelMode` / `browserPanelMode`
        // (side-panel era) are deliberately ignored.
        const orders = parseTabOrders(data.tabOrder);
        tabOrderRef.current = orders;
        persistedTabOrderRef.current = orders;
        if (typeof data.sidebarSection === 'string' && data.sidebarSection) {
          setSidebarSection(data.sidebarSection);
        }
        if (data.workspacesPanelMode === 'overlay' || data.workspacesPanelMode === 'docked') {
          setWorkspacesPanelMode(data.workspacesPanelMode);
        }
        if (typeof data.workspacesPanelDockedOpen === 'boolean') {
          setWorkspacesPanelDockedOpen(data.workspacesPanelDockedOpen);
        }
        if (typeof data.workspaceFilterActiveOnly === 'boolean') {
          setWorkspaceFilterActiveOnly(data.workspaceFilterActiveOnly);
        }
        if (
          data.browserInspectorPosition === 'hidden' ||
          data.browserInspectorPosition === 'right' ||
          data.browserInspectorPosition === 'bottom'
        ) {
          setBrowserInspectorPosition(data.browserInspectorPosition);
        }
      })
      .catch(() => {})
      .finally(() => setSettingsHydrated(true));
  }, [refreshWorkspaces]);

  // Front-end telemetry: init from the server gate, then record app load time.
  useEffect(() => {
    const loadMs = Math.round(performance.now());
    void initClientTelemetry().then(() => track('app_loaded', { load_ms: loadMs }));
  }, []);

  // Persist host-level settings only.
  useEffect(() => {
    if (!settingsHydrated) return;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activePath,
        activeTabId,
        workspacesPanelMode,
        workspacesPanelDockedOpen,
        workspaceFilterActiveOnly,
        sidebarSection,
        browserInspectorPosition,
      }),
    });
  }, [
    settingsHydrated,
    activePath,
    activeTabId,
    workspacesPanelMode,
    workspacesPanelDockedOpen,
    workspaceFilterActiveOnly,
    sidebarSection,
    browserInspectorPosition,
  ]);

  // Persist the active workspace's tab order whenever the strip changes
  // (open / close / reorder). Merging with the saved order keeps the slots of
  // tabs that haven't been restored yet, so a half-restored strip right after
  // a switch or reload never truncates it.
  useEffect(() => {
    if (!settingsHydrated || !activePath) return;
    const merged = mergeTabOrder(
      tabs.map((t) => t.id),
      tabOrderRef.current[activePath] ?? [],
    );
    tabOrderRef.current = { ...tabOrderRef.current, [activePath]: merged };
    const persisted = persistedTabOrderRef.current[activePath] ?? [];
    if (persisted.length === merged.length && persisted.every((id, i) => id === merged[i])) return;
    persistedTabOrderRef.current = { ...persistedTabOrderRef.current, [activePath]: merged };
    const path = activePath;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabOrder: { [path]: merged } }),
    })
      .then((res) => {
        // Forget a failed write so the next change retries it.
        if (!res.ok && persistedTabOrderRef.current[path] === merged)
          delete persistedTabOrderRef.current[path];
      })
      .catch(() => {
        if (persistedTabOrderRef.current[path] === merged) delete persistedTabOrderRef.current[path];
      });
  }, [settingsHydrated, activePath, tabs]);

  const hostApi: HostApi = useMemo(
    () => ({
      openTab(tab, options) {
        const after = options?.after;
        setTabsRaw((prev) => {
          if (prev.some((t) => t.id === tab.id)) return prev;
          const afterIndex = after ? prev.findIndex((t) => t.id === after) : -1;
          if (afterIndex !== -1) {
            // Explicit placement wins over the saved order.
            const next = [...prev];
            next.splice(afterIndex + 1, 0, tab);
            return next;
          }
          const next = [...prev, tab];
          const path = activePathRef.current;
          return path ? placeBySavedOrder(prev, next, tabOrderRef.current[path]) : next;
        });
        if (options?.activate !== false) setActiveTabId(tab.id);
      },
      updateTab(id, patch) {
        setTabsRaw((prev) => {
          const i = prev.findIndex((t) => t.id === id);
          if (i === -1) return prev;
          const cur = prev[i];
          const changed = (Object.keys(patch) as Array<keyof typeof patch>).some(
            (k) => cur[k] !== patch[k],
          );
          if (!changed) return prev;
          const next = [...prev];
          next[i] = { ...cur, ...patch, id: cur.id, type: cur.type };
          return next;
        });
      },
      removeTab(id) {
        removeTabInternal(id);
      },
      activateTab(id) {
        // Checked inside an updater so an openTab queued in the same tick
        // counts as present. Returning `prev` makes this a no-op render-wise.
        setTabsRaw((prev) => {
          if (prev.some((t) => t.id === id)) setActiveTabId(id);
          return prev;
        });
      },
    }),
    [removeTabInternal],
  );

  const handleSelectWorktree = useCallback(
    (wt: WorktreeInfo | null) => {
      const nextPath = wt?.path ?? null;
      if (!shouldResetWorkspaceTabs(activePath, nextPath)) {
        setActiveWorktree((prev) => (prev?.id === wt?.id ? prev : wt));
        return;
      }
      setActivePath(nextPath);
      setActiveWorktree(wt);
      setTabs([]);
      setActiveTabId(null);
      track('workspace_switched', { kind: 'worktree' });
    },
    [activePath],
  );

  const handleSelectDirectory = useCallback(
    (cwd: string) => {
      if (!shouldResetWorkspaceTabs(activePath, cwd)) {
        setActiveWorktree((prev) => (prev === null ? prev : null));
        setWorkspacesOpen(false);
        return;
      }
      setActiveWorktree(null);
      setActivePath(cwd);
      setTabs([]);
      setActiveTabId(null);
      setWorkspacesOpen(false);
      track('workspace_switched', { kind: 'directory' });
    },
    [activePath],
  );

  const handleCreateWorktree = useCallback(
    async (repoId: string) => {
      const res = await fetch(`/api/repos/${repoId}/worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newBranch: true }),
      });
      if (res.ok) {
        const wt: WorktreeInfo = await res.json();
        await refreshWorkspaces();
        handleSelectWorktree({ ...wt, sessionCount: 0 });
      }
    },
    [refreshWorkspaces, handleSelectWorktree],
  );

  const handleDeleteWorktree = useCallback(async (wt: WorktreeInfo) => {
    // Probe uncommitted-changes state so the confirm dialog can warn before we
    // discard work. probeIsDirty fails safe to dirty (see its doc) so a failed
    // or garbled probe still warns and forces rather than silently omitting.
    let dirty = true;
    try {
      const res = await fetch(worktreeStatusUrl(wt.id));
      dirty = probeIsDirty(res.ok, res.ok ? await res.json() : null);
    } catch {
      dirty = true;
    }
    setPendingDeleteWorktree({ wt, dirty });
  }, []);

  const confirmDeleteWorktree = useCallback(async () => {
    const pending = pendingDeleteWorktree;
    setPendingDeleteWorktree(null);
    if (!pending) return;
    const { wt, dirty } = pending;
    try {
      const res = await fetch(worktreeDeleteUrl(wt.id, dirty), { method: 'DELETE' });
      if (!res.ok) {
        // The user confirmed a destructive action and it didn't happen (the
        // worktree went dirty between probe and confirm → 409, a locked worktree,
        // or a 5xx). Surface the server's reason instead of silently leaving a
        // blank panel, and don't clobber the still-live active session for a
        // worktree that wasn't actually removed.
        const reason = await res
          .json()
          .then((b) => (b && typeof b.error === 'string' ? (b.error as string) : null))
          .catch(() => null);
        setWorktreeDeleteError(reason ?? `Delete failed (${res.status}).`);
        await refreshWorkspaces();
        return;
      }
      if (activeWorktree?.id === wt.id) {
        setActiveWorktree(null);
        setActivePath(null);
        setTabs([]);
        setActiveTabId(null);
      }
      await refreshWorkspaces();
    } catch {
      // Network error reaching the server — the user confirmed but nothing
      // happened; surface it rather than leaving a blank panel (mirrors the
      // probe's fail-safe catch above).
      setWorktreeDeleteError('Delete failed — could not reach the server.');
      await refreshWorkspaces();
    }
  }, [pendingDeleteWorktree, activeWorktree, refreshWorkspaces]);

  const handleRenameBranch = useCallback(
    async (wtId: string, newName: string) => {
      await fetch(`/api/worktrees/${wtId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      });
      await refreshWorkspaces();
    },
    [refreshWorkspaces],
  );

  const handleCloneRepo = useCallback(
    async (url: string, destination: string) => {
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, destination }),
      });
      await refreshWorkspaces();
      return res;
    },
    [refreshWorkspaces],
  );

  const handleAddLocalRepo = useCallback(
    async (localPath: string) => {
      await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath }),
      });
      await refreshWorkspaces();
    },
    [refreshWorkspaces],
  );

  // `label` is the row's rendered name (see buildRepoLabels) — the repo id is a
  // path digest and would name nothing the user can see in a destructive prompt.
  const handleDeleteRepo = useCallback((repoId: string, label: string) => {
    setPendingDeleteRepo({ id: repoId, label });
  }, []);

  const confirmDeleteRepo = useCallback(async () => {
    const repoId = pendingDeleteRepo?.id;
    setPendingDeleteRepo(null);
    if (!repoId) return;
    await fetch(`/api/repos/${repoId}`, { method: 'DELETE' });
    if (activeWorktree?.repoId === repoId) {
      setActiveWorktree(null);
      setActivePath(null);
      setTabs([]);
      setActiveTabId(null);
    }
    await refreshWorkspaces();
  }, [pendingDeleteRepo, activeWorktree, refreshWorkspaces]);

  const handleRemoveDir = useCallback(
    async (dir: string) => {
      const settings = await fetch('/api/settings').then((r) => r.json());
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackedDirs: (settings.trackedDirs || []).filter((d: string) => d !== dir),
        }),
      });
      if (activePath === dir) {
        setActivePath(null);
        setTabs([]);
        setActiveTabId(null);
      }
      await refreshWorkspaces();
    },
    [activePath, refreshWorkspaces],
  );

  return {
    activePath,
    activeTabId,
    tabs,
    setTabs,
    setActiveTabId,
    hostApi,
    isMobile,
    settingsHydrated,
    refreshWorkspaces,
    repos,
    worktreesByRepo,
    activeWorktree,
    workspacesOpen,
    workspacesPanelMode,
    workspacesPanelDockedOpen,
    sidebarSection,
    browserInspectorPosition,
    workspaceFilterActiveOnly,
    workspacesWidth,
    settingsOpen,
    settingsPanelWidth,
    isResizing,
    pendingDeleteRepo,
    pendingDeleteWorktree,
    worktreeDeleteError,
    setWorkspacesOpen,
    setWorkspacesPanelMode,
    setWorkspacesPanelDockedOpen,
    setSidebarSection,
    setBrowserInspectorPosition,
    setWorkspaceFilterActiveOnly,
    setWorkspacesWidth,
    setSettingsOpen,
    setSettingsPanelWidth,
    setIsResizing,
    setPendingDeleteRepo,
    setPendingDeleteWorktree,
    setWorktreeDeleteError,
    handleSelectWorktree,
    handleSelectDirectory,
    handleCreateWorktree,
    handleDeleteWorktree,
    handleRenameBranch,
    handleCloneRepo,
    handleAddLocalRepo,
    handleDeleteRepo,
    confirmDeleteRepo,
    confirmDeleteWorktree,
    handleRemoveDir,
  };
}


// =========================================================================
// Home — pure renderer. State must be threaded in via the `state` prop.
// =========================================================================

const EMPTY_PATH_SET: ReadonlySet<string> = new Set();
const EMPTY_TAB_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_ORPHANS: Record<string, { name: string; created: string }[]> = {};
const EMPTY_PANELS: ReadonlyArray<SidebarPanel> = [];

export interface HomeProps {
  /** Required: the host state instance, obtained from `useHomeState()`. */
  state: HomeState;
  /**
   * Render slot for the active tab's component-mode content. Plugin
   * integrations contribute via `composeIntegrations(...)`.
   */
  mainContent?: (ctx: MainContentContext) => ReactNode;
  /** Render slot for the iframe overlay. */
  iframeTabsLayer?: (state: { activeTabId: string | null }) => ReactNode;
  /** @deprecated The file tree is an integration-owned sidebar panel now; the
   *  files integration consumes these. Accepted (and ignored) so a spread of
   *  `composeIntegrations(...)` still type-checks. */
  fileHandlers?: ReadonlyArray<{
    pattern: string;
    label: string;
    onSelect: (absPath: string, api: HostApi) => void | Promise<void>;
  }>;
  /** @deprecated See `fileHandlers`. */
  fileIndicatorPaths?: ReadonlySet<string>;
  ephemeralTabTypes?: ReadonlySet<string>;
  onCloseTab?: (tab: Tab) => void;
  /** Composed veto for user-initiated closes (resolve `false` to keep the tab). */
  beforeCloseTab?: (tab: Tab) => boolean | Promise<boolean>;
  /** Composed per-tab icon (null → the host's per-type default). */
  tabIcon?: (tab: Tab) => ReactNode | null;
  /** Integration-contributed left-sidebar sections, after Workspaces. */
  sidebarPanels?: ReadonlyArray<SidebarPanel>;
  /** Plugin-contributed tab types for the [+] dropdown. */
  tabTypeChoices?: ReadonlyArray<{
    type: string;
    label: string;
    onCreate: (api: HostApi) => void | Promise<void>;
    autoOpenOnLanding?: boolean;
  }>;
  alertedPaths?: ReadonlySet<string>;
  alertedTabIds?: ReadonlySet<string>;
  workspaceOrphans?: Record<string, { name: string; created: string }[]>;
  /** AND of plugins' `workspaceReady` signals; drives the landing-tab auto-spawn. */
  workspaceReady?: boolean;
}

export default function Home(props: HomeProps) {
  const {
    state: host,
    mainContent,
    iframeTabsLayer,
    onCloseTab,
    beforeCloseTab,
    tabIcon,
    sidebarPanels,
    tabTypeChoices,
    alertedPaths,
    alertedTabIds,
    workspaceOrphans,
    workspaceReady,
  } = props;

  const effectiveAlertedPaths = alertedPaths ?? EMPTY_PATH_SET;
  const effectiveAlertedTabIds = alertedTabIds ?? EMPTY_TAB_ID_SET;
  const effectiveOrphans = workspaceOrphans ?? EMPTY_ORPHANS;
  const panels = sidebarPanels ?? EMPTY_PANELS;

  // Narrow viewports always use overlay regardless of the user's preference.
  const effectiveSidebarMode: WorkspacesPanelMode = host.isMobile
    ? 'overlay'
    : host.workspacesPanelMode;
  const isDocked = effectiveSidebarMode === 'docked';
  const sidebarVisible = isDocked ? host.workspacesPanelDockedOpen : host.workspacesOpen;

  // [+] entries need a workspace: every tab is scoped to one.
  const createMenu = useMemo<CreateMenuEntry[]>(() => {
    if (!host.activePath) return [];
    return (tabTypeChoices ?? []).map((c) => ({
      type: c.type,
      label: c.label,
      onSelect: () => {
        void c.onCreate(host.hostApi);
      },
    }));
  }, [tabTypeChoices, host.hostApi, host.activePath]);

  // One landing attempt per workspace activation; stays consumed after user closes tabs.
  const landingAttemptRef = useRef<{ path: string | null; consumed: boolean }>({
    path: null,
    consumed: false,
  });

  // Landing-tab sequence: tabTypeChoices[0] focused, then any later
  // choice with autoOpenOnLanding=true, silent.
  const landingChoices = useMemo(() => {
    if (!tabTypeChoices || tabTypeChoices.length === 0) return [];
    const [first, ...rest] = tabTypeChoices;
    return [first, ...rest.filter((c) => c.autoOpenOnLanding)];
  }, [tabTypeChoices]);
  useEffect(() => {
    const path = host.activePath;
    if (!path) return;
    if (!host.settingsHydrated) return;
    if (workspaceReady === false) return;
    if (landingChoices.length === 0) return;
    if (landingAttemptRef.current.path !== path) {
      landingAttemptRef.current = { path, consumed: false };
    }
    if (landingAttemptRef.current.consumed) return;
    landingAttemptRef.current.consumed = true;
    if (host.tabs.length > 0) return;

    const silentApi: HostApi = {
      ...host.hostApi,
      openTab: (tab, options) => host.hostApi.openTab(tab, { ...options, activate: false }),
      activateTab: () => {},
    };

    (async () => {
      const [first, ...rest] = landingChoices;
      try {
        await first.onCreate(host.hostApi);
      } catch (err) {
        // Focused tab failed — drop consumption so re-entry retries the whole
        // spawn. Skip background tabs; the landing is already broken.
        if (landingAttemptRef.current.path === path) {
          landingAttemptRef.current.consumed = false;
        }
        console.warn(
          '[home] focused landing tab spawn failed:',
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      // Background tab failures stay scoped: log and continue. Resetting
      // consumption here would re-spawn the already-open focused tab.
      for (const choice of rest) {
        try {
          await choice.onCreate(silentApi);
        } catch (err) {
          console.warn(
            '[home] background landing tab spawn failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    })();
  }, [
    host.activePath,
    host.settingsHydrated,
    host.tabs.length,
    host.hostApi,
    workspaceReady,
    landingChoices,
  ]);

  // User-initiated close: ask the owning integration first (e.g. an unsaved
  // file prompt), then notify, then drop the tab and focus its neighbour.
  const closingRef = useRef<Set<string>>(new Set());
  const tabsRef = useRef(host.tabs);
  tabsRef.current = host.tabs;
  const handleCloseTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || closingRef.current.has(tabId)) return;
      closingRef.current.add(tabId);
      try {
        if (beforeCloseTab) {
          let allowed: boolean;
          try {
            allowed = (await beforeCloseTab(tab)) !== false;
          } catch (err) {
            // A throwing guard keeps the tab: losing unsaved work is worse.
            console.warn(
              '[home] beforeCloseTab failed; keeping the tab:',
              err instanceof Error ? err.message : String(err),
            );
            allowed = false;
          }
          if (!allowed) return;
        }
        // The tab may have gone away while the guard was prompting.
        const current = tabsRef.current.find((t) => t.id === tabId) ?? tab;
        onCloseTab?.(current);
        track('tab_closed', { type: current.type });
        host.hostApi.removeTab(tabId);
      } finally {
        closingRef.current.delete(tabId);
      }
    },
    [host.hostApi, beforeCloseTab, onCloseTab],
  );

  const handleCloseSidebar = useCallback(() => {
    if (isDocked) host.setWorkspacesPanelDockedOpen(false);
    else host.setWorkspacesOpen(false);
  }, [host, isDocked]);

  const handleToggleSidebar = useCallback(() => {
    if (isDocked) host.setWorkspacesPanelDockedOpen((prev) => !prev);
    else host.setWorkspacesOpen((v) => !v);
    track('panel_toggled', { panel: 'workspaces' });
  }, [host, isDocked]);

  const openSidebarOn = useCallback(
    (section: string) => {
      host.setSidebarSection(section);
      if (isDocked) host.setWorkspacesPanelDockedOpen(true);
      else host.setWorkspacesOpen(true);
    },
    [host, isDocked],
  );

  const handleSelectWorktreeAndClose = useCallback(
    (wt: WorktreeInfo) => {
      host.handleSelectWorktree(wt);
      // Docked mode keeps the sidebar pinned — selecting a worktree shouldn't hide it.
      if (!isDocked) host.setWorkspacesOpen(false);
    },
    [host, isDocked],
  );

  // When the user switches display mode while the sidebar is visible, carry
  // the visibility across: the two modes use independent flags
  // (workspacesOpen for overlay, workspacesPanelDockedOpen for docked).
  const handleSidebarModeChange = useCallback(
    (newMode: WorkspacesPanelMode) => {
      if (newMode === 'overlay' && host.workspacesPanelDockedOpen) {
        host.setWorkspacesOpen(true);
      } else if (newMode === 'docked' && host.workspacesOpen) {
        host.setWorkspacesPanelDockedOpen(true);
      }
      host.setWorkspacesPanelMode(newMode);
    },
    [host],
  );

  const alertedPathSet = useMemo(
    () =>
      effectiveAlertedPaths instanceof Set
        ? (effectiveAlertedPaths as Set<string>)
        : new Set(effectiveAlertedPaths),
    [effectiveAlertedPaths],
  );

  const workspacePanelElement = (
    <WorkspacePanel
      repos={host.repos}
      worktreesByRepo={host.worktreesByRepo}
      orphanSessions={effectiveOrphans}
      activeWorktreeId={host.activeWorktree?.id || null}
      activePath={host.activePath}
      alertedPaths={alertedPathSet}
      activeOnly={host.workspaceFilterActiveOnly}
      onSelectWorktree={handleSelectWorktreeAndClose}
      onCreateWorktree={host.handleCreateWorktree}
      onDeleteWorktree={host.handleDeleteWorktree}
      onRenameBranch={host.handleRenameBranch}
      onCloneRepo={host.handleCloneRepo}
      onAddLocalRepo={host.handleAddLocalRepo}
      onDeleteRepo={host.handleDeleteRepo}
      onRemoveDir={host.handleRemoveDir}
      onSelectDirectory={host.handleSelectDirectory}
      onToggleActiveOnly={() => host.setWorkspaceFilterActiveOnly((prev) => !prev)}
    />
  );

  const workspacesActions = (
    <WorkspaceHeaderActions
      activeOnly={host.workspaceFilterActiveOnly}
      onToggleActiveOnly={() => host.setWorkspaceFilterActiveOnly((prev) => !prev)}
      onRefresh={() => void host.refreshWorkspaces()}
      onGoHome={() => {
        host.handleSelectWorktree(null);
        if (!isDocked) host.setWorkspacesOpen(false);
      }}
    />
  );

  const hasAlerts = useMemo(() => {
    if (effectiveAlertedPaths.size === 0) return false;
    const workspacePaths: string[] = [];
    for (const wts of Object.values(host.worktreesByRepo)) {
      for (const wt of wts) workspacePaths.push(wt.path);
    }
    for (const dir of Object.keys(effectiveOrphans)) workspacePaths.push(dir);
    return workspacePaths.some((wp) => wp !== host.activePath && effectiveAlertedPaths.has(wp));
  }, [effectiveAlertedPaths, host.worktreesByRepo, effectiveOrphans, host.activePath]);

  // The badge surfaces alerts in other workspaces, but only while the sidebar
  // is hidden — once visible, the in-list highlight already shows where.
  const topBarLeft = (
    <button
      className="ot-icon-btn"
      onClick={handleToggleSidebar}
      title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
      aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
      aria-pressed={sidebarVisible}
    >
      <SidebarIcon size={18} />
      {hasAlerts && !sidebarVisible && <span style={S.alertBadge} />}
    </button>
  );

  const topBarRight = (
    <button
      className="ot-icon-btn"
      onClick={() => host.setSettingsOpen(true)}
      title="Settings"
      aria-label="Settings"
    >
      <SettingsIcon size={18} />
    </button>
  );

  const alertedTabIdSet = useMemo(
    () =>
      effectiveAlertedTabIds instanceof Set
        ? (effectiveAlertedTabIds as Set<string>)
        : new Set(effectiveAlertedTabIds),
    [effectiveAlertedTabIds],
  );

  const activeTab = host.tabs.find((t) => t.id === host.activeTabId) ?? null;

  const emptyState = (() => {
    if (activeTab || host.tabs.length > 0) return null;
    // Restoring: integrations will add tabs shortly; don't flash a prompt.
    if (host.activePath && (workspaceReady === false || !host.settingsHydrated)) return null;
    if (!host.activePath) {
      return (
        <div style={S.empty}>
          <div style={S.emptyTitle}>No workspace selected</div>
          <div style={S.emptyHint}>Pick a repository, worktree or directory to work in.</div>
          <div style={S.emptyActions}>
            <button className="ot-empty-btn" onClick={() => openSidebarOn(WORKSPACES_SECTION)}>
              <SidebarIcon size={14} />
              Choose a workspace
            </button>
          </div>
        </div>
      );
    }
    return (
      <div style={S.empty}>
        <div style={S.emptyTitle}>No tabs open</div>
        {createMenu.length === 0 ? (
          <div style={S.emptyHint}>No tab type registered.</div>
        ) : (
          <div style={S.emptyActions}>
            {createMenu.map((c) => (
              <button key={`${c.type}:${c.label}`} className="ot-empty-btn" onClick={c.onSelect}>
                {renderTabIcon({ type: c.type, id: '', name: c.label }, tabIcon, 14)}
                New {c.label.toLowerCase()}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  })();

  return (
    <div style={S.root}>
      <Sidebar
        mode={effectiveSidebarMode}
        open={sidebarVisible}
        isMobile={host.isMobile}
        width={host.workspacesWidth}
        onWidthChange={host.setWorkspacesWidth}
        onResizeStart={() => host.setIsResizing(true)}
        onResizeEnd={() => host.setIsResizing(false)}
        onClose={handleCloseSidebar}
        section={host.sidebarSection}
        onSectionChange={host.setSidebarSection}
        workspaces={workspacePanelElement}
        workspacesActions={workspacesActions}
        panels={panels}
      />
      <main style={S.center}>
        <TabBar
          tabs={host.tabs}
          activeTabId={host.activeTabId}
          alertedTabIds={alertedTabIdSet}
          compact={host.isMobile}
          leftAction={topBarLeft}
          rightAction={topBarRight}
          onSelect={host.setActiveTabId}
          onClose={(id) => void handleCloseTab(id)}
          createMenu={createMenu}
          tabIcon={tabIcon}
          onRename={(tabId, name) => host.hostApi.updateTab(tabId, { name })}
          onReorder={(from, to) => {
            host.setTabs((prev) => {
              const next = [...prev];
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              return next;
            });
          }}
        />
        <div style={S.content}>
          {host.isResizing && <div style={S.resizeShield} />}
          {activeTab ? mainContent?.({ activeTab, browserPanelOpen: false }) ?? null : emptyState}
          {iframeTabsLayer?.({ activeTabId: host.activeTabId })}
        </div>
      </main>

      {host.pendingDeleteRepo && (
        <ConfirmDialog
          title="Remove Repository"
          message={`Remove "${host.pendingDeleteRepo.label}" and all its worktrees and sessions?`}
          buttons={[
            { label: 'Remove', danger: true, action: host.confirmDeleteRepo },
            { label: 'Cancel', action: () => host.setPendingDeleteRepo(null) },
          ]}
          onClose={() => host.setPendingDeleteRepo(null)}
        />
      )}
      {host.pendingDeleteWorktree && (
        <ConfirmDialog
          title="Remove Workspace"
          message={
            <>
              Remove workspace &quot;{host.pendingDeleteWorktree.wt.branch}&quot;?
              {host.pendingDeleteWorktree.dirty && (
                <div style={{ color: 'var(--danger)', marginTop: '8px' }}>
                  This workspace has uncommitted changes that will be permanently lost.
                </div>
              )}
            </>
          }
          buttons={[
            { label: 'Remove', danger: true, action: host.confirmDeleteWorktree },
            { label: 'Cancel', action: () => host.setPendingDeleteWorktree(null) },
          ]}
          onClose={() => host.setPendingDeleteWorktree(null)}
        />
      )}
      {host.worktreeDeleteError && (
        <ConfirmDialog
          title="Delete Failed"
          message={host.worktreeDeleteError}
          buttons={[{ label: 'OK', primary: true, action: () => host.setWorktreeDeleteError(null) }]}
          onClose={() => host.setWorktreeDeleteError(null)}
        />
      )}
      {host.settingsOpen && (
        <div style={host.isMobile ? S.settingsOverlayMobile : S.settingsOverlayRight}>
          <SettingsPanel
            width={host.isMobile ? 0 : host.settingsPanelWidth}
            isMobile={host.isMobile}
            onClose={() => host.setSettingsOpen(false)}
            onWidthChange={host.setSettingsPanelWidth}
            onResizeStart={() => host.setIsResizing(true)}
            onResizeEnd={() => host.setIsResizing(false)}
            workspacesPanelMode={host.workspacesPanelMode}
            onWorkspacesPanelModeChange={handleSidebarModeChange}
            browserInspectorPosition={host.browserInspectorPosition}
            onBrowserInspectorPositionChange={host.setBrowserInspectorPosition}
          />
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    height: '100dvh',
    width: '100vw',
    overflow: 'hidden',
    position: 'relative',
  },
  center: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
  },
  content: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    minHeight: 0,
  },
  resizeShield: {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '24px 16px',
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: '13px',
    color: 'var(--text)',
  },
  emptyHint: {
    fontSize: '12px',
    color: 'var(--text-muted)',
  },
  emptyActions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '8px',
    marginTop: '8px',
  },
  alertBadge: {
    position: 'absolute',
    top: '7px',
    right: '7px',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: 'var(--warning)',
  },
  settingsOverlayRight: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    boxShadow: '-4px 0 16px rgba(0,0,0,0.5)',
  },
  settingsOverlayMobile: {
    position: 'fixed',
    inset: 0,
    zIndex: 100,
    background: 'var(--bg)',
  },
};
