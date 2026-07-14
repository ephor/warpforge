import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-8 px-3 py-1",
        icon: "h-8 w-8",
        lg: "h-10 rounded-md px-6",
        sm: "h-7 rounded px-2 text-xs",
      },
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive/15 text-destructive hover:bg-destructive/25 border border-destructive/40",
        ghost: "hover:bg-secondary hover:text-secondary-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        outline:
          "border border-border bg-transparent hover:bg-secondary hover:text-secondary-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      },
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ className, size, variant }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
