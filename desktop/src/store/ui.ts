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

interface UiState {
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
