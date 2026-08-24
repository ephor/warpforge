import { useQuery } from "@tanstack/react-query";

import {
  MarkdownImageFrame,
  MarkdownImageLink,
  type MarkdownImageProps,
} from "@/components/Markdown";
import { daemon } from "@/daemon";

/**
 * An image from an issue body, loaded through the daemon.
 *
 * The WebView carries no GitHub or Linear session, so a `<img src>` straight
 * at an attachment URL gets a 404 for exactly the pictures worth showing —
 * every screenshot in a private repository's issues. The daemon holds the
 * credentials the import already used, so it fetches the bytes and they render
 * from a data URL. Clicking still opens the original URL, where the browser's
 * own session takes over.
 *
 * Anything the daemon cannot get (no `gh` login, a host it will not call)
 * degrades to the link, which is strictly better than a broken image.
 */
export function TrackerImage({ src, alt, title }: MarkdownImageProps) {
  const attachment = useQuery({
    // Bytes, and possibly megabytes: not worth holding once the drawer closes.
    gcTime: 60_000,
    queryFn: () => daemon.trackerAttachment(src),
    queryKey: ["trackerAttachment", src],
    // The signed URL behind an attachment is short-lived, but the daemon
    // re-resolves it on each call, so the cached bytes never go stale.
    staleTime: Infinity,
  });

  if (attachment.isPending) {
    return (
      <span className="my-2 block text-xs text-muted-foreground" aria-busy>
        Loading {alt}…
      </span>
    );
  }
  if (!attachment.data) return <MarkdownImageLink href={src} label={alt} />;

  return (
    <MarkdownImageFrame
      src={`data:${attachment.data.contentType};base64,${attachment.data.dataBase64}`}
      alt={alt}
      title={title}
      openHref={src}
    />
  );
}
