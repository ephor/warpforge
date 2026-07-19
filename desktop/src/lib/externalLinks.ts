/** Open an HTTP(S) link outside Warpforge instead of navigating the app webview. */
export async function openExternalLink(url: string): Promise<void> {
  if (!isExternalLink(url)) return;

  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

export function isExternalLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
