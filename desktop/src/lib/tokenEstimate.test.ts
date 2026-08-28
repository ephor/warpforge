import { describe, expect, it } from "vitest";

import { estimateTokens, formatTokenRange, formatTokens } from "./tokenEstimate";

describe("estimateTokens", () => {
  it("counts Cyrillic as more expensive than Latin", () => {
    const latin = estimateTokens("a".repeat(1000));
    const cyrillic = estimateTokens("я".repeat(1000));

    // Same character count, but a naive chars/4 rule would report them equal
    // and understate the Cyrillic side by well over a third.
    expect(cyrillic.tokens).toBeGreaterThan(latin.tokens * 1.5);
  });

  it("brackets the point estimate", () => {
    const estimate = estimateTokens("hello world ".repeat(500));

    expect(estimate.low).toBeLessThan(estimate.tokens);
    expect(estimate.high).toBeGreaterThan(estimate.tokens);
  });

  it("reports nothing for empty text", () => {
    expect(estimateTokens("")).toEqual({ high: 0, low: 0, tokens: 0 });
    expect(formatTokenRange(estimateTokens(""))).toBe("empty");
  });
});

describe("formatTokens", () => {
  it("switches to thousands above a thousand", () => {
    expect(formatTokens(420)).toBe("~420");
    expect(formatTokens(35_400)).toBe("~35k");
  });
});
