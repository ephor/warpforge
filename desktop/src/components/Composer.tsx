import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

import {
  extractFileReferences,
  FILE_REF_MIME,
  findMentionAtCaret,
  insertFileRef,
  isFileRefDrag,
  rankFiles,
  replaceMention,
  splitFileReference,
} from "../lib/composerMentions";
import type { ContextUsage } from "../lib/sessionUsage";
import type {
  CommandInfo,
  FileDiff as FileDiffType,
  ProjectFile,
  PromptSubmission,
} from "../protocol";
import { AttachButton } from "./composer/AttachButton";
import { AttachmentBar } from "./composer/AttachmentBar";
import { ComposerActionButton } from "./composer/ComposerActionButton";
import { ContextUsageIndicator } from "./composer/ContextUsageIndicator";
import { FileMentionMenu } from "./composer/FileMentionMenu";
import { SlashCommandMenu } from "./composer/SlashCommandMenu";
import { useComposerAttachments } from "./composer/useComposerAttachments";

export interface ComposerAttachment {
  id: string;
  filePath: string;
  status: FileDiffType["status"];
  content: string;
  addedLines: number;
  removedLines: number;
}
export interface ComposerHandle {
  attachDiff: (file: FileDiffType, formattedContent: string) => void;
  appendDraft: (text: string) => void;
  submit: () => void;
}
const EMPTY_COMMANDS: CommandInfo[] = [];
const EMPTY_FILES: ProjectFile[] = [];

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSend: (submission: PromptSubmission) => void | Promise<void>;
    onCancel?: () => void | Promise<void>;
    commands?: CommandInfo[];
    files?: ProjectFile[];
    filesLoading?: boolean;
    imageSupported?: boolean;
    placeholder?: string;
    disabled?: boolean;
    toolbar?: React.ReactNode;
    initialValue?: string;
    onDraftChange?: (text: string) => void;
    hideSendButton?: boolean;
    compact?: boolean;
    contextUsage?: ContextUsage;
    className?: string;
  }
>(
  (
    {
      onSend,
      onCancel,
      commands = EMPTY_COMMANDS,
      files = EMPTY_FILES,
      filesLoading = false,
      imageSupported = false,
      placeholder = "Message or steer the agent…",
      disabled = false,
      toolbar,
      initialValue = "",
      onDraftChange,
      hideSendButton = false,
      compact = false,
      contextUsage,
      className,
    },
    ref,
  ) => {
    const [value, setValue] = useState(initialValue);
    const [caret, setCaret] = useState(0);
    const [menuIndex, setMenuIndex] = useState(0);
    const [diffs, setDiffs] = useState<ComposerAttachment[]>([]);
    const [sending, setSending] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [refDrag, setRefDrag] = useState(false);
    const textRef = useRef<HTMLTextAreaElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const sendActionRef = useRef<() => void>(() => {});
    // One error line, one owner: attaching a file, sending and stopping all
    // report through the same state, so neither can leave the other's message
    // stranded under an unrelated action.
    const {
      addFiles,
      attachments,
      clear: clearAttachments,
      error,
      remove: removeAttachment,
      setError,
    } = useComposerAttachments();

    const removeDiff = useCallback((id: string) => {
      setDiffs((prev) => prev.filter((diff) => diff.id !== id));
    }, []);

    const attach = useCallback(
      (incoming: File[]) => void addFiles(incoming, { imageSupported }),
      [addFiles, imageSupported],
    );

    const openFilePicker = useCallback(() => {
      inputRef.current?.click();
    }, []);

    useImperativeHandle(ref, () => ({
      attachDiff(file, formattedContent) {
        setDiffs((prev) => [
          ...prev,
          {
            id: `${file.path}#${Date.now()}`,
            filePath:
              file.status === "renamed" && file.oldPath
                ? `${file.oldPath} → ${file.path}`
                : file.path,
            status: file.status,
            content: formattedContent,
            addedLines: file.hunks.reduce(
              (sum, h) => sum + h.lines.filter((l) => l.startsWith("+")).length,
              0,
            ),
            removedLines: file.hunks.reduce(
              (sum, h) => sum + h.lines.filter((l) => l.startsWith("-")).length,
              0,
            ),
          },
        ]);
        textRef.current?.focus();
      },
      appendDraft(text) {
        setValue((prev) => {
          const sep = prev.length > 0 ? "\n\n" : "";
          return `${prev}${sep}${text}`;
        });
        requestAnimationFrame(() => {
          const el = textRef.current;
          if (!el) return;
          el.focus();
          const pos = el.value.length;
          el.setSelectionRange(pos, pos);
        });
      },
      submit() {
        sendActionRef.current();
      },
    }));

    useLayoutEffect(() => {
      const el = textRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, compact ? 180 : 220)}px`;
    }, [compact, value]);

    const mention = findMentionAtCaret(value, caret);
    const mentionMatches = mention ? rankFiles(files, mention.query).slice(0, 30) : [];
    const mentionOpen = !!mention && !value.startsWith("/");
    const slash =
      !mentionOpen && value.startsWith("/") && !value.includes(" ")
        ? value.slice(1).toLowerCase()
        : null;
    const commandMatches =
      slash !== null ? commands.filter((c) => c.name.toLowerCase().startsWith(slash)) : [];
    const slashOpen = commandMatches.length > 0;
    useEffect(() => setMenuIndex(0), [value]);

    const fileSet = useMemo(() => new Set(files.map((file) => file.path)), [files]);
    const fileAttachments = extractFileReferences(value)
      .map(splitFileReference)
      .filter((fileRef) => fileSet.has(fileRef.path));

    async function send() {
      const text = value.trim();
      if ((!text && diffs.length === 0 && attachments.length === 0) || disabled || sending) return;
      const parts = text ? [text] : [];
      diffs.forEach((diff) => parts.push(`\`\`\`diff\n${diff.content}\n\`\`\``));
      setSending(true);
      setError(null);
      try {
        await onSend({
          text: parts.join("\n\n"),
          attachments: [
            ...fileAttachments.map((fileRef) => ({
              type: "file" as const,
              path: fileRef.path,
              ...(fileRef.range ? { range: fileRef.range } : {}),
            })),
            ...attachments.map((attachment) => attachment.attachment),
          ],
        });
        setValue("");
        setDiffs([]);
        clearAttachments();
        setCaret(0);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Message could not be sent.");
      } finally {
        setSending(false);
      }
    }

    async function stop() {
      if (!onCancel || stopping) return;
      setStopping(true);
      setError(null);
      try {
        await onCancel();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Task could not be stopped.");
      } finally {
        setStopping(false);
      }
    }

    useLayoutEffect(() => {
      sendActionRef.current = () => void send();
    });

    const pickFile = (path: string) => {
      if (!mention) return;
      const result = replaceMention(value, mention, path);
      setValue(result.value);
      setCaret(result.caret);
      requestAnimationFrame(() => {
        textRef.current?.focus();
        textRef.current?.setSelectionRange(result.caret, result.caret);
      });
    };
    const pickCommand = (command: CommandInfo) => {
      const next = `/${command.name} `;
      setValue(next);
      setCaret(next.length);
      textRef.current?.focus();
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
      // ⌘⇧I predates the general attach button; keep it as an alias.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        ["a", "i"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        openFilePicker();
        return;
      }
      const open = mentionOpen || slashOpen;
      const length = mentionOpen ? mentionMatches.length : commandMatches.length;
      if (open) {
        if (event.key === "Escape") {
          event.preventDefault();
          setCaret(-1);
          return;
        }
        if (length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          setMenuIndex((i) => (i + (event.key === "ArrowDown" ? 1 : length - 1)) % length);
          return;
        }
        if (
          length &&
          (event.key === "Tab" || (event.key === "Enter" && !event.metaKey && !event.ctrlKey))
        ) {
          event.preventDefault();
          if (mentionOpen) {
            pickFile(mentionMatches[menuIndex].path);
          } else {
            pickCommand(commandMatches[menuIndex]);
          }
          return;
        }
      }
      if (
        !hideSendButton &&
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault();
        void send();
      }
    };

    const hasSubmission = !!(value.trim() || diffs.length || attachments.length);
    const canSend = hasSubmission && !disabled && !sending;
    const action = onCancel && !hasSubmission ? "stop" : "send";
    return (
      <div
        className={cn("relative", compact ? "p-1.5" : "p-2", className)}
        onDragEnter={(e) => {
          e.preventDefault();
          setRefDrag(isFileRefDrag(Array.from(e.dataTransfer.types)));
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setDragging(false);
            setRefDrag(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          setRefDrag(false);
          const mimePath = e.dataTransfer.getData?.(FILE_REF_MIME) ?? "";
          const plainPath = e.dataTransfer.getData?.("text/plain") ?? "";
          const refPath =
            mimePath && fileSet.has(mimePath)
              ? mimePath
              : plainPath && fileSet.has(plainPath)
                ? plainPath
                : "";
          if (refPath) {
            const dropCaret = textRef.current?.selectionStart ?? value.length;
            const result = insertFileRef(value, dropCaret, refPath);
            setValue(result.value);
            setCaret(result.caret);
            requestAnimationFrame(() => {
              textRef.current?.focus();
              textRef.current?.setSelectionRange(result.caret, result.caret);
            });
            return;
          }
          attach([...e.dataTransfer.files]);
        }}
      >
        {mentionOpen && (
          <FileMentionMenu
            files={mentionMatches}
            activeIndex={Math.min(menuIndex, Math.max(mentionMatches.length - 1, 0))}
            loading={filesLoading}
            onActive={setMenuIndex}
            onPick={(file) => pickFile(file.path)}
          />
        )}
        {slashOpen && (
          <SlashCommandMenu
            commands={commandMatches}
            menuIndex={menuIndex}
            onPick={pickCommand}
            onHover={setMenuIndex}
          />
        )}
        <div className="bg-deep-surface relative flex flex-col rounded-lg border border-input transition-colors focus-within:border-ring">
          {dragging && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/90 text-sm font-medium">
              {refDrag ? "Drop to attach file as context" : "Drop files to attach"}
            </div>
          )}
          {(diffs.length > 0 || attachments.length > 0) && (
            <AttachmentBar
              diffs={diffs}
              attachments={attachments}
              onRemoveDiff={removeDiff}
              onRemoveAttachment={removeAttachment}
            />
          )}
          <textarea
            ref={textRef}
            rows={compact ? 1 : 2}
            value={value}
            disabled={disabled || sending}
            onChange={(e) => {
              setValue(e.target.value);
              onDraftChange?.(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onClick={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const pasted = [...(e.clipboardData?.files ?? [])];
              if (pasted.length === 0) return;
              e.preventDefault();
              attach(pasted);
            }}
            placeholder={diffs.length || attachments.length ? "Add a message…" : placeholder}
            className={cn(
              "resize-none bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:opacity-50",
              compact ? "max-h-[180px] min-h-[52px] py-2" : "max-h-[220px] min-h-[76px] py-2.5",
            )}
          />
          {error && (
            <div role="alert" className="px-3 pb-1 text-xs text-destructive">
              {error}
            </div>
          )}
          <div className="flex items-center gap-1.5 px-2 pb-2 text-[11px] text-muted-foreground">
            {toolbar && <div className="flex flex-wrap items-center gap-1">{toolbar}</div>}
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              multiple
              onChange={(e) => {
                attach([...(e.currentTarget.files ?? [])]);
                e.currentTarget.value = "";
              }}
            />
            <AttachButton disabled={disabled || sending} onClick={openFilePicker} />
            <div className="ml-auto shrink-0">
              {contextUsage && contextUsage.size > 0 ? (
                <ContextUsageIndicator usage={contextUsage} />
              ) : (
                <span>⇧↵ newline</span>
              )}
            </div>
            {!hideSendButton && (
              <ComposerActionButton
                action={action}
                disabled={(action === "send" && !canSend) || stopping}
                sendActionRef={sendActionRef}
                onStop={() => void stop()}
                stopping={stopping}
              />
            )}
          </div>
        </div>
      </div>
    );
  },
);
