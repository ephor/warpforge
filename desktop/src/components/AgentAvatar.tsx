import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { agentDisplayName } from "@/lib/agentNames";
import { cn } from "@/lib/utils";

import { AgentLogo } from "./AgentLogo";

export function AgentAvatar({ agentId, className }: { agentId: string; className?: string }) {
  const name = agentDisplayName(agentId);
  return (
    <Avatar className={cn("size-4 ring-1 ring-background", className)} title={name}>
      <AvatarFallback className="rounded-sm">
        <AgentLogo agentId={agentId} displayName={name} className="size-3.5" />
      </AvatarFallback>
    </Avatar>
  );
}

export function AgentAvatarGroup({
  agentId,
  childAgents,
}: {
  agentId: string;
  childAgents?: string[];
}) {
  if (!childAgents || childAgents.length === 0) {
    return <AgentAvatar agentId={agentId} />;
  }
  const others = childAgents.filter((a) => a !== agentId);
  return (
    <div className="-ml-1 flex items-center">
      <AgentAvatar agentId={agentId} />
      {others.slice(0, 3).map((id) => (
        <AgentAvatar key={id} agentId={id} className="-ml-0.5" />
      ))}
      {others.length > 3 && (
        <span className="-ml-0.5 flex size-4 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground ring-1 ring-background">
          +{others.length - 3}
        </span>
      )}
    </div>
  );
}
