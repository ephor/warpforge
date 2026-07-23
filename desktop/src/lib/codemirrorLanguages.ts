import type { Extension } from "@codemirror/state";

export async function codemirrorLanguageForPath(path: string): Promise<Extension[]> {
  const filename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = filename.split(".").pop();

  switch (ext) {
    case "ts":
    case "tsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return [javascript({ jsx: true, typescript: true })];
    }
    case "js":
    case "jsx":
    case "mjs":
    case "cjs": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return [javascript({ jsx: true })];
    }
    case "rs": {
      const { rust } = await import("@codemirror/lang-rust");
      return [rust()];
    }
    case "go": {
      const { go } = await import("@codemirror/lang-go");
      return [go()];
    }
    case "json": {
      const [{ json, jsonParseLinter }, { linter }] = await Promise.all([
        import("@codemirror/lang-json"),
        import("@codemirror/lint"),
      ]);
      return [json(), linter(jsonParseLinter())];
    }
    case "pyi":
    case "pyw":
    case "py": {
      const { python } = await import("@codemirror/lang-python");
      return [python()];
    }
    case "yaml":
    case "yml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return [yaml()];
    }
    case "md":
    case "markdown":
    case "mdx": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return [markdown()];
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      return [css()];
    }
    case "html":
    case "htm": {
      const { html } = await import("@codemirror/lang-html");
      return [html()];
    }
    default:
      return [];
  }
}
