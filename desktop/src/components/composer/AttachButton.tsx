import { Paperclip } from "lucide-react";
import { memo } from "react";

import { Button } from "@/components/ui/button";

export const AttachButton = memo(function AttachButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-5 [&_svg]:size-3"
      disabled={disabled}
      title="Attach files (⌘⇧A)"
      onClick={onClick}
    >
      <Paperclip />
    </Button>
  );
});
