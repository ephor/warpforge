import { useState } from "react";

import { cn } from "@/lib/utils";

import claudeLogo from "../assets/app-logos/claude-ai-icon.svg?no-inline";
import codexLogo from "../assets/app-logos/codex_dark.svg?no-inline";
import opencodeLogo from "../assets/app-logos/opencode-dark.svg?no-inline";
import qwenLogo from "../assets/app-logos/qwen_dark.svg?no-inline";

const AGENT_SVGS: Record<string, string> = {
  claude: claudeLogo,
  codex: codexLogo,
  opencode: opencodeLogo,
  qwen: qwenLogo,
};

const AGENT_COLORS: Record<string, string> = {
  claude: "#d97706",
  codex: "#10b981",
  opencode: "#607d8b",
  qwen: "#7c3aed",
  goose: "#f59e0b",
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function AgentLogo({
  agentId,
  displayName,
  className,
}: {
  agentId: string;
  displayName: string;
  className?: string;
}) {
  const svg = AGENT_SVGS[agentId];
  const [failedSvg, setFailedSvg] = useState<string | null>(null);
  if (svg && failedSvg !== svg) {
    return (
      <img
        src={svg}
        alt=""
        className={cn("size-4 shrink-0 rounded-sm object-contain", className)}
        aria-hidden
        onError={() => setFailedSvg(svg)}
      />
    );
  }
  const color = AGENT_COLORS[agentId] ?? "#6b7280";
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm",
        className,
      )}
      style={{ backgroundColor: color }}
      aria-hidden
    >
      <span className="text-[8px] font-bold leading-none text-white">{initials(displayName)}</span>
    </span>
  );
}
