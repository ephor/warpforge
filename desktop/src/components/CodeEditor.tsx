import { useEffect, useRef, useState } from "react";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { Check, Save } from "lucide-react";
import { FileDoc } from "../protocol";
import { cn } from "@/lib/utils";

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

export function CodeEditor({
  doc,
  editable,
  onSave,
}: {
  doc: FileDoc;
  editable: boolean;
  onSave: (content: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const [status, setStatus] = useState<SaveStatus>("clean");

  const flushSave = () => {
    const view = viewRef.current;
    if (!view) return true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const text = view.state.doc.toString();
    lastSaved.current = text;
    onSaveRef.current(text);
    setStatus("saved");
    return true;
  };

  useEffect(() => {
    if (!host.current) return;
    setStatus("clean");
    lastSaved.current = null;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: doc.newText,
        extensions: [
          lineNumbers(),
          oneDark,
          EditorView.lineWrapping,
          ...langFor(doc.path),
          EditorState.readOnly.of(!editable),
          keymap.of([{ key: "Mod-s", run: flushSave }]),
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
      }),
    });
    viewRef.current = view;
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (doc.newText === lastSaved.current) return;
    const cur = view.state.doc.toString();
    if (doc.newText === cur) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc.newText } });
    setStatus("clean");
    lastSaved.current = null;
  }, [doc.newText]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b px-3 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono">{doc.path}</span>
        <span
          className={cn(
            "flex items-center gap-1",
            status === "unsaved" && "text-warn",
            status === "saved" && "text-ok",
          )}
        >
          {status === "unsaved" ? (
            "unsaved"
          ) : status === "saved" ? (
            <>
              <Check className="size-3" /> saved
            </>
          ) : null}
        </span>
        <button
          type="button"
          onClick={flushSave}
          disabled={!editable}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          <Save className="size-3" />
          save
        </button>
      </div>
      <div ref={host} className="min-h-0 flex-1 overflow-auto text-[13px]" />
    </div>
  );
}
