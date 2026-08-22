import "@xterm/xterm/css/xterm.css"; // oxlint-disable-line import/no-unassigned-import
import { AlertCircle, Plus, RefreshCw, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

import type { TerminalController } from "../../lib/terminalController";
import type { TerminalEntry } from "../../lib/terminalWorkspace";
import { getTerminalWorkspace } from "../../lib/terminalWorkspace";

interface Props {
  project: string;
}

export const TerminalWorkspaceView = memo(function TerminalWorkspaceView({ project }: Props) {
  const workspace = getTerminalWorkspace(project);

  const terminals = useSyncExternalStore(
    workspace.subscribe,
    () => workspace.getTerminals(),
    () => workspace.getTerminals(),
  );
  const activeId = useSyncExternalStore(
    workspace.subscribe,
    () => workspace.getActiveId(),
    () => workspace.getActiveId(),
  );
  const spawnError = useSyncExternalStore(
    workspace.subscribe,
    () => workspace.getSpawnError(),
    () => workspace.getSpawnError(),
  );

  const handleNew = useCallback(() => {
    void workspace.spawn();
  }, [workspace]);

  const handleRetry = useCallback(() => {
    void workspace.spawn();
  }, [workspace]);

  if (terminals.length === 0) {
    return <TerminalEmptyState onNew={handleNew} error={spawnError} onRetry={handleRetry} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TerminalTabBar
        terminals={terminals}
        activeId={activeId}
        onSelect={(id) => workspace.setActive(id)}
        onClose={(id) => workspace.close(id)}
        onRemove={(id) => workspace.remove(id)}
        onRestart={(id) => void workspace.restart(id)}
        onNew={handleNew}
      />
      <div className="relative min-h-0 flex-1">
        {terminals.map((entry) => (
          <TerminalPane
            key={entry.terminalId}
            terminalId={entry.terminalId}
            controller={entry.controller}
            visible={entry.terminalId === activeId}
            onRestart={() => void workspace.restart(entry.terminalId)}
            onRetryClose={() => workspace.close(entry.terminalId)}
          />
        ))}
      </div>
    </div>
  );
});

function TerminalEmptyState({
  onNew,
  error,
  onRetry,
}: {
  onNew: () => void;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Interactive terminal</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Start a shell session managed by the daemon.
        </p>
      </div>
      {error ? (
        <div className="flex flex-col items-center gap-2">
          <div role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3.5" />
            {error}
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-secondary/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <RefreshCw className="size-3.5" />
            Retry
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onNew}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-secondary/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          aria-label="Start terminal"
        >
          <Plus className="size-3.5" />
          Start terminal
        </button>
      )}
    </div>
  );
}

const TerminalTabBar = memo(function TerminalTabBar({
  terminals,
  activeId,
  onSelect,
  onClose,
  onRemove,
  onRestart,
  onNew,
}: {
  terminals: TerminalEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRemove: (id: string) => void;
  onRestart: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 bg-background/25 px-1.5">
      {terminals.map((entry) => (
        <TerminalTab
          key={entry.terminalId}
          terminalId={entry.terminalId}
          label={entry.label}
          controller={entry.controller}
          active={entry.terminalId === activeId}
          onSelect={() => onSelect(entry.terminalId)}
          onClose={() => onClose(entry.terminalId)}
          onRemove={() => onRemove(entry.terminalId)}
          onRestart={() => onRestart(entry.terminalId)}
        />
      ))}
      <button
        type="button"
        onClick={onNew}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        aria-label="New terminal"
        title="New terminal"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
});

const TerminalTab = memo(function TerminalTab({
  terminalId: _terminalId,
  label,
  controller,
  active,
  onSelect,
  onClose,
  onRemove,
  onRestart,
}: {
  terminalId: string;
  label: string;
  controller: TerminalController;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRemove: () => void;
  onRestart: () => void;
}) {
  const lifecycle = useControllerLifecycle(controller);
  const error = controller.getError();

  return (
    <div
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] transition-colors",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 truncate text-left"
        aria-label={label}
        aria-pressed={active}
      >
        <span>{label}</span>
        {lifecycle === "closing" && <span className="ml-1 text-muted-foreground/60">closing</span>}
        {lifecycle === "starting" && (
          <span className="ml-1 text-muted-foreground/60">starting</span>
        )}
      </button>
      {lifecycle === "closing" ? null : lifecycle === "exited" ? (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRestart();
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-secondary/40 hover:text-foreground"
            aria-label={`Restart ${label}`}
            title="Restart"
          >
            <RefreshCw className="size-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-destructive/20 hover:text-destructive"
            aria-label={`Remove ${label}`}
            title={`Remove ${label}`}
          >
            <X className="size-3" />
          </button>
        </>
      ) : lifecycle === "error" ? (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-secondary/40 hover:text-foreground"
            aria-label={`Retry ${label}`}
            title="Retry"
          >
            <RefreshCw className="size-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded text-destructive/80 transition-colors hover:bg-destructive/20 hover:text-destructive"
            aria-label={`Dismiss ${label}${error ? `: ${error}` : ""}`}
            title={error ?? "Error"}
          >
            <X className="size-3" />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-destructive/20 hover:text-destructive"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
});

function useControllerLifecycle(controller: TerminalController): string {
  return useSyncExternalStore(
    (cb: () => void) => controller.subscribeLifecycle(cb),
    () => controller.getLifecycle(),
    () => controller.getLifecycle(),
  );
}

const TerminalPane = memo(function TerminalPane({
  terminalId,
  controller,
  visible,
  onRestart,
  onRetryClose,
}: {
  terminalId: string;
  controller: TerminalController;
  visible: boolean;
  onRestart: () => void;
  onRetryClose: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);

  const lifecycle = useControllerLifecycle(controller);
  const error = controller.getError();

  useLayoutEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    controller.attach(host, visible);
    return () => controller.detach(host);
  }, [visible, controller]);

  useEffect(() => {
    if (!visible) return;
    const el = mountRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (visible) controller.fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible, controller]);

  const showOverlay =
    lifecycle === "starting" ||
    lifecycle === "closing" ||
    lifecycle === "disconnected" ||
    lifecycle === "exited" ||
    lifecycle === "error";

  return (
    <div
      className="absolute inset-0 p-2"
      style={{ display: visible ? "block" : "none" }}
      data-terminal-id={terminalId}
      data-testid={terminalId}
      aria-hidden={!visible}
    >
      <div ref={mountRef} className="h-full w-full min-h-0 min-w-0" />
      {showOverlay && visible && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-2 text-center">
            {lifecycle === "starting" && (
              <p className="text-xs text-muted-foreground">Starting terminal…</p>
            )}
            {lifecycle === "closing" && (
              <p className="text-xs text-muted-foreground">Closing terminal…</p>
            )}
            {lifecycle === "disconnected" && (
              <p className="text-xs text-muted-foreground">Daemon disconnected</p>
            )}
            {lifecycle === "exited" && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-muted-foreground">Terminal exited</p>
                <button
                  type="button"
                  onClick={onRestart}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-secondary/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
                >
                  <RefreshCw className="size-3.5" />
                  Restart
                </button>
              </div>
            )}
            {lifecycle === "error" && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-destructive">{error ?? "Terminal error"}</p>
                <button
                  type="button"
                  onClick={onRetryClose}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-secondary/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
                >
                  <RefreshCw className="size-3.5" />
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
