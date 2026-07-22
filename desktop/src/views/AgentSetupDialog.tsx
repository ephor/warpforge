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

import type { DetectedAgent } from "../protocol";
import AgentSetupPanel from "../components/AgentSetupPanel";

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

        {/* The panel owns the save button; saving here also closes the dialog. */}
        <AgentSetupPanel detected={detected} onSaved={onClose} />

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Skip for now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
