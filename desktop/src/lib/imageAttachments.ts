import type { PromptAttachment } from "../protocol";

export const ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg"] as const;
export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;

export interface ImageAttachmentDraft {
  id: string;
  name: string;
  size: number;
  previewUrl: string;
  attachment: Extract<PromptAttachment, { type: "image" }>;
}

export function validateImageFiles(
  files: File[],
  existing: ImageAttachmentDraft[] = [],
): string | null {
  if (existing.length + files.length > MAX_IMAGES) {
    return `You can attach up to ${MAX_IMAGES} images.`;
  }
  let total = existing.reduce((sum, image) => sum + image.size, 0);
  for (const file of files) {
    const extensionOk = /\.(png|jpe?g)$/i.test(file.name);
    if (
      !extensionOk ||
      !ALLOWED_IMAGE_MIMES.includes(file.type as (typeof ALLOWED_IMAGE_MIMES)[number])
    ) {
      return `${file.name} must be a PNG or JPEG image.`;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return `${file.name} exceeds 5 MiB.`;
    }
    total += file.size;
  }
  if (total > MAX_IMAGE_TOTAL_BYTES) {
    return "Combined images exceed 10 MiB.";
  }
  return null;
}

export async function fileToImageAttachment(file: File): Promise<ImageAttachmentDraft> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return {
    attachment: {
      data: btoa(binary),
      mimeType: file.type as "image/png" | "image/jpeg",
      name: file.name,
      type: "image",
    },
    id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
    name: file.name,
    previewUrl: URL.createObjectURL(file),
    size: file.size,
  };
}

export function revokeImagePreviews(images: ImageAttachmentDraft[]) {
  images.forEach((image) => URL.revokeObjectURL(image.previewUrl));
}
