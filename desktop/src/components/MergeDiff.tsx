import { useEffect, useRef } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { FileDoc } from "../protocol";

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

/**
 * Editable side-by-side review of one file: HEAD (left, read-only) vs the
 * working tree (right, editable) via CodeMirror's MergeView. Per-chunk revert
 * arrows discard a change; edits to the right pane are debounced-saved back to
 * the working tree.
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
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
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (saveTimer.current) clearTimeout(saveTimer.current);
            const text = u.state.doc.toString();
            saveTimer.current = setTimeout(() => onSaveRef.current(text), 600);
          }),
        ],
      },
      revertControls: editable ? "a-to-b" : undefined,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      view.destroy();
    };
  }, [doc.path, doc.oldText, doc.newText, editable]);

  return <div ref={host} className="cm-merge-host h-full overflow-auto text-[13px]" />;
}
