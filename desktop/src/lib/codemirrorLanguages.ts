import type { Extension } from "@codemirror/state";

/**
 * LSP language id for a path, or null when warpforge has no language server for
 * it. Ids match the daemon's server_command table (src/daemon/lsp.rs).
 */
export function lspLanguageForPath(path: string): string | null {
  const ext = path.split(/[\\/]/).pop()?.toLowerCase().split(".").pop();
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "typescript";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "py":
    case "pyi":
    case "pyw":
      return "python";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    default:
      return null;
  }
}

/** Exact document language id sent in `textDocument/didOpen`. React files need
 * their React-specific ids so TypeScript parses JSX instead of plain TS/JS. */
export function lspDocumentLanguageForPath(path: string): string | null {
  const ext = path.split(/[\\/]/).pop()?.toLowerCase().split(".").pop();
  switch (ext) {
    case "tsx":
      return "typescriptreact";
    case "jsx":
      return "javascriptreact";
    case "ts":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    default:
      return lspLanguageForPath(path);
  }
}

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
