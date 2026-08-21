import { useEffect, useRef } from "react";

/**
 * Invokes `onOpen` on ⌘/Ctrl ⇧ F — the IDE "find in files" gesture. Shift is
 * held, so `event.key` arrives as the shifted glyph on most layouts; `code`
 * keeps it layout-stable.
 */
export function useFindInFilesShortcut(onOpen: () => void) {
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.code !== "KeyF" && event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      onOpenRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
