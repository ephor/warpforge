import { useState } from "react";

import { useThemeMode } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

import claudeLogo from "../assets/app-logos/claude-ai-icon.svg?no-inline";
import codexDark from "../assets/app-logos/codex_dark.svg?no-inline";
import codexLight from "../assets/app-logos/codex_light.svg?no-inline";
import cursorDark from "../assets/app-logos/cursor_dark.svg?no-inline";
import cursorLight from "../assets/app-logos/cursor_light.svg?no-inline";
import gooseDark from "../assets/app-logos/goose_dark.png";
import gooseLight from "../assets/app-logos/goose_light.png";
import junieLogo from "../assets/app-logos/junie.svg?no-inline";
import opencodeDark from "../assets/app-logos/openCode_dark.svg?no-inline";
import opencodeLight from "../assets/app-logos/openCode_light.svg?no-inline";
import piDark from "../assets/app-logos/pi_dark.svg?no-inline";
import piLight from "../assets/app-logos/pi_light.svg?no-inline";
import qwenDark from "../assets/app-logos/qwen_dark.svg?no-inline";
import qwenLight from "../assets/app-logos/qwen_light.svg?no-inline";

/**
 * Per-agent logo assets, as {dark, light} pairs. These SVGs ship with baked-in
 * colors — a logo that pops on dark vanishes on light — so each agent carries
 * both variants and `useThemeMode` picks the right one. A badge fallback covers
 * any agent without an entry here, so a logo never simply disappears.
 */
interface AgentIconAsset {
  dark: string;
  light?: string;
}

const AGENT_ICONS: Record<string, AgentIconAsset> = {
  claude: { dark: claudeLogo, light: claudeLogo },
  codex: { dark: codexDark, light: codexLight },
  opencode: { dark: opencodeDark, light: opencodeLight },
  qwen: { dark: qwenDark, light: qwenLight },
  goose: { dark: gooseDark, light: gooseLight },
  junie: { dark: junieLogo, light: junieLogo },
  cursor: { dark: cursorDark, light: cursorLight },
  pi: { dark: piDark, light: piLight },
};

const AGENT_COLORS: Record<string, string> = {
  claude: "#d97706",
  codex: "#10b981",
  opencode: "#607d8b",
  qwen: "#7c3aed",
  goose: "#f59e0b",
  junie: "#48e054",
  cursor: "#6366f1",
  pi: "#16a34a",
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
  const mode = useThemeMode();
  const asset = AGENT_ICONS[agentId];
  const [failedSvg, setFailedSvg] = useState<string | null>(null);

  const src = asset ? (mode === "light" ? (asset.light ?? asset.dark) : asset.dark) : undefined;

  if (src && failedSvg !== src) {
    return (
      <img
        src={src}
        alt=""
        className={cn("size-4 shrink-0 rounded-sm object-contain", className)}
        aria-hidden
        onError={() => setFailedSvg(src)}
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
