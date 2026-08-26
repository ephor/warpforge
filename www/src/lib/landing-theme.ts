/**
 * The landing page's theme, shared by the three places that touch it: the
 * switcher in the nav, the demo iframe's pre-paint script, and the demo island
 * that listens for live changes.
 *
 * Every key in a theme's `colors` is the name of a CSS custom property, so one
 * rule covers all of them — no per-property list to fall behind the app's.
 */
import type { Theme } from "@app/lib/themes";

/** Where the chosen theme id is kept. Read by the demo page too — same origin. */
export const THEME_STORAGE_KEY = "wf-landing-theme";

export const DEFAULT_THEME_ID = "forge";

/**
 * Paint a theme, and mark the document light or dark.
 *
 * `:root` alone is enough: the page and its panels inherit these tokens rather
 * than restating them, so there is nothing left to shadow an inline value.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${name}`, value);
  }
  root.dataset.theme = theme.id;
  root.classList.toggle("dark", theme.mode === "dark");
}

/** The stored theme id, or null when there is none or storage is unavailable. */
export function storedThemeId(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeThemeId(id: string) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* Private browsing, or storage disabled — the choice just won't persist. */
  }
}
