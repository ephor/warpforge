import { ChevronDown, GitCommitVertical, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

interface CommitBoxProps {
  commitExpanded: boolean;
  setCommitExpanded: (v: boolean) => void;
  stagedSize: number;
  message: string;
  setMessage: (v: string) => void;
  amend: boolean;
  setAmend: (v: boolean) => void;
  busy: boolean;
  generating: boolean;
  error: string | null;
  canCommit: boolean;
  onCommit: () => void;
  onGenerate: () => void;
  textGenAgentId: string | null;
}

export function CommitBox({
  commitExpanded,
  setCommitExpanded,
  stagedSize,
  message,
  setMessage,
  amend,
  setAmend,
  busy,
  generating,
  error,
  canCommit,
  onCommit,
  onGenerate,
  textGenAgentId,
}: CommitBoxProps) {
  return (
    <div className="flex flex-col gap-2 border-t bg-background/30 p-2.5">
      {commitExpanded ? (
        <>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tnum">{stagedSize} selected</span>
            <button
              type="button"
              className="ml-auto rounded p-1 hover:bg-secondary hover:text-foreground"
              aria-label="Collapse commit form"
              onClick={() => setCommitExpanded(false)}
            >
              <ChevronDown className="size-3.5" />
            </button>
          </div>
          <div className="relative">
            <textarea
              autoFocus
              aria-label="Commit message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              rows={3}
              className="bg-deep-surface min-h-20 w-full resize-none rounded-md border py-1.5 pl-2 pr-9 text-xs outline-none placeholder:text-muted-foreground/80 focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              className="absolute bottom-1.5 right-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              disabled={generating || busy || !textGenAgentId}
              aria-label="Draft commit message"
              title={
                textGenAgentId
                  ? "Draft a commit message from the staged diff"
                  : "Pick a text-generation agent in Settings first"
              }
              onClick={onGenerate}
            >
              {generating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
            </button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={amend}
                onChange={(e) => setAmend(e.target.checked)}
                className="size-3 accent-primary"
              />
              amend
            </label>
            <Button
              type="button"
              size="sm"
              className="ml-auto h-7"
              disabled={!canCommit}
              onClick={onCommit}
            >
              <GitCommitVertical className="size-3.5" />
              {busy ? "…" : amend ? "Amend" : "Commit"}
            </Button>
          </div>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full justify-between"
          disabled={stagedSize === 0}
          onClick={() => setCommitExpanded(true)}
        >
          <span className="flex items-center gap-1.5">
            <GitCommitVertical className="size-3.5" />
            Commit…
          </span>
          <span className="tnum text-[10px] text-muted-foreground">{stagedSize} selected</span>
        </Button>
      )}
    </div>
  );
}
