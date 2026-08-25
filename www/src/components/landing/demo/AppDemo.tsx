import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import AppHeader from "@app/components/AppHeader";
import Sidebar from "@app/components/Sidebar";
import { TooltipProvider } from "@app/components/ui/tooltip";
import { daemon } from "@app/daemon";
import { SIDEBAR_WIDTH_MIN, useUi } from "@app/store/ui";
import TaskDetail from "@app/views/TaskDetail";

import { projectFiles } from "./files";
import { diffFor, fileDocFor, LEAD_TASK_ID, snapshot } from "./fixtures";
import { script } from "./script";

/** How long the finished run stays on screen before the demo replays. */
const REPLAY_PAUSE_MS = 6000;

/** Pre-opened in the editor so the Files surface is never an empty pane. */
const OPEN_FILE = "api/src/middleware/rate-limit.ts";

/**
 * The demo's own query client, rather than the app's exported one.
 *
 * Components read the client off React context, so nothing here needs the
 * app's instance — and borrowing it would drag a nominal type across the two
 * package trees, which ends with the checker and the bundler disagreeing about
 * how many query clients exist. Nothing is fetched over a network here, so
 * there is nothing to retry and nothing to go stale.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false, staleTime: 0 } },
});

/**
 * The landing page's demo: the desktop app, running on the page.
 *
 * Not a mock-up of the app — the app. `Sidebar`, `AppHeader` and `TaskDetail`
 * are imported straight out of `desktop/src`, and the only thing swapped is
 * what they read from: `daemon.enableDemoMode` seeds the store and serves the
 * reads, and `script.ts` replays a run through the real reducer.
 *
 * The upside is that this can never drift into a flattering lie — if a pill or
 * a diff row looks a certain way here, that is how the product looks. The cost
 * is that a refactor in `desktop/src` can break this build, which is the
 * trade we want: the website noticing is better than the website lying.
 */
/**
 * Widen `file.list` for the demo.
 *
 * Demo mode answers it with the diff's own files, which is right for its
 * original job — reviewing a change — but leaves the file tree showing a
 * four-file repository. Extending the reply here rather than in the app keeps
 * the demo's needs out of the daemon: every other call still goes to demo
 * mode untouched, and the changed flags come from the live diff, so the tree
 * and the changes rail can never disagree.
 */
function serveProjectFiles() {
  const inner = daemon.request.bind(daemon);
  daemon.request = (method: string, params?: unknown) => {
    if (method === "file.list") {
      return Promise.resolve(projectFiles(diffFor().files.map((file) => file.path)));
    }
    return inner(method, params);
  };
}

export default function AppDemo() {
  const { snapshot: live } = useSyncExternalStore(daemon.subscribe, daemon.getState);
  const [openTaskId, setOpenTaskId] = useState<string | null>(LEAD_TASK_ID);

  // Seed before first paint so the shell never flashes an empty state.
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    daemon.enableDemoMode({ diffFor, fileDocFor, sessionUpdates: {}, snapshot });
    serveProjectFiles();
    // The app's own defaults, minus the two that only make sense at desk
    // width: side-by-side diff needs more room than this frame has, and the
    // nav rail is wound down to the narrowest the app itself allows, so the
    // width goes to the task instead of to four menu items.
    useUi.setState({
      diffView: "unified",
      // The editor offers to install a language server when it cannot attach
      // one — which it never can here, there being no daemon to run it. The
      // app's own off switch is the honest way to not nag about it.
      lspEnabled: false,
      // Open a file through the app's own "go to this file" navigation, so the
      // Files tab has a tab strip and a loaded editor waiting when a visitor
      // gets there instead of an empty pane. The surface it forces on the way
      // through is put back below.
      openTaskNav: { path: OPEN_FILE, surface: "files" },
      sidebarWidth: SIDEBAR_WIDTH_MIN,
    });
  }

  // Opening that file switches the surface to Files, which is not where the
  // story starts. Put it back once the navigation has been consumed.
  useEffect(() => {
    const frame = requestAnimationFrame(() => useUi.setState({ activeSurface: "diff" }));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Run the script, hold on the finished state, then start over. Timers are
  // chained rather than scheduled up front so a paused background tab resumes
  // where it left off instead of firing the rest of the run at once.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const step = (index: number) => {
      if (cancelled) return;
      if (index === script.length) {
        timer = setTimeout(() => {
          if (cancelled) return;
          // Reseeding clears the transcript and the diff. The `file.list`
          // wrapper lives on the client itself and survives, so it is
          // installed once at mount rather than re-wrapped every replay.
          daemon.enableDemoMode({ diffFor, fileDocFor, sessionUpdates: {}, snapshot });
          step(0);
        }, REPLAY_PAUSE_MS);
        return;
      }
      const beat = script[index];
      timer = setTimeout(() => {
        daemon.demoEvent(beat.event);
        step(index + 1);
      }, beat.after);
    };
    step(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const openTask = live.tasks.find((task) => task.id === openTaskId) ?? null;
  const noop = () => {};

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <div
          className="flex h-full w-full overflow-hidden bg-background text-foreground"
        >
          <aside style={{ width: SIDEBAR_WIDTH_MIN }}
            className="flex shrink-0 flex-col overflow-hidden">
            <Sidebar
              collapsed={false}
              connection="connected"
              onNewTask={noop}
              onOpenProject={noop}
              onOpenSettings={noop}
              onOpenTask={setOpenTaskId}
              onSelectView={noop}
              onToggleCollapsed={noop}
              openTaskId={openTaskId}
              state={daemon.getState()}
              view="control"
            />
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <AppHeader
              onAddProject={noop}
              onCloseTask={noop}
              openTask={openTask}
              view="control"
            />
            <main className="min-h-0 flex-1 overflow-hidden p-2">
              {openTask && (
                <TaskDetail
                  onOpenPush={noop}
                  onOpenTask={setOpenTaskId}
                  snapshot={live}
                  task={openTask}
                />
              )}
            </main>
          </div>
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
