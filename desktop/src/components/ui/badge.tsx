import { badgeVariants, type BadgeProps } from "@/lib/badgeVariants";
import { cn } from "@/lib/utils";

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge };
export type { BadgeProps };
