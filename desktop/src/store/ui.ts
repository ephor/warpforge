import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { EditHunk } from "../protocol";
import { DEFAULT_THEME } from "@/lib/themes";

/**
 * Client-side UI state (view, panel toggles, prefs) — persisted to localStorage.
 * The server-data store is `daemon.ts` (useSyncExternalStore); this owns UI only.
 */

export type View = "control" | "projects";
export type DiffView = "unified" | "split";
export type RightPanel = "changes" | "files" | "subtasks" | null;
export type RepositoryOperation = { taskId: string; kind: "pull" | "push" };

/** Center-pane workspace surface. Exactly one is active per task at a time. */
export type TaskSurface = "files" | "diff" | "runtime" | "pipeline";
export const DEFAULT_TASK_SURFACE: TaskSurface = "diff";

/** Transient intent to open a task already showing a specific file/diff. */
export type TaskOpenNav =
  | { surface: "files"; path: string }
  | { surface: "diff"; path: string; hunks?: EditHunk[] };

export interface PinnedTileLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_MONO_FONT_SIZE = 13;
const FONT_SIZE_STEP = 1;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;
const MONO_FONT_SIZE_MIN = 9;
const MONO_FONT_SIZE_MAX = 22;

export const SIDEBAR_WIDTH_DEFAULT = 340;
export const SIDEBAR_WIDTH_MIN = 260;
export const SIDEBAR_WIDTH_MAX = 480;

export function clampSidebarWidth(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(v)));
}

export interface SettingsState {
  /** Id of the active color theme. See lib/themes. */
  theme: string;
  setTheme: (id: string) => void;
  fontSize: number;
  monoFontSize: number;
  setFontSize: (size: number) => void;
  setMonoFontSize: (size: number) => void;
  bumpFontSize: (direction: 1 | -1) => void;
  bumpMonoFontSize: (direction: 1 | -1) => void;
  resetFontSizes: () => void;
  /** Agent that drafts commit messages and PR descriptions. null = none picked. */
  textGenAgentId: string | null;
  setTextGenAgentId: (id: string | null) => void;
  /** Model override for that agent. null = whatever the agent defaults to. */
  textGenModel: string | null;
  setTextGenModel: (model: string | null) => void;
  /** When true and a text-gen agent is selected, auto-generate a task title after creation. */
  autoNameTasks: boolean;
  setAutoNameTasks: (v: boolean) => void;
  /** Easter egg: blur email addresses wherever they render. */
  theoMod: boolean;
  setTheoMod: (v: boolean) => void;
  /**
   * Whether New Task starts in an isolated git worktree. Persisted so the
   * choice survives across task creations instead of resetting every time.
   * Off by default — most tasks run in the checkout the user is already in.
   */
  newTaskWorktree: boolean;
  setNewTaskWorktree: (v: boolean) => void;
}

interface UiState extends SettingsState {
  // Navigation
  view: View;
  openTaskId: string | null; // Transient — not persisted
  /** Project whose detail the Projects view shows. Persisted; cleared when removed. */
  selectedProjectId: string | null;
  /** Transient intent to open a task at a specific file/diff. Not persisted. */
  openTaskNav: TaskOpenNav | null;
  // App shell
  attentionTargetId: string | null;
  attentionTargetNonce: number;
  repositoryOperation: RepositoryOperation | null;
  // TaskDetail zones
  showChat: boolean;
  showDiff: boolean;
  diffView: DiffView;
  rightPanel: RightPanel;
  /** Which of Files/Diff/Runtime/Plan is active in the workspace pane. Task-scoped, like `rightPanel`. */
  activeSurface: TaskSurface;
  runtimeOpenByProject: Record<string, boolean>;
  pinnedTaskIds: string[];
  pinnedLayout: Record<string, PinnedTileLayout>;
  sidebarWidth: number;
  /** Sidebar shrunk to its icon rail. */
  sidebarCollapsed: boolean;
  // Editor: language-server (LSP) features — persisted, user-toggled.
  lspEnabled: boolean;

  setView: (v: View) => void;
  openTask: (id: string | null) => void;
  /** Open a task and immediately surface a specific file/diff in its workspace. */
  openTaskWithNav: (id: string, nav: TaskOpenNav) => void;
  clearOpenTaskNav: () => void;
  /** Switch to the Projects view focused on a specific project. */
  openProject: (id: string) => void;
  focusAttentionTask: (id: string) => void;
  setRepositoryOperation: (operation: RepositoryOperation | null) => void;
  toggleChat: () => void;
  toggleDiff: () => void;
  setShowDiff: (open: boolean) => void;
  setDiffView: (v: DiffView) => void;
  setRightPanel: (panel: RightPanel) => void;
  setActiveSurface: (surface: TaskSurface) => void;
  toggleRuntime: (project: string) => void;
  setRuntimeOpen: (project: string, open: boolean) => void;
  clearRuntimeOpen: (project: string) => void;
  togglePinnedTask: (id: string) => void;
  setPinnedTaskIds: (ids: string[]) => void;
  setPinnedLayout: (id: string, layout: PinnedTileLayout) => void;
  setSidebarWidth: (w: number) => void;
  toggleSidebarCollapsed: () => void;
  toggleLsp: () => void;
}

function clampFontSize(v: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(v)));
}

function clampMonoFontSize(v: number): number {
  return Math.min(MONO_FONT_SIZE_MAX, Math.max(MONO_FONT_SIZE_MIN, Math.round(v)));
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      view: "control",
      openTaskId: null,
      selectedProjectId: null,
      openTaskNav: null,
      attentionTargetId: null,
      attentionTargetNonce: 0,
      repositoryOperation: null,
      showChat: true,
      showDiff: true,
      diffView: "split",
      rightPanel: null,
      activeSurface: DEFAULT_TASK_SURFACE,
      runtimeOpenByProject: {},
      pinnedTaskIds: [],
      pinnedLayout: {},
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      sidebarCollapsed: false,
      fontSize: DEFAULT_FONT_SIZE,
      monoFontSize: DEFAULT_MONO_FONT_SIZE,
      theme: DEFAULT_THEME,
      textGenAgentId: null,
      textGenModel: null,
      autoNameTasks: true,
      newTaskWorktree: false,
      theoMod: false,
      lspEnabled: true,

      setView: (view) => set({ openTaskId: null, openTaskNav: null, view }),
      openProject: (selectedProjectId) =>
        set({ openTaskId: null, openTaskNav: null, view: "projects", selectedProjectId }),
      // Contextual task tools must not leak from one task into the next.
      // Project-scoped Runtime visibility and other layout preferences remain persisted.
      openTask: (openTaskId) =>
        set({
          openTaskId,
          openTaskNav: null,
          rightPanel: null,
          activeSurface: DEFAULT_TASK_SURFACE,
        }),
      openTaskWithNav: (openTaskId, openTaskNav) =>
        set({ openTaskId, openTaskNav, rightPanel: null, activeSurface: openTaskNav.surface }),
      clearOpenTaskNav: () => set({ openTaskNav: null }),
      focusAttentionTask: (attentionTargetId) =>
        set((s) => ({
          attentionTargetId,
          attentionTargetNonce: s.attentionTargetNonce + 1,
        })),
      setRepositoryOperation: (repositoryOperation) => set({ repositoryOperation }),
      // Chat + Center are the mutual pair — never let both close. Tree is a
      // Sub-panel of Center, so it toggles freely.
      toggleChat: () => set((s) => (!s.showChat || s.showDiff ? { showChat: !s.showChat } : s)),
      toggleDiff: () => set((s) => (!s.showDiff || s.showChat ? { showDiff: !s.showDiff } : s)),
      setShowDiff: (showDiff) => set((s) => (!showDiff && !s.showChat ? s : { showDiff })),
      setDiffView: (diffView) => set({ diffView }),
      setRightPanel: (rightPanel) => set({ rightPanel }),
      setActiveSurface: (activeSurface) => set({ activeSurface }),
      toggleRuntime: (project) =>
        set((s) => ({
          runtimeOpenByProject: {
            ...s.runtimeOpenByProject,
            [project]: !s.runtimeOpenByProject[project],
          },
        })),
      setRuntimeOpen: (project, open) =>
        set((s) => ({
          runtimeOpenByProject: {
            ...s.runtimeOpenByProject,
            [project]: open,
          },
        })),
      clearRuntimeOpen: (project) =>
        set((s) => {
          const runtimeOpenByProject = { ...s.runtimeOpenByProject };
          delete runtimeOpenByProject[project];
          return { runtimeOpenByProject };
        }),
      setPinnedTaskIds: (pinnedTaskIds) => set({ pinnedTaskIds }),
      togglePinnedTask: (id) =>
        set((s) => {
          const isPinned = s.pinnedTaskIds.includes(id);
          if (isPinned) {
            const pinnedLayout = { ...s.pinnedLayout };
            delete pinnedLayout[id];
            return {
              pinnedTaskIds: s.pinnedTaskIds.filter((x) => x !== id),
              pinnedLayout,
            };
          }
          const y = Object.values(s.pinnedLayout).reduce((max, l) => Math.max(max, l.y + l.h), 0);
          return {
            pinnedTaskIds: [...s.pinnedTaskIds, id],
            pinnedLayout: {
              ...s.pinnedLayout,
              [id]: { x: 0, y, w: 2, h: 2 },
            },
          };
        }),
      setPinnedLayout: (id, layout) =>
        set((s) => ({
          pinnedLayout: { ...s.pinnedLayout, [id]: layout },
        })),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: clampSidebarWidth(sidebarWidth) }),
      toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      // ── Font size settings ──
      setFontSize: (fontSize) => set({ fontSize: clampFontSize(fontSize) }),
      setMonoFontSize: (monoFontSize) => set({ monoFontSize: clampMonoFontSize(monoFontSize) }),
      bumpFontSize: (direction) =>
        set((s) => ({ fontSize: clampFontSize(s.fontSize + direction * FONT_SIZE_STEP) })),
      bumpMonoFontSize: (direction) =>
        set((s) => ({
          monoFontSize: clampMonoFontSize(s.monoFontSize + direction * FONT_SIZE_STEP),
        })),
      resetFontSizes: () =>
        set({ fontSize: DEFAULT_FONT_SIZE, monoFontSize: DEFAULT_MONO_FONT_SIZE }),
      setTheme: (theme) => set({ theme }),
      // Models are per-agent, so a stored pick is meaningless once the agent changes.
      setTextGenAgentId: (textGenAgentId) => set({ textGenAgentId, textGenModel: null }),
      setTextGenModel: (textGenModel) => set({ textGenModel }),
      setAutoNameTasks: (autoNameTasks) => set({ autoNameTasks }),
      setNewTaskWorktree: (newTaskWorktree) => set({ newTaskWorktree }),
      setTheoMod: (theoMod) => set({ theoMod }),
      toggleLsp: () => set((s) => ({ lspEnabled: !s.lspEnabled })),
    }),
    {
      name: "wf-ui",
      version: 3,
      migrate: (persisted: unknown, version: number) => {
        let state = persisted as Record<string, unknown>;
        if (version === 0 && state && "sidebarWidth" in state) {
          if (typeof state.sidebarWidth === "number") {
            state = { ...state, sidebarWidth: clampSidebarWidth(state.sidebarWidth) };
          }
        }
        if (version < 2 && state && !("pinnedLayout" in state)) {
          state = { ...state, pinnedLayout: {} };
        }
        // The Board view was removed. `view` is persisted, so without this a
        // session that ended there rehydrates a `view` no branch renders.
        if (version < 3 && state && state.view === "board") {
          state = { ...state, view: "control" };
        }
        return state;
      },
      // OpenTaskId is session-only — a reload shouldn't force-open a stale task.
      // activeSurface follows rightPanel: task-scoped, reset by openTask, not persisted.
      partialize: ({
        openTaskId: _openTaskId,
        openTaskNav: _openTaskNav,
        attentionTargetId: _attentionTargetId,
        attentionTargetNonce: _attentionTargetNonce,
        repositoryOperation: _repositoryOperation,
        rightPanel: _rightPanel,
        activeSurface: _activeSurface,
        ...rest
      }) => rest,
    },
  ),
);
