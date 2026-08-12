import type { ReactNode } from "react";

import { useUi } from "@/store/ui";

const EMAIL_RE = /[^\s@·]+@[^\s@·]+\.[^\s@·]+/g;

/**
 * Renders `text` with any email addresses blurred while TeoMod is on.
 *
 * The blur is cosmetic only — the real address stays in the DOM, so
 * selecting and copying gets the actual string. Hover (or focus) un-blurs
 * it, in case you actually need to read it and you're nobody's broadcast.
 */
export default function EmailBlur({ text, className }: { text: string; className?: string }) {
  const teoMod = useUi((s) => s.teoMod);
  if (!teoMod) return <span className={className}>{text}</span>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = EMAIL_RE.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(
      <span
        key={index++}
        className="blur-[3px] transition-[filter] select-all hover:blur-none focus:blur-none"
        title={match[0]}
      >
        {match[0]}
      </span>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));

  return <span className={className}>{parts}</span>;
}