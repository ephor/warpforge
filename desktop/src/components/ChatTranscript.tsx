import type { FileLinkResolver } from "@/components/Markdown";
import type { SessionActivity } from "@/lib/sessionActivity";

import type {
  AgentConfig,
  CommandInfo,
  EditHunk,
  ProjectFile,
  SessionUpdate,
  TaskInfo,
} from "../protocol";
import type { ComposerHandle } from "./Composer";
import { SessionChat } from "./SessionChat";

interface Props {
  activity: SessionActivity | null;
  active: boolean;
  commands: CommandInfo[];
  composerRef: React.Ref<ComposerHandle>;
  files: ProjectFile[];
  filesLoading: boolean;
  imageSupported: boolean;
  onOpenFile: (path: string) => void;
  onOpenFileDiff: (path: string, hunks?: EditHunk[]) => void;
  resolveFilePath: FileLinkResolver;
  task: TaskInfo;
  updates: SessionUpdate[];
  agents: AgentConfig[];
  onOpenTask: (id: string) => void;
}

export function ChatTranscript(props: Props) {
  return <SessionChat {...props} />;
}
