import { ArrowRight, GitBranch, Loader2, Sparkles } from "lucide-react";

import type { GitPushInfo } from "../../protocol";

interface PrFormProps {
  info: GitPushInfo | null;
  needsPush: boolean;
  prTitle: string;
  setPrTitle: (v: string) => void;
  prBody: string;
  setPrBody: (v: string) => void;
  prBase: string;
  setPrBase: (v: string) => void;
  generatingPr: boolean;
  textGenAgentId: string | null;
  onGenerate: () => void;
}

export function PrForm({
  info,
  needsPush,
  prTitle,
  setPrTitle,
  prBody,
  setPrBody,
  prBase,
  setPrBase,
  generatingPr,
  textGenAgentId,
  onGenerate,
}: PrFormProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
      <div className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
        <GitBranch className="size-4 shrink-0 text-primary" />
        <span className="truncate text-foreground">{info?.branch}</span>
        <ArrowRight className="size-4 shrink-0" />
        <span className="truncate">{prBase.trim() || "default branch"}</span>
      </div>
      {needsPush && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {info && info.commits.length > 0
            ? `${info.commits.length} ${info.commits.length === 1 ? "commit" : "commits"} will be pushed to ${info.upstream} first, then the PR is opened.`
            : "The branch will be pushed first, then the PR is opened."}
        </p>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Title</span>
        <input
          value={prTitle}
          onChange={(e) => setPrTitle(e.target.value)}
          placeholder="Pull request title"
          className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
      </label>
      <label className="flex min-h-0 flex-1 flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Description</span>
        <div className="relative flex min-h-0 flex-1">
          <textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            placeholder="Optional — Markdown supported"
            className="min-h-32 flex-1 resize-none rounded-md border bg-background py-2 pl-3 pr-10 font-mono text-sm outline-none focus:border-primary"
          />
          <button
            type="button"
            className="absolute bottom-2 right-2 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            disabled={generatingPr || !textGenAgentId}
            aria-label="Draft pull request title and description"
            title={
              textGenAgentId
                ? "Draft the title and description from the outgoing commits"
                : "Pick a text-generation agent in Settings first"
            }
            onClick={onGenerate}
          >
            {generatingPr ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
          </button>
        </div>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Base branch <span className="text-muted-foreground/60">(optional)</span>
        </span>
        <input
          value={prBase}
          onChange={(e) => setPrBase(e.target.value)}
          placeholder="repo default"
          className="rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
        />
      </label>
    </div>
  );
}
