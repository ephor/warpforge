import { lintGutter } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { Check, Code, Eye, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  codemirrorLanguageForPath,
  lspLanguageForPath,
} from "@/lib/codemirrorLanguages";
import { cmChromeForMode } from "@/lib/codemirrorTheme";
import { acquireLspClient, releaseLspClient } from "@/lib/lspClients";
import { cn } from "@/lib/utils";
import { useThemeMode } from "@/hooks/useTheme";

import { useUi } from "../store/ui";

import type { FileDoc, SymbolMatch } from "../protocol";
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
  taskId,
  onSave,
  onGotoDefinition,
  onOpenSymbol,
}: {
  doc: FileDoc;
  editable: boolean;
  taskId: string;
  onSave: (content: string) => void;
  /** Resolve a symbol under the cursor to project lines (go-to-definition).
   *  When provided, ⌘/Ctrl-click and ⌘B run it. */
  onGotoDefinition?: (query: string) => Promise<SymbolMatch[]>;
  /** Open a found symbol's file at its line/column. */
  onOpenSymbol?: (path: string, line: number, column: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lspCompartment = useRef(new Compartment());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string | null>(null);
  const onSaveRef = useRef(onSave);
  const onGotoRef = useRef(onGotoDefinition);
  const onOpenSymbolRef = useRef(onOpenSymbol);
  const lspEnabled = useUi((s) => s.lspEnabled);
  const [status, setStatus] = useState<SaveStatus>("clean");
  const [preview, setPreview] = useState(false);
  const [text, setText] = useState(doc.newText);
  const [editorReady, setEditorReady] = useState(false);
  const [gotoResults, setGotoResults] = useState<SymbolMatch[]>([]);
  const [gotoActive, setGotoActive] = useState(0);
  const markdown = isMarkdownPath(doc.path);
  const svgImage = isSvgPath(doc.path);
  const binaryImage = isBinaryImagePath(doc.path);
  const themeMode = useThemeMode();
  const showPreview = (markdown || svgImage) && preview;
  const previewText = text;
  const isReadOnly = binaryImage || svgImage;

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);
  useEffect(() => {
    onGotoRef.current = onGotoDefinition;
    onOpenSymbolRef.current = onOpenSymbol;
  }, [onGotoDefinition, onOpenSymbol]);

  const flushSave = () => {
    const view = viewRef.current;
    if (!view) {
      return true;
    }
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const current = view.state.doc.toString();
    lastSaved.current = current;
    setText(current);
    onSaveRef.current(current);
    setStatus("saved");
    return true;
  };

  const runGoto = useCallback((): boolean => {
    const view = viewRef.current;
    const save = onGotoRef.current;
    if (!view || !save) {
      return false;
    }
    const head = view.state.selection.main.head;
    const word = view.state.wordAt(head);
    if (!word) {
      return false;
    }
    const query = view.state.sliceDoc(word.from, word.to).trim();
    if (!query) {
      return false;
    }
    setGotoResults([]);
    void save(query).then((results) => {
      if (!results.length) {
        return;
      }
      setGotoResults(results.slice(0, 12));
      setGotoActive(0);
    });
    return true;
  }, []);

  const pickGoto = useCallback(
    (index: number) => {
      const hit = gotoResults[index];
      if (!hit) {
        return;
      }
      const open = onOpenSymbolRef.current;
      setGotoResults([]);
      open?.(hit.path, hit.line, hit.column);
    },
    [gotoResults],
  );

  useEffect(() => {
    const parent = host.current;
    if (!parent || binaryImage) {
      return;
    }
    let disposed = false;
    let view: EditorView | null = null;

    void codemirrorLanguageForPath(doc.path).then((language) => {
      if (disposed) return;
      setStatus("clean");
      setText(doc.newText);
      setPreview(false);
      lastSaved.current = null;
      view = new EditorView({
        parent,
        state: EditorState.create({
          doc: doc.newText,
          extensions: [
            basicSetup,
            lintGutter(),
            ...cmChromeForMode(themeMode),
            EditorView.lineWrapping,
            ...language,
            lspCompartment.current.of([]),
            EditorState.readOnly.of(!editable || isReadOnly),
            keymap.of([
              { key: "Mod-s", run: flushSave },
              ...(onGotoDefinition
                ? [{ key: "Mod-b", run: runGoto, preventDefault: true }]
                : []),
            ]),
            ...(onGotoDefinition
              ? [
                  EditorView.domEventHandlers({
                    mousedown(event, cv) {
                      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) {
                        return false;
                      }
                      event.preventDefault();
                      const pos = cv.posAtCoords({ x: event.clientX, y: event.clientY });
                      if (pos === null) {
                        return false;
                      }
                      cv.dispatch({ selection: { anchor: pos } });
                      runGoto();
                      return true;
                    },
                  }),
                ]
              : []),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) {
                return;
              }
              setStatus("unsaved");
              const next = u.state.doc.toString();
              setText(next);
              if (saveTimer.current) {
                clearTimeout(saveTimer.current);
              }
              saveTimer.current = setTimeout(() => {
                lastSaved.current = next;
                onSaveRef.current(next);
                setStatus("saved");
              }, 600);
            }),
          ],
        }),
      });
      viewRef.current = view;
      setEditorReady(true);
    });

    return () => {
      disposed = true;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      setEditorReady(false);
      view?.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, editable, binaryImage, isReadOnly, themeMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (doc.newText === lastSaved.current) {
      return;
    }
    if (status === "clean") {
      const current = view.state.doc.toString();
      if (current === doc.newText) {
        return;
      }
      view.dispatch({
        changes: { from: 0, insert: doc.newText, to: current.length },
      });
      setText(doc.newText);
      lastSaved.current = null;
    }
  }, [doc.newText, status]);

  // Attach a language server to the editor when one is available for this file.
  // Servers are shared per (workspace, language) and spawned lazily by the
  // daemon; disabled files (diffs/history) and the LSP-off toggle skip this.
  useEffect(() => {
    const language = lspLanguageForPath(doc.path);
    if (!editable || !editorReady || !lspEnabled || !language) {
      return;
    }
    let cancelled = false;
    let detach: (() => void) | null = null;
    void acquireLspClient(taskId, language).then((acquired) => {
      if (!acquired) {
        return;
      }
      const view = viewRef.current;
      if (cancelled || !view) {
        releaseLspClient(acquired.key);
        return;
      }
      const uri = `file://${acquired.rootPath}/${doc.path}`;
      view.dispatch({
        effects: lspCompartment.current.reconfigure(
          acquired.client.plugin(uri, language),
        ),
      });
      detach = () => {
        viewRef.current?.dispatch({ effects: lspCompartment.current.reconfigure([]) });
        releaseLspClient(acquired.key);
      };
    });
    return () => {
      cancelled = true;
      detach?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.path, editable, editorReady, lspEnabled, taskId]);

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
            {gotoResults.length > 0 && !showPreview && (
              <div className="absolute left-6 top-2 z-20 w-96 overflow-hidden rounded-md border bg-popover shadow-lg">
                <div className="border-b px-3 py-1.5 text-xs font-semibold">
                  Go to definition
                </div>
                <div className="max-h-64 overflow-y-auto py-1">
                  {gotoResults.map((hit, index) => (
                    <button
                      key={`${hit.path}:${hit.line}`}
                      type="button"
                      onMouseEnter={() => setGotoActive(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        pickGoto(index);
                      }}
                      className={cn(
                        "flex w-full items-baseline gap-2 px-3 py-1 text-left font-mono text-xs",
                        index === gotoActive
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground",
                      )}
                    >
                      <span className="shrink-0 text-muted-foreground">
                        {hit.path}:{hit.line}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{hit.text.trim()}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
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
