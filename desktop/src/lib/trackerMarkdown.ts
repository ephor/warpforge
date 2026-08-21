/**
 * Issue bodies written in GitHub or Linear are markdown, but GitHub's own
 * upload widget pastes a raw `<img …>` tag rather than markdown image syntax.
 * The renderer does not parse raw HTML — deliberately, since this text comes
 * off the network — so those tags used to show up verbatim in the middle of
 * the description.
 *
 * Rewriting the tag into `![alt](src)` gets the picture back without enabling
 * HTML: nothing but the src and alt survive, and both go through the normal
 * markdown pipeline afterwards.
 */

const IMG_TAG = /<img\b[^>]*?\/?>/gi;
const ATTRIBUTE = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");

const SRC = ATTRIBUTE("src");
const ALT = ATTRIBUTE("alt");

function attribute(tag: string, pattern: RegExp): string | null {
  const match = pattern.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** Only http(s) — a `javascript:` or `data:` src has no business here. */
function isRenderableSource(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

export function inlineHtmlImages(body: string): string {
  return body.replace(IMG_TAG, (tag) => {
    const src = attribute(tag, SRC);
    if (!src || !isRenderableSource(src)) return "";
    // A title containing `]` or `)` would break out of the link syntax.
    const alt = (attribute(tag, ALT) ?? "Image").replace(/[[\]()]/g, "");
    return `![${alt}](${src})`;
  });
}
