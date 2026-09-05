import { FileDiff, FileMinus, FilePen, FilePlus, X } from "lucide-react";
import { memo } from "react";

import type { AttachmentDraft } from "../../lib/fileAttachments";
import type { FileDiff as FileDiffType } from "../../protocol";
import type { ComposerAttachment } from "../Composer";
import { DocumentAttachmentChip } from "./DocumentAttachmentChip";
import { ImageAttachmentPreview } from "./ImageAttachmentPreview";

const statusIcon = (s: FileDiffType["status"]) => {
  switch (s) {
    case "added":
      return <FilePlus className="size-3.5 text-ok" />;
    case "deleted":
      return <FileMinus className="size-3.5 text-destructive" />;
    case "renamed":
      return <FilePen className="size-3.5 text-warn" />;
    default:
      return <FileDiff className="size-3.5 text-info" />;
  }
};

interface AttachmentBarProps {
  diffs: ComposerAttachment[];
  attachments: AttachmentDraft[];
  onRemoveDiff: (id: string) => void;
  onRemoveAttachment: (attachment: AttachmentDraft) => void;
}

export const AttachmentBar = memo(function AttachmentBar({
  diffs,
  attachments,
  onRemoveDiff,
  onRemoveAttachment,
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
            <span className="text-ok">+{a.addedLines}</span>{" "}
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
      {attachments.map((attachment) =>
        attachment.kind === "image" ? (
          <ImageAttachmentPreview
            key={attachment.id}
            image={attachment}
            onRemove={() => onRemoveAttachment(attachment)}
          />
        ) : (
          <DocumentAttachmentChip
            key={attachment.id}
            document={attachment}
            onRemove={() => onRemoveAttachment(attachment)}
          />
        ),
      )}
    </div>
  );
});
