import type { SessionUpdate } from "../protocol";

export type ContextUsage = Extract<SessionUpdate, { kind: "usage" }>;

export function latestContextUsage(updates: SessionUpdate[]): ContextUsage | undefined {
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    if (updates[index].kind === "usage") return updates[index] as ContextUsage;
  }
  return undefined;
}

export function compactTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return Math.max(0, Math.round(value)).toString();
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, "");
}
