export const EMPTY_LOGS: string[] = [];
export const LOG_DISPLAY_CAP = 500;
export const FOLLOW_THRESHOLD_PX = 40;
export const SIDEBAR_WIDTH = 256;

export type SidebarItem = { kind: "service"; name: string } | { kind: "portforward"; name: string };

export function makeSidebarKey(item: SidebarItem): string {
  return `${item.kind}:${item.name}`;
}
