import { Loader2, Send, Square } from "lucide-react";
import { memo } from "react";

import { Button } from "@/components/ui/button";

export const ComposerActionButton = memo(function ComposerActionButton({
  action,
  disabled,
  sendActionRef,
  onStop,
  stopping,
}: {
  action: "send" | "stop";
  disabled: boolean;
  sendActionRef: React.RefObject<() => void>;
  onStop?: () => void;
  stopping: boolean;
}) {
  const stopAction = action === "stop";

  return (
    <Button
      type="button"
      size="icon"
      variant={stopAction ? "destructive" : "default"}
      aria-label={stopping ? "Stopping" : stopAction ? "Stop" : "Send"}
      className="size-6 shrink-0"
      onClick={stopAction ? onStop : () => sendActionRef.current?.()}
      disabled={disabled}
    >
      {stopping ? (
        <Loader2 className="size-3 animate-spin" />
      ) : stopAction ? (
        <Square className="size-3 fill-current" />
      ) : (
        <Send className="size-3" />
      )}
    </Button>
  );
});
