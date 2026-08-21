import { Check, ChevronDown, FolderGit2 } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";

import AccountSwitcher from "@/components/AccountSwitcher";
import { TaskMenu } from "@/components/TaskMenu";
import { TaskTitleEditor } from "@/components/TaskTitleEditor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UpdateBanner } from "@/components/UpdateBanner";
import { daemon } from "@/daemon";
import { buildTaskGroupIndex, isTaskGroupPinned, setTaskGroupPinned } from "@/lib/taskGroups";
import type { TaskInfo } from "@/protocol";
import { useUi, type View } from "@/store/ui";

const VIEW_LABEL: Record<View, string> = {
  control: "Mission Control",
  projects: "Projects",
};

interface AppHeaderProps {
  view: View;
  openTask: TaskInfo | null;
  onAddProject: () => void;
  onCloseTask: () => void;
}

/**
 * Global chrome: a breadcrumb row plus the account
 * switcher for whichever agents are relevant. App update and daemon
 * connection moved to the sidebar footer/brand row — chrome you check once in
 * a while doesn't need to sit in the row you look at constantly. Brand,
 * navigation, New task and Settings live in the sidebar too.
 *
 * When a task is open, the breadcrumb's second segment becomes its (editable)
 * title, and its agent plus the task menu appear before the account switcher.
 * Project and status are deliberately not repeated here: the sidebar already
 * establishes which project you're in, and status is one glance away in the
 * conversation itself. Navigating to another view (sidebar nav, or clicking
 * another task) closes this one — no separate back control needed.
 */
export default function AppHeader({ view, openTask, onAddProject, onCloseTask }: AppHeaderProps) {
  // Accounts come straight from the daemon rather than through App: the chip is
  // the only consumer, and threading them through every render of the shell
  // would couple unrelated views to account state.
  const { snapshot } = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const openProject = useUi((s) => s.openProject);
  const pinnedTaskIds = useUi((s) => s.pinnedTaskIds);
  const setPinnedTaskIds = useUi((s) => s.setPinnedTaskIds);
  const isProjects = view === "projects" && !openTask;
  const crumbProject =
    isProjects && snapshot.projects.length > 0
      ? (snapshot.projects.find((p) => p.name === selectedProjectId) ?? snapshot.projects[0])
      : null;
  const taskGroupIndex = useMemo(() => buildTaskGroupIndex(snapshot.tasks), [snapshot.tasks]);
  const taskPinned = openTask
    ? isTaskGroupPinned(taskGroupIndex, pinnedTaskIds, openTask.id)
    : false;

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 bg-card/80 px-2.5">
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground"
      >
        <span className="text-xs">Warpforge</span>
        <span aria-hidden className="text-xs text-muted-foreground/60">
          /
        </span>
        {openTask ? (
          <TaskTitleEditor task={openTask} />
        ) : isProjects ? (
          <>
            <span className="text-xs">Projects</span>
            <span aria-hidden className="text-xs text-muted-foreground/60">
              /
            </span>
            {crumbProject && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Switch project"
                    className="flex min-w-0 max-w-56 items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span className="truncate">{crumbProject.name}</span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {snapshot.projects.map((p) => (
                    <DropdownMenuItem
                      key={p.name}
                      onSelect={() => openProject(p.name)}
                      className="gap-2"
                    >
                      <FolderGit2 className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {p.name === crumbProject.name && <Check className="size-4 text-primary" />}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onAddProject} className="gap-2">
                    <FolderGit2 className="size-4 text-muted-foreground" />
                    Add project
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        ) : (
          <strong className="min-w-0 truncate text-sm font-medium text-foreground">
            {VIEW_LABEL[view]}
          </strong>
        )}
      </nav>

      <UpdateBanner />

      {openTask && (
        <>
          {/* This task's harness, in place of the old static badge — same
              interactive account chip the global cluster renders, just scoped
              to this one agent and shown even with a single account. Note it
              still switches the agent's *global* active account (there is no
              per-task binding yet): see memory/per_task_account_switch. */}
          <AccountSwitcher
            agents={snapshot.agents ?? []}
            accounts={snapshot.accounts ?? []}
            agentFilter={openTask.agent}
            alwaysShow
          />
          <TaskMenu
            task={openTask}
            pinned={taskPinned}
            onTogglePin={() =>
              setPinnedTaskIds(
                setTaskGroupPinned(taskGroupIndex, pinnedTaskIds, openTask.id, !taskPinned),
              )
            }
            onClose={onCloseTask}
          />
        </>
      )}

      {/* Only relevant outside a task: an open task already shows its own
          harness's account chip on the left, and a *different* agent's
          switcher here would just be account chrome for a tool this task
          doesn't use. Global-view screens (Mission Control, Projects)
          have no single agent in focus, so the full switcher belongs there. */}
      {!openTask && (
        <div className="ml-auto">
          <AccountSwitcher agents={snapshot.agents ?? []} accounts={snapshot.accounts ?? []} />
        </div>
      )}
    </header>
  );
}
