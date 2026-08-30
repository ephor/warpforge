export const CHAT_BOTTOM_THRESHOLD_PX = 72;

export interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export function distanceFromBottom({ clientHeight, scrollHeight, scrollTop }: ScrollMetrics) {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function isNearChatBottom(metrics: ScrollMetrics, threshold = CHAT_BOTTOM_THRESHOLD_PX) {
  return distanceFromBottom(metrics) <= threshold;
}

/**
 * Scrolling upward is an explicit opt-out, even inside the near-bottom zone.
 * Scrolling back down re-enables following once the viewport reaches that zone.
 */
export function shouldFollowAfterScroll(
  previousScrollTop: number,
  metrics: ScrollMetrics,
  threshold = CHAT_BOTTOM_THRESHOLD_PX,
) {
  if (metrics.scrollTop < previousScrollTop - 0.5) {
    return false;
  }
  return isNearChatBottom(metrics, threshold);
}

/** Invalidates queued animation-frame scrolls when user intent detaches following. */
export function createChatFollowGate() {
  let generation = 0;
  return {
    cancel() {
      generation += 1;
    },
    isCurrent(token: number) {
      return token === generation;
    },
    issue() {
      generation += 1;
      return generation;
    },
  };
}

/**
 * Which rows the transcript list may restore (anchor) its scroll position to.
 *
 * - While following the live edge and not settling a disclosure, nothing: the
 *   list's own end-pinning owns the scroll, and anchoring would race it on
 *   per-type size estimates that churn over unmeasured history rows.
 * - While settling a work-group disclosure, only the toggled row: the trigger
 *   stays under the cursor instead of the viewport chasing the end.
 * - While reading away from the end, every row: keeps the reading position
 *   stable while new content streams in below.
 */
export type TranscriptRestoreMode = "none" | "anchor" | "all";

export function transcriptRestoreMode(
  following: boolean,
  settling: boolean,
  anchorKey: string | null,
): TranscriptRestoreMode {
  if (settling && anchorKey !== null) return "anchor";
  return following ? "none" : "all";
}
