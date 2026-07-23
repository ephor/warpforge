import { ImagePlus, Send, Square } from "lucide-react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import {
  extractFileReferences,
  findMentionAtCaret,
  rankFiles,
  replaceMention,
} from "../lib/composerMentions";
import type { ImageAttachmentDraft } from "../lib/imageAttachments";
import {
  fileToImageAttachment,
  revokeImagePreviews,
  validateImageFiles,
} from "../lib/imageAttachments";
import { compactTokenCount, type ContextUsage } from "../lib/sessionUsage";
import type {
  CommandInfo,
  FileDiff as FileDiffType,
  ProjectFile,
  PromptSubmission,
} from "../protocol";
import { AttachmentBar } from "./composer/AttachmentBar";
import { FileMentionMenu } from "./composer/FileMentionMenu";
import { SlashCommandMenu } from "./composer/SlashCommandMenu";

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
  submit: () => void;
}
const EMPTY_COMMANDS: CommandInfo[] = [];
const EMPTY_FILES: ProjectFile[] = [];

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSend: (submission: PromptSubmission) => void | Promise<void>;
    onCancel?: () => void;
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
    },
    ref,
  ) => {
    const [value, setValue] = useState(initialValue);
    const [caret, setCaret] = useState(0);
    const [menuIndex, setMenuIndex] = useState(0);
    const [diffs, setDiffs] = useState<ComposerAttachment[]>([]);
    const [images, setImages] = useState<ImageAttachmentDraft[]>([]);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const textRef = useRef<HTMLTextAreaElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const imagesRef = useRef(images);
    const sendActionRef = useRef<() => void>(() => {});

    useEffect(() => {
      imagesRef.current = images;
    }, [images]);
    useEffect(() => () => revokeImagePreviews(imagesRef.current), []);

    const removeDiff = useCallback((id: string) => {
      setDiffs((prev) => prev.filter((diff) => diff.id !== id));
    }, []);

    const removeImage = useCallback((image: ImageAttachmentDraft) => {
      URL.revokeObjectURL(image.previewUrl);
      setImages((prev) => prev.filter((item) => item.id !== image.id));
    }, []);

    const openImagePicker = useCallback(() => {
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
    const fileAttachments = extractFileReferences(value).filter((path) => fileSet.has(path));

    const addImages = async (incoming: File[]) => {
      setError(null);
      const imageFiles = incoming;
      const validation = validateImageFiles(imageFiles, images);
      if (validation) {
        setError(validation);
        return;
      }
      try {
        const drafts = await Promise.all(imageFiles.map(fileToImageAttachment));
        setImages((prev) => [...prev, ...drafts]);
      } catch {
        setError("Could not read one of the selected images.");
      }
    };

    async function send() {
      const text = value.trim();
      if ((!text && diffs.length === 0 && images.length === 0) || disabled || sending) return;
      const parts = text ? [text] : [];
      diffs.forEach((diff) => parts.push(`\`\`\`diff\n${diff.content}\n\`\`\``));
      setSending(true);
      setError(null);
      try {
        await onSend({
          text: parts.join("\n\n"),
          attachments: [
            ...fileAttachments.map((path) => ({ type: "file" as const, path })),
            ...images.map((image) => image.attachment),
          ],
        });
        revokeImagePreviews(images);
        setValue("");
        setDiffs([]);
        setImages([]);
        setCaret(0);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Message could not be sent.");
      } finally {
        setSending(false);
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
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        if (imageSupported) inputRef.current?.click();
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

    const hasSubmission = !!(value.trim() || diffs.length || images.length);
    const canSend = hasSubmission && !disabled && !sending;
    const action = onCancel && !hasSubmission ? "stop" : "send";
    return (
      <div
        className={cn("relative", compact ? "p-1.5" : "p-2")}
        onDragEnter={(e) => {
          e.preventDefault();
          if (imageSupported) setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (imageSupported) void addImages([...e.dataTransfer.files]);
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
        <div className="bg-deep-surface relative flex flex-col rounded-lg border border-input focus-within:ring-2 focus-within:ring-ring">
          {dragging && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/90 text-sm font-medium">
              Drop PNG or JPEG images
            </div>
          )}
          {(diffs.length > 0 || images.length > 0) && (
            <AttachmentBar
              diffs={diffs}
              images={images}
              onRemoveDiff={removeDiff}
              onRemoveImage={removeImage}
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
            placeholder={diffs.length || images.length ? "Add a message…" : placeholder}
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
              accept="image/png,image/jpeg"
              onChange={(e) => {
                void addImages([...(e.currentTarget.files ?? [])]);
                e.currentTarget.value = "";
              }}
            />
            <ImageUploadButton
              disabled={!imageSupported || disabled || sending}
              imageSupported={imageSupported}
              onClick={openImagePicker}
            />
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
                disabled={action === "send" && !canSend}
                sendActionRef={sendActionRef}
                onStop={onCancel}
              />
            )}
          </div>
        </div>
      </div>
    );
  },
);

const ComposerActionButton = memo(function ComposerActionButton({
  action,
  disabled,
  sendActionRef,
  onStop,
}: {
  action: "send" | "stop";
  disabled: boolean;
  sendActionRef: React.RefObject<() => void>;
  onStop?: () => void;
}) {
  const stopping = action === "stop";

  return (
    <Button
      type="button"
      size="icon"
      variant={stopping ? "destructive" : "default"}
      aria-label={stopping ? "Stop" : "Send"}
      className="size-6 shrink-0"
      onClick={stopping ? onStop : () => sendActionRef.current?.()}
      disabled={disabled}
    >
      {stopping ? <Square className="size-3 fill-current" /> : <Send className="size-3" />}
    </Button>
  );
});

const ImageUploadButton = memo(function ImageUploadButton({
  disabled,
  imageSupported,
  onClick,
}: {
  disabled: boolean;
  imageSupported: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-5"
      disabled={disabled}
      title={imageSupported ? "Attach images (⌘⇧I)" : "This agent does not support images"}
      onClick={onClick}
    >
      <ImagePlus className="size-3" />
    </Button>
  );
});

const ContextUsageIndicator = memo(function ContextUsageIndicator({
  usage,
}: {
  usage: ContextUsage;
}) {
  const used = Math.max(0, usage.used);
  const size = Math.max(1, usage.size);
  const remaining = Math.max(0, size - used);
  const percentage = Math.min(100, Math.round((used / size) * 100));
  const tone =
    percentage >= 90
      ? "text-destructive"
      : percentage >= 75
        ? "text-warn"
        : "text-muted-foreground";
  const progressTone =
    percentage >= 90 ? "bg-destructive" : percentage >= 75 ? "bg-warn" : "bg-primary";
  const cost = usage.cost
    ? ` · ${usage.cost.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${usage.cost.currency}`
    : "";
  const detail = `${compactTokenCount(used)} used · ${compactTokenCount(remaining)} remaining · ${compactTokenCount(size)} total${cost}`;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Context window: ${detail}`}
          title="Context window"
          className={cn(
            "flex size-6 items-center justify-center rounded-md outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
            tone,
          )}
        >
          <span
            aria-hidden="true"
            className="relative size-4 rounded-full"
            style={{
              background: `conic-gradient(currentColor ${percentage * 3.6}deg, hsl(var(--secondary)) 0deg)`,
            }}
          >
            <span className="bg-deep-surface absolute inset-[3px] rounded-full" />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-72 space-y-3 rounded-lg p-4"
      >
        <div className="tnum flex items-center justify-between gap-4 text-sm">
          <span className="font-semibold text-foreground">Context Window</span>
          <span className={cn("shrink-0", tone)}>
            {percentage}% · {compactTokenCount(used)}/{compactTokenCount(size)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn("h-full rounded-full transition-[width]", progressTone)}
            style={{ width: `${percentage}%` }}
          />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The agent can compact its context automatically when needed.
        </p>
        {usage.cost && (
          <p className="tnum border-t pt-3 text-xs text-muted-foreground">
            Session cost ·{" "}
            {usage.cost.amount.toLocaleString(undefined, {
              maximumFractionDigits: 4,
            })}{" "}
            {usage.cost.currency}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
