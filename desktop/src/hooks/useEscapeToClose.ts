import { useEffect, useRef } from "react";

/**
 * Closes an overlay on Escape pressed anywhere, not just inside its input.
 * The listener sits on the window's capture phase — the earliest point JS can
 * see the key — and swallows it, because an Escape the web content leaves
 * unconsumed is what macOS turns into "leave fullscreen".
 */
export function useEscapeToClose(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);
}
