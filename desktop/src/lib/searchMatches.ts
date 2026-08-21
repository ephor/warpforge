import type { SymbolMatch } from "../protocol";

/** All hits from one file, in the order the daemon walked them. */
export interface FileMatchGroup {
  path: string;
  matches: SymbolMatch[];
}

/** Group flat `file.search` hits by file, keeping both orders stable. */
export function groupMatchesByFile(matches: SymbolMatch[]): FileMatchGroup[] {
  const groups: FileMatchGroup[] = [];
  const byPath = new Map<string, FileMatchGroup>();
  for (const match of matches) {
    let group = byPath.get(match.path);
    if (!group) {
      group = { matches: [], path: match.path };
      byPath.set(match.path, group);
      groups.push(group);
    }
    group.matches.push(match);
  }
  return groups;
}

/** One run of a line, either plain or a query hit. `start` is its offset in the
 *  line, which doubles as a stable React key. */
export interface HighlightSegment {
  text: string;
  hit: boolean;
  start: number;
}

/** Alternating plain/hit segments of `text` for a case-insensitive `query`,
 *  so a result line can render every occurrence highlighted. */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  if (query === "") return [{ hit: false, start: 0, text }];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;
    if (at > cursor) segments.push({ hit: false, start: cursor, text: text.slice(cursor, at) });
    segments.push({ hit: true, start: at, text: text.slice(at, at + needle.length) });
    cursor = at + needle.length;
  }
  if (cursor < text.length) segments.push({ hit: false, start: cursor, text: text.slice(cursor) });
  return segments;
}

/** `src/a/b.ts` → `{ name: "b.ts", dir: "src/a" }`. */
export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf("/");
  return at === -1 ? { dir: "", name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}

/** Lines around a 1-based `line`, plus the 1-based number of the first one. */
export function previewWindow(
  text: string,
  line: number,
  radius = 6,
): { firstLine: number; lines: string[] } {
  const all = text.split("\n");
  const firstLine = Math.max(1, line - radius);
  return { firstLine, lines: all.slice(firstLine - 1, line + radius) };
}
