import type { ProjectFile } from "../protocol";

export interface ActiveMention {
  start: number;
  end: number;
  query: string;
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

export function mentionToken(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
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
