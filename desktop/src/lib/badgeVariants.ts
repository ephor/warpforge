import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

export const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium transition-colors",
  {
    defaultVariants: { variant: "default" },
    variants: {
      variant: {
        default: "border-border bg-secondary text-secondary-foreground",
        destructive: "border-destructive/40 text-destructive bg-destructive/10",
        ok: "border-ok/40 text-ok bg-ok/10",
        outline: "border-border text-muted-foreground",
        warn: "border-warn/40 text-warn bg-warn/10",
      },
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}
