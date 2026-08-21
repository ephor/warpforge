import { lintGutter } from "@codemirror/lint";
import { jumpToDefinition } from "@codemirror/lsp-client";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { Check, Code, Eye, Loader2, Save, Wand2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useThemeMode } from "@/hooks/useTheme";
import {
  codemirrorLanguageForPath,
  lspDocumentLanguageForPath,
  lspLanguageForPath,
} from "@/lib/codemirrorLanguages";
import { cmChromeForMode } from "@/lib/codemirrorTheme";
import { acquireLspClient, releaseLspClient } from "@/lib/lspClients";
import { cn } from "@/lib/utils";

import { daemon } from "../daemon";
import type { FileDoc, FileRange, SymbolMatch } from "../protocol";
import { useUi } from "../store/ui";
import { Markdown } from "./Markdown";

type SaveStatus = "clean" | "unsaved" | "saved";

const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
const isHtmlPath = (path: string) => /\.html?$/i.test(path);
const LSP_LABELS: Record<string, string> = {
  typescript: "TypeScript/JavaScript",
  rust: "Rust",
  go: "Go",
  python: "Python",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  yaml: "YAML",
};
const isSvgPath = (path: string) => /\.svg$/i.test(path);
const isBinaryImagePath = (path: string) => /\.(png|jpg|jpeg|gif|webp|ico|bmp)$/i.test(path);
// Guard for SSR/test (navigator may be undefined).
const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
const SEND_TO_CHAT_HINT = IS_MAC ? "⌘L" : "Ctrl L";

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
  gotoLocation,
  onGotoLocationHandled,
  onAskFile,
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
  /** Move the editor to a pending 1-based source location after it loads. */
  gotoLocation?: { line: number; column: number };
  onGotoLocationHandled?: () => void;
  /** When provided, a floating "Send to chat" action appears over text
   * selections that sends the highlighted line range to the task chat as a
   * file reference. */
  onAskFile?: (path: string, range: FileRange) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lspCompartment = useRef(new Compartment());
  const gotoLocationKey = useRef<string | null>(null);
  const lastSaved = useRef<string | null>(null);
  const onSaveRef = useRef(onSave);
  const onGotoRef = useRef(onGotoDefinition);
  const onOpenSymbolRef = useRef(onOpenSymbol);
  const onAskFileRef = useRef(onAskFile);
  const lspEnabled = useUi((s) => s.lspEnabled);
  const [status, setStatus] = useState<SaveStatus>("clean");
  const [preview, setPreview] = useState(false);
  const [text, setText] = useState(doc.newText);
  const [editorReady, setEditorReady] = useState(false);
  const [lspMissing, setLspMissing] = useState<string | null>(null);
  const [lspInstallBusy, setLspInstallBusy] = useState(false);
  const [lspRetry, setLspRetry] = useState(0);
  const [gotoResults, setGotoResults] = useState<SymbolMatch[]>([]);
  const [gotoActive, setGotoActive] = useState(0);
  const [gotoPending, setGotoPending] = useState(false);
  const [gotoQuery, setGotoQuery] = useState("");
  const [selectionMenu, setSelectionMenu] = useState<{
    from: number;
    to: number;
    x: number;
    y: number;
  } | null>(null);
  const markdown = isMarkdownPath(doc.path);
  const htmlDoc = isHtmlPath(doc.path);
  const svgImage = isSvgPath(doc.path);
  const binaryImage = isBinaryImagePath(doc.path);
  const themeMode = useThemeMode();
  const showPreview = (markdown || htmlDoc || svgImage) && preview;
  const previewText = text;
  const isReadOnly = binaryImage || svgImage;

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);
  useEffect(() => {
    onGotoRef.current = onGotoDefinition;
    onOpenSymbolRef.current = onOpenSymbol;
    onAskFileRef.current = onAskFile;
  }, [onGotoDefinition, onOpenSymbol, onAskFile]);

  const flushSave = () => {
    const view = viewRef.current;
    if (!view) {
      return true;
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
    if (!view) {
      return false;
    }
    if (jumpToDefinition(view)) {
      setGotoResults([]);
      setGotoPending(false);
      setGotoQuery("");
      return true;
    }
    if (!save) {
      return false;
    }
    const head = view.state.selection.main.head;
    const word = view.state.wordAt(head) ?? (head > 0 ? view.state.wordAt(head - 1) : null);
    if (!word) {
      return false;
    }
    const query = view.state.sliceDoc(word.from, word.to).trim();
    if (!query) {
      return false;
    }
    setGotoResults([]);
    setGotoQuery(query);
    setGotoPending(true);
    void save(query)
      .then((results) => {
        setGotoPending(false);
        if (!results.length) {
          return;
        }
        setGotoResults(results.slice(0, 12));
        setGotoActive(0);
      })
      .catch(() => {
        setGotoPending(false);
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
      setGotoQuery("");
      open?.(hit.path, hit.line, hit.column);
    },
    [gotoResults],
  );

  const updateSelectionMenu = useCallback(() => {
    const view = viewRef.current;
    if (!view || !onAskFileRef.current || markdown || svgImage || binaryImage) {
      setSelectionMenu(null);
      return;
    }
    const sel = view.state.selection.main;
    if (sel.empty) {
      setSelectionMenu(null);
      return;
    }
    const from = Math.min(sel.from, sel.to);
    const to = Math.max(sel.from, sel.to);
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    if (!start) {
      setSelectionMenu(null);
      return;
    }
    // Place the action relative to the host container, since the button is
    // absolutely positioned inside it and coordsAtPos is viewport-relative.
    const hostRect = host.current?.getBoundingClientRect();
    const x = hostRect ? start.left - hostRect.left : start.left;
    // Single-line selections: sit below the line (above overlaps the row of
    // text the button is describing). Multi-line: float above the first line.
    const singleLine = !!end && Math.abs(end.top - start.top) < 1;
    const lineHeight = start.bottom - start.top;
    const y = hostRect
      ? singleLine
        ? start.top - hostRect.top + lineHeight + 10
        : start.top - hostRect.top - 8
      : start.top + (singleLine ? lineHeight + 10 : -8);
    setSelectionMenu({ from, to, x, y });
  }, [binaryImage, markdown, svgImage]);

  const askSelection = useCallback(() => {
    const view = viewRef.current;
    const ask = onAskFileRef.current;
    if (!view || !ask || !selectionMenu) {
      return;
    }
    const docText = view.state.doc;
    setSelectionMenu(null);
    ask(doc.path, {
      start: docText.lineAt(selectionMenu.from).number,
      end: docText.lineAt(selectionMenu.to).number,
    });
  }, [doc.path, selectionMenu]);

  // CodeMirror consumes mouse/key events; React handlers on the host wrapper
  // never see mouseup/keyup. Keep the latest updater in a ref the editor's own
  // dom-event extension can invoke while the view is mounted.
  const updateSelectionMenuRef = useRef(updateSelectionMenu);
  useEffect(() => {
    updateSelectionMenuRef.current = updateSelectionMenu;
  }, [updateSelectionMenu]);

  const askSelectionRef = useRef(askSelection);
  useEffect(() => {
    askSelectionRef.current = askSelection;
  }, [askSelection]);

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
              ...(onGotoDefinition ? [{ key: "Mod-b", run: runGoto, preventDefault: true }] : []),
              ...(onAskFile
                ? [
                    {
                      key: "Mod-l",
                      run: () => {
                        askSelectionRef.current();
                        return true;
                      },
                      preventDefault: true,
                    },
                  ]
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
            ...(onAskFile
              ? [
                  EditorView.domEventHandlers({
                    mouseup: () => {
                      updateSelectionMenuRef.current();
                      return false;
                    },
                    keyup: () => {
                      updateSelectionMenuRef.current();
                      return false;
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
            }),
          ],
        }),
      });
      viewRef.current = view;
      setEditorReady(true);
    });

    return () => {
      disposed = true;
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
    const documentLanguage = lspDocumentLanguageForPath(doc.path);
    if (!editable || !editorReady || !lspEnabled || !language || !documentLanguage) {
      setLspMissing(null);
      return;
    }
    let cancelled = false;
    let detach: (() => void) | null = null;
    void acquireLspClient(taskId, language).then((acquired) => {
      if (!acquired) {
        if (!cancelled) setLspMissing(language);
        return;
      }
      const view = viewRef.current;
      if (cancelled || !view) {
        releaseLspClient(acquired.key);
        return;
      }
      setLspMissing(null);
      const uri = `file://${acquired.rootPath}/${doc.path}`;
      view.dispatch({
        effects: lspCompartment.current.reconfigure(acquired.client.plugin(uri, documentLanguage)),
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
  }, [doc.path, editable, editorReady, lspEnabled, taskId, lspRetry]);

  const installLsp = async () => {
    if (!lspMissing) return;
    setLspInstallBusy(true);
    try {
      await daemon.installLanguageServer(lspMissing);
    } finally {
      setLspInstallBusy(false);
    }
    setLspMissing(null);
    setLspRetry((n) => n + 1);
  };

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !editorReady || !gotoLocation) {
      if (!gotoLocation) {
        gotoLocationKey.current = null;
      }
      return;
    }
    const key = `${gotoLocation.line}:${gotoLocation.column}`;
    if (gotoLocationKey.current === key) {
      return;
    }
    const lineNumber = Math.min(Math.max(gotoLocation.line, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    const column = Math.min(Math.max(gotoLocation.column - 1, 0), line.length);
    view.dispatch({
      selection: { anchor: line.from + column },
      // Centered, not merely "in view": a plain scrollIntoView stops as soon as
      // the line touches an edge, leaving the jump target glued to the bottom
      // with no context under it.
      effects: EditorView.scrollIntoView(line.from + column, { y: "center" }),
      userEvent: "select.goto",
    });
    // Without focus the caret sits at the target invisibly and the first
    // keystroke goes nowhere — a jump from search should land ready to type.
    view.focus();
    gotoLocationKey.current = key;
    onGotoLocationHandled?.();
  }, [editorReady, gotoLocation, onGotoLocationHandled]);

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
        {(markdown || htmlDoc || svgImage) && (
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
      {lspMissing && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-warn/10 px-3 py-1.5 text-[11px]">
          <Wand2 className="size-3 shrink-0 text-warn" />
          <span className="min-w-0 flex-1 text-muted-foreground">
            {LSP_LABELS[lspMissing] ?? lspMissing} IntelliSense isn&apos;t installed
          </span>
          <button
            type="button"
            onClick={() => void installLsp()}
            disabled={lspInstallBusy}
            className="flex shrink-0 items-center gap-1 rounded bg-foreground/90 px-2 py-0.5 font-medium text-background transition-colors hover:bg-foreground disabled:opacity-50"
          >
            {lspInstallBusy && <Loader2 className="size-3 animate-spin" />}
            {lspInstallBusy ? "Installing…" : "Install"}
          </button>
        </div>
      )}
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
              onMouseUp={updateSelectionMenu}
              onKeyUp={updateSelectionMenu}
            />
            {(gotoResults.length > 0 || gotoPending || (gotoQuery && !gotoPending)) &&
              !showPreview && (
                <div className="absolute left-6 top-2 z-20 w-96 overflow-hidden rounded-md border bg-popover shadow-lg">
                  <div className="border-b px-3 py-1.5 text-xs font-semibold">Go to definition</div>
                  {gotoPending ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      Searching for {gotoQuery}…
                    </div>
                  ) : gotoResults.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      No definition found for {gotoQuery}
                    </div>
                  ) : (
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
                  )}
                </div>
              )}
            {selectionMenu && !showPreview && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={askSelection}
                className="absolute z-20 flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-xs font-medium text-foreground shadow-lg hover:bg-accent hover:text-accent-foreground"
                style={{ left: selectionMenu.x, top: selectionMenu.y }}
              >
                Send to chat
                <kbd className="rounded-sm border border-border bg-muted px-1 font-mono text-[10px] leading-4 text-muted-foreground">
                  {SEND_TO_CHAT_HINT}
                </kbd>
              </button>
            )}
            {showPreview && (
              <div className="h-full overflow-auto px-4 py-3">
                {htmlDoc ? (
                  <iframe
                    title={doc.path}
                    srcDoc={previewText}
                    sandbox=""
                    className="h-full w-full border-0 bg-white"
                  />
                ) : svgImage ? (
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
