import { X } from "lucide-react";

import type { ImageAttachmentDraft } from "../../lib/imageAttachments";

export function ImageAttachmentPreview({
  image,
  onRemove,
}: {
  image: ImageAttachmentDraft;
  onRemove: () => void;
}) {
  return (
    <div className="group relative w-28 overflow-hidden rounded-md border bg-secondary/60">
      <img src={image.previewUrl} alt={image.name} className="h-16 w-full object-cover" />
      <div className="truncate px-1.5 py-1 text-[10px]" title={image.name}>
        {image.name}
      </div>
      <div className="px-1.5 pb-1 text-[9px] text-muted-foreground">
        {(image.size / 1024).toFixed(0)} KiB
      </div>
      <button
        type="button"
        aria-label={`Remove ${image.name}`}
        onClick={onRemove}
        className="absolute right-1 top-1 rounded bg-background/90 p-1 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
