import { useEffect } from "react";

import { useUi } from "@/store/ui";

export function useFontScaling() {
  const fontSize = useUi((s) => s.fontSize);
  const monoFontSize = useUi((s) => s.monoFontSize);
  const bumpFontSize = useUi((s) => s.bumpFontSize);
  const bumpMonoFontSize = useUi((s) => s.bumpMonoFontSize);
  const resetFontSizes = useUi((s) => s.resetFontSizes);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--app-font-size", `${fontSize}px`);
    root.style.setProperty("--app-mono-font-size", `${monoFontSize}px`);
    const fontScale = fontSize / 14;
    const monoScale = monoFontSize / 13;
    root.style.setProperty("--app-font-scale", String(fontScale));
    root.style.setProperty("--app-mono-font-scale", String(monoScale));
  }, [fontSize, monoFontSize]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        bumpFontSize(1);
        bumpMonoFontSize(1);
      } else if (e.key === "-") {
        e.preventDefault();
        bumpFontSize(-1);
        bumpMonoFontSize(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        resetFontSizes();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bumpFontSize, bumpMonoFontSize, resetFontSizes]);
}
