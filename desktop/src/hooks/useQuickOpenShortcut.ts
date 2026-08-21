import { useEffect, useRef } from "react";

const DOUBLE_SHIFT_WINDOW_MS = 600;

/**
 * Invokes `onOpen` on a double-Shift press (the WebStorm/IntelliJ "search
 * everywhere" gesture) or on ⌘/Ctrl+P. Shift is also the selection modifier,
 * so a double-press must land within a short window while a normal Shift-tap
 * holds no state — the keyboard keeps "running" only while Shift is held down.
 */
export function useQuickOpenShortcut(onOpen: () => void) {
  const onOpenRef = useRef(onOpen);
  const lastShiftAtRef = useRef(0);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        const now = Date.now();
        if (now - lastShiftAtRef.current < DOUBLE_SHIFT_WINDOW_MS) {
          event.preventDefault();
          onOpenRef.current();
          lastShiftAtRef.current = 0;
        } else {
          lastShiftAtRef.current = now;
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        onOpenRef.current();
        return;
      }
      // Any other key resets the pending first Shift so typing never misfires.
      if (event.key !== "Shift") {
        lastShiftAtRef.current = 0;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
