import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Client-side UI state (view, panel toggles, prefs) — persisted to localStorage.
 * The server-data store is `daemon.ts` (useSyncExternalStore); this owns UI only.
 */

export type View = "control" | "board" | "projects";
export type CenterTab = "changes" | "editor";
export type DiffView = "unified" | "split";
export type RightPanel = "changes" | "files" | null;

interface UiState {
  // Navigation
  view: View;
  openTaskId: string | null; // transient — not persisted
  // App shell
  attentionOpen: boolean;
  // TaskDetail zones
  showChat: boolean;
  showDiff: boolean;
  showTree: boolean;
  centerTab: CenterTab;
  diffView: DiffView;
  rightPanel: RightPanel;
  runtimeOpen: boolean;
  pinnedTaskIds: string[];

  setView: (v: View) => void;
  openTask: (id: string | null) => void;
  toggleAttention: () => void;
  toggleChat: () => void;
  toggleDiff: () => void;
  setShowDiff: (open: boolean) => void;
  toggleTree: () => void;
  setCenterTab: (t: CenterTab) => void;
  setDiffView: (v: DiffView) => void;
  setRightPanel: (panel: RightPanel) => void;
  toggleRuntime: () => void;
  setRuntimeOpen: (open: boolean) => void;
  togglePinnedTask: (id: string) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      view: "control",
      openTaskId: null,
      attentionOpen: true,
      showChat: true,
      showDiff: true,
      showTree: false,
      centerTab: "changes",
      diffView: "split",
      rightPanel: "changes",
      runtimeOpen: false,
      pinnedTaskIds: [],

      setView: (view) => set({ view, openTaskId: null }),
      openTask: (openTaskId) => set({ openTaskId }),
      toggleAttention: () => set((s) => ({ attentionOpen: !s.attentionOpen })),
      // Chat + Center are the mutual pair — never let both close. Tree is a
      // sub-panel of Center, so it toggles freely.
      toggleChat: () => set((s) => (!s.showChat || s.showDiff ? { showChat: !s.showChat } : s)),
      toggleDiff: () => set((s) => (!s.showDiff || s.showChat ? { showDiff: !s.showDiff } : s)),
      setShowDiff: (showDiff) => set((s) => (!showDiff && !s.showChat ? s : { showDiff })),
      toggleTree: () => set((s) => ({ showTree: !s.showTree })),
      setCenterTab: (centerTab) => set({ centerTab }),
      setDiffView: (diffView) => set({ diffView }),
      setRightPanel: (rightPanel) => set({ rightPanel }),
      toggleRuntime: () => set((s) => ({ runtimeOpen: !s.runtimeOpen })),
      setRuntimeOpen: (runtimeOpen) => set({ runtimeOpen }),
      togglePinnedTask: (id) =>
        set((s) => ({
          pinnedTaskIds: s.pinnedTaskIds.includes(id)
            ? s.pinnedTaskIds.filter((x) => x !== id)
            : [...s.pinnedTaskIds, id],
        })),
    }),
    {
      name: "wf-ui",
      // openTaskId is session-only — a reload shouldn't force-open a stale task.
      partialize: ({ openTaskId, ...rest }) => rest,
    },
  ),
);
