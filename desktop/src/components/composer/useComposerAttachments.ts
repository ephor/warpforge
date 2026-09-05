import { useCallback, useEffect, useRef, useState } from "react";

import type { AttachmentDraft } from "../../lib/fileAttachments";
import { buildAttachments, revokeAttachmentPreviews } from "../../lib/fileAttachments";

/**
 * Owns the composer's pending attachments and the object URLs their previews
 * hold, so the drafts are revoked whether they are removed, sent or unmounted.
 */
export function useComposerAttachments() {
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const attachmentsRef = useRef(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => () => revokeAttachmentPreviews(attachmentsRef.current), []);

  const addFiles = useCallback(async (files: File[], options: { imageSupported: boolean }) => {
    if (files.length === 0) return;
    setError(null);
    const result = await buildAttachments(files, attachmentsRef.current, options);
    if (result.error) {
      setError(result.error);
      return;
    }
    setAttachments((prev) => [...prev, ...result.drafts]);
  }, []);

  const remove = useCallback((draft: AttachmentDraft) => {
    revokeAttachmentPreviews([draft]);
    setAttachments((prev) => prev.filter((item) => item.id !== draft.id));
  }, []);

  const clear = useCallback(() => {
    revokeAttachmentPreviews(attachmentsRef.current);
    setAttachments([]);
  }, []);

  return { addFiles, attachments, clear, error, remove, setError };
}
