import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Client-side UI state (view, panel toggles, prefs) — persisted to localStorage.
 * The server-data store is `daemon.ts` (useSyncExternalStore); this owns UI only.
 */

export type View = "control" | "board" | "projects";
export type DiffView = "unified" | "split";
export type RightPanel = "changes" | "files" | "subtasks" | null;
export type RepositoryOperation = { taskId: string; kind: "pull" | "push" };

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_MONO_FONT_SIZE = 13;
const FONT_SIZE_STEP = 1;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;
const MONO_FONT_SIZE_MIN = 9;
const MONO_FONT_SIZE_MAX = 22;

export interface SettingsState {
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
}

interface UiState extends SettingsState {
  // Navigation
  view: View;
  openTaskId: string | null; // Transient — not persisted
  // App shell
  attentionOpen: boolean;
  attentionTargetId: string | null;
  attentionTargetNonce: number;
  repositoryOperation: RepositoryOperation | null;
  // TaskDetail zones
  showChat: boolean;
  showDiff: boolean;
  diffView: DiffView;
  rightPanel: RightPanel;
  runtimeOpen: boolean;
  pinnedTaskIds: string[];

  setView: (v: View) => void;
  openTask: (id: string | null) => void;
  toggleAttention: () => void;
  setAttentionOpen: (open: boolean) => void;
  focusAttentionTask: (id: string) => void;
  setRepositoryOperation: (operation: RepositoryOperation | null) => void;
  toggleChat: () => void;
  toggleDiff: () => void;
  setShowDiff: (open: boolean) => void;
  setDiffView: (v: DiffView) => void;
  setRightPanel: (panel: RightPanel) => void;
  toggleRuntime: () => void;
  setRuntimeOpen: (open: boolean) => void;
  togglePinnedTask: (id: string) => void;
  setPinnedTaskIds: (ids: string[]) => void;
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
      attentionOpen: true,
      attentionTargetId: null,
      attentionTargetNonce: 0,
      repositoryOperation: null,
      showChat: true,
      showDiff: true,
      diffView: "split",
      rightPanel: null,
      runtimeOpen: false,
      pinnedTaskIds: [],
      fontSize: DEFAULT_FONT_SIZE,
      monoFontSize: DEFAULT_MONO_FONT_SIZE,
      textGenAgentId: null,
      textGenModel: null,
      autoNameTasks: true,

      setView: (view) => set({ openTaskId: null, view }),
      // Contextual task tools must not leak from one task into the next.
      // Layout preferences (chat/workspace visibility and diff style) remain persisted.
      openTask: (openTaskId) => set({ openTaskId, rightPanel: null, runtimeOpen: false }),
      toggleAttention: () => set((s) => ({ attentionOpen: !s.attentionOpen })),
      setAttentionOpen: (attentionOpen) => set({ attentionOpen }),
      focusAttentionTask: (attentionTargetId) =>
        set((s) => ({
          attentionOpen: true,
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
      toggleRuntime: () => set((s) => ({ runtimeOpen: !s.runtimeOpen })),
      setRuntimeOpen: (runtimeOpen) => set({ runtimeOpen }),
      setPinnedTaskIds: (pinnedTaskIds) => set({ pinnedTaskIds }),
      togglePinnedTask: (id) =>
        set((s) => ({
          pinnedTaskIds: s.pinnedTaskIds.includes(id)
            ? s.pinnedTaskIds.filter((x) => x !== id)
            : [...s.pinnedTaskIds, id],
        })),

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
      // Models are per-agent, so a stored pick is meaningless once the agent changes.
      setTextGenAgentId: (textGenAgentId) => set({ textGenAgentId, textGenModel: null }),
      setTextGenModel: (textGenModel) => set({ textGenModel }),
      setAutoNameTasks: (autoNameTasks) => set({ autoNameTasks }),
    }),
    {
      name: "wf-ui",
      // OpenTaskId is session-only — a reload shouldn't force-open a stale task.
      partialize: ({
        openTaskId: _openTaskId,
        attentionTargetId: _attentionTargetId,
        attentionTargetNonce: _attentionTargetNonce,
        repositoryOperation: _repositoryOperation,
        rightPanel: _rightPanel,
        runtimeOpen: _runtimeOpen,
        ...rest
      }) => rest,
    },
  ),
);
