import { useEffect, useState } from "react";
import { THEMES, type Theme } from "../../../../desktop/src/lib/themes";

const STORAGE_KEY = "wf-landing-theme";
const hsl = (v: string) => `hsl(${v})`;

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const wf = document.querySelector<HTMLElement>(".wf");
  const claims = document.querySelectorAll<HTMLElement>(".claim");
  const vars: Record<string, string> = {
    "--background": theme.colors.background,
    "--foreground": theme.colors.foreground,
    "--card": theme.colors.card,
    "--card-foreground": theme.colors["card-foreground"],
    "--primary": theme.colors.primary,
    "--primary-foreground": theme.colors["primary-foreground"],
    "--secondary": theme.colors.secondary,
    "--secondary-foreground": theme.colors["secondary-foreground"],
    "--muted": theme.colors.muted,
    "--muted-foreground": theme.colors["muted-foreground"],
    "--accent": theme.colors.accent,
    "--accent-foreground": theme.colors["accent-foreground"],
    "--border": theme.colors.border,
    "--input": theme.colors.input,
    "--ring": theme.colors.ring,
    "--ok": theme.colors.ok,
    "--warn": theme.colors.warn,
    "--info": theme.colors.info,
    "--destructive": theme.colors.destructive,
    "--destructive-foreground": theme.colors["destructive-foreground"],
    "--deep-surface": theme.colors["deep-surface"],
    "--syntax-keyword": theme.colors["syntax-keyword"],
    "--syntax-string": theme.colors["syntax-string"],
    "--syntax-const": theme.colors["syntax-const"],
    "--syntax-comment": theme.colors["syntax-comment"],
    "--syntax-function": theme.colors["syntax-function"],
    "--syntax-type": theme.colors["syntax-type"],
    "--syntax-variable": theme.colors["syntax-variable"],
    "--syntax-operator": theme.colors["syntax-operator"],
    "--syntax-punctuation": theme.colors["syntax-punctuation"],
    "--syntax-tag": theme.colors["syntax-tag"],
    "--syntax-attribute": theme.colors["syntax-attribute"],
  };
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
    if (wf) wf.style.setProperty(k, v);
    claims.forEach((c) => c.style.setProperty(k, v));
  }
  root.dataset.theme = theme.id;
  root.classList.toggle("dark", theme.mode === "dark");
  localStorage.setItem(STORAGE_KEY, theme.id);
  const iframe = document.querySelector<HTMLIFrameElement>("[data-forge-demo] iframe");
  if (iframe?.contentWindow) iframe.contentWindow.postMessage({ type: "wf-theme", theme }, "*");
}

export default function ThemeSwitcher() {
  const [id, setId] = useState<string>(() => {
    if (typeof localStorage !== "undefined") return localStorage.getItem(STORAGE_KEY) ?? "forge";
    return "forge";
  });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
    applyTheme(theme);
  }, [id]);

  useEffect(() => {
    const iframe = document.querySelector<HTMLIFrameElement>("[data-forge-demo] iframe");
    if (!iframe) return;
    const handler = () => {
      const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
      iframe.contentWindow?.postMessage({ type: "wf-theme", theme }, "*");
    };
    iframe.addEventListener("load", handler);
    return () => iframe.removeEventListener("load", handler);
  }, [id]);

  const active = THEMES.find((t) => t.id === id) ?? THEMES[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Theme: ${active.name}`}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-border bg-card px-2.5 py-1.5 text-xs text-foreground hover:border-border/80 focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <span className="flex items-center gap-1">
          <span className="size-3.5 rounded-full border border-border" style={{ background: hsl(active.colors.background) }} />
          <span className="size-3.5 rounded-full border border-border" style={{ background: hsl(active.colors.primary) }} />
        </span>
        <span className="hidden sm:inline">{active.name}</span>
      </button>

      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-2 grid w-64 grid-cols-2 gap-2 rounded-xl border border-border bg-popover p-2 shadow-lg">
            {THEMES.map((t) => {
              const isActive = t.id === id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setId(t.id); setOpen(false); }}
                  aria-pressed={isActive}
                  className={`flex flex-col items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                    isActive ? "border-ring bg-accent" : "border-border/70 bg-card hover:border-primary/50"
                  }`}
                >
                  <span className="flex items-center gap-1">
                    <span className="size-3.5 rounded-full border border-border" style={{ background: hsl(t.colors.background) }} />
                    <span className="size-3.5 rounded-full border border-border" style={{ background: hsl(t.colors.primary) }} />
                    <span className="size-3.5 rounded-full border border-border" style={{ background: hsl(t.colors["muted-foreground"]) }} />
                    <span className="size-3.5 rounded-full border border-border" style={{ background: hsl(t.colors.accent) }} />
                  </span>
                  <span className="text-xs font-medium text-foreground">{t.name}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
