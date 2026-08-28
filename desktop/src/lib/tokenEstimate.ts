/**
 * Rough token counts for text we are about to hand to a model.
 *
 * Every harness tokenises differently and none of them will tell us the number
 * without a round trip, so this is deliberately a range rather than a figure.
 * The naive "characters ÷ 4" rule is built for English and understates
 * non-Latin text badly — Cyrillic runs closer to 2–3 characters per token — so
 * the estimate weights the script mix instead of assuming one.
 */

/** Latin-ish prose: ~4 characters per token. */
const LATIN_CHARS_PER_TOKEN = 4;
/** Cyrillic and other non-Latin scripts: ~2.5 characters per token. */
const WIDE_CHARS_PER_TOKEN = 2.5;
/** Spread applied either side of the point estimate. */
const UNCERTAINTY = 0.2;

export interface TokenEstimate {
  /** Point estimate, in tokens. */
  tokens: number;
  low: number;
  high: number;
}

/** Characters outside the Latin/ASCII range, which tokenise less efficiently. */
function wideCharCount(text: string): number {
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0)! > 0x24f) wide += 1;
  }
  return wide;
}

export function estimateTokens(text: string): TokenEstimate {
  if (!text) return { high: 0, low: 0, tokens: 0 };
  const wide = wideCharCount(text);
  const latin = [...text].length - wide;
  const tokens = Math.round(latin / LATIN_CHARS_PER_TOKEN + wide / WIDE_CHARS_PER_TOKEN);
  return {
    high: Math.round(tokens * (1 + UNCERTAINTY)),
    low: Math.round(tokens * (1 - UNCERTAINTY)),
    tokens,
  };
}

/** "~12k" / "~800" — compact enough for a radio label. */
export function formatTokens(count: number): string {
  if (count < 1000) return `~${count}`;
  return `~${Math.round(count / 1000)}k`;
}

/** "~35–45k tokens" — the honest form, for the choice the user is making. */
export function formatTokenRange(estimate: TokenEstimate): string {
  if (estimate.tokens === 0) return "empty";
  if (estimate.high < 1000) return `~${estimate.low}–${estimate.high} tokens`;
  return `~${Math.round(estimate.low / 1000)}–${Math.round(estimate.high / 1000)}k tokens`;
}
