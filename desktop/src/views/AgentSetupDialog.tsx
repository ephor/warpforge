import { Bot } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import AgentSetupPanel from "../components/AgentSetupPanel";
import type { DetectedAgent } from "../protocol";

interface Props {
  detected: DetectedAgent[];
  onClose: () => void;
}

export default function AgentSetupDialog({ detected, onClose }: Props) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5" />
            Set up AI agents
          </DialogTitle>
          <DialogDescription>
            Select which agents to enable. Warpforge connects to them via ACP (Agent Client
            Protocol) over stdio.
          </DialogDescription>
        </DialogHeader>

        {/* The panel owns the save button; saving here also closes the dialog.
            Its rows are edge-to-edge with dividers, so they need the same card
            around them that a Settings section provides. */}
        <div className="overflow-hidden rounded-xl border border-border/80">
          <AgentSetupPanel detected={detected} onSaved={onClose} />
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Skip for now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
