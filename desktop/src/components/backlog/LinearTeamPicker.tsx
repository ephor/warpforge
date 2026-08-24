import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { daemon } from "@/daemon";
import { cn } from "@/lib/utils";
import type { LinearTeam } from "@/protocol";

import { TRACKER_PROJECT_SOURCES_KEY, useProjectSources, useTrackerStatus } from "./use-tracker";

/** Radix Select forbids an empty item value, so "not mapped" needs a sentinel. */
const NONE = "__none__";

/**
 * Which Linear team a project reads, as a plain select. No gating: the caller
 * decides when mapping is relevant (the toolbar hides it for projects without
 * Linear; Settings lists it for every project so the first team can be mapped).
 *
 * A Linear API key sees the whole account, so unlike GitHub — where the
 * repository is the scope — nothing about a project tells warpforge which of
 * the account's issues are its work. Until a team is picked here, the project
 * imports no Linear issues at all; picking one is what turns the import on.
 */
export function ProjectLinearTeamSelect({ project }: { project: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["tracker", "projectSettings", project],
    queryFn: () => daemon.trackerProjectSettings(project),
  });
  const teams = useQuery({
    queryKey: ["tracker", "linearTeams"],
    queryFn: () => daemon.linearTeams(),
    staleTime: 5 * 60_000,
  });

  const setTeam = useMutation({
    mutationFn: (team: LinearTeam | null) => daemon.setProjectLinearTeam(project, team),
    onSuccess: (next) => {
      queryClient.setQueryData(["tracker", "projectSettings", project], next);
      // The mapping decides which rows exist and whether Linear counts as a
      // source here at all, so both go stale together.
      void queryClient.invalidateQueries({
        queryKey: [...TRACKER_PROJECT_SOURCES_KEY, project],
      });
      void queryClient.invalidateQueries({ queryKey: ["backlog", project] });
    },
    onError: (error: Error) =>
      toast.error("Could not change the Linear team", { description: error.message }),
  });

  const current = settings.data?.linearTeamId ?? null;
  const options = teams.data ?? [];

  return (
    <Select
      value={current ?? NONE}
      disabled={setTeam.isPending || teams.isLoading}
      onValueChange={(next) =>
        setTeam.mutate(next === NONE ? null : (options.find((t) => t.id === next) ?? null))
      }
    >
      <SelectTrigger
        aria-label={`Linear team for ${project}`}
        className={cn("h-7 w-auto gap-1.5 text-xs", current === null && "text-muted-foreground")}
      >
        <SelectValue placeholder="Linear team" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No Linear team</SelectItem>
        {options.map((team) => (
          <SelectItem key={team.id} value={team.id}>
            {team.key ? `${team.key} · ${team.name}` : team.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Toolbar variant: only rendered when this project actually reads Linear
 * (connected key plus a mapped team), so GitHub-only projects never see an
 * empty selector that could not apply to them. First-time mapping happens in
 * Settings → Trackers, where every project is listed.
 */
export function LinearTeamPicker({ project }: { project: string }) {
  const status = useTrackerStatus();
  const connected = status.data?.linear?.connected === true;
  const sources = useProjectSources(project);

  if (!connected || sources.data?.linear !== true) return null;
  return <ProjectLinearTeamSelect project={project} />;
}
