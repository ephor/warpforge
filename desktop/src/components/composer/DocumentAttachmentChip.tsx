import { FileText, X } from "lucide-react";

import type { DocumentAttachmentDraft } from "../../lib/fileAttachments";

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(0)} KiB`;
}

export function DocumentAttachmentChip({
  document,
  onRemove,
}: {
  document: DocumentAttachmentDraft;
  onRemove: () => void;
}) {
  return (
    <div className="group flex items-center gap-1.5 rounded-md border bg-secondary/60 px-2 py-1 font-mono text-xs">
      <FileText className="size-3.5 text-info" />
      <span className="max-w-[180px] truncate" title={document.name}>
        {document.name}
      </span>
      <span className="text-muted-foreground">{formatSize(document.size)}</span>
      <button type="button" aria-label={`Remove ${document.name}`} onClick={onRemove}>
        <X className="size-3" />
      </button>
    </div>
  );
}
