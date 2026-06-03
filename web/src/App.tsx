import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Box,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CheckCircle2,
  CircleAlert,
  Clock3,
  CloudDownload,
  Download,
  FilePenLine,
  FolderGit2,
  HardDrive,
  Languages,
  Layers3,
  GitCompareArrows,
  Loader2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PlusCircle,
  RefreshCw,
  Save,
  RotateCcw,
  Search,
  Settings,
  ShieldAlert,
  Sun,
  Trash2,
  Unlink2,
  X
} from "lucide-react";
import type {
  ApiStatus,
  AutoSyncStatus,
  GitBranchSyncStatus,
  LocalSkillSource,
  CodexArchivePreviewResponse,
  CodexArchiveListResponse,
  CodexArchiveSession,
  DependencyInstallInfo,
  RepoConflictsResponse,
  RepoConflictSource,
  RepoSkillConflict,
  ResolveConflictResult,
  SkillRow,
  SkillVersion,
  SkillVersionsResponse,
  StatusReport,
  SyncResult,
  UsageMonitorStatus
} from "./types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle
} from "./components/ui/dialog";
import { CommandPalette, type CommandPaletteAction } from "./components/CommandPalette";
import { SettingsPanel, PathInput, PathSummary, type SetupPathField, type SetupPaths } from "./components/SettingsPanel";
import { documentLanguage, localeStorageKey, makeT, readInitialLocale, type Locale, type TFunction } from "./i18n";
import { Input } from "./components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Skeleton } from "./components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { Textarea } from "./components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";

const filters = [
  "all",
  "clean",
  "local_modified",
  "repo_modified",
  "conflict",
  "missing_local",
  "unmanaged"
] as const;

const pageSizes = [10, 20, 50, 100] as const;

type Filter = (typeof filters)[number];
type PageSize = (typeof pageSizes)[number];
type View = "skills" | "settings" | "archive";
type Theme = "light" | "dark";
type SortDirection = "asc" | "desc";
type SortState<T extends string> = {
  key: T;
  direction: SortDirection;
};
type SkillSortKey = "name" | "source" | "state" | "local_copy" | "local_modified" | "last_used";
type CodexArchiveState = "active" | "trash";
type ArchiveSortKey = "title" | "archived_at" | "updated_at" | "cwd" | "source" | "size";
const viewRoutes: Record<View, string> = {
  skills: "/skills",
  archive: "/codex-archive",
  settings: "/settings"
};
const themeStorageKey = "csm-theme";

type EditorState = {
  rowKey: string;
  source: LocalSkillSource;
  path: string;
  content: string;
  dirty: boolean;
};
type SkillActionEndpoint = "import" | "install" | "update-local" | "stop-syncing" | "remove-local";
type CodexArchiveRow = CodexArchiveSession & {
  state: CodexArchiveState;
  sourceLabel: string;
};
type ResolveStrategy = "codex" | "agents" | "repo";
type PendingSkillAction = {
  endpoint: SkillActionEndpoint;
  row: SkillRow;
};

export function App() {
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [view, setView] = useState<View>(() => viewFromLocation());
  const [checkedRowKeys, setCheckedRowKeys] = useState<string[]>([]);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingSkillAction | null>(null);
  const [pendingArchiveDelete, setPendingArchiveDelete] = useState<CodexArchiveRow | null>(null);
  const [pendingEditRow, setPendingEditRow] = useState<SkillRow | null>(null);
  const [compareState, setCompareState] = useState<{ row: SkillRow; versions: SkillVersion[] } | null>(null);
  const [repoConflictState, setRepoConflictState] = useState<{ conflicts: RepoSkillConflict[]; selections: Record<string, RepoConflictSource> } | null>(null);
  const [skillSort, setSkillSort] = useState<SortState<SkillSortKey>>({ key: "name", direction: "asc" });
  const [archiveSort, setArchiveSort] = useState<SortState<ArchiveSortKey>>({ key: "updated_at", direction: "desc" });
  const [detailOpen, setDetailOpen] = useState(false);
  const [archiveDetailOpen, setArchiveDetailOpen] = useState(false);
  const [archiveState, setArchiveState] = useState<CodexArchiveState>("active");
  const [archiveSessionRows, setArchiveSessionRows] = useState<CodexArchiveRow[]>([]);
  const [archiveSession, setArchiveSession] = useState<CodexArchivePreviewResponse | null>(null);
  const [setupRoot, setSetupRoot] = useState("");
  const [setupPaths, setSetupPaths] = useState<SetupPaths>({
    syncRepo: "",
    codexSkillsDir: "",
    agentsSkillsDir: "",
    cacheDir: ""
  });
  const [advancedPathsOpen, setAdvancedPathsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectingPath, setSelectingPath] = useState<SetupPathField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());
  const [locale, setLocale] = useState<Locale>(() => readInitialLocale());
  const [commandOpen, setCommandOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const t = useMemo(() => makeT(locale), [locale]);

  const navigateView = useCallback((nextView: View, options: { replace?: boolean } = {}) => {
    setView(nextView);

    if (typeof window === "undefined") {
      return;
    }

    const nextPath = viewRoutes[nextView];
    if (normalizeRoutePath(window.location.pathname) === nextPath) {
      return;
    }

    const update = options.replace ? window.history.replaceState.bind(window.history) : window.history.pushState.bind(window.history);
    update(null, "", nextPath);
  }, []);

  async function refresh(options: { silent?: boolean } = {}) {
    if (!options.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const response = await fetch("/api/status");
      const payload = (await response.json()) as ApiStatus;
      setStatus(payload);
    } catch (err) {
      setError(errorMessage(err, t("unableToLoadStatus"), t));
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }

  async function loadCodexArchiveSessions(options: { silent?: boolean } = {}) {
    if (!options.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const response = await fetch(`/api/codex-archive?state=${archiveState}`);
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = (await response.json()) as CodexArchiveListResponse;
      setArchiveSessionRows(payload.items.map((item) => ({ ...item, state: payload.state, sourceLabel: item.source || t("unknown") })));
    } catch (err) {
      setError(errorMessage(err, t("unableToLoadCodexArchive"), t));
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
    }

    if (typeof window !== "undefined") {
      window.localStorage.setItem(themeStorageKey, theme);
    }
  }, [theme]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = documentLanguage(locale);
    }

    if (typeof window !== "undefined") {
      window.localStorage.setItem(localeStorageKey, locale);
    }
  }, [locale]);

  useEffect(() => {
    const openCommandPalette = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") {
        return;
      }

      event.preventDefault();
      setCommandOpen((open) => !open);
    };

    window.addEventListener("keydown", openCommandPalette);
    return () => window.removeEventListener("keydown", openCommandPalette);
  }, []);

  useEffect(() => {
    navigateView(viewFromLocation(), { replace: true });

    function handlePopState() {
      setView(viewFromLocation());
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [navigateView]);

  useEffect(() => {
    if (status?.configured === false) {
      const defaultRoot = status.defaults.syncRepo;
      setSetupRoot((current) => current || defaultRoot);
      setSetupPaths((current) => ({
        syncRepo: current.syncRepo || defaultRoot,
        codexSkillsDir: current.codexSkillsDir || status.defaults.codexSkillsDir,
        agentsSkillsDir: current.agentsSkillsDir || status.defaults.agentsSkillsDir,
        cacheDir: current.cacheDir || status.defaults.cacheDir
      }));
    } else if (status?.configured === true) {
      setSetupPaths({
        syncRepo: status.config.syncRepo,
        codexSkillsDir: status.config.codexSkillsDir,
        agentsSkillsDir: status.config.agentsSkillsDir,
        cacheDir: status.config.cacheDir
      });
    }
  }, [status]);

  useEffect(() => {
    if (status?.configured === false && view !== "skills") {
      navigateView("skills", { replace: true });
    }
  }, [navigateView, status?.configured, view]);

  const rows = useMemo(() => {
    if (!status?.configured) {
      return [];
    }

    return buildRows(status.report);
  }, [status]);

  const archiveRows = useMemo(() => {
    return archiveSessionRows.map((row) => ({
      ...row,
      state: archiveState,
      sourceLabel: row.source || t("unknown")
    }));
  }, [archiveSessionRows, archiveState, t]);
  const configured = status?.configured === true;
  const activeView = configured ? view : "skills";
  const report = configured ? status.report : null;
  const autoSyncStatus = configured ? status.autoSync : null;

  useEffect(() => {
    if (activeView !== "archive") {
      return;
    }

    void loadCodexArchiveSessions();
  }, [activeView, archiveState]);

  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesQuery =
        !normalized ||
        row.id.toLowerCase().includes(normalized) ||
        row.name.toLowerCase().includes(normalized) ||
        row.description.toLowerCase().includes(normalized);
      const matchesFilter = filter === "all" || row.syncState === filter;
      return matchesQuery && matchesFilter;
    }).sort((a, b) => compareSkillRows(a, b, skillSort));
  }, [filter, query, rows, skillSort]);

  const filteredArchiveRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return archiveRows.filter((row) => {
      const matchesQuery =
        !normalized ||
        row.title.toLowerCase().includes(normalized) ||
        row.sessionId.toLowerCase().includes(normalized) ||
        row.fileName.toLowerCase().includes(normalized) ||
        (row.cwd ?? "").toLowerCase().includes(normalized) ||
        (row.source ?? "").toLowerCase().includes(normalized);
      return matchesQuery;
    }).sort((a, b) => compareArchiveRows(a, b, archiveSort));
  }, [archiveRows, archiveSort, query]);

  const skillPageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const archivePageCount = Math.max(1, Math.ceil(filteredArchiveRows.length / pageSize));
  const activePageCount = activeView === "archive" ? archivePageCount : skillPageCount;
  const pageCount = activePageCount;
  const currentPageIndex = Math.min(pageIndex, activePageCount - 1);
  const pageRows = useMemo(() => {
    const start = currentPageIndex * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [currentPageIndex, filteredRows, pageSize]);
  const archivePageRows = useMemo(() => {
    const start = currentPageIndex * pageSize;
    return filteredArchiveRows.slice(start, start + pageSize);
  }, [currentPageIndex, filteredArchiveRows, pageSize]);
  const activePageRows = activeView === "archive" ? archivePageRows : pageRows;
  const activeFilteredRows = activeView === "archive" ? filteredArchiveRows : filteredRows;
  const pageStart = activeFilteredRows.length === 0 ? 0 : currentPageIndex * pageSize + 1;
  const pageEnd = activeFilteredRows.length === 0 ? 0 : Math.min(activeFilteredRows.length, pageStart + activePageRows.length - 1);
  const selected = rows.find((row) => rowKey(row) === selectedRowKey) ?? null;
  const editorRow = editorState ? rows.find((row) => rowKey(row) === editorState.rowKey) ?? null : null;
  const selectedRows = useMemo(() => {
    const checked = new Set(checkedRowKeys);
    return rows.filter((row) => checked.has(rowKey(row)));
  }, [checkedRowKeys, rows]);
  const importableSelectedRows = selectedRows.filter(canAddToSync);
  const installableSelectedRows = selectedRows.filter(canInstallLocal);
  const updatableSelectedRows = selectedRows.filter(canUpdateLocal);
  const repoInstallRows = rows.filter(canInstallLocal);
  const repoUpdateRows = rows.filter(canUpdateLocal);
  const repoApplyCount = repoInstallRows.length + repoUpdateRows.length;
  const localChangeRows = rows.filter((row) => row.syncState === "local_modified" || row.syncState === "missing_repo");
  const conflictRows = rows.filter((row) => row.syncState === "conflict");
  const unmanagedRows = rows.filter((row) => row.kind === "unmanaged");
  const visibleRowsSelected = activeView === "skills" && pageRows.length > 0 && pageRows.every((row) => checkedRowKeys.includes(rowKey(row)));
  const someVisibleRowsSelected = activeView === "skills" && pageRows.some((row) => checkedRowKeys.includes(rowKey(row)));
  const cleanCount = rows.filter((row) => row.syncState === "clean").length;
  const reviewCount = rows.filter((row) => row.syncState !== "clean").length;
  const setupRepoSelected = setupPaths.syncRepo.trim().length > 0;

  useEffect(() => {
    if (!configured) {
      return;
    }

    const timer = window.setInterval(() => {
      void refresh({ silent: true });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [configured]);

  useEffect(() => {
    if (selectedRowKey && !rows.some((row) => rowKey(row) === selectedRowKey)) {
      setSelectedRowKey(null);
      setDetailOpen(false);
    }
  }, [rows, selectedRowKey]);

  useEffect(() => {
    setPageIndex(0);
  }, [archiveSort, archiveState, filter, pageSize, query, skillSort]);

  useEffect(() => {
    setArchiveSession(null);
    setArchiveDetailOpen(false);
  }, [archiveState]);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, pageCount - 1));
  }, [activePageCount]);

  useEffect(() => {
    const availableKeys = new Set(rows.map(rowKey));
    setCheckedRowKeys((current) => current.filter((key) => availableKeys.has(key)));
  }, [rows]);

  useEffect(() => {
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (editorState) {
        setEditorState(null);
      } else if (compareState) {
        setCompareState(null);
      } else if (repoConflictState) {
        setRepoConflictState(null);
      } else if (archiveDetailOpen) {
        setArchiveDetailOpen(false);
      } else if (detailOpen) {
        setDetailOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [archiveDetailOpen, compareState, detailOpen, editorState, repoConflictState]);

  async function initialize() {
    setError(null);
    setNotice(null);
    if (!setupPaths.syncRepo.trim()) {
      setError(t("chooseFolderBeforeInitializing"));
      return;
    }

    setBusyId("init");
    try {
      const response = await fetch("/api/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(setupPaths)
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      await refresh();
    } catch (err) {
      setError(errorMessage(err, t("initializationFailed"), t));
    } finally {
      setBusyId(null);
    }
  }

  async function saveSettings() {
    setError(null);
    setNotice(null);
    setBusyId("save-config");
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(setupPaths)
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = (await response.json()) as Extract<ApiStatus, { configured: true }>;
      setStatus(payload);
    } catch (err) {
      setError(errorMessage(err, t("unableToSaveSettings"), t));
    } finally {
      setBusyId(null);
    }
  }

  function updateSetupRoot(value: string) {
    setSetupRoot(value);
    setSetupPaths((current) => ({
      ...current,
      syncRepo: value
    }));
  }

  async function chooseDirectory(field: SetupPathField, title: string) {
    setError(null);
    setNotice(null);
    setSelectingPath(field);
    try {
      const response = await fetch("/api/select-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as { canceled: true } | { canceled: false; path: string };
      if (!payload.canceled) {
        if (field === "setupRoot") {
          updateSetupRoot(payload.path);
        } else {
          setSetupPaths((current) => ({ ...current, [field]: payload.path }));
        }
      }
    } catch (err) {
      setError(errorMessage(err, t("directorySelectionFailed"), t));
    } finally {
      setSelectingPath(null);
    }
  }

  function requestSkillAction(endpoint: SkillActionEndpoint, row: SkillRow) {
    if (requiresConfirmation(endpoint)) {
      setPendingAction({ endpoint, row });
      return;
    }

    void runSkillAction(endpoint, row);
  }

  async function runSkillAction(endpoint: SkillActionEndpoint, row: SkillRow): Promise<boolean> {
    setError(null);
    setNotice(null);
    setBusyId(actionBusyId(endpoint, row));
    try {
      const response = await fetch(`/api/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skillActionBody(row))
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = (await response.json()) as { result?: SyncResult; dependencyInstall?: DependencyInstallInfo };
      const messages: string[] = [];
      if (payload.result) {
        messages.push(syncResultMessage(payload.result, t));
      }
      if (payload.dependencyInstall) {
        const dependencyMessage = dependencyInstallMessage(payload.dependencyInstall, t);
        if (dependencyMessage) {
          messages.push(dependencyMessage);
        }
      }
      if (messages.length > 0) {
        setNotice(messages.join(" "));
      }
      await refresh({ silent: true });
      setSelectedRowKey(endpoint === "import" ? `managed:${row.id}` : rowKey(row));
      return true;
    } catch (err) {
      setError(errorMessage(err, t("skillActionFailed", { action: skillActionFailureLabel(endpoint, t) }), t));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function confirmPendingAction() {
    const action = pendingAction;
    if (!action) {
      return;
    }

    setPendingAction(null);
    void runSkillAction(action.endpoint, action.row);
  }

  async function openArchiveSession(row: CodexArchiveRow) {
    const busyKey = `archive-preview:${archiveRowKey(row)}`;
    setError(null);
    setNotice(null);
    setBusyId(busyKey);
    try {
      const response = await fetch("/api/codex-archive/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: row.state, fileName: row.fileName })
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as CodexArchivePreviewResponse;
      setArchiveSession(payload);
      setArchiveDetailOpen(true);
      return true;
    } catch (err) {
      setError(errorMessage(err, t("unableToLoadArchivedSessionPreview"), t));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function runArchiveSessionAction(action: "delete" | "restore" | "unarchive", row: CodexArchiveRow) {
    const busyKey = `archive-${action}:${archiveRowKey(row)}`;
    setError(null);
    setNotice(null);
    setBusyId(busyKey);
    try {
      const response = await fetch(`/api/codex-archive/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: row.state, fileName: row.fileName })
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const messages = {
        delete: t("movedToTrash", { title: row.title }),
        restore: t("restoredToArchive", { title: row.title }),
        unarchive: t("unarchivedToSessions", { title: row.title })
      };
      setNotice(messages[action]);
      setArchiveSession(null);
      setArchiveDetailOpen(false);
      await loadCodexArchiveSessions({ silent: true });
      return true;
    } catch (err) {
      const fallback = action === "delete" ? t("deleteAction") : action === "restore" ? t("restoreAction") : t("unarchiveAction");
      setError(errorMessage(err, t("deleteArchivedFailed", { action: fallback }), t));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function confirmArchiveDelete() {
    if (!pendingArchiveDelete) {
      return;
    }

    const deleted = await runArchiveSessionAction("delete", pendingArchiveDelete);
    if (deleted) {
      setPendingArchiveDelete(null);
    }
  }

  async function runBulkAction(endpoint: "import" | "install" | "update-local", targetRows: SkillRow[]) {
    if (targetRows.length === 0) {
      return;
    }

    setError(null);
    setNotice(null);
    setBusyId(`bulk:${endpoint}`);
    try {
      const payload = await requestBulkAction(endpoint, targetRows);
      const messages: string[] = [];
      if (payload.result) {
        messages.push(syncResultMessage(payload.result, t));
      }
      const installedDependencyCount = payload.dependencyInstalls?.filter((install) => install.status === "installed").length ?? 0;
      if (installedDependencyCount > 0) {
        messages.push(t("installedDependenciesForSkills", { count: installedDependencyCount, plural: installedDependencyCount === 1 ? "" : "s" }));
      }
      if (messages.length > 0) {
        setNotice(messages.join(" "));
      }
      const completedKeys = new Set(targetRows.map(rowKey));
      setCheckedRowKeys((current) => current.filter((key) => !completedKeys.has(key)));
      await refresh({ silent: true });
    } catch (err) {
      setError(errorMessage(err, t("bulkActionFailed"), t));
    } finally {
      setBusyId(null);
    }
  }

  async function applyRepoChangesToLocal() {
    if (repoApplyCount === 0) {
      return;
    }

    setError(null);
    setNotice(null);
    setBusyId("apply-repo");
    try {
      const messages: string[] = [];
      let installedDependencyCount = 0;

      if (repoInstallRows.length > 0) {
        const payload = await requestBulkAction("install", repoInstallRows);
        if (payload.result) {
          messages.push(syncResultMessage(payload.result, t));
        }
        installedDependencyCount += payload.dependencyInstalls?.filter((install) => install.status === "installed").length ?? 0;
      }

      if (repoUpdateRows.length > 0) {
        const payload = await requestBulkAction("update-local", repoUpdateRows);
        if (payload.result) {
          messages.push(syncResultMessage(payload.result, t));
        }
        installedDependencyCount += payload.dependencyInstalls?.filter((install) => install.status === "installed").length ?? 0;
      }

      if (installedDependencyCount > 0) {
        messages.push(t("installedDependenciesForSkills", { count: installedDependencyCount, plural: installedDependencyCount === 1 ? "" : "s" }));
      }

      setNotice(messages.length > 0 ? messages.join(" ") : t("appliedRepositoryChangesToLocalSkills"));
      await refresh({ silent: true });
    } catch (err) {
      setError(errorMessage(err, t("applyRepoChangesFailed"), t));
    } finally {
      setBusyId(null);
    }
  }

  async function requestBulkAction(endpoint: "import" | "install" | "update-local", targetRows: SkillRow[]) {
    const response = await fetch("/api/bulk-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, skills: targetRows.map(skillActionBody) })
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }

    return (await response.json()) as { result?: SyncResult; dependencyInstalls?: Array<DependencyInstallInfo & { skillId: string }> };
  }

  async function pullFromRemote() {
    setError(null);
    setNotice(null);
    setBusyId("pull");
    try {
      const response = await fetch("/api/pull", {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      await refresh({ silent: true });
      setNotice(t("pulledLatestChanges"));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("pullFailed");
      if (message.includes("Cannot auto-resolve sync conflict") || message.includes("Review these paths manually")) {
        setBusyId(null);
        await openRepoConflicts();
        return;
      }
      setError(errorMessage(err, t("pullFailed"), t));
    } finally {
      setBusyId(null);
    }
  }

  async function openRepoConflicts() {
    setError(null);
    setNotice(null);
    setBusyId("repo-conflicts");
    try {
      const response = await fetch("/api/repo-conflicts");
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as RepoConflictsResponse;
      if (payload.conflicts.length === 0) {
        setNotice(t("noSkillRepoConflictsNeedReview"));
        await refresh({ silent: true });
        return;
      }

      const selections: Record<string, RepoConflictSource> = {};
      for (const conflict of payload.conflicts) {
        selections[conflict.skillId] = conflict.versions.find((version) => version.exists)?.source ?? "github";
      }
      setRepoConflictState({ conflicts: payload.conflicts, selections });
    } catch (err) {
      setError(errorMessage(err, t("unableToLoadRepoConflicts"), t));
    } finally {
      setBusyId(null);
    }
  }

  async function resolveRepoConflicts() {
    if (!repoConflictState) {
      return;
    }

    setError(null);
    setNotice(null);
    setBusyId("repo-conflicts-resolve");
    try {
      const response = await fetch("/api/repo-conflicts/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolutions: repoConflictState.conflicts.map((conflict) => ({
            skillId: conflict.skillId,
            source: repoConflictState.selections[conflict.skillId]
          }))
        })
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      setRepoConflictState(null);
      await refresh({ silent: true });
      setNotice(t("resolvedRepoSkillConflictsPushed"));
    } catch (err) {
      setError(errorMessage(err, t("unableToResolveRepoConflicts"), t));
    } finally {
      setBusyId(null);
    }
  }

  function toggleRowChecked(row: SkillRow, checked: boolean) {
    const key = rowKey(row);
    setCheckedRowKeys((current) => {
      if (checked) {
        return current.includes(key) ? current : [...current, key];
      }
      return current.filter((item) => item !== key);
    });
  }

  function requestSkillEditor(row: SkillRow) {
    if (!canEditLocal(row)) {
      return;
    }

    if (row.localSources.length > 1) {
      setPendingEditRow(row);
      return;
    }

    const source = row.localSources[0];
    if (source) {
      void openSkillEditor(row, source);
    }
  }

  async function openSkillEditor(row: SkillRow, source: LocalSkillSource) {
    if (!canEditLocal(row) || !localSourcesForRow(row).includes(source)) {
      return;
    }

    const key = rowKey(row);
    setError(null);
    setNotice(null);
    setBusyId(`editor-open:${key}`);
    try {
      const response = await fetch("/api/skill-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: row.id, source })
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as { path: string; content: string };
      setSelectedRowKey(key);
      setDetailOpen(false);
      setEditorState({ rowKey: key, source, path: payload.path, content: payload.content, dirty: false });
    } catch (err) {
      setError(errorMessage(err, t("unableToOpenSkillMd"), t));
    } finally {
      setBusyId(null);
    }
  }

  async function saveSkillEditor(row: SkillRow) {
    const key = rowKey(row);
    if (!editorState || editorState.rowKey !== key) {
      return;
    }

    setError(null);
    setNotice(null);
    setBusyId(`editor-save:${key}`);
    try {
      const response = await fetch("/api/skill-file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: row.id, source: editorState.source, sources: row.localSources, content: editorState.content })
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      setEditorState(null);
      await refresh({ silent: true });
      setSelectedRowKey(key);
      setNotice(t("localSkillMdSaved"));
    } catch (err) {
      setError(errorMessage(err, t("unableToSaveSkillMd"), t));
    } finally {
      setBusyId(null);
    }
  }

  async function openCompareVersions(row: SkillRow) {
    const key = rowKey(row);
    setError(null);
    setNotice(null);
    setBusyId(`compare:${key}`);
    try {
      const response = await fetch("/api/skill-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: row.id })
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as SkillVersionsResponse;
      setCompareState({ row, versions: payload.versions });
    } catch (err) {
      setError(errorMessage(err, t("unableToLoadVersionSnapshot"), t));
    } finally {
      setBusyId(null);
    }
  }

  async function runCompareVersionResolution(strategy: ResolveStrategy) {
    if (!compareState) {
      return;
    }

    await runResolveConflictWithTarget(strategy, compareState.row);
  }

  async function runResolveConflictWithTarget(
    strategy: ResolveStrategy,
    targetRow: SkillRow
  ) {
    const key = rowKey(targetRow);
    setError(null);
    setNotice(null);
    setBusyId(compareResolveBusyId(targetRow, strategy));
    try {
      const response = await fetch("/api/resolve-conflict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: targetRow.id, strategy })
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as ResolveConflictResult;
      if (payload.result) {
        setNotice(syncResultMessage(payload.result, t));
      } else {
        setNotice(t("resolvedWithCopy", { name: targetRow.name || targetRow.id, strategy }));
      }
      setCompareState(null);
      await refresh({ silent: true });
      setSelectedRowKey(key);
    } catch (err) {
      setError(errorMessage(err, t("conflictResolutionFailed"), t));
    } finally {
      setBusyId(null);
    }
  }

  function toggleVisibleRows(checked: boolean) {
    const visibleKeys = pageRows.map(rowKey);
    setCheckedRowKeys((current) => {
      if (!checked) {
        return current.filter((key) => !visibleKeys.includes(key));
      }

      const next = new Set(current);
      visibleKeys.forEach((key) => next.add(key));
      return [...next];
    });
  }

  function updateSkillSort(key: SkillSortKey) {
    setSkillSort((current) => nextSortState(current, key));
  }

  function updateArchiveSort(key: ArchiveSortKey) {
    setArchiveSort((current) => nextSortState(current, key));
  }

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale((current) => (current === "zh" ? "en" : "zh"));
  }, []);

  const commandActions = useMemo<CommandPaletteAction[]>(
    () => [
      {
        id: "go-skills",
        label: t("goToSkills"),
        description: t("openSkillSyncTable"),
        group: t("navigation"),
        keywords: ["skill", "sync"],
        onSelect: () => navigateView("skills")
      },
      {
        id: "go-archive",
        label: t("goToCodexArchive"),
        description: t("reviewArchivedCodexSessions"),
        group: t("navigation"),
        disabled: !configured,
        keywords: ["archive", "session"],
        onSelect: () => navigateView("archive")
      },
      {
        id: "go-settings",
        label: t("goToSettings"),
        description: t("changeLocalPaths"),
        group: t("navigation"),
        disabled: !configured,
        keywords: ["paths", "config"],
        onSelect: () => navigateView("settings")
      },
      {
        id: "refresh",
        label: t("refresh"),
        description: t("reloadLocalStatus"),
        group: t("actions"),
        disabled: busyId !== null,
        onSelect: () => void refresh()
      },
      {
        id: "pull",
        label: t("pullRemoteChanges"),
        description: t("fetchApplyGitUpdates"),
        group: t("actions"),
        disabled: !configured || activeView !== "skills" || busyId !== null,
        keywords: ["git", "remote"],
        onSelect: () => void pullFromRemote()
      },
      {
        id: "apply-repo",
        label: t("applyRepoChanges"),
        description:
          repoApplyCount > 0
            ? t("applyLocalActionCount", { count: repoApplyCount, plural: repoApplyCount === 1 ? "" : "s" })
            : t("noRepoChangesApply"),
        group: t("actions"),
        disabled: !configured || activeView !== "skills" || busyId !== null || repoApplyCount === 0,
        keywords: ["install", "update"],
        onSelect: () => void applyRepoChangesToLocal()
      },
      {
        id: "toggle-theme",
        label: theme === "dark" ? t("switchToLight") : t("switchToDark"),
        description: t("toggleInterfaceTheme"),
        group: t("actions"),
        keywords: ["dark", "light"],
        onSelect: toggleTheme
      },
      {
        id: "toggle-language",
        label: t("switchLanguage"),
        description: locale === "zh" ? "English" : "中文",
        group: t("actions"),
        keywords: ["language", "中文", "english"],
        onSelect: toggleLocale
      },
      {
        id: "clear-search",
        label: t("clearSearch"),
        description: query ? t("clearSearchDescription") : t("searchAlreadyEmpty"),
        group: t("actions"),
        disabled: query.length === 0,
        keywords: ["filter"],
        onSelect: () => setQuery("")
      }
    ],
    [activeView, busyId, configured, locale, navigateView, query, repoApplyCount, t, theme, toggleLocale, toggleTheme]
  );

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"} data-theme={theme}>
      <CommandPalette actions={commandActions} open={commandOpen} t={t} onOpenChange={setCommandOpen} />
      <aside className="sidebar" aria-label={t("primaryNavigation")}>
        <div className="brand">
          <div className="brand-mark">
            <Layers3 size={18} aria-hidden="true" />
          </div>
          <div>
            <strong>{t("appName")}</strong>
            <span>{t("appSubtitle")}</span>
          </div>
          <Button
            className="sidebar-toggle"
            variant="ghost"
            size="icon"
            type="button"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            aria-label={sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
            title={sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
          </Button>
        </div>

        <nav className="nav-list">
          <Button
            className={activeView === "skills" ? "nav-item active" : "nav-item"}
            variant="outline"
            size="sm"
            type="button"
            onClick={() => navigateView("skills")}
          >
            <Box size={16} aria-hidden="true" />
            {t("skills")}
          </Button>
          <Button
            className={configured && activeView === "archive" ? "nav-item active" : configured ? "nav-item" : "nav-item disabled"}
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              if (configured) {
                navigateView("archive");
              }
            }}
            disabled={!configured}
          >
            <Archive size={16} aria-hidden="true" />
            {t("codexArchive")}
          </Button>
          <Button
            className={configured && activeView === "settings" ? "nav-item active" : configured ? "nav-item" : "nav-item disabled"}
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              if (configured) {
                navigateView("settings");
              }
            }}
            disabled={!configured}
          >
            <Settings size={16} aria-hidden="true" />
            {t("settings")}
            {!configured ? <span>{t("planned")}</span> : null}
          </Button>
        </nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{t("productName")}</p>
            <h1>{viewTitle(activeView, t)}</h1>
          </div>
          <div className="topbar-actions">
            <Button
              className="theme-toggle"
              variant="secondary"
              size="sm"
              type="button"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? t("switchToLight") : t("switchToDark")}
              title={theme === "dark" ? t("switchToLight") : t("switchToDark")}
            >
              {theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
              {theme === "dark" ? t("light") : t("dark")}
            </Button>
            <Button
              className="language-toggle"
              variant="secondary"
              size="sm"
              type="button"
              onClick={toggleLocale}
              aria-label={t("switchLanguage")}
              title={t("switchLanguage")}
            >
              <Languages size={15} aria-hidden="true" />
              {locale === "zh" ? "EN" : "中文"}
            </Button>
            <Button variant="secondary" size="sm" type="button" onClick={() => void refresh()}>
              <RefreshCw size={15} aria-hidden="true" />
              {t("refresh")}
            </Button>
            <Button variant="secondary" size="sm" type="button" onClick={() => setCommandOpen(true)} title={t("commandPaletteShortcut")}>
              <Search size={15} aria-hidden="true" />
              {t("command")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => void pullFromRemote()}
              disabled={!configured || activeView !== "skills" || busyId !== null}
            >
              {busyId === "pull" ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <CloudDownload size={15} aria-hidden="true" />}
              {t("pull")}
            </Button>
            {autoSyncStatus ? <AutoSyncIndicator status={autoSyncStatus} t={t} /> : null}
          </div>
        </header>

        {error ? (
          <div className="notice error" role="alert">
            <CircleAlert size={17} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {notice ? (
          <div className="notice success" role="status">
            <CheckCircle2 size={17} aria-hidden="true" />
            <span>{notice}</span>
          </div>
        ) : null}

        {!configured && !loading ? (
          <section className="setup-panel" aria-labelledby="setup-title">
            <Card className="setup-copy">
              <CardHeader>
                <p className="eyebrow">{t("setupRequired")}</p>
                <CardTitle id="setup-title">{t("initializeLocalRepo")}</CardTitle>
                <CardDescription>{t("setupDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="setup-fields">
                  <PathInput
                    id="setup-root-path"
                    label={t("syncRepositoryDirectory")}
                    value={setupRoot}
                    onChange={updateSetupRoot}
                    onChoose={() => void chooseDirectory("setupRoot", t("chooseSyncRepositoryDirectory"))}
                    choosing={selectingPath === "setupRoot"}
                    placeholder={t("chooseFolderBeforeInitializing")}
                    chooseLabel={t("choose")}
                  />
                  <div className="setup-derived" aria-label={t("derivedSetupPaths")}>
                    <PathSummary label={t("willBeCommitted")} value={setupPaths.syncRepo || t("notYet")} />
                    <PathSummary label={t("codexSkills")} value={setupPaths.codexSkillsDir} />
                    <PathSummary label={t("agentsSkills")} value={setupPaths.agentsSkillsDir} />
                    <PathSummary label={t("localCache")} value={setupPaths.cacheDir} />
                  </div>
                  <Button
                    variant="ghost"
                    className="advanced-toggle"
                    type="button"
                    aria-expanded={advancedPathsOpen}
                    onClick={() => setAdvancedPathsOpen((open) => !open)}
                  >
                    {advancedPathsOpen ? t("hideAdvancedPaths") : t("advancedPaths")}
                  </Button>
                  {advancedPathsOpen ? (
                    <div className="advanced-paths">
                      <PathInput
                        id="sync-repo-path"
                        label={t("gitSyncRepository")}
                        value={setupPaths.syncRepo}
                        onChange={(value) => setSetupPaths((current) => ({ ...current, syncRepo: value }))}
                        onChoose={() => void chooseDirectory("syncRepo", t("chooseSyncRepositoryDirectory"))}
                        choosing={selectingPath === "syncRepo"}
                        chooseLabel={t("choose")}
                      />
                      <PathInput
                        id="codex-skills-path"
                        label={t("codexSkillsDirectory")}
                        value={setupPaths.codexSkillsDir}
                        onChange={(value) => setSetupPaths((current) => ({ ...current, codexSkillsDir: value }))}
                        onChoose={() => void chooseDirectory("codexSkillsDir", t("codexSkillsDirectory"))}
                        choosing={selectingPath === "codexSkillsDir"}
                        chooseLabel={t("choose")}
                      />
                      <PathInput
                        id="agents-skills-path"
                        label={t("agentsSkillsDirectory")}
                        value={setupPaths.agentsSkillsDir}
                        onChange={(value) => setSetupPaths((current) => ({ ...current, agentsSkillsDir: value }))}
                        onChoose={() => void chooseDirectory("agentsSkillsDir", t("agentsSkillsDirectory"))}
                        choosing={selectingPath === "agentsSkillsDir"}
                        chooseLabel={t("choose")}
                      />
                      <PathInput
                        id="cache-path"
                        label={t("localCacheDirectory")}
                        value={setupPaths.cacheDir}
                        onChange={(value) => setSetupPaths((current) => ({ ...current, cacheDir: value }))}
                        onChoose={() => void chooseDirectory("cacheDir", t("localCacheDirectory"))}
                        choosing={selectingPath === "cacheDir"}
                        chooseLabel={t("choose")}
                      />
                    </div>
                  ) : null}
                  <p className="setup-note">
                    {t("setupNote")}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Button variant="primary" type="button" onClick={() => void initialize()} disabled={busyId === "init" || !setupRepoSelected}>
              {busyId === "init" ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <FolderGit2 size={15} aria-hidden="true" />}
              {t("initialize")}
            </Button>
          </section>
        ) : null}

        {configured && activeView === "settings" ? (
          <SettingsPanel
            paths={setupPaths}
            busyId={busyId}
            selectingPath={selectingPath}
            t={t}
            onPathChange={(field, value) => setSetupPaths((current) => ({ ...current, [field]: value }))}
            onChoose={(field, title) => void chooseDirectory(field, title)}
            onSave={() => void saveSettings()}
          />
        ) : null}

        {configured && activeView === "skills" ? (
          <Card className="skill-panel">
            <section className="repo-strip" aria-label={t("repositoryStatus")}>
              <StatusTile label={t("managed")} value={String(report?.managed.length ?? 0)} />
              <StatusTile label={t("clean")} value={String(cleanCount)} tone="good" />
              <StatusTile label={t("review")} value={String(reviewCount)} tone={reviewCount > 0 ? "risk" : "neutral"} />
              <div className="path-stack">
                <div className="path-stack-lines">
                  <PathLine icon={<FolderGit2 size={14} aria-hidden="true" />} label={t("syncRepo")} value={report?.syncRepo ?? ""} />
                  <PathLine icon={<HardDrive size={14} aria-hidden="true" />} label={t("codexSkills")} value={report?.codexSkillsDir ?? ""} />
                  <PathLine icon={<HardDrive size={14} aria-hidden="true" />} label={t("agentsSkills")} value={report?.agentsSkillsDir ?? ""} />
                </div>
                <div className="path-stack-controls">
                  <BranchSyncBadge
                    status={status.gitBranchStatus}
                    t={t}
                    busy={busyId === "repo-conflicts" || busyId === "pull"}
                    onReview={status.gitBranchStatus.state === "diverged" ? () => void pullFromRemote() : undefined}
                  />
                  <Button
                    className="path-stack-action"
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() => void applyRepoChangesToLocal()}
                    disabled={!configured || activeView !== "skills" || busyId !== null || repoApplyCount === 0}
                    title={repoApplyCount === 0 ? t("noRepoChangesToApply") : t("applyRepoChangesTitle", { install: repoInstallRows.length, update: repoUpdateRows.length })}
                  >
                    {busyId === "apply-repo" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                    {t("applyRepoChanges")}{repoApplyCount > 0 ? ` (${repoApplyCount})` : ""}
                  </Button>
                  <Button className="path-stack-action" variant="secondary" size="sm" type="button" onClick={() => navigateView("settings")}>
                    <Settings size={14} aria-hidden="true" />
                    {t("changePaths")}
                  </Button>
                </div>
              </div>
            </section>

            <section className="skills-summary-strip" aria-label={t("syncUsageSummary")}>
              <SummaryAction
                icon={<Download size={15} aria-hidden="true" />}
                label={t("repoChanges")}
                value={String(repoApplyCount)}
                detail={t("installUpdateDetail", { install: repoInstallRows.length, update: repoUpdateRows.length })}
                disabled={repoApplyCount === 0}
                onClick={() => setFilter(repoInstallRows.length > 0 ? "missing_local" : "repo_modified")}
              />
              <SummaryAction
                icon={<RefreshCw size={15} aria-hidden="true" />}
                label={t("localChanges")}
                value={String(localChangeRows.length + unmanagedRows.length)}
                detail={t("trackedLocalOnlyDetail", { tracked: localChangeRows.length, localOnly: unmanagedRows.length })}
                disabled={localChangeRows.length + unmanagedRows.length === 0}
                onClick={() => setFilter(localChangeRows.length > 0 ? "local_modified" : "unmanaged")}
              />
              <SummaryAction
                icon={<ShieldAlert size={15} aria-hidden="true" />}
                label={t("conflicts")}
                value={String(conflictRows.length)}
                detail={t("compareAcceptCopy")}
                tone={conflictRows.length > 0 ? "risk" : "neutral"}
                disabled={conflictRows.length === 0}
                onClick={() => setFilter("conflict")}
              />
              <UsageTraceStatus status={status.usageMonitor} t={t} locale={locale} />
            </section>

            <section className="toolbar" aria-label={t("skillFilters")}>
              <label className="search-box">
                <Search size={16} aria-hidden="true" />
                <span className="sr-only">{t("searchSkills")}</span>
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("searchSkills")}
                  autoComplete="off"
                />
              </label>

              <label className="filter-select">
                <span>{t("state")}</span>
                <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
                  <SelectTrigger aria-label={t("filterByState")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {filters.map((item) => (
                      <SelectItem key={item} value={item}>
                        {filterLabel(item, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </section>

            {checkedRowKeys.length > 0 ? (
              <section className="bulk-bar" aria-label={t("bulkActions")}>
                <div className="bulk-summary">
                  <strong>{selectedRows.length}</strong>
                  <span>{selectedRows.length === 1 ? t("skillSelected") : t("skillsSelected")}</span>
                </div>
                <Button
                  className="button secondary"
                  type="button"
                  onClick={() => void runBulkAction("import", importableSelectedRows)}
                  disabled={busyId !== null || importableSelectedRows.length === 0}
                >
                  {busyId === "bulk:import" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <PlusCircle size={14} aria-hidden="true" />}
                  {t("addToSync")} ({importableSelectedRows.length})
                </Button>
                <Button
                  className="button secondary"
                  type="button"
                  onClick={() => void runBulkAction("install", installableSelectedRows)}
                  disabled={busyId !== null || installableSelectedRows.length === 0}
                >
                  {busyId === "bulk:install" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                  {t("installLocal")} ({installableSelectedRows.length})
                </Button>
                <Button
                  className="button secondary"
                  type="button"
                  onClick={() => void runBulkAction("update-local", updatableSelectedRows)}
                  disabled={busyId !== null || updatableSelectedRows.length === 0}
                >
                  {busyId === "bulk:update-local" ? (
                    <Loader2 className="spin" size={14} aria-hidden="true" />
                  ) : (
                    <Download size={14} aria-hidden="true" />
                  )}
                  {t("updateLocal")} ({updatableSelectedRows.length})
                </Button>
                <Button className="button ghost" variant="ghost" size="sm" type="button" onClick={() => setCheckedRowKeys([])} disabled={busyId !== null}>
                  <X size={14} aria-hidden="true" />
                  {t("clear")}
                </Button>
                <span className="bulk-note">{t("supportedActionsEnabled")}</span>
              </section>
            ) : null}

            <section className="skill-list" aria-label={t("skillsTable")}>
              <div className="skill-table-scroll skills-table-scroll">
                <Table className="skills-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="select-cell">
                        <SelectAllCheckbox
                          checked={visibleRowsSelected}
                          mixed={someVisibleRowsSelected && !visibleRowsSelected}
                          onChange={toggleVisibleRows}
                          label={t("selectVisibleSkills")}
                        />
                      </TableHead>
                      <TableHead><SortableHeader label={t("name")} sortKey="name" sort={skillSort} onSort={updateSkillSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("source")} sortKey="source" sort={skillSort} onSort={updateSkillSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("state")} sortKey="state" sort={skillSort} onSort={updateSkillSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("localCopy")} sortKey="local_copy" sort={skillSort} onSort={updateSkillSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("localModified")} sortKey="local_modified" sort={skillSort} onSort={updateSkillSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("lastUsed")} sortKey="last_used" sort={skillSort} onSort={updateSkillSort} t={t} /></TableHead>
                      <TableHead className="action-cell">{t("action")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? <SkeletonRows columns={8} /> : null}

                    {!loading && filteredRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8}>
                          <div className="empty-state">
                            <h2>{t("noSkillsMatch")}</h2>
                            <p>{t("noSkillsMatchDescription")}</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}

                    {!loading &&
                      pageRows.map((row) => (
                        <TableRow
                          tabIndex={0}
                          className={selected && rowKey(selected) === rowKey(row) ? "skill-row selected" : "skill-row"}
                          key={rowKey(row)}
                          onClick={() => {
                            setSelectedRowKey(rowKey(row));
                            setDetailOpen(true);
                          }}
                          onKeyDown={(event) =>
                            selectRowWithKeyboard(event, rowKey(row), (key) => {
                              setSelectedRowKey(key);
                              setDetailOpen(true);
                            })
                          }
                        >
                          <TableCell className="select-cell" onClick={(event) => event.stopPropagation()}>
                            <Checkbox
                              checked={checkedRowKeys.includes(rowKey(row))}
                              onChange={(event) => toggleRowChecked(row, event.target.checked)}
                              aria-label={t("selectSkill", { name: row.name || row.id })}
                            />
                          </TableCell>
                          <TableCell>
                            <span className="skill-main">
                              <strong>{row.name || row.id}</strong>
                              <small>{row.id}</small>
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`source-badge ${row.source}`}>
                              {sourceLabel(row.source, t)}
                            </Badge>
                          </TableCell>
                          <TableCell><SyncBadge state={row.syncState} t={t} /></TableCell>
                          <TableCell>
                            <span className={row.installed ? "install-state installed" : "install-state"}>
                              {row.installed ? t("installed") : t("missing")}
                            </span>
                          </TableCell>
                          <TableCell><span className="skill-time">{formatLocalModified(row.localModifiedAt, locale, t)}</span></TableCell>
                          <TableCell><span className="skill-time">{formatLastUsed(row.lastUsedAt, locale, t)}</span></TableCell>
                          <TableCell className="action-cell">
                            <RowAction
                              row={row}
                              busyId={busyId}
                              onAction={requestSkillAction}
                              onEdit={requestSkillEditor}
                              onCompare={() => void openCompareVersions(row)}
                              t={t}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
              <div className="pagination-bar" aria-label={t("skillTablePagination")}>
                <div className="pagination-summary">
                  <strong>{filteredRows.length === 0 ? "0" : `${pageStart}-${pageEnd}`}</strong>
                  <span>{t("of")} {filteredRows.length}</span>
                </div>
                <label className="page-size-select">
                  <span>{t("rows")}</span>
                  <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value) as PageSize)}>
                    <SelectTrigger aria-label={t("rows")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {pageSizes.map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <div className="pagination-actions">
                  <Button
                    variant="secondary"
                    size="icon"
                    type="button"
                    onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                    disabled={loading || filteredRows.length === 0 || currentPageIndex === 0}
                    aria-label={t("previousPage")}
                    title={t("previousPage")}
                  >
                    <ChevronLeft size={15} aria-hidden="true" />
                  </Button>
                  <span className="pagination-page">
                    {t("page")} {currentPageIndex + 1} / {pageCount}
                  </span>
                  <Button
                    variant="secondary"
                    size="icon"
                    type="button"
                    onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
                    disabled={loading || filteredRows.length === 0 || currentPageIndex >= pageCount - 1}
                    aria-label={t("nextPage")}
                    title={t("nextPage")}
                  >
                    <ChevronRight size={15} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </section>
          </Card>
        ) : null}

        {configured && activeView === "archive" ? (
          <Card className="skill-panel">
            <section className="repo-strip" aria-label={t("archivedCodexSessions")}>
              <StatusTile label={archiveState === "active" ? t("archived") : t("trash")} value={String(archiveRows.length)} tone="neutral" />
              <StatusTile label={t("showing")} value={archiveState === "active" ? t("active") : t("trash")} tone={archiveState === "active" ? "good" : "risk"} />
              <StatusTile label={t("preview")} value={archiveSession ? t("loaded") : t("onDemand")} tone="neutral" />
              <div className="path-stack">
                <div className="path-stack-lines">
                  <PathLine icon={<Archive size={14} aria-hidden="true" />} label={t("archiveSource")} value="~/.codex/archived_sessions" />
                  <PathLine icon={<Trash2 size={14} aria-hidden="true" />} label={t("trash")} value="~/.codex/archived_sessions/.trash" />
                </div>
                <div className="path-stack-controls">
                  <Button className="path-stack-action" variant="secondary" size="sm" type="button" onClick={() => void loadCodexArchiveSessions()}>
                    <RefreshCw size={14} aria-hidden="true" />
                    {t("refreshArchive")}
                  </Button>
                </div>
              </div>
            </section>

            <section className="toolbar" aria-label={t("archiveFilters")}>
              <label className="search-box">
                <Search size={16} aria-hidden="true" />
                <span className="sr-only">{t("searchArchivedSessions")}</span>
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("searchArchivedSessions")}
                  autoComplete="off"
                />
              </label>
              <label className="filter-select">
                <span>{t("state")}</span>
                <Select value={archiveState} onValueChange={(value) => setArchiveState(value as CodexArchiveState)}>
                  <SelectTrigger aria-label={t("archiveState")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{t("activeArchive")}</SelectItem>
                    <SelectItem value="trash">{t("trash")}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </section>

            <section className="skill-list codex-archive-list" aria-label={t("archivedCodexSessions")}>
              <div className="skill-table-scroll codex-archive-scroll">
                <Table className="codex-archive-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead><SortableHeader label={t("title")} sortKey="title" sort={archiveSort} onSort={updateArchiveSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("archivedAt")} sortKey="archived_at" sort={archiveSort} onSort={updateArchiveSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("updated")} sortKey="updated_at" sort={archiveSort} onSort={updateArchiveSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("workspace")} sortKey="cwd" sort={archiveSort} onSort={updateArchiveSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("source")} sortKey="source" sort={archiveSort} onSort={updateArchiveSort} t={t} /></TableHead>
                      <TableHead><SortableHeader label={t("size")} sortKey="size" sort={archiveSort} onSort={updateArchiveSort} t={t} /></TableHead>
                      <TableHead className="action-cell">{t("action")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? <SkeletonRows columns={7} /> : null}

                    {!loading && filteredArchiveRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7}>
                          <div className="empty-state">
                            <h2>{t("noArchivedSessions")}</h2>
                            <p>{archiveState === "active" ? t("archivedSessionsEmpty") : t("trashSessionsEmpty")}</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}

                    {!loading &&
                      archivePageRows.map((row) => (
                        <TableRow
                          className={archiveSession?.item.fileName === row.fileName ? "skill-row codex-archive-row selected" : "skill-row codex-archive-row"}
                          key={archiveRowKey(row)}
                          tabIndex={0}
                          onClick={() => void openArchiveSession(row)}
                          onKeyDown={(event) =>
                            selectRowWithKeyboard(event, archiveRowKey(row), () => {
                              void openArchiveSession(row);
                            })
                          }
                        >
                          <TableCell>
                            <span className="skill-main archive-title-cell" title={`${row.title}\n${row.sessionId}`}>
                              <strong>{row.title}</strong>
                              <small>{shortSessionId(row.sessionId)}</small>
                            </span>
                          </TableCell>
                          <TableCell><span className="skill-time">{formatArchiveDate(row.archivedAt, locale, t)}</span></TableCell>
                          <TableCell><span className="skill-time">{formatTimestamp(row.updatedAt, locale, t)}</span></TableCell>
                          <TableCell><span className="archive-cwd archive-workspace-cell" title={row.cwd ?? t("unknownWorkspace")}>{row.cwd ?? t("unknown")}</span></TableCell>
                          <TableCell><span className="archive-cwd" title={row.sourceLabel}>{row.sourceLabel}</span></TableCell>
                          <TableCell><span className="skill-time">{formatFileSize(row.fileSize)}</span></TableCell>
                          <TableCell className="action-cell" onClick={(event) => event.stopPropagation()}>
                            {archiveState === "active" ? (
                              <span className="row-actions">
                                <ActionIconButton
                                  label={t("unarchiveSession")}
                                  busy={busyId === `archive-unarchive:${archiveRowKey(row)}`}
                                  disabled={busyId !== null && busyId !== `archive-unarchive:${archiveRowKey(row)}`}
                                  icon={<ArchiveRestore size={14} aria-hidden="true" />}
                                  onClick={() => void runArchiveSessionAction("unarchive", row)}
                                />
                                <ActionIconButton
                                  label={t("delete")}
                                  busy={busyId === `archive-delete:${archiveRowKey(row)}`}
                                  disabled={busyId !== null && busyId !== `archive-delete:${archiveRowKey(row)}`}
                                  icon={<Trash2 size={14} aria-hidden="true" />}
                                  tone="danger"
                                  onClick={() => setPendingArchiveDelete(row)}
                                />
                              </span>
                            ) : (
                              <ActionIconButton
                                label={t("restore")}
                                busy={busyId === `archive-restore:${archiveRowKey(row)}`}
                                disabled={busyId !== null && busyId !== `archive-restore:${archiveRowKey(row)}`}
                                icon={<RotateCcw size={14} aria-hidden="true" />}
                                onClick={() => void runArchiveSessionAction("restore", row)}
                              />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
              <div className="pagination-bar" aria-label={t("archivedSkillPagination")}>
                <div className="pagination-summary">
                  <strong>{filteredArchiveRows.length === 0 ? "0" : `${pageStart}-${pageEnd}`}</strong>
                  <span>{t("of")} {filteredArchiveRows.length}</span>
                </div>
                <label className="page-size-select">
                  <span>{t("rows")}</span>
                  <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value) as PageSize)}>
                    <SelectTrigger aria-label={t("rows")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {pageSizes.map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <div className="pagination-actions">
                  <Button
                    variant="outline"
                    size="icon"
                    type="button"
                    onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                    disabled={loading || filteredArchiveRows.length === 0 || currentPageIndex === 0}
                  >
                    <ChevronLeft size={16} aria-hidden="true" />
                    <span className="sr-only">{t("previousPage")}</span>
                  </Button>
                  <span className="pagination-page">{t("page")} {currentPageIndex + 1} / {pageCount}</span>
                  <Button
                    variant="outline"
                    size="icon"
                    type="button"
                    onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
                    disabled={loading || filteredArchiveRows.length === 0 || currentPageIndex >= pageCount - 1}
                  >
                    <ChevronRight size={16} aria-hidden="true" />
                    <span className="sr-only">{t("nextPage")}</span>
                  </Button>
                </div>
              </div>
            </section>
          </Card>
        ) : null}
      </main>

      {configured && activeView === "skills" && detailOpen && selected ? (
        <DetailDrawer selected={selected} t={t} locale={locale} onClose={() => setDetailOpen(false)} />
      ) : null}

      {configured && activeView === "archive" && archiveDetailOpen && archiveSession ? (
        <CodexArchiveDrawer
          preview={archiveSession}
          busyId={busyId}
          t={t}
          locale={locale}
          onClose={() => setArchiveDetailOpen(false)}
          onDelete={(row) => setPendingArchiveDelete(row)}
          onRestore={(row) => void runArchiveSessionAction("restore", row)}
          onUnarchive={(row) => void runArchiveSessionAction("unarchive", row)}
        />
      ) : null}

      {configured && activeView === "skills" && editorState && editorRow ? (
        <SkillEditorDrawer
          row={editorRow}
          editorState={editorState}
          busyId={busyId}
          t={t}
          onSave={saveSkillEditor}
          onClose={() => setEditorState(null)}
          onChange={(content) => {
            setEditorState((current) => (current ? { ...current, content, dirty: true } : current));
          }}
        />
      ) : null}

      <ConfirmActionDialog
        action={pendingAction}
        busyId={busyId}
        t={t}
        onClose={() => setPendingAction(null)}
        onConfirm={() => void confirmPendingAction()}
      />

      <ArchiveDeleteDialog
        row={pendingArchiveDelete}
        busyId={busyId}
        t={t}
        onClose={() => setPendingArchiveDelete(null)}
        onConfirm={() => void confirmArchiveDelete()}
      />

      <EditSourceDialog
        row={pendingEditRow}
        busyId={busyId}
        t={t}
        onClose={() => setPendingEditRow(null)}
        onChoose={(row, source) => {
          setPendingEditRow(null);
          void openSkillEditor(row, source);
        }}
      />

      <CompareVersionsDialog
        state={compareState}
        busyId={busyId}
        t={t}
        onClose={() => setCompareState(null)}
        onAcceptVersion={runCompareVersionResolution}
      />

      <RepoConflictsDialog
        state={repoConflictState}
        busyId={busyId}
        t={t}
        onClose={() => setRepoConflictState(null)}
        onSelect={(skillId, source) => {
          setRepoConflictState((current) =>
            current ? { ...current, selections: { ...current.selections, [skillId]: source } } : current
          );
        }}
        onResolve={() => void resolveRepoConflicts()}
      />

    </div>
  );
}

function SortableHeader<TSortKey extends string>({
  label,
  sortKey,
  sort,
  onSort,
  t
}: {
  label: string;
  sortKey: TSortKey;
  sort: SortState<TSortKey>;
  onSort: (key: TSortKey) => void;
  t: TFunction;
}) {
  const active = sort.key === sortKey;
  const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
  const Icon = active ? (sort.direction === "asc" ? ChevronUp : ChevronDown) : ArrowUpDown;

  return (
    <span className="sortable-head" data-sort={ariaSort}>
      <button
        className={active ? "table-sort-button active" : "table-sort-button"}
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={t("sortBy", { label })}
      >
        <span>{label}</span>
        <Icon size={13} aria-hidden="true" />
      </button>
    </span>
  );
}

function SelectAllCheckbox({
  checked,
  mixed,
  onChange,
  label
}: {
  checked: boolean;
  mixed: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <Checkbox
      checked={mixed ? "indeterminate" : checked}
      onChange={(event) => onChange(event.target.checked)}
      aria-label={label}
      aria-checked={mixed ? "mixed" : checked}
    />
  );
}

function buildRows(report: StatusReport): SkillRow[] {
  const managed: SkillRow[] = report.managed.map((skill) => {
    const localSources = normalizeLocalSources(skill.localSources ?? (skill.localSource ? [skill.localSource] : []));
    return {
      kind: "managed",
      id: skill.id,
      name: skill.name,
      description: skill.description,
      status: skill.status,
      syncState: skill.syncState,
      installed: skill.installed,
      source: sourceForLocalSources(localSources, skill.installed ? "codex" : "repo"),
      localSources,
      localCopiesDiffer: skill.localCopiesDiffer ?? false,
      repoHash: skill.currentRepoHash,
      localHash: skill.currentLocalHash,
      lastUsedAt: skill.lastUsedAt,
      repoPath: `${report.syncRepo}/skills/${skill.id}`,
      localPath: formatLocalPaths(report, skill.id, localSources),
      localModifiedAt: skill.localModifiedAt ?? null
    };
  });

  const unmanaged: SkillRow[] = groupUnmanagedRows(report);

  const repoOnly: SkillRow[] = report.repoOnly.map((skill) => ({
    kind: "repo-only",
    id: skill.id,
    name: skill.name,
    description: skill.description,
      syncState: "repo_only",
      source: "repo",
      localSources: [],
      localCopiesDiffer: false,
      installed: false,
    repoHash: skill.hash,
    localHash: null,
    lastUsedAt: skill.lastUsedAt ?? null,
    repoPath: skill.path,
    localPath: null,
    localModifiedAt: null
  }));

  return [...managed, ...unmanaged, ...repoOnly].sort((a, b) => a.id.localeCompare(b.id));
}

function localRootForSource(report: StatusReport, source: LocalSkillSource): string {
  return source === "agents" ? report.agentsSkillsDir : report.codexSkillsDir;
}

function groupUnmanagedRows(report: StatusReport): SkillRow[] {
  const grouped = new Map<string, typeof report.unmanagedLocal>();
  for (const skill of report.unmanagedLocal) {
    const existing = grouped.get(skill.id) ?? [];
    existing.push(skill);
    grouped.set(skill.id, existing);
  }

  return [...grouped.values()].map((skills) => {
    const preferred = skills.find((skill) => skill.source === "codex") ?? skills[0];
    const localSources = normalizeLocalSources(
      skills
        .map((skill) => skill.source)
        .filter((source): source is LocalSkillSource => source === "codex" || source === "agents")
    );

    return {
      kind: "unmanaged",
      id: preferred.id,
      name: preferred.name,
      description: preferred.description,
      syncState: "unmanaged",
      source: sourceForLocalSources(localSources, "codex"),
      localSources,
      localCopiesDiffer: localCandidateHashes(skills).length > 1,
      installed: true,
      repoHash: null,
      localHash: preferred.hash,
      lastUsedAt: latestScannedUsageAt(skills),
      repoPath: null,
      localPath: skills
        .map((skill) => `${sourceLabel(skill.source === "agents" ? "agents" : "codex")}: ${skill.path}`)
        .join("\n"),
      localModifiedAt: latestScannedModifiedAt(skills)
    };
  });
}

function latestScannedModifiedAt(skills: Array<{ modifiedAt: string }>): string | null {
  if (skills.length === 0) {
    return null;
  }

  return skills.map((skill) => skill.modifiedAt).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
}

function latestScannedUsageAt(skills: Array<{ lastUsedAt?: string | null }>): string | null {
  return latestTimestamp(skills.map((skill) => skill.lastUsedAt ?? null));
}

function latestTimestamp(values: Array<string | null>): string | null {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null
  );
}

function localCandidateHashes(skills: Array<{ hash: string }>): string[] {
  return [...new Set(skills.map((skill) => skill.hash))];
}

function normalizeLocalSources(sources: LocalSkillSource[]): LocalSkillSource[] {
  return [...new Set(sources)].sort((a, b) => a.localeCompare(b));
}

function sourceForLocalSources(sources: LocalSkillSource[], fallback: LocalSkillSource | "repo"): SkillRow["source"] {
  if (sources.length > 1) {
    return "both";
  }

  return sources[0] ?? fallback;
}

function formatLocalPaths(report: StatusReport, skillId: string, sources: LocalSkillSource[]): string {
  if (sources.length === 0) {
    return "Missing on this machine";
  }

  return sources.map((source) => `${sourceLabel(source)}: ${localRootForSource(report, source)}/${skillId}`).join("\n");
}

function rowKey(row: SkillRow) {
  return `${row.kind}:${row.id}`;
}

function archiveRowKey(row: CodexArchiveSession | CodexArchiveRow) {
  return `${"state" in row ? row.state : "active"}:${row.fileName}`;
}

function canAddToSync(row: SkillRow) {
  return row.kind === "unmanaged";
}

function canInstallLocal(row: SkillRow) {
  return row.kind === "managed" && row.syncState === "missing_local" && !row.installed && Boolean(row.repoHash);
}

function canUpdateLocal(row: SkillRow) {
  return row.kind === "managed" && row.syncState === "repo_modified";
}

function canCompareVersions(row: SkillRow) {
  return row.kind === "managed" && row.syncState === "conflict";
}

function canEditLocal(row: SkillRow) {
  return row.installed && row.localSources.length > 0;
}

function canStopSyncing(row: SkillRow) {
  return row.kind === "managed";
}

function canRemoveLocal(row: SkillRow) {
  return row.installed && row.localSources.length > 0;
}

function localSourcesForRow(row: SkillRow): LocalSkillSource[] {
  return [...row.localSources] as LocalSkillSource[];
}

function skillActionBody(row: SkillRow): { skillId: string; source?: LocalSkillSource } {
  return row.localSources.length === 1 ? { skillId: row.id, source: row.localSources[0] } : { skillId: row.id };
}

function syncResultMessage(result: SyncResult, t: TFunction) {
  if (result.skillIds.length === 0) {
    if (result.committed && result.commitHash) {
      return t("syncRepoChangesPushed", { hash: result.commitHash });
    }

    return t("remoteUpToDate");
  }

  const target = result.skillIds.length === 1 ? result.skillIds[0] : t("skillCount", { count: result.skillIds.length });
  if (result.committed && result.commitHash) {
    return t("syncedTargetCommit", { target, hash: result.commitHash });
  }

  return t("noNewCommitPushed", { target });
}

function dependencyInstallMessage(result: DependencyInstallInfo, t: TFunction) {
  if (result.status !== "installed") {
    return null;
  }

  return result.command ? t("installedDependenciesWithCommand", { command: result.command }) : t("dependenciesInstalled");
}

function skillActionFailureLabel(endpoint: SkillActionEndpoint, t: TFunction) {
  const labels: Record<SkillActionEndpoint, string> = {
    import: t("addToSync"),
    install: t("installLocal"),
    "update-local": t("updateLocal"),
    "stop-syncing": t("stopSyncing"),
    "remove-local": t("removeLocalCopy")
  };

  return labels[endpoint];
}

function actionBusyId(endpoint: SkillActionEndpoint | "compare", row: SkillRow) {
  return `${endpoint}:${rowKey(row)}`;
}

function compareResolveBusyId(row: SkillRow, strategy: ResolveStrategy) {
  return `compare-resolve:${rowKey(row)}:${strategy}`;
}

function requiresConfirmation(endpoint: SkillActionEndpoint) {
  return endpoint === "stop-syncing" || endpoint === "remove-local";
}

function StatusTile({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "risk" }) {
  return (
    <div className={`status-tile ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SummaryAction({
  icon,
  label,
  value,
  detail,
  tone = "neutral",
  disabled,
  onClick
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "risk";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`summary-action ${tone}`} type="button" onClick={onClick} disabled={disabled}>
      <span className="summary-action-head">
        <span className="summary-action-icon">{icon}</span>
        <span>{label}</span>
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </button>
  );
}

function UsageTraceStatus({ status, t, locale }: { status: UsageMonitorStatus; t: TFunction; locale: Locale }) {
  const healthy = status.enabled && !status.lastError;
  const label = status.running ? t("scanning") : status.enabled ? t("listening") : t("paused");

  return (
    <div className={`usage-trace-status ${status.lastError ? "risk" : healthy ? "good" : "neutral"}`}>
      <span className="summary-action-head">
        <span className="summary-action-icon">
          <Clock3 size={15} aria-hidden="true" />
        </span>
        <span>{t("usageScan")}</span>
      </span>
      <strong>{label}</strong>
      <small>
        {status.lastError
          ? status.lastError
          : t("usageScanStatus", { seconds: Math.round(status.intervalMs / 1000), time: formatMonitorTime(status.lastScanCompletedAt, locale, t) })}
      </small>
    </div>
  );
}

function PathLine({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="path-line">
      {icon}
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function SyncBadge({ state, t }: { state: SkillRow["syncState"]; t: TFunction }) {
  const icon = state === "clean" ? <CheckCircle2 size={14} aria-hidden="true" /> : <ShieldAlert size={14} aria-hidden="true" />;
  const variant: "success" | "warning" | "destructive" | "default" =
    state === "clean" ? "success" : state === "conflict" ? "destructive" : "warning";

  return (
    <Badge variant={variant} className={`sync-badge ${state}`}>
      {icon}
      {syncLabel(state, t)}
    </Badge>
  );
}

function AutoSyncIndicator({ status, t }: { status: AutoSyncStatus; t: TFunction }) {
  const text = formatAutoSyncLabel(status, t);
  const isActive = status.enabled;
  const classes = `auto-sync-indicator ${isActive ? `mode-${status.mode}` : "mode-disabled"}${status.running ? " running" : ""}`;
  const tooltip = status.lastError ? `${t("autoSyncOff")}: ${status.lastError}` : statusMessage(status, t);

  return (
    <span className={classes} title={tooltip} role="status" aria-live="polite">
      {status.running ? <Loader2 className="spin" size={14} aria-hidden="true" /> : null}
      {text}
    </span>
  );
}

function BranchSyncBadge({ status, busy, onReview, t }: { status: GitBranchSyncStatus; busy?: boolean; onReview?: () => void; t: TFunction }) {
  const label = branchSyncLabel(status, t);
  const needsAttention = status.state === "ahead" || status.state === "behind" || status.state === "diverged";
  const className = `branch-sync-badge ${status.state}${needsAttention ? " attention" : ""}`;
  const content = (
    <>
      {busy ? <Loader2 className="spin" size={13} aria-hidden="true" /> : needsAttention ? <CircleAlert size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}
      {label}
    </>
  );

  if (onReview) {
    return (
      <button className={`${className} branch-sync-button`} title={branchSyncActionTitle(status, t)} type="button" onClick={onReview} disabled={busy}>
        {content}
      </button>
    );
  }

  return (
    <span className={className} title={branchSyncTitle(status, t)} role="status" aria-live="polite">
      {content}
    </span>
  );
}

function RowAction({
  row,
  busyId,
  onAction,
  onEdit,
  onCompare,
  t
}: {
  row: SkillRow;
  busyId: string | null;
  onAction: (endpoint: SkillActionEndpoint, row: SkillRow) => void;
  onEdit: (row: SkillRow) => void;
  onCompare: (row: SkillRow) => void;
  t: TFunction;
}) {
  const importBusy = busyId === actionBusyId("import", row);
  const installBusy = busyId === actionBusyId("install", row);
  const updateBusy = busyId === actionBusyId("update-local", row);
  const stopSyncingBusy = busyId === actionBusyId("stop-syncing", row);
  const removeBusy = busyId === actionBusyId("remove-local", row);
  const editBusy = busyId === `editor-open:${rowKey(row)}`;
  const compareBusy = busyId === actionBusyId("compare", row);
  const hasAction =
    canCompareVersions(row) ||
    canEditLocal(row) ||
    canAddToSync(row) ||
    canInstallLocal(row) ||
    canUpdateLocal(row) ||
    canStopSyncing(row) ||
    canRemoveLocal(row);

  if (!hasAction) {
    return <span className="row-actions muted">{t("view")}</span>;
  }

  return (
    <span className="row-actions">
      {canEditLocal(row) ? (
        <ActionIconButton
          label={t("editLocalSkillMd")}
          busy={editBusy}
          disabled={busyId !== null && !editBusy}
          icon={<FilePenLine size={14} aria-hidden="true" />}
          onClick={() => onEdit(row)}
        />
      ) : null}
      {canAddToSync(row) ? (
        <ActionIconButton
          label={t("addToSync")}
          busy={importBusy}
          disabled={busyId !== null && !importBusy}
          icon={<PlusCircle size={14} aria-hidden="true" />}
          onClick={() => onAction("import", row)}
        />
      ) : null}
      {canInstallLocal(row) ? (
        <ActionIconButton
          label={t("installLocal")}
          busy={installBusy}
          disabled={busyId !== null && !installBusy}
          icon={<Download size={14} aria-hidden="true" />}
          onClick={() => onAction("install", row)}
        />
      ) : null}
      {canUpdateLocal(row) ? (
        <ActionIconButton
          label={t("updateLocal")}
          busy={updateBusy}
          disabled={busyId !== null && !updateBusy}
          icon={<Download size={14} aria-hidden="true" />}
          onClick={() => onAction("update-local", row)}
        />
      ) : null}
      {canCompareVersions(row) ? (
        <ActionIconButton
          label={t("compareVersions")}
          busy={compareBusy}
          disabled={busyId !== null && !compareBusy}
          icon={<GitCompareArrows size={14} aria-hidden="true" />}
          onClick={() => onCompare(row)}
        />
      ) : null}
      {canStopSyncing(row) ? (
        <ActionIconButton
          label={t("stopSyncing")}
          busy={stopSyncingBusy}
          disabled={busyId !== null && !stopSyncingBusy}
          icon={<Unlink2 size={14} aria-hidden="true" />}
          onClick={() => onAction("stop-syncing", row)}
        />
      ) : null}
      {canRemoveLocal(row) ? (
        <ActionIconButton
          label={row.localSources.length > 1 ? t("removeLocalCopies") : t("removeLocalCopy")}
          busy={removeBusy}
          disabled={busyId !== null && !removeBusy}
          icon={<Trash2 size={14} aria-hidden="true" />}
          tone="danger"
          onClick={() => onAction("remove-local", row)}
        />
      ) : null}
    </span>
  );
}

function ActionIconButton({
  label,
  busy,
  disabled,
  icon,
  tone,
  onClick
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  icon: ReactNode;
  tone?: "danger";
  onClick: () => void;
}) {
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`row-action icon-only${tone ? ` ${tone}` : ""}`}
            type="button"
            aria-label={label}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
            disabled={disabled}
          >
            {busy ? <Loader2 className="spin" size={14} aria-hidden="true" /> : icon}
            <span className="sr-only">{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function EditSourceDialog({
  row,
  busyId,
  t,
  onClose,
  onChoose
}: {
  row: SkillRow | null;
  busyId: string | null;
  t: TFunction;
  onClose: () => void;
  onChoose: (row: SkillRow, source: LocalSkillSource) => void;
}) {
  const busy = row ? busyId === `editor-open:${rowKey(row)}` : false;

  return (
    <Dialog
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        {row ? (
          <DialogContent className="confirm-dialog edit-source-dialog" aria-labelledby="edit-source-title" aria-describedby="edit-source-description">
            <DialogHeader className="confirm-dialog-header">
              <div className="confirm-icon" aria-hidden="true">
                <FilePenLine size={16} />
              </div>
              <div>
                <DialogTitle id="edit-source-title">{t("chooseLocalCopyToEdit")}</DialogTitle>
                <DialogDescription id="edit-source-description">
                  {t("chooseLocalCopyDescription", { name: row.name || row.id })}
                </DialogDescription>
              </div>
            </DialogHeader>
            <div className="edit-source-options" aria-label={t("localCopies")}>
              {localSourcesForRow(row).map((source) => (
                <button
                  className="edit-source-option"
                  type="button"
                  key={source}
                  onClick={() => onChoose(row, source)}
                  disabled={busyId !== null}
                >
                  <span>{sourceLabel(source, t)}</span>
                  <code>{localPathForSource(row, source)}</code>
                </button>
              ))}
            </div>
            <DialogFooter className="confirm-dialog-footer">
              <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
                {t("cancel")}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </DialogPortal>
    </Dialog>
  );
}

function CompareVersionsDialog({
  state,
  busyId,
  t,
  onClose,
  onAcceptVersion
}: {
  state: { row: SkillRow; versions: SkillVersion[] } | null;
  busyId: string | null;
  t: TFunction;
  onClose: () => void;
  onAcceptVersion: (strategy: ResolveStrategy) => Promise<void>;
}) {
  const busy = busyId !== null && state !== null;
  const row = state?.row ?? null;
  const versionDisabled = (version: SkillVersion) => !version.exists || busy;

  return (
    <Dialog
      open={Boolean(state)}
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        {state ? (
          <DialogContent className="confirm-dialog compare-dialog" aria-labelledby="compare-versions-title" aria-describedby="compare-versions-description">
            <DialogHeader className="compare-header">
              <div className="confirm-icon" aria-hidden="true">
                <GitCompareArrows size={16} />
              </div>
              <div>
                <DialogTitle id="compare-versions-title">{t("compareTitle", { name: state.row.name || state.row.id })}</DialogTitle>
                <DialogDescription id="compare-versions-description">{t("compareDescription")}</DialogDescription>
              </div>
            </DialogHeader>
            <div className="compare-source-grid">
              {state.versions.map((version) => (
                <section className="compare-source" key={version.source}>
                  <div className="compare-source-title">
                    <strong>{sourceLabel(version.source, t)}</strong>
                    <span>{version.exists ? t("available") : t("missing")}</span>
                  </div>
                  <p className="compare-source-path">{version.path}</p>
                  <pre className="compare-source-content">
                    <code>{version.content ?? t("noSkillMd")}</code>
                  </pre>
                  <div className="compare-source-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => void onAcceptVersion(version.source)}
                      disabled={versionDisabled(version)}
                      title={
                        version.exists
                          ? t("acceptVersionTitle", { source: sourceLabel(version.source, t), name: state.row.name || state.row.id })
                          : t("versionMissingTitle", { source: sourceLabel(version.source, t) })
                      }
                    >
                      {busyId === compareResolveBusyId(state.row, version.source) ? (
                        <Loader2 className="spin" size={14} aria-hidden="true" />
                      ) : (
                        <CheckCircle2 size={14} aria-hidden="true" />
                      )}
                      {t("acceptThisVersion")}
                    </Button>
                  </div>
                </section>
              ))}
            </div>
            <DialogFooter className="compare-footer">
              <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
                {busy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
                {t("close")}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </DialogPortal>
    </Dialog>
  );
}

function RepoConflictsDialog({
  state,
  busyId,
  t,
  onClose,
  onSelect,
  onResolve
}: {
  state: { conflicts: RepoSkillConflict[]; selections: Record<string, RepoConflictSource> } | null;
  busyId: string | null;
  t: TFunction;
  onClose: () => void;
  onSelect: (skillId: string, source: RepoConflictSource) => void;
  onResolve: () => void;
}) {
  const busy = busyId !== null && state !== null;
  const resolving = busyId === "repo-conflicts-resolve";
  const conflictCount = state?.conflicts.length ?? 0;

  return (
    <Dialog
      open={Boolean(state)}
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        {state ? (
          <DialogContent className="confirm-dialog compare-dialog repo-conflict-dialog" aria-labelledby="repo-conflicts-title" aria-describedby="repo-conflicts-description">
            <DialogHeader className="compare-header">
              <div className="confirm-icon" aria-hidden="true">
                <GitCompareArrows size={16} />
              </div>
              <div>
                <DialogTitle id="repo-conflicts-title">{t("reviewRepoConflicts")}</DialogTitle>
                <DialogDescription id="repo-conflicts-description">{t("repoConflictsDescription")}</DialogDescription>
              </div>
            </DialogHeader>
            <div className="repo-conflict-stack">
              {state.conflicts.map((conflict) => {
                const selectedSource = state.selections[conflict.skillId];
                return (
                  <section className="repo-conflict-card" key={conflict.skillId}>
                    <div className="repo-conflict-card-head">
                      <div>
                        <h3>{conflict.skillId}</h3>
                        <p>{t("conflictedFile", { count: conflict.files.length, plural: conflict.files.length === 1 ? "" : "s" })}</p>
                      </div>
                      <Badge variant="destructive">{t("needsChoice")}</Badge>
                    </div>
                    <div className="repo-conflict-files">
                      {conflict.files.slice(0, 4).map((filePath) => (
                        <code key={filePath}>{filePath}</code>
                      ))}
                      {conflict.files.length > 4 ? <span>{t("moreFiles", { count: conflict.files.length - 4 })}</span> : null}
                    </div>
                    <div className="compare-source-grid">
                      {conflict.versions.map((version) => {
                        const selected = selectedSource === version.source;
                        return (
                          <section className={`compare-source repo-version-card${selected ? " selected" : ""}`} key={version.source}>
                            <div className="compare-source-title">
                              <strong>{repoConflictSourceLabel(version.source, t)}</strong>
                              <span>{version.exists ? (selected ? t("selected") : t("available")) : t("missing")}</span>
                            </div>
                            <p className="compare-source-path">{version.path}</p>
                            <pre className="compare-source-content">
                              <code>{version.content ?? t("noSkillMd")}</code>
                            </pre>
                            <div className="compare-source-actions">
                              <Button
                                variant={selected ? "default" : "secondary"}
                                size="sm"
                                type="button"
                                onClick={() => onSelect(conflict.skillId, version.source)}
                                disabled={busy || !version.exists}
                                title={version.exists ? t("useVersionTitle", { source: repoConflictSourceLabel(version.source, t), skillId: conflict.skillId }) : t("versionMissingTitle", { source: version.label })}
                              >
                                <CheckCircle2 size={14} aria-hidden="true" />
                                {t("useThisVersion")}
                              </Button>
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
            <DialogFooter className="compare-footer">
              <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
                <X size={15} aria-hidden="true" />
                {t("cancel")}
              </Button>
              <Button type="button" onClick={onResolve} disabled={busy || conflictCount === 0}>
                {resolving ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <GitCompareArrows size={15} aria-hidden="true" />}
                {t("resolveAndPush")}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </DialogPortal>
    </Dialog>
  );
}

function ConfirmActionDialog({
  action,
  busyId,
  t,
  onClose,
  onConfirm
}: {
  action: PendingSkillAction | null;
  busyId: string | null;
  t: TFunction;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const busy = action ? busyId === actionBusyId(action.endpoint, action.row) : false;
  const copy = action ? confirmDialogCopy(action.endpoint, action.row, t) : null;

  return (
    <Dialog
      open={Boolean(action)}
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        {copy ? (
          <DialogContent className="confirm-dialog" aria-labelledby="confirm-action-title" aria-describedby="confirm-action-description">
            <DialogHeader className="confirm-dialog-header">
              <div className="confirm-icon" aria-hidden="true">
                {copy.icon}
              </div>
              <div>
                <DialogTitle id="confirm-action-title">{copy.title}</DialogTitle>
                <DialogDescription id="confirm-action-description">{copy.description}</DialogDescription>
              </div>
            </DialogHeader>
            <div className="confirm-scope" aria-label={t("actionScope")}>
              {copy.scope.map((item) => (
                <div className="confirm-scope-item" key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
            <DialogFooter className="confirm-dialog-footer">
              <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
                {t("cancel")}
              </Button>
              <Button variant={copy.danger ? "destructive" : "primary"} type="button" onClick={onConfirm} disabled={busy}>
                {busy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : copy.icon}
                {copy.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </DialogPortal>
    </Dialog>
  );
}

function confirmDialogCopy(endpoint: SkillActionEndpoint, row: SkillRow, t: TFunction) {
  const skillName = row.name || row.id;
  if (endpoint === "stop-syncing") {
    return {
      title: t("stopSyncingTitle", { name: skillName }),
      description: t("stopSyncingDescription"),
      confirmLabel: t("stopSyncing"),
      icon: <Unlink2 size={16} aria-hidden="true" />,
      danger: true,
      scope: [
        { label: t("localCopies"), value: t("keptInstalled") },
        { label: t("syncRepo"), value: t("deleteRepoCopyMetadata") },
        { label: t("gitRemote"), value: t("commitPushRemoval") }
      ]
    };
  }

  const multipleLocalCopies = row.localSources.length > 1;
  return {
    title: multipleLocalCopies ? t("removeLocalCopiesTitle", { name: skillName }) : t("removeLocalCopyTitle", { name: skillName }),
    description: multipleLocalCopies ? t("removeLocalCopiesDescription") : t("removeLocalCopyDescription"),
    confirmLabel: multipleLocalCopies ? t("removeLocalCopies") : t("removeLocalCopy"),
    icon: <Trash2 size={16} aria-hidden="true" />,
    danger: true,
    scope: [
      { label: t("thisMachine"), value: multipleLocalCopies ? t("deleteCodexAgentsCopies") : t("deleteLocalFolder") },
      { label: t("syncRepo"), value: t("leaveUnchanged") },
      { label: t("gitRemote"), value: t("noSyncStateChange") }
    ]
  };
}

function ArchiveDeleteDialog({
  row,
  busyId,
  t,
  onClose,
  onConfirm
}: {
  row: CodexArchiveRow | null;
  busyId: string | null;
  t: TFunction;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const busy = row ? busyId === `archive-delete:${archiveRowKey(row)}` : false;

  return (
    <Dialog
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        {row ? (
          <DialogContent className="confirm-dialog" aria-labelledby="archive-delete-title" aria-describedby="archive-delete-description">
            <DialogHeader className="confirm-dialog-header">
              <div className="confirm-icon" aria-hidden="true">
                <Trash2 size={16} />
              </div>
              <div>
                <DialogTitle id="archive-delete-title">{t("deleteArchivedSessionTitle")}</DialogTitle>
                <DialogDescription id="archive-delete-description">{t("deleteArchivedSessionDescription")}</DialogDescription>
              </div>
            </DialogHeader>
            <DialogFooter className="confirm-dialog-footer">
              <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
                {t("cancel")}
              </Button>
              <Button variant="destructive" type="button" onClick={onConfirm} disabled={busy}>
                {busy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                {t("delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </DialogPortal>
    </Dialog>
  );
}

function DetailDrawer({
  selected,
  t,
  locale,
  onClose
}: {
  selected: SkillRow;
  t: TFunction;
  locale: Locale;
  onClose: () => void;
}) {
  return (
    <Sheet open={true} onOpenChange={onClose}>
      <SheetContent className="detail-drawer">
        <SheetHeader>
          <div className="drawer-title-row">
            <div>
              <p className="eyebrow">{kindLabel(selected.kind, t)}</p>
              <SheetTitle>{selected.name || selected.id}</SheetTitle>
            </div>
            <Button className="icon-button" variant="outline" size="icon" type="button" onClick={onClose} aria-label={t("closeDetails")}>
              <X size={18} aria-hidden="true" />
            </Button>
          </div>
          <p>{selected.description || t("noDescription")}</p>
          <div className="drawer-badges">
            <SyncBadge state={selected.syncState} t={t} />
            <span className={`source-badge ${selected.source}`}>{sourceLabel(selected.source, t)}</span>
          </div>
        </SheetHeader>

        <div className="detail-metadata" aria-label={t("skillSummary")}>
          <DetailField label={t("source")} value={sourceLabel(selected.source, t)} />
          <DetailField label={t("localCopy")} value={selected.installed ? t("installed") : t("missing")} />
          <DetailField label={t("syncState")} value={syncLabel(selected.syncState, t)} />
          <DetailField label={t("lastUsed")} value={formatLastUsed(selected.lastUsedAt, locale, t)} />
          <DetailField label={t("localModified")} value={formatLocalModified(selected.localModifiedAt, locale, t)} />
        </div>

        <div className="detail-section">
          <h3>{t("paths")}</h3>
          <KeyValue label={t("localCopy")} value={selected.localPath ?? t("missingOnMachine")} />
          <KeyValue label={t("syncRepo")} value={selected.repoPath ?? t("notAddedToSync")} />
        </div>

        <div className="detail-section">
          <h3>{t("hashes")}</h3>
          <KeyValue label={t("localHash")} value={localHashLabel(selected, t)} />
          <KeyValue label={t("repoHash")} value={shortHash(selected.repoHash, t)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CodexArchiveDrawer({
  preview,
  busyId,
  t,
  locale,
  onClose,
  onDelete,
  onRestore,
  onUnarchive
}: {
  preview: CodexArchivePreviewResponse;
  busyId: string | null;
  t: TFunction;
  locale: Locale;
  onClose: () => void;
  onDelete: (row: CodexArchiveRow) => void;
  onRestore: (row: CodexArchiveRow) => void;
  onUnarchive: (row: CodexArchiveRow) => void;
}) {
  const row: CodexArchiveRow = {
    ...preview.item,
    state: preview.state,
    sourceLabel: preview.item.source || t("unknown")
  };
  const deleteBusy = busyId === `archive-delete:${archiveRowKey(row)}`;
  const restoreBusy = busyId === `archive-restore:${archiveRowKey(row)}`;
  const unarchiveBusy = busyId === `archive-unarchive:${archiveRowKey(row)}`;
  const busy = deleteBusy || restoreBusy || unarchiveBusy;

  return (
    <Sheet open={true} onOpenChange={onClose}>
      <SheetContent className="detail-drawer codex-archive-drawer">
        <SheetHeader>
          <div className="drawer-title-row">
            <div>
              <p className="eyebrow">{preview.state === "active" ? t("archivedSession") : t("archiveTrash")}</p>
              <SheetTitle>{row.title}</SheetTitle>
            </div>
            <Button className="icon-button" variant="outline" size="icon" type="button" onClick={onClose} aria-label={t("closeArchivedSession")}>
              <X size={18} aria-hidden="true" />
            </Button>
          </div>
          <p>{row.sessionId}</p>
          <div className="drawer-badges">
            <span className={`source-badge repo`}>{row.sourceLabel}</span>
            <Badge variant={preview.state === "active" ? "success" : "warning"}>{preview.state === "active" ? t("activeArchive") : t("trash")}</Badge>
          </div>
        </SheetHeader>

        <div className="detail-metadata" aria-label={t("archivedSessionSummary")}>
          <DetailField label={t("archived")} value={formatArchiveDate(row.archivedAt, locale, t)} />
          <DetailField label={t("updated")} value={formatTimestamp(row.updatedAt, locale, t)} />
          <DetailField label={t("source")} value={row.sourceLabel} />
          <DetailField label={t("fileSize")} value={formatFileSize(row.fileSize)} />
        </div>

        <div className="detail-section">
          <h3>{t("metadata")}</h3>
          <KeyValue label={t("file")} value={row.fileName} />
          <KeyValue label={t("sessionId")} value={row.sessionId} />
          <KeyValue label={t("workspace")} value={row.cwd ?? t("unknown")} />
        </div>

        <div className="detail-section">
          <h3>{t("preview")}</h3>
          <pre className="archive-preview">
            <code>{preview.preview.join("\n") || t("noPreviewAvailable")}</code>
          </pre>
          {preview.truncated ? <p className="preview-note">{t("previewTruncated")}</p> : null}
        </div>

        <div className="editor-footer">
          {preview.state === "active" ? (
            <>
              <Button variant="primary" type="button" onClick={() => onUnarchive(row)} disabled={busyId !== null && !unarchiveBusy}>
                {unarchiveBusy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <ArchiveRestore size={15} aria-hidden="true" />}
                {t("unarchive")}
              </Button>
              <Button variant="destructive" type="button" onClick={() => onDelete(row)} disabled={busyId !== null && !deleteBusy}>
                {deleteBusy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                {t("delete")}
              </Button>
            </>
          ) : (
            <Button variant="primary" type="button" onClick={() => onRestore(row)} disabled={busyId !== null && !restoreBusy}>
              {restoreBusy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}
              {t("restore")}
            </Button>
          )}
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
            <X size={15} aria-hidden="true" />
            {t("close")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SkillEditorDrawer({
  row,
  editorState,
  busyId,
  t,
  onSave,
  onClose,
  onChange
}: {
  row: SkillRow;
  editorState: EditorState;
  busyId: string | null;
  t: TFunction;
  onSave: (row: SkillRow) => Promise<void>;
  onClose: () => void;
  onChange: (content: string) => void;
}) {
  const saving = busyId === `editor-save:${rowKey(row)}`;

  return (
    <Sheet open={true} onOpenChange={onClose}>
      <SheetContent className="editor-drawer">
        <div className="drawer-header">
          <div className="drawer-title-row">
            <div>
              <p className="eyebrow">{t("localEditor")}</p>
              <SheetTitle>{t("editSkillMd")}</SheetTitle>
            </div>
            <Button className="icon-button" variant="outline" size="icon" type="button" onClick={onClose} aria-label={t("closeEditor")} disabled={saving}>
              <X size={18} aria-hidden="true" />
            </Button>
          </div>
          <p>{row.name || row.id}</p>
          <div className="drawer-badges">
            <span className={`source-badge ${editorState.source}`}>{sourceLabel(editorState.source, t)}</span>
            {editorState.dirty ? <span className="dirty-badge">{t("unsaved")}</span> : <span className="saved-badge">{t("saved")}</span>}
          </div>
        </div>

        <div className="editor-body">
          <div className="editor-path">
            <span>{t("file")}</span>
            <code>{editorState.path}</code>
          </div>
          <Textarea
            value={editorState.content}
            onChange={(event) => onChange(event.target.value)}
            aria-label={`${t("editSkillMd")} ${row.name || row.id}`}
            spellCheck={false}
          />
        </div>

        <div className="editor-footer">
          <Button
            variant="primary"
            type="button"
            onClick={() => void onSave(row)}
            disabled={saving || !editorState.dirty}
          >
            {saving ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            {t("saveLocal")}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={saving}
          >
            <X size={15} aria-hidden="true" />
            {t("close")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-field">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="key-value">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function SkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {Array.from({ length: 9 }).map((_, index) => (
        <TableRow className="skeleton-row" key={index} aria-hidden="true">
          <TableCell colSpan={columns}>
            <Skeleton className="skeleton-line" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function filterLabel(filter: Filter, t: TFunction) {
  if (filter === "all") return t("all");
  return syncLabel(filter, t);
}

function viewTitle(view: View, t: TFunction) {
  const titles: Record<View, string> = {
    skills: t("skills"),
    archive: t("codexArchive"),
    settings: t("settings")
  };

  return titles[view];
}

function viewFromLocation(): View {
  if (typeof window === "undefined") {
    return "skills";
  }

  return viewFromPath(window.location.pathname);
}

function viewFromPath(pathname: string): View {
  switch (normalizeRoutePath(pathname)) {
    case "/codex-archive":
    case "/archive":
      return "archive";
    case "/settings":
      return "settings";
    case "/":
    case "/skills":
    default:
      return "skills";
  }
}

function normalizeRoutePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function readInitialTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }

  const stored = window.localStorage.getItem(themeStorageKey);
  if (stored === "light" || stored === "dark") {
    return stored;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function nextSortState<TSortKey extends string>(current: SortState<TSortKey>, key: TSortKey): SortState<TSortKey> {
  if (current.key === key) {
    return {
      key,
      direction: current.direction === "asc" ? "desc" : "asc"
    };
  }

  return {
    key,
    direction: defaultSortDirection(key)
  };
}

function defaultSortDirection(key: string): SortDirection {
  return key.includes("used") || key.includes("modified") || key.includes("archived") || key.includes("updated") ? "desc" : "asc";
}

function compareSkillRows(a: SkillRow, b: SkillRow, sort: SortState<SkillSortKey>) {
  let result = 0;
  switch (sort.key) {
    case "name":
      result = compareRowNames(a, b, sort.direction);
      break;
    case "source":
      result = compareTextValues(sourceLabel(a.source), sourceLabel(b.source), sort.direction);
      break;
    case "state":
      result = compareTextValues(syncLabel(a.syncState), syncLabel(b.syncState), sort.direction);
      break;
    case "local_copy":
      result = compareTextValues(a.installed ? "Installed" : "Missing", b.installed ? "Installed" : "Missing", sort.direction);
      break;
    case "local_modified":
      result = compareTimestampValues(a.localModifiedAt, b.localModifiedAt, sort.direction);
      break;
    case "last_used":
      result = compareTimestampValues(a.lastUsedAt, b.lastUsedAt, sort.direction);
      break;
  }

  return result || compareRowNames(a, b, "asc");
}

function compareArchiveRows(a: CodexArchiveRow, b: CodexArchiveRow, sort: SortState<ArchiveSortKey>) {
  let result = 0;
  switch (sort.key) {
    case "title":
      result = compareTextValues(a.title, b.title, sort.direction);
      break;
    case "archived_at":
      result = compareTimestampValues(a.archivedAt, b.archivedAt, sort.direction);
      break;
    case "updated_at":
      result = compareTimestampValues(a.updatedAt, b.updatedAt, sort.direction);
      break;
    case "cwd":
      result = compareTextValues(a.cwd ?? "", b.cwd ?? "", sort.direction);
      break;
    case "source":
      result = compareTextValues(a.source ?? "", b.source ?? "", sort.direction);
      break;
    case "size":
      result = sort.direction === "asc" ? a.fileSize - b.fileSize : b.fileSize - a.fileSize;
      break;
  }

  return result || compareTextValues(a.title, b.title, "asc") || compareTextValues(a.sessionId, b.sessionId, "asc");
}

function compareRowNames(a: SkillRow, b: SkillRow, direction: SortDirection) {
  return compareNamedRecords(a, b, direction);
}

function compareNamedRecords(a: { id: string; name: string }, b: { id: string; name: string }, direction: SortDirection) {
  return compareTextValues(a.name || a.id, b.name || b.id, direction) || compareTextValues(a.id, b.id, direction);
}

function compareTextValues(a: string, b: string, direction: SortDirection) {
  const result = a.localeCompare(b, undefined, { sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

function compareTimestampValues(a: string | null, b: string | null, direction: SortDirection) {
  const aTime = parseTimestamp(a);
  const bTime = parseTimestamp(b);
  if (aTime !== null && bTime !== null) {
    return direction === "asc" ? aTime - bTime : bTime - aTime;
  }

  if (aTime !== null) {
    return -1;
  }

  if (bTime !== null) {
    return 1;
  }

  return 0;
}

function parseTimestamp(value: string | null) {
  if (!value) {
    return null;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function syncLabel(state: SkillRow["syncState"] | Filter, t?: TFunction) {
  const labels: Record<string, string> = {
    clean: t ? t("inSync") : "In sync",
    local_modified: t ? t("localChanged") : "Local changed",
    repo_modified: t ? t("repoChanged") : "Repo changed",
    conflict: t ? t("conflict") : "Conflict",
    missing_local: t ? t("missingLocalCopy") : "Missing local copy",
    missing_repo: t ? t("missingInRepo") : "Missing in repo",
    unmanaged: t ? t("localOnly") : "Local only",
    repo_only: t ? t("repoOnly") : "Repo only",
    all: t ? t("all") : "All"
  };

  return labels[state] ?? state;
}

function formatAutoSyncLabel(status: AutoSyncStatus, t: TFunction) {
  if (!status.enabled) {
    return t("autoSyncOff");
  }

  if (status.running) {
    return t("autoSyncRunning");
  }

  if (status.pending) {
    return t("autoSyncQueued", { mode: status.mode });
  }

  if (status.watchersSupported) {
    return t("autoSyncMode", { mode: status.mode });
  }

  return t("autoSyncPolling");
}

function statusMessage(status: AutoSyncStatus, t: TFunction) {
  if (!status.lastRunCompletedAt) {
    return status.enabled ? t("autoSyncIdle") : t("autoSyncOff");
  }

  const last = new Date(status.lastRunCompletedAt);
  if (Number.isNaN(last.getTime())) {
    return t("autoSyncIdle");
  }

  const now = new Date();
  const mins = Math.max(0, Math.floor((now.getTime() - last.getTime()) / 60000));
  return `${mins} min ago`;
}

function branchSyncLabel(status: GitBranchSyncStatus, t: TFunction) {
  if (status.state === "up-to-date") {
    return t("remoteSynced");
  }

  if (status.state === "ahead") {
    return t("pushNeeded", { count: status.ahead });
  }

  if (status.state === "behind") {
    return t("remoteChanges", { count: status.behind });
  }

  if (status.state === "diverged") {
    return t("syncConflict", { ahead: status.ahead, behind: status.behind });
  }

  if (status.state === "no-upstream") {
    return t("noUpstream");
  }

  return t("remoteUnknown");
}

function branchSyncTitle(status: GitBranchSyncStatus, t: TFunction) {
  const target = status.upstream ?? "remote";
  if (status.state === "up-to-date") {
    return t("upToDateWithRemote", { target });
  }

  if (status.state === "ahead") {
    return t("localCommitsAhead", { count: status.ahead, target });
  }

  if (status.state === "behind") {
    return t("remoteCommitsBehind", { target, count: status.behind });
  }

  if (status.state === "diverged") {
    return t("divergedTitle", { target });
  }

  if (status.state === "no-upstream") {
    return t("noUpstreamTitle");
  }

  return t("remoteUnknownTitle");
}

function branchSyncActionTitle(status: GitBranchSyncStatus, t: TFunction) {
  if (status.state === "diverged") {
    return t("syncConflictActionTitle");
  }

  return branchSyncTitle(status, t);
}

function sourceLabel(source: SkillRow["source"], t?: TFunction) {
  const labels: Record<SkillRow["source"], string> = {
    codex: t ? t("codexLocal") : "Codex local",
    agents: t ? t("agentsLocal") : "Agents local",
    both: t ? t("codexAgents") : "Codex + Agents",
    repo: t ? t("syncRepo") : "Sync repo"
  };

  return labels[source];
}

function repoConflictSourceLabel(source: RepoConflictSource, t?: TFunction) {
  const labels: Record<RepoConflictSource, string> = {
    github: t ? t("githubVersion") : "GitHub version",
    syncRepo: t ? t("syncRepoLocal") : "Sync repo local",
    codex: t ? t("codexInstalledCopy") : "Codex installed copy",
    agents: t ? t("agentsInstalledCopy") : "Agents installed copy"
  };

  return labels[source];
}

function localPathForSource(row: SkillRow, source: LocalSkillSource) {
  const prefix = `${sourceLabel(source)}: `;
  const matchingLine = row.localPath?.split("\n").find((line) => line.startsWith(prefix));
  return matchingLine ? matchingLine.slice(prefix.length) : sourceLabel(source);
}

function localHashLabel(row: SkillRow, t: TFunction) {
  return row.localCopiesDiffer ? t("mixedLocalCopies") : shortHash(row.localHash, t);
}

function kindLabel(kind: SkillRow["kind"], t: TFunction) {
  const labels: Record<SkillRow["kind"], string> = {
    managed: t("trackedSkill"),
    unmanaged: t("localOnlySkill"),
    "repo-only": t("repoOnlySkill")
  };

  return labels[kind];
}

function shortHash(hash: string | null, t?: TFunction) {
  return hash ? hash.slice(0, 12) : t ? t("none") : "None";
}

function shortSessionId(sessionId: string) {
  return sessionId.length > 18 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}` : sessionId;
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatTimestamp(value: string | null, locale: Locale = "en", t?: TFunction) {
  if (!value) {
    return t ? t("notTracked") : "Not tracked";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
}

function formatArchiveDate(value: string | null, locale: Locale = "en", t?: TFunction) {
  return value ? formatTimestamp(value, locale, t) : t ? t("unknown") : "Unknown";
}

function formatLocalModified(value: string | null, locale: Locale = "en", t?: TFunction) {
  return value ? formatTimestamp(value, locale, t) : t ? t("noLocalCopy") : "No local copy";
}

function formatMonitorTime(value: string | null, locale: Locale = "en", t?: TFunction) {
  return value ? formatTimestamp(value, locale, t) : t ? t("notYet") : "Not yet";
}

function formatLastUsed(lastUsedAt: string | null, locale: Locale = "en", t?: TFunction) {
  if (!lastUsedAt) {
    return t ? t("never") : "Never";
  }

  const parsed = new Date(lastUsedAt);
  if (Number.isNaN(parsed.getTime())) {
    return lastUsedAt;
  }

  return `${parsed.toLocaleString(locale === "zh" ? "zh-CN" : "en-US")} (${formatAge(parsed, t)})`;
}

function formatAge(date: Date, t?: TFunction): string {
  const now = Date.now();
  const ageMs = Math.max(0, now - date.getTime());
  const minutes = Math.floor(ageMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days >= 1) {
    return t ? t("dayAgo", { count: days, plural: days === 1 ? "" : "s" }) : `${days} day${days === 1 ? "" : "s"} ago`;
  }

  if (hours >= 1) {
    return t ? t("hourAgo", { count: hours, plural: hours === 1 ? "" : "s" }) : `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  return t ? t("minuteAgo", { count: minutes, plural: minutes === 1 ? "" : "s" }) : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

function errorMessage(error: unknown, fallback: string, t: TFunction) {
  if (!(error instanceof Error) || !error.message) {
    return fallback;
  }

  return localizeServerError(error.message, t) ?? error.message;
}

function localizeServerError(message: string, t: TFunction): string | null {
  if (message.startsWith("Cannot pull: sync repo has local uncommitted changes.")) {
    const details = message.split("\n").slice(1).join("\n").trim();
    return details ? `${t("cannotPullUncommittedChanges")}\n${details}` : t("cannotPullUncommittedChanges");
  }

  const autoResolvePrefix = "Cannot auto-resolve sync conflict. Review these paths manually:";
  if (message.startsWith(autoResolvePrefix)) {
    return t("cannotAutoResolveSyncConflict", { paths: message.slice(autoResolvePrefix.length).trim() });
  }

  const manualReviewPrefix = "Cannot resolve repository conflict. Review these paths manually:";
  if (message.startsWith(manualReviewPrefix)) {
    return t("cannotResolveRepoConflictManual", { paths: message.slice(manualReviewPrefix.length).trim() });
  }

  return null;
}

async function readError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string; message?: string };
    return payload.error ?? payload.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

function selectRowWithKeyboard(event: KeyboardEvent<HTMLElement>, id: string, setSelectedId: (id: string) => void) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  setSelectedId(id);
}
