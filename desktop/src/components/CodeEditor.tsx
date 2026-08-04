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
const isSvgPath = (path: string) => /\.svg$/i.test(path);
const isBinaryImagePath = (path: string) => /\.(png|jpg|jpeg|gif|webp|ico|bmp)$/i.test(path);

function getMimeType(path: string): string {
  const ext = path.toLowerCase().split(".").pop();
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  return mimeMap[ext ?? ""] ?? "application/octet-stream";
}

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
  const onSaveRef = useRef(onSave);
  const [status, setStatus] = useState<SaveStatus>("clean");
  const [preview, setPreview] = useState(false);
  const markdown = isMarkdownPath(doc.path);
  const svgImage = isSvgPath(doc.path);
  const binaryImage = isBinaryImagePath(doc.path);
  const showPreview = (markdown || svgImage) && preview;
  const previewText = viewRef.current?.state.doc.toString() ?? doc.newText;
  const isReadOnly = binaryImage || svgImage;

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const flushSave = () => {
    const view = viewRef.current;
    if (!view) {
      return true;
    }
    const current = view.state.doc.toString();
    onSaveRef.current(current);
    setStatus("saved");
    return true;
  };

  useEffect(() => {
    const parent = host.current;
    if (!parent || binaryImage) {
      return;
    }
    let disposed = false;
    let view: EditorView | null = null;

    void codemirrorLanguageForPath(doc.path).then((language) => {
      if (disposed) return;
      view = new EditorView({
        parent,
        state: EditorState.create({
          doc: doc.newText,
          extensions: [
            basicSetup,
            lintGutter(),
            oneDark,
            EditorView.lineWrapping,
            ...language,
            EditorState.readOnly.of(!editable || isReadOnly),
            keymap.of([{ key: "Mod-s", run: flushSave }]),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) {
                return;
              }
              setStatus("unsaved");
            }),
          ],
        }),
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
  }, [doc.path, editable, binaryImage, isReadOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (status === "clean") {
      const current = view.state.doc.toString();
      if (current !== doc.newText) {
        view.dispatch({
          changes: { from: 0, insert: doc.newText, to: current.length },
        });
      }
    }
  }, [doc.newText, status]);

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
        {(markdown || svgImage) && (
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
        {!isReadOnly && (
          <button
            type="button"
            onClick={flushSave}
            disabled={!editable}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            <Save className="size-3" />
            save
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {binaryImage ? (
          <div className="flex h-full flex-col items-center justify-center overflow-auto bg-card p-4">
            {doc.newDataBase64 ? (
              <>
                <img
                  src={`data:${getMimeType(doc.path)};base64,${doc.newDataBase64}`}
                  alt={doc.path}
                  className="max-h-full max-w-full object-contain"
                />
                <div className="mt-2 text-xs text-muted-foreground">
                  {doc.path} • {((doc.newDataBase64.length * 0.75) / 1024).toFixed(1)} KB
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">
                No image data available for {doc.path}
              </div>
            )}
          </div>
        ) : (
          <>
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
                {svgImage ? (
                  <div className="flex h-full items-center justify-center">
                    {doc.newDataBase64 ? (
                      <img
                        src={`data:image/svg+xml;base64,${doc.newDataBase64}`}
                        alt={doc.path}
                        className="max-h-full max-w-full object-contain"
                      />
                    ) : (
                      <div
                        className="prose dark:prose-invert max-w-none"
                        dangerouslySetInnerHTML={{ __html: previewText }}
                      />
                    )}
                  </div>
                ) : (
                  <Markdown>{previewText}</Markdown>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
