import { getOriginalDoc, unifiedMergeView, updateOriginalDoc } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { ChangeSet, EditorState, Text } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Check, Send, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useThemeMode } from "@/hooks/useTheme";
import { codemirrorLanguageForPath } from "@/lib/codemirrorLanguages";
import { cmChromeForMode } from "@/lib/codemirrorTheme";
import { cn } from "@/lib/utils";

import type { FileDiff, FileDoc } from "../protocol";

type SaveStatus = "clean" | "unsaved" | "saved";

export function UnifiedDiff({
  doc,
  file,
  editable,
  highlightedHunks,
  onScrolledToHunk,
  onSave,
  onSendToChat,
}: {
  doc: FileDoc;
  file: FileDiff;
  editable?: boolean;
  /** Indexes of hunks to bring into view / highlight (chat "changed lines"). */
  highlightedHunks?: ReadonlySet<number>;
  /** Fired once the editor has actually brought a highlighted hunk into view.
   *  The caller cannot know when that happens: this editor is lazy-loaded and
   *  waits on its own document fetch, so on a cold open it can mount seconds
   *  after the request to scroll was made. */
  onScrolledToHunk?: () => void;
  onSave?: (content: string) => void;
  onSendToChat?: (file: FileDiff) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeMode = useThemeMode();
  const [status, setStatus] = useState<SaveStatus>("clean");
  const onSaveRef = useRef(onSave);
  // Read through a ref: the scroll effect must not re-run just because the
  // parent passed a new closure.
  const onScrolledToHunkRef = useRef(onScrolledToHunk);
  onScrolledToHunkRef.current = onScrolledToHunk;
  const originalRef = useRef(doc.newText);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    originalRef.current = doc.newText;
  }, [doc.newText]);

  const flushSave = () => {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    onSaveRef.current?.(text);
    setStatus("saved");
  };

  const discard = () => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, insert: originalRef.current, to: view.state.doc.length } });
    flushSave();
  };

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let disposed = false;
    let view: EditorView | null = null;

    void codemirrorLanguageForPath(doc.path).then((lang) => {
      if (disposed) return;
      const common: Extension[] = [
        lineNumbers(),
        ...cmChromeForMode(themeMode),
        EditorView.lineWrapping,
        ...lang,
      ];
      const state = EditorState.create({
        doc: doc.newText,
        extensions: [
          ...common,
          EditorState.readOnly.of(!editable),
          keymap.of([{ key: "Mod-s", run: () => (flushSave(), true) }]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            setStatus("unsaved");
          }),
          unifiedMergeView({
            original: doc.oldText,
            highlightChanges: true,
            gutter: true,
            collapseUnchanged: { margin: 3, minSize: 4 },
            diffConfig: { scanLimit: 20000, timeout: 250 },
            mergeControls: false,
          }),
          EditorView.theme({
            "&": { fontSize: "var(--app-mono-font-size)" },
            ".cm-content": { padding: "8px 0" },
          }),
        ],
      });
      view = new EditorView({ parent, state });
      viewRef.current = view;
    });

    return () => {
      disposed = true;
      view?.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
    // recreate only when path / editable / theme changes; content sync via effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, editable, themeMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (status !== "clean") return;
    const cur = view.state.doc.toString();
    if (cur !== doc.newText) {
      view.dispatch({ changes: { from: 0, insert: doc.newText, to: cur.length } });
    }
  }, [doc.newText, status]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (status !== "clean") return;
    const orig = getOriginalDoc(view.state).toString();
    if (orig !== doc.oldText) {
      const docText = doc.oldText.length ? Text.of(doc.oldText.split("\n")) : Text.empty;
      const changes = ChangeSet.of(
        [{ from: 0, insert: doc.oldText, to: orig.length }],
        orig.length,
      );
      view.dispatch({ effects: updateOriginalDoc.of({ doc: docText, changes }) });
    }
  }, [doc.oldText, status]);

  // Chat "changed lines" (e.g. +34 -4) → bring the matched hunks into view.
  // CodeMirror's mergeView already marks changed rows (cm-changedLine + gutter
  // marker), so here we only scroll to the first changed line of the matched
  // hunks — no extra flash layer.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!highlightedHunks || highlightedHunks.size === 0) return;
    let firstLine: number | null = null;
    for (const index of highlightedHunks) {
      const hunk = file.hunks[index];
      if (!hunk) continue;
      let newLine = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.startsWith("+") || line.startsWith(" ")) {
          if (line.startsWith("+") && firstLine === null) firstLine = newLine;
          newLine += 1;
        }
        // "-" rows are removals: no new-doc line, counter stays put.
      }
      if (firstLine !== null) break;
    }
    if (firstLine === null) return;
    const from = view.state.doc.line(Math.min(firstLine, view.state.doc.lines)).from;
    view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
    onScrolledToHunkRef.current?.();
  }, [file, highlightedHunks]);

  return (
    <div className="flex flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-secondary/30 px-3 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{doc.path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1 text-[11px] whitespace-nowrap",
              status === "unsaved" && "text-warn",
              status === "saved" && "text-ok",
            )}
          >
            {status === "unsaved" ? (
              "● unsaved"
            ) : status === "saved" ? (
              <>
                <Check className="size-3" /> saved
              </>
            ) : null}
          </span>
          {editable && (
            <button
              type="button"
              onClick={discard}
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Restore this file to how the agent left it"
            >
              <Undo2 className="size-3" /> revert
            </button>
          )}
          {onSendToChat && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => onSendToChat(file)}
              title="Send this file's diff to chat"
            >
              <Send className="size-3" />
              send
            </Button>
          )}
        </span>
      </div>
      <div ref={host} className="warpforge-unified-diff overflow-auto bg-card" />
    </div>
  );
}
