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

import { useTrackerStatus } from "./use-tracker";

/** Radix Select forbids an empty item value, so "not mapped" needs a sentinel. */
const NONE = "__none__";

/**
 * Which Linear team this project reads.
 *
 * A Linear API key sees the whole account, so unlike GitHub — where the
 * repository is the scope — nothing about a project tells warpforge which of the
 * account's issues are its work. Until a team is picked here, the project
 * imports no Linear issues at all; picking one is what turns the import on.
 * Absent when Linear is not connected, so a GitHub-only setup never sees it.
 */
export function LinearTeamPicker({ project }: { project: string }) {
  const queryClient = useQueryClient();
  const status = useTrackerStatus();
  const connected = status.data?.linear?.connected === true;

  const settings = useQuery({
    queryKey: ["tracker", "projectSettings", project],
    queryFn: () => daemon.trackerProjectSettings(project),
    enabled: connected,
  });
  const teams = useQuery({
    queryKey: ["tracker", "linearTeams"],
    queryFn: () => daemon.linearTeams(),
    enabled: connected,
    staleTime: 5 * 60_000,
  });

  const setTeam = useMutation({
    mutationFn: (team: LinearTeam | null) => daemon.setProjectLinearTeam(project, team),
    onSuccess: (next) => {
      queryClient.setQueryData(["tracker", "projectSettings", project], next);
      // The mapping decides which rows exist, so the board is stale either way:
      // a new team has issues to import, and dropping one took its rows with it.
      void queryClient.invalidateQueries({ queryKey: ["backlog", project] });
    },
    onError: (error: Error) =>
      toast.error("Could not change the Linear team", { description: error.message }),
  });

  if (!connected) return null;

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
        aria-label="Linear team"
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
