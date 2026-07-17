import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createChatFollowGate, shouldFollowAfterScroll } from "@/lib/chatScroll";

export function useChatFollow(active: boolean, identity: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const previousScrollTop = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const followGate = useMemo(() => createChatFollowGate(), []);
  const touchY = useRef<number | null>(null);
  const pointerY = useRef<number | null>(null);
  const [following, setFollowingState] = useState(true);

  const setFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowingState((current) => (current === next ? current : next));
  }, []);

  const cancelPendingScroll = useCallback(() => {
    followGate.cancel();
    if (scrollFrame.current !== null) {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    }
  }, [followGate]);

  const pause = useCallback(() => {
    cancelPendingScroll();
    setFollowing(false);
  }, [cancelPendingScroll, setFollowing]);

  const queueBottom = useCallback(() => {
    const token = followGate.issue();
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (!followGate.isCurrent(token) || !followingRef.current) return;
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTo({ behavior: "auto", top: element.scrollHeight });
      previousScrollTop.current = element.scrollTop;
    });
  }, [followGate]);

  const resume = useCallback(() => {
    cancelPendingScroll();
    setFollowing(true);
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ behavior: "auto", top: element.scrollHeight });
    previousScrollTop.current = element.scrollTop;
  }, [cancelPendingScroll, setFollowing]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (!followingRef.current) {
      previousScrollTop.current = element.scrollTop;
      return;
    }
    const next = shouldFollowAfterScroll(previousScrollTop.current, element);
    if (!next) cancelPendingScroll();
    setFollowing(next);
    previousScrollTop.current = element.scrollTop;
  }, [cancelPendingScroll, setFollowing]);

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (event.deltaY < 0) pause();
    },
    [pause],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (["ArrowUp", "Home", "PageUp"].includes(event.key)) pause();
    },
    [pause],
  );

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    touchY.current = event.touches[0]?.clientY ?? null;
  }, []);

  const onTouchMove = useCallback(
    (event: React.TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (nextY === undefined) return;
      if (touchY.current !== null && nextY > touchY.current + 1) pause();
      touchY.current = nextY;
    },
    [pause],
  );

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    pointerY.current = event.pointerType === "mouse" ? event.clientY : null;
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType !== "mouse" || event.buttons !== 1) return;
      if (pointerY.current !== null && event.clientY < pointerY.current - 1) pause();
      pointerY.current = event.clientY;
    },
    [pause],
  );

  useEffect(() => {
    if (!active) return;
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) queueBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [active, queueBottom]);

  useEffect(() => {
    if (!active) {
      cancelPendingScroll();
      return;
    }
    setFollowing(true);
    previousScrollTop.current = 0;
    resume();
    return cancelPendingScroll;
  }, [active, cancelPendingScroll, identity, resume, setFollowing]);

  useEffect(() => cancelPendingScroll, [cancelPendingScroll]);

  return {
    contentRef,
    following,
    resume,
    scrollHandlers: {
      onKeyDown,
      onPointerDown,
      onPointerMove,
      onScroll,
      onTouchMove,
      onTouchStart,
      onWheel,
    },
    scrollRef,
  };
}
