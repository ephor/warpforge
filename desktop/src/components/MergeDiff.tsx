import { useEffect, useRef, useState } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { Undo2, Check } from "lucide-react";
import { FileDoc } from "../protocol";
import { cn } from "@/lib/utils";

/** Pick a CodeMirror language extension by file extension. */
function langFor(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: true })];
    case "rs":
      return [rust()];
    case "go":
      return [go()];
    case "json":
      return [json()];
    case "py":
      return [python()];
    default:
      return [];
  }
}

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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // Text we last wrote to disk — lets the sync effect tell our own save-echo
  // (harmless, skip) from a real external/agent edit (apply to the pane).
  const lastSaved = useRef<string | null>(null);
  const original = doc.newText; // the agent's version, for "discard edits"
  const [status, setStatus] = useState<SaveStatus>("clean");

  const flushSave = () => {
    const view = viewRef.current;
    if (!view) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const text = view.b.state.doc.toString();
    lastSaved.current = text;
    onSaveRef.current(text);
    setStatus("saved");
  };

  const discard = () => {
    const view = viewRef.current;
    if (!view) return;
    view.b.dispatch({
      changes: { from: 0, to: view.b.state.doc.length, insert: original },
    });
    flushSave();
  };

  useEffect(() => {
    if (!host.current) return;
    setStatus("clean");
    lastSaved.current = null;
    const lang = langFor(doc.path);
    const common: Extension[] = [lineNumbers(), oneDark, EditorView.lineWrapping, ...lang];

    const view = new MergeView({
      parent: host.current,
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
            if (saveTimer.current) clearTimeout(saveTimer.current);
            const text = u.state.doc.toString();
            saveTimer.current = setTimeout(() => {
              lastSaved.current = text;
              onSaveRef.current(text);
              setStatus("saved");
            }, 600);
          }),
        ],
      },
      revertControls: editable ? "a-to-b" : undefined,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    viewRef.current = view;

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, doc.oldText, editable]);

  // The right pane changed on disk (agent edited the open file). Apply it in
  // place — but skip our own save-echo and any content that already matches,
  // so a user's unsaved edits and cursor survive.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (doc.newText === lastSaved.current) return;
    const cur = view.b.state.doc.toString();
    if (doc.newText === cur) return;
    view.b.dispatch({
      changes: { from: 0, to: view.b.state.doc.length, insert: doc.newText },
    });
    setStatus("clean");
    lastSaved.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.newText]);

  return (
    <div className="flex h-full flex-col">
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
            onClick={discard}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
            title="Restore this file to how the agent left it"
          >
            <Undo2 className="size-3" /> discard edits
          </button>
          <span className="text-[10px]">⌘S save · ↩ revert hunk</span>
        </div>
      )}
      <div ref={host} className="min-h-0 flex-1 overflow-auto text-[13px]" />
    </div>
  );
}
