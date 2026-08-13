import { RotateCcw, X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import AccountsPanel from "@/components/AccountsPanel";
import AgentSetupPanel from "@/components/AgentSetupPanel";
import LanguageServersPanel from "@/components/LanguageServersPanel";
import { Button } from "@/components/ui/button";
import { daemon } from "@/daemon";
import { configRole } from "@/lib/configRole";
import { THEMES } from "@/lib/themes";
import { useUi } from "@/store/ui";

// ── Helpers ──

function hsl(triplet: string): string {
  return `hsl(${triplet})`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
        <span className="mr-2 inline-block h-px w-3 bg-border" aria-hidden />
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card">{children}</div>
    </section>
  );
}

function SettingRow({
  title,
  description,
  control,
  resetAction,
}: {
  title: string;
  description: string;
  control: React.ReactNode;
  resetAction?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/60 px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-h-5 items-center gap-1.5">
          <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
          {resetAction}
        </div>
        <p className="text-xs text-muted-foreground/80">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 w-7 p-0 text-xs"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
      >
        −
      </Button>
      <span className="w-10 text-center text-sm tabular-nums">{value}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 w-7 p-0 text-xs"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
      >
        +
      </Button>
    </div>
  );
}

// ── Main view ──

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export default function SettingsView({ open, onOpenChange }: Props) {
  const fontSize = useUi((s) => s.fontSize);
  const monoFontSize = useUi((s) => s.monoFontSize);
  const setFontSize = useUi((s) => s.setFontSize);
  const setMonoFontSize = useUi((s) => s.setMonoFontSize);
  const resetFontSizes = useUi((s) => s.resetFontSizes);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const textGenAgentId = useUi((s) => s.textGenAgentId);
  const setTextGenAgentId = useUi((s) => s.setTextGenAgentId);
  const textGenModel = useUi((s) => s.textGenModel);
  const setTextGenModel = useUi((s) => s.setTextGenModel);
  const autoNameTasks = useUi((s) => s.autoNameTasks);
  const setAutoNameTasks = useUi((s) => s.setAutoNameTasks);
  const theoMod = useUi((s) => s.theoMod);
  const setTheoMod = useUi((s) => s.setTheoMod);
  const state = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const enabledAgents = (state.snapshot.agents ?? []).filter((a) => a.enabled);
  // The daemon caches an agent's config options after probing it over ACP; the
  // model list is empty until that probe has happened at least once.
  const modelOption = enabledAgents
    .find((a) => a.id === textGenAgentId)
    ?.models.find((o) => configRole(o) === "model");

  const fontDirty = fontSize !== 14 || monoFontSize !== 13;

  // Escape key closes overlay.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="flex h-full max-h-full w-full max-w-3xl flex-col overflow-y-auto px-8 py-8">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Settings</h1>
          <div className="flex items-center gap-3">
            {fontDirty && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                onClick={resetFontSizes}
              >
                <RotateCcw className="size-3" />
                Reset defaults
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
              type="button"
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        <div className="flex flex-col gap-8">
          {/* ── Appearance ── */}
          <Section title="Appearance">
            <div className="grid grid-cols-4 gap-2 p-4">
              {THEMES.map((t) => {
                const active = t.id === theme;
                const swatch = (key: keyof typeof t.colors) =>
                  hsl(t.colors[key]);
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
              control={
                <NumberInput value={monoFontSize} min={9} max={22} onChange={setMonoFontSize} />
              }
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
          </Section>

          {/* ── Agents ── */}
          <Section title="Agents">
            <div className="p-4">
              <AgentSetupPanel />
            </div>
          </Section>

          {/* ── Accounts ── */}
          <Section title="Accounts">
            <div className="p-4">
              <AccountsPanel />
            </div>
          </Section>

          {/* ── Language servers ── */}
          <Section title="Language servers">
            <div className="p-4">
              <LanguageServersPanel />
            </div>
          </Section>

          {/* ── Text generation ── */}
          <Section title="Text generation">
            <SettingRow
              title="Auto-name tasks"
              description="On task creation, ask the selected agent to generate a short title. Respects your agent and model picks above."
              control={
                <label
                  htmlFor="auto-name-tasks"
                  className="relative inline-flex cursor-pointer items-center"
                >
                  <input
                    id="auto-name-tasks"
                    type="checkbox"
                    className="peer sr-only"
                    checked={autoNameTasks}
                    onChange={(e) => setAutoNameTasks(e.target.checked)}
                  />
                  <div className="h-5 w-9 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-foreground/80 after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-background after:transition-transform peer-checked:after:translate-x-4" />
                </label>
              }
            />
            <SettingRow
              title="Agent for git text"
              description="Drafts commit messages and PR descriptions from the diff, on demand. Used for both."
              control={
                <select
                  value={textGenAgentId ?? ""}
                  onChange={(e) => setTextGenAgentId(e.target.value || null)}
                  className="bg-deep-surface h-7 rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">None</option>
                  {enabledAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </select>
              }
            />
            {textGenAgentId && (
              <SettingRow
                title="Model"
                description={
                  modelOption
                    ? "Which model that agent uses for this. Agent default when unset."
                    : "Model list appears once the agent has been started at least once, so Warpforge can read its options."
                }
                control={
                  <select
                    value={textGenModel ?? ""}
                    onChange={(e) => setTextGenModel(e.target.value || null)}
                    disabled={!modelOption}
                    className="bg-deep-surface h-7 max-w-56 rounded-md border px-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                  >
                    <option value="">Agent default</option>
                    {modelOption?.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                }
              />
            )}
          </Section>
        </div>

        {/* ── Fun ── */}
        <Section title="Fun">
          <SettingRow
            title="TheoMod"
            description="For when you might share your screen. Blurs email addresses everywhere they appear. Hover to peek — copy still works."
            control={
              <label
                htmlFor="theo-mod"
                className="relative inline-flex cursor-pointer items-center"
              >
                <input
                  id="theo-mod"
                  type="checkbox"
                  className="peer sr-only"
                  checked={theoMod}
                  onChange={(e) => setTheoMod(e.target.checked)}
                />
                <div className="h-5 w-9 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-foreground/80 after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-background after:transition-transform peer-checked:after:translate-x-4" />
              </label>
            }
          />
        </Section>
      </div>
    </div>
  );
}
