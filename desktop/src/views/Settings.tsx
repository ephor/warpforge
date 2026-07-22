import { RotateCcw, X } from "lucide-react";
import { useEffect } from "react";

import AgentSetupPanel from "@/components/AgentSetupPanel";
import { Button } from "@/components/ui/button";
import { useUi } from "@/store/ui";

// ── Helpers ──

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
        <span className="mr-2 inline-block h-px w-3 bg-border" aria-hidden />
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
        {children}
      </div>
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
          <SettingRow
            title="UI font size"
            description="Controls labels, chat prose, buttons, and all general chrome. Keyboard: Cmd/Ctrl +/−/0"
            control={
              <NumberInput value={fontSize} min={10} max={24} onChange={setFontSize} />
            }
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

        {/* ── Harness per action ── */}
        <Section title="Harness per action">
          <SettingRow
            title="Default agent for new tasks"
            description="Select which agent handles new tasks by default. Currently set per-task via the task creation dialog."
            control={
              <span className="text-xs text-muted-foreground">
                Per-task selection (no backend hook yet)
              </span>
            }
          />
          <SettingRow
            title="Commit message generation"
            description="Which agent/model generates commit messages. TODO: wire to backend once the daemon exposes a per-action harness selector."
            control={
              <span className="text-xs text-muted-foreground">Not wired — backend TODO</span>
            }
          />
          <SettingRow
            title="PR description generation"
            description="Which agent/model generates PR descriptions. TODO: wire to backend once the daemon exposes a per-action harness selector."
            control={
              <span className="text-xs text-muted-foreground">Not wired — backend TODO</span>
            }
          />
        </Section>
        </div>
      </div>
    </div>
  );
}
