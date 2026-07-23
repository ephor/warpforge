const AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  qwen: "Qwen Code",
  goose: "Goose",
};

export function agentDisplayName(agentId: string, override?: string): string {
  return override ?? AGENT_NAMES[agentId] ?? agentId;
}
