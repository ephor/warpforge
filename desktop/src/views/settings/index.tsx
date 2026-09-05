import { RotateCcw, X } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUi, type SettingsPage } from "@/store/ui";

import { SETTINGS_PAGES } from "./nav";
import AdvancedPage from "./pages/Advanced";
import AgentsPage from "./pages/Agents";
import AppearancePage from "./pages/Appearance";
import IntegrationsPage from "./pages/Integrations";
import MemoryPage from "./pages/Memory";
import TasksPage from "./pages/Tasks";

const PAGES: Record<SettingsPage, () => React.ReactElement> = {
  appearance: AppearancePage,
  agents: AgentsPage,
  integrations: IntegrationsPage,
  tasks: TasksPage,
  memory: MemoryPage,
  advanced: AdvancedPage,
};

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/**
 * Full-screen Settings overlay. The category rail lives *inside* the overlay
 * rather than in the app sidebar: entering settings stays one explicit mode you
 * leave with Escape, instead of settings pages appearing as app navigation.
 */
export default function SettingsView({ open, onOpenChange }: Props) {
  const page = useUi((s) => s.settingsPage);
  const setPage = useUi((s) => s.setSettingsPage);
  const fontSize = useUi((s) => s.fontSize);
  const monoFontSize = useUi((s) => s.monoFontSize);
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

  const Page = PAGES[page] ?? AppearancePage;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="flex h-full max-h-full w-full max-w-5xl flex-col px-8 py-8">
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

        <div className="grid min-h-0 flex-1 grid-cols-[180px_1fr] gap-8">
          <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
            {SETTINGS_PAGES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={id === page ? "page" : undefined}
                onClick={() => setPage(id)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] transition-colors",
                  id === page
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 overflow-y-auto pb-8 pr-1">
            <Page />
          </div>
        </div>
      </div>
    </div>
  );
}
