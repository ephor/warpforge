import { cn } from "@/lib/utils";

import { AgentLogo, agentDisplayName } from "./AgentLogo";

type BadgeSize = "xs" | "sm" | "md";

const SIZE_TEXT: Record<BadgeSize, string> = {
  xs: "gap-1 text-[11px]",
  sm: "gap-1.5 text-xs",
  md: "gap-1.5 text-sm",
};

const SIZE_ICON: Record<BadgeSize, string> = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
};

/**
 * The one way to show an agent identity anywhere in the UI: company logo plus
 * the proper display name ("Claude Code", "Codex"), never case-transformed —
 * the badge resets `uppercase`/`tracking` inherited from header-styled rows.
 *
 * - `plain` (default) inherits the surrounding text color, for meta rows.
 * - `chip` draws a subtle pill, for standalone placement (lists, pickers).
 */
export function AgentBadge({
  agentId,
  displayName,
  size = "sm",
  variant = "plain",
  className,
}: {
  agentId: string;
  /** Override from an AgentConfig when at hand; otherwise the built-in registry name is used. */
  displayName?: string;
  size?: BadgeSize;
  variant?: "plain" | "chip";
  className?: string;
}) {
  const name = agentDisplayName(agentId, displayName);
  return (
    <span
      title={name}
      className={cn(
        "inline-flex min-w-0 items-center normal-case tracking-normal",
        SIZE_TEXT[size],
        variant === "chip" &&
          "shrink-0 rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-secondary-foreground",
        className,
      )}
    >
      <AgentLogo agentId={agentId} displayName={name} className={SIZE_ICON[size]} />
      <span className="truncate">{name}</span>
    </span>
  );
}
