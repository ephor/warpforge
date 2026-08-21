import { useEffect } from "react";

import { getTheme } from "@/lib/themes";
import { useUi } from "@/store/ui";

/** Current theme's light/dark mode, for consumers that branch on it (CodeMirror). */
export function useThemeMode(): "light" | "dark" {
  const themeId = useUi((s) => s.theme);
  return getTheme(themeId).mode;
}

/**
 * Applies the selected color theme to the document root — the mirror image of
 * useFontScaling. Each theme's palette is written as CSS variables on the root
 * element, which every styled surface reads via hsl(var(--...)). The `dark`
 * class (which tailwind is configured to key off) follows the theme's mode so
 * any `dark:` variants + OS chrome stay consistent with the palette.
 */
export function useTheme() {
  const themeId = useUi((s) => s.theme);
  const theme = getTheme(themeId);

  useEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.colors)) {
      root.style.setProperty(`--${name}`, value);
    }
    root.dataset.theme = theme.id;
    root.classList.toggle("dark", theme.mode === "dark");
  }, [theme]);

  useEffect(() => {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", theme.mode === "dark" ? "dark" : "light");
  }, [theme]);
}
