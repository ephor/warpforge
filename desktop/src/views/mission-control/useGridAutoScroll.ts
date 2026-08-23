import { useCallback, useEffect } from "react";
import type { RefObject } from "react";
import type { EventCallback } from "react-grid-layout";

const GRID_SCROLL_EDGE = 48;
const GRID_SCROLL_STEP = 24;
const GRID_SCROLL_GAP = 8;

function pointerClientY(event: Event): number | null {
  if ("clientY" in event && typeof event.clientY === "number") {
    return event.clientY;
  }

  const touchEvent = event as TouchEvent;
  const touch = touchEvent.touches[0] ?? touchEvent.changedTouches[0];
  return touch?.clientY ?? null;
}

export function useGridAutoScroll(scrollAreaRef: RefObject<HTMLDivElement | null>) {
  const beginGridInteraction = useCallback(() => {
    document.body.classList.add("wf-dragging");
  }, []);
  const endGridInteraction = useCallback(() => {
    document.body.classList.remove("wf-dragging");
  }, []);
  const scrollDuringResize = useCallback(
    (event: Event) => {
      const pointerY = pointerClientY(event);
      if (pointerY === null) return;

      const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
        "[data-radix-scroll-area-viewport]",
      );
      if (!viewport) return;

      const bounds = viewport.getBoundingClientRect();
      let delta = 0;
      if (pointerY > bounds.bottom - GRID_SCROLL_EDGE) {
        delta = Math.min(GRID_SCROLL_STEP, pointerY - (bounds.bottom - GRID_SCROLL_EDGE));
      } else if (pointerY < bounds.top + GRID_SCROLL_EDGE) {
        delta = -Math.min(GRID_SCROLL_STEP, bounds.top + GRID_SCROLL_EDGE - pointerY);
      }
      if (delta !== 0) viewport.scrollTop += delta;
    },
    [scrollAreaRef],
  );
  const beginResizeInteraction = useCallback<EventCallback>(
    (_layout, _oldItem, _newItem, _placeholder, event) => {
      beginGridInteraction();
      scrollDuringResize(event);
    },
    [beginGridInteraction, scrollDuringResize],
  );
  const handleResize = useCallback<EventCallback>(
    (_layout, _oldItem, _newItem, _placeholder, event) => {
      scrollDuringResize(event);
    },
    [scrollDuringResize],
  );
  const revealResizedCard = useCallback<EventCallback>(
    (_newLayout, _oldItem, _newItem, _placeholder, _event, element) => {
      endGridInteraction();
      if (!element) return;

      window.requestAnimationFrame(() => {
        const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
          "[data-radix-scroll-area-viewport]",
        );
        if (!viewport) {
          element.scrollIntoView({ block: "end", inline: "nearest" });
          return;
        }

        const bounds = viewport.getBoundingClientRect();
        const card = element.getBoundingClientRect();
        const bottomOverflow = card.bottom - (bounds.bottom - GRID_SCROLL_GAP);
        const topOverflow = card.top - bounds.top;
        if (bottomOverflow > 0) {
          viewport.scrollTop += bottomOverflow;
        } else if (topOverflow < 0) {
          viewport.scrollTop += topOverflow;
        }
      });
    },
    [endGridInteraction, scrollAreaRef],
  );

  useEffect(() => () => document.body.classList.remove("wf-dragging"), []);

  return {
    beginGridInteraction,
    endGridInteraction,
    beginResizeInteraction,
    handleResize,
    revealResizedCard,
  };
}
