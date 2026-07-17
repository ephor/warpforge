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
