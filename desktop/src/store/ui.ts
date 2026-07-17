import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Client-side UI state (view, panel toggles, prefs) — persisted to localStorage.
 * The server-data store is `daemon.ts` (useSyncExternalStore); this owns UI only.
 */

export type View = "control" | "board" | "projects";
export type CenterTab = "changes" | "editor";
export type DiffView = "unified" | "split";
export type RightPanel = "changes" | "files" | "subtasks" | null;

interface UiState {
  // Navigation
  view: View;
  openTaskId: string | null; // Transient — not persisted
  // App shell
  attentionOpen: boolean;
  attentionTargetId: string | null;
  attentionTargetNonce: number;
  // TaskDetail zones
  showChat: boolean;
  showDiff: boolean;
  centerTab: CenterTab;
  diffView: DiffView;
  rightPanel: RightPanel;
  runtimeOpen: boolean;
  pinnedTaskIds: string[];

  setView: (v: View) => void;
  openTask: (id: string | null) => void;
  toggleAttention: () => void;
  setAttentionOpen: (open: boolean) => void;
  focusAttentionTask: (id: string) => void;
  toggleChat: () => void;
  toggleDiff: () => void;
  setShowDiff: (open: boolean) => void;
  setCenterTab: (t: CenterTab) => void;
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
      showChat: true,
      showDiff: true,
      centerTab: "changes",
      diffView: "split",
      rightPanel: "changes",
      runtimeOpen: false,
      pinnedTaskIds: [],

      setView: (view) => set({ openTaskId: null, view }),
      openTask: (openTaskId) => set({ openTaskId }),
      toggleAttention: () => set((s) => ({ attentionOpen: !s.attentionOpen })),
      setAttentionOpen: (attentionOpen) => set({ attentionOpen }),
      focusAttentionTask: (attentionTargetId) =>
        set((s) => ({
          attentionOpen: true,
          attentionTargetId,
          attentionTargetNonce: s.attentionTargetNonce + 1,
        })),
      // Chat + Center are the mutual pair — never let both close. Tree is a
      // Sub-panel of Center, so it toggles freely.
      toggleChat: () => set((s) => (!s.showChat || s.showDiff ? { showChat: !s.showChat } : s)),
      toggleDiff: () => set((s) => (!s.showDiff || s.showChat ? { showDiff: !s.showDiff } : s)),
      setShowDiff: (showDiff) => set((s) => (!showDiff && !s.showChat ? s : { showDiff })),
      setCenterTab: (centerTab) => set({ centerTab }),
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
        ...rest
      }) => rest,
    },
  ),
);
