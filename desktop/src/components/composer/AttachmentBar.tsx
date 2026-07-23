import { FileDiff, FileMinus, FilePen, FilePlus, X } from "lucide-react";
import { memo } from "react";

import type { ImageAttachmentDraft } from "../../lib/imageAttachments";
import type { FileDiff as FileDiffType } from "../../protocol";
import type { ComposerAttachment } from "../Composer";
import { ImageAttachmentPreview } from "./ImageAttachmentPreview";

const statusIcon = (s: FileDiffType["status"]) => {
  switch (s) {
    case "added":
      return <FilePlus className="size-3.5 text-emerald-400" />;
    case "deleted":
      return <FileMinus className="size-3.5 text-destructive" />;
    case "renamed":
      return <FilePen className="size-3.5 text-sky-400" />;
    default:
      return <FileDiff className="size-3.5 text-amber-400" />;
  }
};

interface AttachmentBarProps {
  diffs: ComposerAttachment[];
  images: ImageAttachmentDraft[];
  onRemoveDiff: (id: string) => void;
  onRemoveImage: (image: ImageAttachmentDraft) => void;
}

export const AttachmentBar = memo(function AttachmentBar({
  diffs,
  images,
  onRemoveDiff,
  onRemoveImage,
}: AttachmentBarProps) {
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-input/50 px-2.5 py-2">
      {diffs.map((a) => (
        <div
          key={a.id}
          className="group flex items-center gap-1.5 rounded-md border bg-secondary/60 px-2 py-1 font-mono text-xs"
        >
          {statusIcon(a.status)}
          <span className="max-w-[180px] truncate">{a.filePath}</span>
          <span>
            <span className="text-emerald-400">+{a.addedLines}</span>{" "}
            <span className="text-destructive">-{a.removedLines}</span>
          </span>
          <button
            type="button"
            aria-label={`Remove ${a.filePath}`}
            onClick={() => onRemoveDiff(a.id)}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {images.map((image) => (
        <ImageAttachmentPreview
          key={image.id}
          image={image}
          onRemove={() => onRemoveImage(image)}
        />
      ))}
    </div>
  );
});
