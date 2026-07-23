import {
  ArrowLeft,
  GitPullRequestArrow,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";

import type { RepositoryOperation } from "../../store/ui";

interface PrFooterProps {
  creatingPr: boolean;
  prTitle: string;
  prStep: "pushing" | "creating" | null;
  needsPush: boolean;
  repositoryOperation: RepositoryOperation | null;
  onBack: () => void;
  onCancel: () => void;
  onCreatePr: () => void;
}

export function PrFooter({
  creatingPr,
  prTitle,
  prStep,
  needsPush,
  repositoryOperation,
  onBack,
  onCancel,
  onCreatePr,
}: PrFooterProps) {
  return (
    <footer className="flex h-[72px] shrink-0 items-center border-t bg-card/50 px-5">
      <Button
        type="button"
        variant="ghost"
        disabled={creatingPr}
        onClick={onBack}
      >
        <ArrowLeft className="size-4" />
        Back
      </Button>
      <div className="ml-auto flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={creatingPr}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={creatingPr || !prTitle.trim() || Boolean(repositoryOperation)}
          onClick={onCreatePr}
        >
          {creatingPr ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <GitPullRequestArrow className="size-4" />
          )}
          {prStep === "pushing"
            ? "Pushing…"
            : prStep === "creating"
              ? "Creating PR…"
              : needsPush
                ? "Push & Create PR"
                : "Create Pull Request"}
        </Button>
      </div>
    </footer>
  );
}
