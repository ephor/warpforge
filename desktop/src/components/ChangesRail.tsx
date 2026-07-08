import { useEffect, useMemo, useState } from "react";
import { ChevronRight, GitCommitVertical } from "lucide-react";
import { FileDiff } from "../protocol";
import { daemon } from "../daemon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * JetBrains-Air "Changes" rail: a grouped tree of changed files with per-file
 * (and per-folder) staging checkboxes and +adds/-dels counts, plus an inline
 * commit box at the bottom. Clicking a file selects it in the diff view.
 */

interface Stat {
  adds: number;
  dels: number;
  status: FileDiff["status"];
}

function stat(f: FileDiff): Stat {
  let adds = 0;
  let dels = 0;
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) adds++;
      else if (l.startsWith("-")) dels++;
    }
  }
  return { adds, dels, status: f.status };
}

interface Node {
  name: string;
  path?: string; // set on leaves
  stat?: Stat;
  children: Map<string, Node>;
}

function buildTree(files: FileDiff[]): Node {
  const root: Node = { name: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.path = f.path;
        child.stat = stat(f);
      }
      node = child;
    });
  }
  return root;
}

/** Collapse single-child folder chains into one row (plans/sub). */
function compact(node: Node): Node {
  const children = [...node.children.values()].map(compact);
  if (!node.path && children.length === 1 && !children[0].path) {
    const only = children[0];
    return { ...only, name: node.name ? `${node.name}/${only.name}` : only.name };
  }
  const map = new Map<string, Node>();
  for (const c of children) map.set(c.name, c);
  return { ...node, children: map };
}

function leaves(node: Node): string[] {
  if (node.path) return [node.path];
  return [...node.children.values()].flatMap(leaves);
}

const STATUS: Record<FileDiff["status"], { glyph: string; color: string }> = {
  added: { glyph: "A", color: "text-ok" },
  deleted: { glyph: "D", color: "text-destructive" },
  renamed: { glyph: "R", color: "text-warn" },
  modified: { glyph: "M", color: "text-sky-400" },
};

function sortChildren(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => {
    const af = a.path ? 1 : 0;
    const bf = b.path ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name);
  });
}

function Row({
  node,
  depth,
  selected,
  staged,
  onSelect,
  onToggle,
}: {
  node: Node;
  depth: number;
  selected: string | null;
  staged: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (paths: string[], on: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  if (node.path) {
    const st = node.stat!;
    const s = STATUS[st.status];
    const on = staged.has(node.path);
    return (
      <div
        className={cn(
          "group flex items-center gap-1.5 py-0.5 pr-2 text-xs",
          selected === node.path ? "bg-secondary" : "hover:bg-secondary/50",
        )}
        style={pad}
      >
        <input
          type="checkbox"
          checked={on}
          onChange={() => onToggle([node.path!], !on)}
          className="size-3 shrink-0"
        />
        <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", s.color)}>
          {s.glyph}
        </span>
        <button
          onClick={() => onSelect(node.path!)}
          title={node.path}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="truncate">{node.name}</span>
          <span className="tnum ml-auto shrink-0 font-mono text-[10px]">
            {st.adds > 0 && <span className="text-ok">+{st.adds}</span>}{" "}
            {st.dels > 0 && <span className="text-destructive">-{st.dels}</span>}
          </span>
        </button>
      </div>
    );
  }

  const kids = sortChildren(node);
  const paths = leaves(node);
  const on = paths.filter((p) => staged.has(p)).length;
  const state = on === 0 ? "off" : on === paths.length ? "on" : "some";
  return (
    <>
      <div className="flex items-center gap-1.5 py-0.5 pr-2 text-xs text-muted-foreground" style={pad}>
        <input
          type="checkbox"
          checked={state === "on"}
          ref={(el) => el && (el.indeterminate = state === "some")}
          onChange={() => onToggle(paths, state !== "on")}
          className="size-3 shrink-0"
        />
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="truncate">{node.name}</span>
          <span className="ml-1 shrink-0 text-[10px] text-muted-foreground/60">
            {paths.length} files
          </span>
        </button>
      </div>
      {open &&
        kids.map((c) => (
          <Row
            key={c.name}
            node={c}
            depth={depth + 1}
            selected={selected}
            staged={staged}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

export function ChangesRail({
  project,
  files,
  selected,
  onSelect,
  taskId,
  onCommitted,
}: {
  project: string;
  files: FileDiff[];
  selected: string | null;
  onSelect: (path: string) => void;
  taskId: string;
  onCommitted: () => void;
}) {
  const allPaths = useMemo(() => files.map((f) => f.path), [files]);
  const [staged, setStaged] = useState<Set<string>>(() => new Set(allPaths));
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync selection as the diff's file set changes (keep prior choices).
  useEffect(() => {
    setStaged((prev) => new Set(allPaths.filter((p) => prev.has(p) || prev.size === 0)));
  }, [allPaths]);

  // Wrap the project's files under a single root labelled with the project.
  const root = useMemo(() => {
    const tree = compact(buildTree(files));
    return { name: project, children: tree.children } as Node;
  }, [files, project]);

  const toggle = (paths: string[], on: boolean) =>
    setStaged((prev) => {
      const next = new Set(prev);
      for (const p of paths) (on ? next.add(p) : next.delete(p));
      return next;
    });

  const canCommit = !busy && staged.size > 0 && (message.trim().length > 0 || amend);

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const all = staged.size === allPaths.length;
      await daemon.request("git.commit", {
        task_id: taskId,
        message: message.trim(),
        files: all ? null : [...staged],
        amend,
      });
      setMessage("");
      setAmend(false);
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-3 py-2.5 text-sm font-semibold">Changes</div>
      <div className="flex items-center gap-2 border-y bg-secondary/40 px-3 py-1 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={staged.size === allPaths.length && allPaths.length > 0}
          ref={(el) => el && (el.indeterminate = staged.size > 0 && staged.size < allPaths.length)}
          onChange={(e) => setStaged(e.target.checked ? new Set(allPaths) : new Set())}
          className="size-3"
        />
        <span className="tnum">
          {staged.size}/{allPaths.length} files
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        <Row
          node={root}
          depth={0}
          selected={selected}
          staged={staged}
          onSelect={onSelect}
          onToggle={toggle}
        />
      </div>

      <div className="flex flex-col gap-2 border-t p-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          rows={3}
          className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => setAmend(e.target.checked)}
              className="size-3"
            />
            amend
          </label>
          <Button size="sm" className="ml-auto h-7" disabled={!canCommit} onClick={commit}>
            <GitCommitVertical className="size-3.5" />
            {busy ? "…" : amend ? "Amend" : "Commit"}
          </Button>
        </div>
      </div>
    </div>
  );
}
