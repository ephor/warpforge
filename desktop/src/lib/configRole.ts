import type { ConfigOption } from "@/protocol";

export function configRole(option: ConfigOption): "model" | "effort" | null {
  const identity = `${option.category ?? ""} ${option.id} ${option.name}`.toLowerCase();
  if (identity.includes("model")) return "model";
  if (/effort|reasoning|thought[_ -]?level/.test(identity)) return "effort";
  return null;
}
