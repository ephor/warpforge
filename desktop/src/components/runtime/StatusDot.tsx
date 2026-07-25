import { cn } from "@/lib/utils";

export function StatusDot({ variant }: { variant: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        variant === "ok" && "bg-ok",
        variant === "warn" && "bg-warn",
        variant === "destructive" && "bg-destructive",
        variant !== "ok" &&
          variant !== "warn" &&
          variant !== "destructive" &&
          "bg-muted-foreground/50",
      )}
    />
  );
}
