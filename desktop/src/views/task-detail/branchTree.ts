/**
 * WebStorm-style branch grouping: `feat/agent-account/foo` becomes
 * feat ▸ agent-account ▸ foo. Each `/` segment is a folder node; the last
 * segment is the branch leaf. Mirrors the Changes-rail tree conventions.
 */

export interface BranchTreeNode {
  name: string;
  branch?: string;
  children: Map<string, BranchTreeNode>;
}

export function buildBranchTree(branches: string[]): BranchTreeNode {
  const root: BranchTreeNode = { name: "", children: new Map() };
  for (const branch of branches) {
    const parts = branch.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), name: part };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.branch = branch;
      }
      node = child;
    });
  }
  return root;
}

export interface BranchRow {
  key: string;
  depth: number;
  /** Folder label when `branch` is absent, leaf name when present. */
  label: string;
  branch?: string;
  fKey?: string;
  /** Remote-tracking rows (e.g. `origin/main`) can't be switched to directly. */
  remote?: boolean;
}

export function flattenBranchTree(
  node: BranchTreeNode,
  depth: number,
  parentKey: string,
  openFolders: Set<string>,
  out: BranchRow[],
): void {
  const kids = [...node.children.values()].sort((a, b) => {
    const af = a.branch ? 1 : 0;
    const bf = b.branch ? 1 : 0;
    if (af !== bf) return af - bf;
    return intersectPriority(a.name) - intersectPriority(b.name) || a.name.localeCompare(b.name);
  });
  for (const child of kids) {
    const childKey = parentKey ? `${parentKey}/${child.name}` : child.name;
    if (child.branch) {
      out.push({ key: child.branch, depth, label: child.name, branch: child.branch });
    } else {
      out.push({ key: `f:${childKey}`, depth, label: child.name, fKey: childKey });
      if (openFolders.has(childKey)) {
        flattenBranchTree(child, depth + 1, childKey, openFolders, out);
      }
    }
  }
}

/** `main` outranks other top-level branches while sorting leaves. */
function intersectPriority(name: string): number {
  return name === "main" ? -1 : 0;
}

/** Seed `openFolders` so top-level folders appear expanded by default. */
export function defaultOpenFolders(root: BranchTreeNode): Set<string> {
  const out = new Set<string>();
  for (const child of root.children.values()) {
    if (!child.branch) {
      out.add(child.name);
    }
  }
  return out;
}
