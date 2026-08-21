import type { FileRange, ProjectFile } from "../protocol";

export interface ActiveMention {
  start: number;
  end: number;
  query: string;
}

export interface FileReference {
  path: string;
  range?: FileRange;
}

const LINE_RANGE_RE = /#L(\d+)(?:-(\d+))?$/;

export function mentionToken(path: string, range?: FileRange): string {
  const base = path.includes(" ") ? `@"${path}"` : `@${path}`;
  if (!range) {
    return base;
  }
  const suffix = range.start === range.end ? `#L${range.start}` : `#L${range.start}-${range.end}`;
  return `${base}${suffix}`;
}

/** Split a `@path#L2-4` token into its path and (optional) line range.
 *  Paths without a range parse back untouched. */
export function splitFileReference(token: string): FileReference {
  const match = token.match(LINE_RANGE_RE);
  if (!match || match.index === undefined) {
    return { path: token, range: undefined };
  }
  const path = token.slice(0, match.index);
  const start = Number(match[1]);
  const end = match[2] !== undefined ? Number(match[2]) : start;
  return { path, range: { start, end } };
}

export function findMentionAtCaret(text: string, caret: number): ActiveMention | null {
  const before = text.slice(0, caret);
  const match = before.match(/(?:^|\s)@(?:"([^"]*)|([^\s@]*))$/);
  if (!match) {
    return null;
  }
  const token = match[0].trimStart();
  return {
    end: caret,
    query: (match[1] ?? match[2] ?? "").toLowerCase(),
    start: caret - token.length,
  };
}

export function rankFiles(files: ProjectFile[], query: string): ProjectFile[] {
  const q = query.toLowerCase();
  const score = (path: string) => {
    const full = path.toLowerCase();
    const base = full.split("/").pop() ?? full;
    if (base.startsWith(q)) {
      return 0;
    }
    if (full.startsWith(q)) {
      return 1;
    }
    if (base.includes(q)) {
      return 2;
    }
    if (full.includes(q)) {
      return 3;
    }
    return 4;
  };
  const scored: { file: ProjectFile; score: number }[] = [];
  for (const file of files) {
    const s = score(file.path);
    if (s < 4) {
      scored.push({ file, score: s });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.file.path.localeCompare(b.file.path));
  return scored.map((entry) => entry.file);
}

export const FILE_REF_MIME = "application/x-warpforge-file-ref";

export function isFileRefDrag(types: string[]): boolean {
  return types.includes("text/plain") || types.includes(FILE_REF_MIME);
}

export function insertFileRef(text: string, caret: number, path: string) {
  const token = mentionToken(path);
  const value = `${text.slice(0, caret)}${token} ${text.slice(caret)}`;
  return { caret: caret + token.length + 1, value };
}

export function replaceMention(text: string, mention: ActiveMention, path: string) {
  const token = mentionToken(path);
  const value = `${text.slice(0, mention.start)}${token} ${text.slice(mention.end)}`;
  return { caret: mention.start + token.length + 1, value };
}

export function extractFileReferences(text: string): string[] {
  const refs: string[] = [];
  const regex = /(?:^|\s)@(?:"([^"]+)"|([^\s@]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    refs.push(match[1] ?? match[2]);
  }
  return [...new Set(refs)];
}
