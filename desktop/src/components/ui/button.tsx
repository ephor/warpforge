import { Slot } from "@radix-ui/react-slot";
import * as React from "react";

import { buttonVariants, type ButtonProps } from "@/lib/buttonVariants";
import { cn } from "@/lib/utils";

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ className, size, variant }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button };
export type { ButtonProps };
