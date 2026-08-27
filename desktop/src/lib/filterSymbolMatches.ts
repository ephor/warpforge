import type { SymbolMatch } from "../protocol";
import { lspLanguageForPath } from "./codemirrorLanguages";

/** Filter matches to same language group as current file. Fallback to exact extension. */
export function filterByFiletype(matches: SymbolMatch[], currentPath: string): SymbolMatch[] {
  const lang = lspLanguageForPath(currentPath);
  if (lang) {
    const filtered = matches.filter((m) => lspLanguageForPath(m.path) === lang);
    // If filter yields results, use it; else fall back to unfiltered (e.g. cross-lang defs rare but keep).
    // Actually for goto-definition we want strict filter - return filtered even if empty.
    return filtered;
  }
  // No known language: filter by exact extension
  const ext = currentPath.split(".").pop()?.toLowerCase();
  if (!ext) return matches;
  const filtered = matches.filter((m) => m.path.toLowerCase().endsWith(`.${ext}`));
  return filtered.length > 0 ? filtered : matches;
}
