import type { SessionUpdate } from "../protocol";

type PermissionRequest = Extract<SessionUpdate, { kind: "permission_request" }>;

const GENERIC_PERMISSION_TITLES = new Set([
  "permission needed",
  "permission request",
  "request permission",
]);

const SENSITIVE_NAME =
  "(?:api[_-]?key|access[_-]?key|auth|bearer|credential|password|passwd|private[_-]?key|secret|token)";
export const PERMISSION_TOAST_CONTEXT_LIMIT = 160;

const ONE_SHOT_APPROVALS = new Set(["allow", "allow_once", "approve", "approve_once"]);

/** Pick only an explicitly one-shot approval. Persistent grants always require review. */
export function permissionToastApproveOption(options: string[]): string | undefined {
  return options.find((option) =>
    ONE_SHOT_APPROVALS.has(
      option
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_"),
    ),
  );
}

/** Keep permission notifications useful without copying arbitrary tool payloads into a toast. */
export function permissionToastContext(
  request: PermissionRequest,
  updates: SessionUpdate[],
  maxLength = PERMISSION_TOAST_CONTEXT_LIMIT,
): string {
  const explicitTitle = normalize(request.title);
  if (explicitTitle && !GENERIC_PERMISSION_TITLES.has(explicitTitle.toLowerCase())) {
    return safeSummary(explicitTitle, maxLength);
  }

  const requestIndex = updates.findIndex(
    (update) => update.kind === "permission_request" && update.request_id === request.request_id,
  );
  const preceding = requestIndex >= 0 ? updates.slice(0, requestIndex) : updates;
  for (let index = preceding.length - 1; index >= 0; index -= 1) {
    const update = preceding[index];
    if (update.kind === "tool_call" && normalize(update.title)) {
      return safeSummary(update.title, maxLength);
    }
    // Do not borrow context from an earlier turn or permission prompt.
    if (update.kind === "turn_ended" || update.kind === "permission_request") break;
  }

  return "Permission request";
}

function normalize(value: string): string {
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  return withoutControls.replace(/\s+/g, " ").trim();
}

function safeSummary(value: string, maxLength: number): string {
  let summary = normalize(value);
  if ((summary.startsWith("{") || summary.startsWith("[")) && isJson(summary)) {
    return "Permission request";
  }
  summary = summary
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)[*-]\s+/g, "$1")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      new RegExp(`(\\b${SENSITIVE_NAME}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s]+)`, "gi"),
      "$1[redacted]",
    )
    .replace(
      new RegExp(`(--${SENSITIVE_NAME})(?:=|\\s+)(?:"[^"]*"|'[^']*'|[^\\s]+)`, "gi"),
      "$1 [redacted]",
    )
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]");

  const characters = Array.from(summary);
  if (characters.length > maxLength) {
    summary = `${characters
      .slice(0, Math.max(1, maxLength - 1))
      .join("")
      .trimEnd()}…`;
  }
  return summary || "Permission request";
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
