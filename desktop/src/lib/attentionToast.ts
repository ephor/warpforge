const ATTENTION_SUMMARY_LIMIT = 160;

export function attentionToastSummary(prompt: string): string {
  const withoutControls = Array.from(prompt, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  const normalized = withoutControls.replace(/\s+/g, " ").trim();
  if (!normalized) return "Open the session for details";

  const characters = Array.from(normalized);
  if (characters.length <= ATTENTION_SUMMARY_LIMIT) return normalized;
  return `${characters
    .slice(0, ATTENTION_SUMMARY_LIMIT - 1)
    .join("")
    .trimEnd()}…`;
}
