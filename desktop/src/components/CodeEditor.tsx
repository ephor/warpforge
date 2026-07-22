import { lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { Check, Code, Eye, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { codemirrorLanguageForPath } from "@/lib/codemirrorLanguages";
import { cn } from "@/lib/utils";

import type { FileDoc } from "../protocol";
import { Markdown } from "./Markdown";

type SaveStatus = "clean" | "unsaved" | "saved";

const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

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
  const lastSaved = useRef<string | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const [status, setStatus] = useState<SaveStatus>("clean");
  const [preview, setPreview] = useState(false);
  const [text, setText] = useState(doc.newText);
  const markdown = isMarkdownPath(doc.path);
  const showPreview = markdown && preview;

  const flushSave = () => {
    const view = viewRef.current;
    if (!view) {
      return true;
    }
    const current = view.state.doc.toString();
    lastSaved.current = current;
    onSaveRef.current(current);
    setStatus("saved");
    return true;
  };

  useEffect(() => {
    if (!host.current) {
      return;
    }
    setStatus("clean");
    setText(doc.newText);
    setPreview(false);
    lastSaved.current = null;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: doc.newText,
        extensions: [
          basicSetup,
          lintGutter(),
          oneDark,
          EditorView.lineWrapping,
          ...codemirrorLanguageForPath(doc.path),
          EditorState.readOnly.of(!editable),
          keymap.of([{ key: "Mod-s", run: flushSave }]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) {
              return;
            }
            setStatus("unsaved");
            setText(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    if (doc.newText === lastSaved.current) {
      return;
    }
    const cur = view.state.doc.toString();
    if (doc.newText === cur) {
      return;
    }
    view.dispatch({ changes: { from: 0, insert: doc.newText, to: view.state.doc.length } });
    setText(doc.newText);
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
        {markdown && (
          <button
            type="button"
            onClick={() => setPreview((p) => !p)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
          >
            {preview ? (
              <>
                <Code className="size-3" /> source
              </>
            ) : (
              <>
                <Eye className="size-3" /> preview
              </>
            )}
          </button>
        )}
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
      <div className="relative min-h-0 flex-1">
        <div
          ref={host}
          className={cn(
            "warpforge-code-editor h-full overflow-auto bg-card",
            showPreview && "hidden",
          )}
          style={{ fontSize: "var(--app-mono-font-size)" }}
        />
        {showPreview && (
          <div className="h-full overflow-auto px-4 py-3">
            <Markdown>{text}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
