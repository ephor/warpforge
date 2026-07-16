import { FileDiff, FileMinus, FilePen, FilePlus, ImagePlus, Send, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
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
import type {
  CommandInfo,
  FileDiff as FileDiffType,
  ProjectFile,
  PromptSubmission,
} from "../protocol";
import { FileMentionMenu } from "./composer/FileMentionMenu";
import { ImageAttachmentPreview } from "./composer/ImageAttachmentPreview";

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

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSend: (submission: PromptSubmission) => void | Promise<void>;
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
  }
>(
  (
    {
      onSend,
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

    useEffect(() => {
      imagesRef.current = images;
    }, [images]);
    useEffect(() => () => revokeImagePreviews(imagesRef.current), []);
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
        void send();
      },
    }));

    useLayoutEffect(() => {
      const el = textRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    }, [value]);

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

    const canSend = !!(value.trim() || diffs.length || images.length) && !disabled && !sending;
    return (
      <div
        className="relative p-2"
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
          <div className="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-[50vh] overflow-y-auto rounded-md border bg-popover shadow-md">
            {commandMatches.map((command, index) => (
              <button
                type="button"
                key={command.name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickCommand(command);
                }}
                onMouseEnter={() => setMenuIndex(index)}
                className={cn(
                  "flex w-full flex-col items-start px-3 py-1.5 text-left text-sm",
                  index === menuIndex ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <span className="font-mono text-primary">/{command.name}</span>
                {command.description && (
                  <span className="text-xs text-muted-foreground">{command.description}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="relative flex flex-col rounded-lg border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
          {dragging && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/90 text-sm font-medium">
              Drop PNG or JPEG images
            </div>
          )}
          {(diffs.length > 0 || images.length > 0) && (
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
                    onClick={() => setDiffs((prev) => prev.filter((d) => d.id !== a.id))}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              {images.map((image) => (
                <ImageAttachmentPreview
                  key={image.id}
                  image={image}
                  onRemove={() => {
                    URL.revokeObjectURL(image.previewUrl);
                    setImages((prev) => prev.filter((item) => item.id !== image.id));
                  }}
                />
              ))}
            </div>
          )}
          <textarea
            ref={textRef}
            rows={2}
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
            placeholder={diffs.length || images.length ? "Add a message (optional)…" : placeholder}
            className="max-h-[220px] min-h-[76px] resize-none bg-transparent px-3 py-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:opacity-50"
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
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5"
              disabled={!imageSupported || disabled || sending}
              title={imageSupported ? "Attach images (⌘⇧I)" : "This agent does not support images"}
              onClick={() => inputRef.current?.click()}
            >
              <ImagePlus className="size-3" />
            </Button>
            <span className="ml-auto shrink-0">⇧↵ newline</span>
            {!hideSendButton && (
              <Button
                type="button"
                size="icon"
                aria-label="Send"
                className="size-7 shrink-0"
                onClick={() => void send()}
                disabled={!canSend}
              >
                <Send className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  },
);
