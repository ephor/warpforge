# 0008 — Prompt attachments carry text, not blobs

**Status:** accepted (2026-09-04)

## Context

The composer could attach two things: a *path reference* into the task
worktree (`@src/main.rs`, produced by the `@` menu and by dragging a file out
of the tree) and a PNG/JPEG *image*. Users kept trying to drag in an ordinary
text file — a log, a spec, a CSV exported from somewhere else — which is not
in the worktree and so cannot be a path reference. The drop was silently
ignored unless the agent happened to advertise image support.

Generalising this ran into two constraints that are not visible from the UI
side. First, `PromptAttachment::File` already means *path reference*, so the
obvious wire tag `"file"` was taken. Second, the ACP content blocks this
daemon emits (`src/daemon/prompt/mod.rs`) are `text`, `resource` and `image`
only; there is no generic blob block and no capability probe that would tell
us an agent could accept one.

## Decisions

**The new wire variant is `document`, not `file`.**
`{"type":"document", name, mimeType, text}` on `PromptAttachment`, with a
matching `PromptAttachmentSummary::Document { name }` for the transcript.
*Rejected:* overloading `"file"` with an optional `data` field — the same tag
would then mean "read this path in the worktree" or "here are bytes I already
read", and every consumer would have to disambiguate by which fields are
present.

**Documents travel as plain UTF-8, not base64.** Binary uploads are rejected
(below), so base64 would buy nothing but 33 % inflation, a chunked `btoa`
loop on the frontend and a decode failure mode on the daemon. Images keep
their existing base64 `data` field, unchanged.

**Non-text binaries are rejected, with a clear message.** There is nowhere
for an opaque blob to go in an ACP prompt here, and inventing a private block
shape would be a lie to whichever agent received it. The client says
`"<name> is not a text file or a PNG/JPEG image."` and attaches nothing.
*Rejected:* base64-in-a-text-block — an agent cannot do anything useful with
it and it burns the whole context budget.

**"Is it text?" is answered by decoding, not by an extension allowlist.**
Frontend: `new TextDecoder("utf-8", { fatal: true })`, then a NUL scan
(UTF-16 payloads can decode into valid-but-meaningless UTF-8, and the NUL is
what gives them away). The daemon re-checks for NUL rather than trusting the
client. This accepts extensionless files (`Makefile`, `Dockerfile`) and any
code extension without maintaining a list.

**Documents share the text budget with path references.** One 2 MiB ceiling
(`MAX_TEXT_BYTES`) governs every text block going into a prompt, whether it
came from a worktree path or an upload. *Rejected:* a second, independent
document budget — two attachments of different kinds could then push a prompt
to 4 MiB while each looked within limits.

**Documents are never capability-gated; images are.**
`PromptContent::to_acp(false)` already inlines resources as plain text, so
every agent can consume a document regardless of what it advertises. The
paperclip button is therefore always enabled, and an image dropped on an
agent without image support is refused during validation with an explanation,
rather than the whole button being dead.

## Invariants

Applies to `src/daemon/prompt/` and `desktop/src/lib/fileAttachments.ts`.

1. **Client-side validation is a UX affordance, not a security boundary.**
   `prepare_document` re-checks size and NUL bytes on every request. A
   client-supplied `size` is deliberately absent from the wire type so no
   daemon code can be tempted to trust it.
2. **Frontend and daemon limits must move together.** `MAX_DOCUMENTS` (10),
   `MAX_DOCUMENT_BYTES` (512 KiB) and `MAX_IMAGES` (10) exist in both
   `src/daemon/prompt/mod.rs` and `desktop/src/lib/`. They drifted once
   already — the daemon capped images at 4 while the UI allowed 10, so the
   fifth image failed the whole send with a message the UI never predicted.
   Both files carry a comment naming the other.
3. **`PromptAttachment::File` stays a worktree path.** It is resolved through
   `secure_file`, which canonicalises and rejects escapes and symlinks. Never
   route uploaded bytes through it; a `Document` has no path and must not
   acquire one.
4. **A rejected batch attaches nothing.** `buildAttachments` is
   all-or-nothing, so a drop of five files with one binary in it does not
   leave four half-attached chips and an error the user has to reconcile.
   Image previews created before the failing file are revoked on that path.
5. **Adding a `PromptAttachment` variant is a daemon change, not just a wire
   change.** `prepare_prompt` matches exhaustively, so the compiler will catch
   the daemon side — but the demo-mode mapper in `desktop/src/daemon.ts` and
   the transcript label in `StreamLine.tsx` are TypeScript unions with a
   fallback arm, and will silently mislabel a new variant.
