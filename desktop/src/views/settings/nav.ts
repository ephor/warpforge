import { Bot, Brain, ListChecks, Palette, Plug, Wrench, type LucideIcon } from "lucide-react";

import type { SettingsPage } from "@/store/ui";

/** Left-rail entries of the Settings overlay, in display order. */
export const SETTINGS_PAGES: { id: SettingsPage; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "advanced", label: "Advanced", icon: Wrench },
];
