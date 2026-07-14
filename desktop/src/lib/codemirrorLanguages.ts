import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";

export function codemirrorLanguageForPath(path: string): Extension[] {
  const filename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = filename.split(".").pop();

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
    case "pyi":
    case "pyw":
      return [python()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "md":
    case "markdown":
    case "mdx":
      return [markdown()];
    case "css":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    default:
      return [];
  }
}
