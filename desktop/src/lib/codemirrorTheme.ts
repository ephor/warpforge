import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { appSyntaxHighlighting } from "./codemirrorSyntax";

/**
 * CodeMirror chrome that follows the app theme exactly. The editor's host
 * surfaces are themed via hsl(var(--...)) CSS variables on `:root`, so color
 * values here are runtime-resolved and automatically match whichever theme the
 * user has selected — no rebuild needed on theme switch.
 *
 * The one thing this does NOT drive is syntax highlighting: on dark themes the
 * editor lets `oneDark` own the highlight palette, and on light themes it falls
 * back to CodeMirror's built-in light `defaultHighlightStyle` (which
 * `basicSetup` already installs). Picking the right set also flips CodeMirror's
 * internal `light`/`dark` parent class, which is what merge additions clamp onto
 * for their `&light`/`&dark` styling.
 */
export function appChromeTheme(_mode: "light" | "dark") {
  return EditorView.theme({
    "&": {
      color: "hsl(var(--foreground))",
      backgroundColor: "transparent",
    },
    ".cm-content": {
      caretColor: "hsl(var(--ring))",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "hsl(var(--ring))",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "hsl(var(--muted-foreground))",
      borderRight: "1px solid hsl(var(--border))",
    },
    ".warpforge-code-editor .cm-lineNumbers": {
      minWidth: "26px",
    },
    ".warpforge-code-editor .cm-lineNumbers .cm-gutterElement": {
      padding: "0 4px 0 2px",
      textAlign: "right",
    },
    // Collapsed-chunk margin fix (globals.css) now keeps line numbers aligned
    // with content, so the gutter bar needs no vertical transform.
    ".cm-changedLineGutter": {
      transform: "translateY(0px)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "hsl(var(--muted) / 0.7)",
      color: "hsl(var(--foreground))",
    },
    ".cm-activeLine": {
      backgroundColor: "hsl(var(--muted) / 0.45)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "hsl(var(--accent))",
      color: "hsl(var(--accent-foreground))",
      border: "none",
    },
  });
}

/** Editor chrome + syntax set for the app theme. Both modes use the theme's
 * own `--syntax-*` tokens, so dark editor text tracks the Forge/Old-Money
 * palettes just like light ones do. (oneDark was the only shipped highlight —
 * dropping it lets every theme own its editor colors.) */
export function cmChromeForMode(mode: "light" | "dark"): Extension[] {
  return [appChromeTheme(mode), appSyntaxHighlighting];
}
