import type { EditHunk, Hunk } from "../../protocol";

function intervalDistance(aStart: number, aLines: number, bStart: number, bLines: number): number {
  const aEnd = aStart + Math.max(aLines, 1) - 1;
  const bEnd = bStart + Math.max(bLines, 1) - 1;
  if (aEnd < bStart) return bStart - aEnd;
  if (bEnd < aStart) return aStart - bEnd;
  return 0;
}

function changedLines(lines: string[]): Set<string> {
  return new Set(lines.filter((line) => line.startsWith("+") || line.startsWith("-")));
}

/** Match tool-scoped ACP hunks to the current aggregate git diff. */
export function matchingHunkIndexes(hunks: Hunk[], edits: EditHunk[]): number[] {
  const candidates = hunks.map((hunk) => ({
    changed: changedLines(hunk.lines),
    hunk,
  }));
  const matches: number[] = [];

  for (const edit of edits) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const sharedLines = edit.lines.reduce(
        (count, line) => count + (candidate.changed.has(line) ? 1 : 0),
        0,
      );
      const newDistance = intervalDistance(
        edit.newStart,
        edit.newLines,
        candidate.hunk.newStart,
        candidate.hunk.newLines,
      );
      const oldDistance = intervalDistance(
        edit.oldStart,
        edit.oldLines,
        candidate.hunk.oldStart,
        candidate.hunk.oldLines,
      );
      // Exact changed content is the strongest signal. Coordinates break ties
      // and provide a fallback when later edits altered the same lines.
      const score = sharedLines * 10_000 - Math.min(newDistance, oldDistance);
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }
    if (bestIndex >= 0 && !matches.includes(bestIndex)) {
      matches.push(bestIndex);
    }
  }

  return matches;
}
