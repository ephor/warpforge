import { Maximize2, Minimize2 } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface FocusButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  focused: boolean;
  label: string;
}

export const FocusButton = React.forwardRef<HTMLButtonElement, FocusButtonProps>(
  ({ className, focused, label, ...props }, ref) => (
    <button
      ref={ref}
      {...props}
      type="button"
      aria-label={label}
      aria-pressed={focused}
      title={label}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50",
        focused && "bg-secondary text-primary",
        className,
      )}
    >
      {focused ? (
        <Minimize2 aria-hidden className="size-3.5" />
      ) : (
        <Maximize2 aria-hidden className="size-3.5" />
      )}
    </button>
  ),
);
FocusButton.displayName = "FocusButton";
