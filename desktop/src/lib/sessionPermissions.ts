import type { SessionUpdate } from "../protocol";

export type PermissionUpdate = Extract<SessionUpdate, { kind: "permission_request" }>;

interface PermissionCacheEntry {
  updates: SessionUpdate[];
  pending: Map<string, PermissionUpdate>;
}

const permissionCache = new Map<string, PermissionCacheEntry>();

export function prunePermissionCache(taskIds: ReadonlySet<string>): void {
  for (const taskId of permissionCache.keys()) {
    if (!taskIds.has(taskId)) permissionCache.delete(taskId);
  }
}

/** Incrementally track the latest unresolved request for a live task stream. */
export function latestPendingPermission(
  taskId: string,
  updates: SessionUpdate[] | undefined,
): PermissionUpdate | null {
  if (!updates) return null;
  let cached = permissionCache.get(taskId);
  if (cached?.updates !== updates) {
    const extendsCached =
      cached !== undefined &&
      cached.updates.length <= updates.length &&
      (cached.updates.length === 0 ||
        cached.updates[cached.updates.length - 1] === updates[cached.updates.length - 1]);
    const pending =
      extendsCached && cached ? new Map(cached.pending) : new Map<string, PermissionUpdate>();
    const start = extendsCached && cached ? cached.updates.length : 0;
    for (let index = start; index < updates.length; index += 1) {
      const update = updates[index];
      if (update.kind === "permission_request") {
        pending.delete(update.request_id);
        pending.set(update.request_id, update);
      } else if (update.kind === "permission_resolved") {
        pending.delete(update.request_id);
      }
    }
    cached = { pending, updates };
    permissionCache.set(taskId, cached);
  }
  let latest: PermissionUpdate | null = null;
  for (const permission of cached.pending.values()) latest = permission;
  return latest;
}

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
