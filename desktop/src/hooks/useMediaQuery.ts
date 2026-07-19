import { useEffect, useState } from "react";

/** Subscribe to a desktop-window breakpoint without assuming matchMedia exists in tests. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}
