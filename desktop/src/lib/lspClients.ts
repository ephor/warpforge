/**
 * Shared LSP client registry. One `LSPClient` per (task workspace, language),
 * reference-counted across every editor that opens a file of that language.
 * The client talks to the daemon over a `Transport` that tunnels JSON-RPC as
 * `lsp.send` requests and `lsp.message` events — the daemon owns the actual
 * language-server process (spawned lazily, killed once the last editor closes).
 */
import { setDiagnostics } from "@codemirror/lint";
import {
  languageServerExtensions,
  LSPClient,
  LSPPlugin,
  type LSPClientExtension,
  type Transport,
} from "@codemirror/lsp-client";
import { ViewPlugin, type EditorView } from "@codemirror/view";

import { daemon } from "../daemon";
import type { LspStartResult } from "../protocol";

type Resolved = {
  client: LSPClient;
  rootPath: string;
  dispose: () => void;
};

type Entry = {
  refs: number;
  ready: Promise<Resolved | null>;
};

const entries = new Map<string, Entry>();

type PullDiagnostic = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number;
};

type PullDiagnosticReport = {
  kind: "full" | "unchanged";
  items?: PullDiagnostic[];
};

function pullDiagnostics(view: EditorView) {
  const plugin = LSPPlugin.get(view);
  if (!plugin) {
    return;
  }
  plugin.client.sync();
  void plugin.client
    .request<{ textDocument: { uri: string } }, PullDiagnosticReport>("textDocument/diagnostic", {
      textDocument: { uri: plugin.uri },
    })
    .then((report) => {
      const current = LSPPlugin.get(view);
      if (!current || report.kind !== "full") {
        return;
      }
      const diagnostics = (report.items ?? []).map((item) => ({
        from: current.unsyncedChanges.mapPos(
          current.fromPosition(item.range.start, current.syncedDoc),
        ),
        to: current.unsyncedChanges.mapPos(current.fromPosition(item.range.end, current.syncedDoc)),
        severity:
          item.severity === 2
            ? ("warning" as const)
            : item.severity === 3
              ? ("info" as const)
              : item.severity === 4
                ? ("hint" as const)
                : ("error" as const),
        message: item.message,
      }));
      view.dispatch(setDiagnostics(view.state, diagnostics));
    })
    .catch(() => {
      // The server may be warming up or shutting down; next edit retries.
    });
}

const pullDiagnosticsExtension: LSPClientExtension = {
  clientCapabilities: {
    textDocument: {
      diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    },
  },
  editorExtension: ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(private readonly view: EditorView) {
        this.schedule(0);
      }

      update(update: { docChanged: boolean }) {
        if (update.docChanged) {
          this.schedule(500);
        }
      }

      destroy() {
        if (this.timer) {
          clearTimeout(this.timer);
        }
      }

      private schedule(delay: number) {
        if (this.timer) {
          clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
          this.timer = null;
          pullDiagnostics(this.view);
        }, delay);
      }
    },
  ),
};

async function startClient(taskId: string, language: string): Promise<Resolved | null> {
  const res = (await daemon
    .request("lsp.start", { language, task_id: taskId })
    .catch(() => null)) as LspStartResult | null;
  if (!res?.available || !res.serverId) {
    return null;
  }
  const serverId = res.serverId;

  const handlers = new Set<(value: string) => void>();
  const unsubscribe = daemon.subscribeEvents((ev) => {
    if (ev.event === "lsp.message" && ev.data.server_id === serverId) {
      const text = JSON.stringify(ev.data.payload);
      handlers.forEach((handler) => handler(text));
    }
  });

  const transport: Transport = {
    send(message) {
      void daemon.request("lsp.send", { payload: JSON.parse(message), server_id: serverId });
    },
    subscribe(handler) {
      handlers.add(handler);
    },
    unsubscribe(handler) {
      handlers.delete(handler);
    },
  };

  const client = new LSPClient({
    extensions: [...languageServerExtensions(), pullDiagnosticsExtension],
    rootUri: `file://${res.rootPath}`,
    // rust-analyzer may need more than the package default of three seconds
    // while it is warming a workspace for the first time.
    timeout: 15_000,
  });
  client.connect(transport);

  const dispose = () => {
    unsubscribe();
    try {
      client.disconnect();
    } catch {
      // client may already be torn down
    }
    void daemon.request("lsp.stop", { server_id: serverId }).catch(() => {});
  };

  return { client, dispose, rootPath: res.rootPath };
}

/** Acquire a shared client; returns null when no server is available. */
export async function acquireLspClient(
  taskId: string,
  language: string,
): Promise<{ key: string; client: LSPClient; rootPath: string } | null> {
  const key = `${taskId}:${language}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = { ready: startClient(taskId, language), refs: 0 };
    entries.set(key, entry);
  }
  entry.refs += 1;
  const resolved = await entry.ready;
  if (!resolved) {
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entries.delete(key);
    }
    return null;
  }
  return { client: resolved.client, key, rootPath: resolved.rootPath };
}

/** Release a reference; the process is killed once the last editor closes. */
export function releaseLspClient(key: string): void {
  const entry = entries.get(key);
  if (!entry) {
    return;
  }
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entries.delete(key);
    void entry.ready.then((resolved) => resolved?.dispose());
  }
}
