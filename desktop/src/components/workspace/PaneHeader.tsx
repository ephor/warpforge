import type { LucideIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface PaneHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
}

export const PaneHeader = React.forwardRef<HTMLElement, PaneHeaderProps>(
  ({ actions, className, icon: Icon, subtitle, title, ...props }, ref) => (
    <header
      ref={ref}
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 border-b border-border/70 bg-card/95 px-3",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {Icon && <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-xs font-semibold text-foreground">{title}</h2>
          {subtitle != null && (
            <span className="truncate text-[11px] text-muted-foreground">{subtitle}</span>
          )}
        </div>
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  ),
);
PaneHeader.displayName = "PaneHeader";
