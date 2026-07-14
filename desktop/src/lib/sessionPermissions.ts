import type { SessionUpdate } from "../protocol";

export type PermissionUpdate = Extract<SessionUpdate, { kind: "permission_request" }>;

export function resolvedPermissions(updates: SessionUpdate[]): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const update of updates) {
    if (update.kind === "permission_request") {
      delete resolved[update.request_id];
    } else if (update.kind === "permission_resolved") {
      resolved[update.request_id] = update.outcome;
    }
  }
  return resolved;
}

export function pendingPermission(
  updates: SessionUpdate[],
  resolved = resolvedPermissions(updates),
): PermissionUpdate | null {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const update = updates[i];
    if (update.kind === "permission_request" && !resolved[update.request_id]) {
      return update;
    }
  }
  return null;
}
