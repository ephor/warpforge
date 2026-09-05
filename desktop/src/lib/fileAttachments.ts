import type { PromptAttachment } from "../protocol";
import type { ImageAttachmentDraft } from "./imageAttachments";
import { ALLOWED_IMAGE_MIMES, fileToImageAttachment, validateImageFiles } from "./imageAttachments";

/** Kept in step with `MAX_DOCUMENTS` in `src/daemon/prompt/mod.rs`. */
export const MAX_DOCUMENTS = 10;
export const MAX_DOCUMENT_BYTES = 512 * 1024;
export const MAX_DOCUMENT_TOTAL_BYTES = 2 * 1024 * 1024;

export interface DocumentAttachmentDraft {
  kind: "document";
  id: string;
  name: string;
  size: number;
  attachment: Extract<PromptAttachment, { type: "document" }>;
}

export type AttachmentDraft = (ImageAttachmentDraft & { kind: "image" }) | DocumentAttachmentDraft;

/** Extension → MIME for the cases Finder and the browser leave blank. */
const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  toml: "text/plain",
  xml: "text/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};

export function isImageFile(file: File): boolean {
  return ALLOWED_IMAGE_MIMES.includes(file.type as (typeof ALLOWED_IMAGE_MIMES)[number]);
}

export function guessTextMime(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.includes(".")
    ? file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return TEXT_MIME_BY_EXTENSION[extension] ?? "text/plain";
}

/**
 * Decode a file as strict UTF-8. Returns null for anything that is not text —
 * a fatal decode plus a NUL scan, because UTF-16 payloads can decode cleanly
 * into garbage that only a NUL byte gives away.
 */
export async function readTextFile(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes("\0") ? null : text;
}

function documentTotal(drafts: AttachmentDraft[]): number {
  return drafts.reduce((sum, draft) => (draft.kind === "document" ? sum + draft.size : sum), 0);
}

/**
 * Turn dropped/pasted/picked files into attachment drafts. All-or-nothing:
 * a single invalid file rejects the whole batch, matching how image-only
 * validation has always behaved.
 */
export async function buildAttachments(
  files: File[],
  existing: AttachmentDraft[],
  options: { imageSupported: boolean },
): Promise<{ drafts: AttachmentDraft[]; error: string | null }> {
  const images = files.filter(isImageFile);
  const documents = files.filter((file) => !isImageFile(file));

  if (images.length > 0 && !options.imageSupported) {
    return { drafts: [], error: "This agent does not support images." };
  }
  const existingImages = existing.filter(
    (draft): draft is ImageAttachmentDraft & { kind: "image" } => draft.kind === "image",
  );
  const imageError = images.length > 0 ? validateImageFiles(images, existingImages) : null;
  if (imageError) return { drafts: [], error: imageError };

  const existingDocuments = existing.filter((draft) => draft.kind === "document").length;
  if (existingDocuments + documents.length > MAX_DOCUMENTS) {
    return { drafts: [], error: `You can attach up to ${MAX_DOCUMENTS} files.` };
  }
  let total = documentTotal(existing);
  for (const file of documents) {
    if (file.size > MAX_DOCUMENT_BYTES) {
      return { drafts: [], error: `${file.name} exceeds 512 KiB.` };
    }
    total += file.size;
  }
  if (total > MAX_DOCUMENT_TOTAL_BYTES) {
    return { drafts: [], error: "Combined attached files exceed 2 MiB." };
  }

  const drafts: AttachmentDraft[] = [];
  try {
    const read = await Promise.all(images.map(fileToImageAttachment));
    drafts.push(...read.map((draft) => ({ ...draft, kind: "image" as const })));
  } catch {
    return { drafts: [], error: "Could not read one of the selected images." };
  }

  // A dropped folder arrives as a zero-byte File whose read throws, and a file
  // can vanish between the drop and the read; both must surface as a message
  // rather than an unhandled rejection.
  let texts: (string | null)[];
  try {
    texts = await Promise.all(documents.map(readTextFile));
  } catch {
    revokeAttachmentPreviews(drafts);
    return { drafts: [], error: "Could not read one of the selected files." };
  }
  const binary = documents.find((_, index) => texts[index] === null);
  if (binary) {
    revokeAttachmentPreviews(drafts);
    return { drafts: [], error: `${binary.name} is not a text file or a PNG/JPEG image.` };
  }
  documents.forEach((file, index) => {
    drafts.push({
      attachment: {
        mimeType: guessTextMime(file),
        name: file.name,
        text: texts[index] as string,
        type: "document",
      },
      id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
      kind: "document",
      name: file.name,
      size: file.size,
    });
  });
  return { drafts, error: null };
}

export function revokeAttachmentPreviews(drafts: AttachmentDraft[]) {
  drafts.forEach((draft) => {
    if (draft.kind === "image") URL.revokeObjectURL(draft.previewUrl);
  });
}
