import { MergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Check, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { codemirrorLanguageForPath } from "@/lib/codemirrorLanguages";
import { cn } from "@/lib/utils";

import type { FileDoc } from "../protocol";

type SaveStatus = "clean" | "unsaved" | "saved";

/**
 * Editable side-by-side review of one file: HEAD (left, read-only) vs the
 * working tree (right, editable) via CodeMirror's MergeView. Per-chunk revert
 * arrows (↩) discard an agent change; edits to the right pane auto-save (debounced)
 * back to the working tree. ⌘S saves now; "Discard edits" restores the file to
 * how the agent left it.
 */
export function MergeDiff({
  doc,
  editable,
  onSave,
}: {
  doc: FileDoc;
  editable: boolean;
  onSave: (content: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | null>(null);
  const onSaveRef = useRef(onSave);
  const originalRef = useRef(doc.newText);
  const [status, setStatus] = useState<SaveStatus>("clean");

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    originalRef.current = doc.newText;
  }, [doc.newText]);

  const flushSave = () => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const text = view.b.state.doc.toString();
    onSaveRef.current(text);
    setStatus("saved");
  };

  const discard = () => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    view.b.dispatch({
      changes: { from: 0, insert: originalRef.current, to: view.b.state.doc.length },
    });
    flushSave();
  };

  useEffect(() => {
    const parent = host.current;
    if (!parent) {
      return;
    }
    let disposed = false;
    let view: MergeView | null = null;

    void codemirrorLanguageForPath(doc.path).then((lang) => {
      if (disposed) return;
      const common: Extension[] = [lineNumbers(), oneDark, EditorView.lineWrapping, ...lang];
      view = new MergeView({
        a: {
          doc: doc.oldText,
          extensions: [...common, EditorState.readOnly.of(true)],
        },
        b: {
          doc: doc.newText,
          extensions: [
            ...common,
            EditorState.readOnly.of(!editable),
            keymap.of([{ key: "Mod-s", run: () => (flushSave(), true) }]),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return;
              setStatus("unsaved");
            }),
          ],
        },
        collapseUnchanged: { margin: 3, minSize: 4 },
        // The default scanLimit (500) makes the Myers diff bail out to a crude
        // Match on any region over ~4k chars, which paints a whole file as
        // Changed after a one-line insert. Source files need a real diff.
        diffConfig: { scanLimit: 20000, timeout: 250 },
        gutter: true,
        highlightChanges: true,
        parent,
        revertControls: editable ? "a-to-b" : undefined,
      });
      viewRef.current = view;
    });

    return () => {
      disposed = true;
      view?.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentOld = view.a.state.doc.toString();
    if (currentOld !== doc.oldText) {
      view.a.dispatch({
        changes: { from: 0, insert: doc.oldText, to: currentOld.length },
      });
    }
  }, [doc.oldText]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (status === "clean") {
      const currentNew = view.b.state.doc.toString();
      if (currentNew !== doc.newText) {
        view.b.dispatch({
          changes: { from: 0, insert: doc.newText, to: currentNew.length },
        });
      }
    }
  }, [doc.newText, status]);

  return (
    <div className="flex flex-col">
      {editable && (
        <div className="flex items-center gap-3 border-b px-3 py-1 text-xs text-muted-foreground">
          <span className="font-mono">{doc.path}</span>
          <span
            className={cn(
              "flex items-center gap-1",
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
            ) : (
              ""
            )}
          </span>
          <button
            type="button"
            onClick={discard}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
            title="Restore this file to how the agent left it"
          >
            <Undo2 className="size-3" /> discard edits
          </button>
          <span className="text-[10px]">⌘S save · ↩ revert hunk</span>
        </div>
      )}
      <div
        ref={host}
        className="warpforge-merge-diff overflow-x-auto bg-card"
        style={{ fontSize: "var(--app-mono-font-size)" }}
      />
    </div>
  );
}
