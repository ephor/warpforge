import { ChevronRight, File } from "lucide-react";
import { useState } from "react";

import { getFileIconUrl } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";

import type { FileDiff } from "../protocol";

/**
 * A collapsible directory tree of changed files (WebStorm-style), an
 * alternative to the flat file-tab strip. Purely a navigator: clicking a leaf
 * selects that file in the diff view.
 */
interface TreeNode {
  name: string;
  /** Set on leaves — the full file path. */
  path?: string;
  status?: FileDiff["status"];
  children: Map<string, TreeNode>;
}

function buildTree(files: FileDiff[]): TreeNode {
  const root: TreeNode = { children: new Map(), name: "" };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), name: part };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.path = f.path;
        child.status = f.status;
      }
      node = child;
    });
  }
  return root;
}

/** Collapse chains of single-child folders into one row (src/lib/foo). */
function compact(node: TreeNode): TreeNode {
  const children = [...node.children.values()].map(compact);
  if (!node.path && children.length === 1 && !children[0].path) {
    const only = children[0];
    return { ...only, name: `${node.name}/${only.name}` };
  }
  const map = new Map<string, TreeNode>();
  for (const c of children) {
    map.set(c.name, c);
  }
  return { ...node, children: map };
}

const STATUS_COLOR: Record<FileDiff["status"], string> = {
  added: "text-ok",
  deleted: "text-destructive",
  modified: "text-warn",
  renamed: "text-warn",
};

function Row({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  if (node.path) {
    const iconUrl = getFileIconUrl(node.name);
    return (
      <button
        style={pad}
        onClick={() => onSelect(node.path!)}
        title={node.path}
        className={cn(
          "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs",
          selected === node.path ? "bg-secondary text-foreground" : "hover:bg-secondary/50",
        )}
      >
        {iconUrl ? (
          <img src={iconUrl} alt="" aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <File className={cn("size-3.5 shrink-0", STATUS_COLOR[node.status ?? "modified"])} />
        )}
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  const children = [...node.children.values()].sort((a, b) => {
    // Folders first, then files, each alphabetical
    const af = a.path ? 1 : 0;
    const bf = b.path ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name);
  });

  return (
    <>
      <button
        style={pad}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs text-muted-foreground hover:bg-secondary/50"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="truncate">{node.name}</span>
      </button>
      {open &&
        children.map((c) => (
          <Row key={c.name} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
    </>
  );
}

export function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: FileDiff[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const root = compact(buildTree(files));
  const top = [...root.children.values()].sort((a, b) => {
    const af = a.path ? 1 : 0;
    const bf = b.path ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name);
  });
  return (
    <div className="py-1">
      {top.map((c) => (
        <Row key={c.name} node={c} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}
