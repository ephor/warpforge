import { useCallback, useEffect, useRef, useState } from "react";

import { THEMES, type Theme } from "@app/lib/themes";

import {
  applyTheme,
  DEFAULT_THEME_ID,
  storedThemeId,
  storeThemeId,
} from "../../lib/landing-theme";
import "./theme-switcher.css";

/**
 * Theme picker for the landing nav.
 *
 * Deliberately not styled with Tailwind: the landing page ships its own CSS and
 * never loads a Tailwind build, so utility classes here would have no rules at
 * all — which is exactly how this rendered as bare browser buttons. The panel
 * follows the app's own Appearance section: a card per theme, four swatches,
 * the active one carried on `--ring` and `--accent`.
 */

const THEME_BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

function themeOf(id: string): Theme {
  return THEME_BY_ID.get(id) ?? THEME_BY_ID.get(DEFAULT_THEME_ID) ?? THEMES[0];
}

/** Hand the demo iframe the theme it should paint. */
function tellDemo(theme: Theme) {
  const frame = document.querySelector<HTMLIFrameElement>("[data-forge-demo] iframe");
  frame?.contentWindow?.postMessage({ theme, type: "wf-theme" }, window.location.origin);
}

function Swatches({ theme, size }: { theme: Theme; size: "sm" | "md" }) {
  const keys = ["background", "primary", "muted-foreground", "accent"] as const;
  return (
    <span className={`wf-sw wf-sw-${size}`} aria-hidden="true">
      {keys.map((key) => (
        <span key={key} style={{ background: `hsl(${theme.colors[key]})` }} />
      ))}
    </span>
  );
}

export default function ThemeSwitcher() {
  // `null` until the stored choice has been read. Reading it in the initial
  // state instead would have the server render one theme's name and the client
  // another, which is a hydration mismatch; and applying before the read would
  // write the default back over the choice it is about to load.
  const [id, setId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = themeOf(id ?? DEFAULT_THEME_ID);

  useEffect(() => setId(storedThemeId() ?? DEFAULT_THEME_ID), []);

  useEffect(() => {
    if (id === null) return;
    const theme = themeOf(id);
    applyTheme(theme);
    storeThemeId(theme.id);
    tellDemo(theme);
  }, [id]);

  // The frame is lazy: it may mount long after the choice was made, and its
  // own pre-paint script reads the same storage — this only covers a reload
  // that races the write.
  useEffect(() => {
    const frame = document.querySelector<HTMLIFrameElement>("[data-forge-demo] iframe");
    if (!frame) return;
    const send = () => tellDemo(themeOf(id ?? DEFAULT_THEME_ID));
    frame.addEventListener("load", send);
    return () => frame.removeEventListener("load", send);
  }, [id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const choose = useCallback((next: string) => {
    setId(next);
    setOpen(false);
  }, []);

  return (
    <div className="wf-theme" ref={root}>
      <button
        type="button"
        className="wf-theme-btn"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Theme: ${active.name}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className="wf-theme-dot"
          aria-hidden="true"
          style={{
            background: `linear-gradient(135deg, hsl(${active.colors.primary}) 0 50%, hsl(${active.colors.background}) 50% 100%)`,
          }}
        />
        <span className="wf-theme-name">{active.name}</span>
        <svg className="wf-theme-caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <div className="wf-theme-menu" role="menu">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="menuitemradio"
              aria-checked={theme.id === active.id}
              className={theme.id === active.id ? "wf-theme-item wf-theme-item-on" : "wf-theme-item"}
              onClick={() => choose(theme.id)}
            >
              <Swatches theme={theme} size="md" />
              <span className="wf-theme-label">{theme.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
