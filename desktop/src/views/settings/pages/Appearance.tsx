import { Button } from "@/components/ui/button";
import { THEMES } from "@/lib/themes";
import { useUi } from "@/store/ui";

import { hsl, NumberInput, Section, SettingRow, Toggle } from "../primitives";

export default function AppearancePage() {
  const fontSize = useUi((s) => s.fontSize);
  const monoFontSize = useUi((s) => s.monoFontSize);
  const setFontSize = useUi((s) => s.setFontSize);
  const setMonoFontSize = useUi((s) => s.setMonoFontSize);
  const resetFontSizes = useUi((s) => s.resetFontSizes);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const theoMod = useUi((s) => s.theoMod);
  const setTheoMod = useUi((s) => s.setTheoMod);

  const fontDirty = fontSize !== 14 || monoFontSize !== 13;

  return (
    <Section title="Appearance">
      <div className="grid grid-cols-4 gap-2 p-4">
        {THEMES.map((t) => {
          const active = t.id === theme;
          const swatch = (key: keyof typeof t.colors) => hsl(t.colors[key]);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              aria-pressed={active}
              className={`flex cursor-pointer flex-col items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                active
                  ? "border-ring bg-accent"
                  : "border-border/70 bg-card hover:border-primary/50"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className="size-4 rounded-full border border-border"
                  style={{ background: swatch("background") }}
                />
                <span
                  className="size-4 rounded-full border border-border"
                  style={{ background: swatch("primary") }}
                />
                <span
                  className="size-4 rounded-full border border-border"
                  style={{ background: swatch("muted-foreground") }}
                />
                <span
                  className="size-4 rounded-full border border-border"
                  style={{ background: swatch("accent") }}
                />
              </span>
              <span className="text-xs font-medium text-foreground">{t.name}</span>
            </button>
          );
        })}
      </div>
      <SettingRow
        title="UI font size"
        description="Controls labels, chat prose, buttons, and all general chrome. Keyboard: Cmd/Ctrl +/−/0"
        control={<NumberInput value={fontSize} min={10} max={24} onChange={setFontSize} />}
      />
      <SettingRow
        title="Mono font size"
        description="Controls code editor, diff views, and terminal output. Scales independently from UI font."
        control={<NumberInput value={monoFontSize} min={9} max={22} onChange={setMonoFontSize} />}
      />
      <SettingRow
        title="Reset font sizes"
        description="Restore UI font to 14px and mono font to 13px."
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={resetFontSizes}
            disabled={!fontDirty}
          >
            Reset
          </Button>
        }
      />
      <SettingRow
        title="TheoMod"
        description="For when you might share your screen. Blurs email addresses everywhere they appear. Hover to peek — copy still works."
        control={<Toggle id="theo-mod" checked={theoMod} onChange={setTheoMod} />}
      />
    </Section>
  );
}
