import type { FileDiff } from "../../protocol";

export interface Stat {
  adds: number;
  dels: number;
  status: FileDiff["status"];
}

export function stat(f: FileDiff): Stat {
  let adds = 0;
  let dels = 0;
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) {
        adds++;
      } else if (l.startsWith("-")) {
        dels++;
      }
    }
  }
  return { adds, dels, status: f.status };
}

export interface Node {
  name: string;
  path?: string;
  stat?: Stat;
  children: Map<string, Node>;
}

export function buildTree(files: FileDiff[]): Node {
  const root: Node = { children: new Map(), name: "" };
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
        child.stat = stat(f);
      }
      node = child;
    });
  }
  return root;
}

export function compact(node: Node): Node {
  const children = [...node.children.values()].map(compact);
  if (!node.path && children.length === 1 && !children[0].path) {
    const only = children[0];
    return { ...only, name: node.name ? `${node.name}/${only.name}` : only.name };
  }
  const map = new Map<string, Node>();
  for (const c of children) {
    map.set(c.name, c);
  }
  return { ...node, children: map };
}

export function leaves(node: Node): string[] {
  if (node.path) {
    return [node.path];
  }
  return [...node.children.values()].flatMap(leaves);
}

export const STATUS: Record<FileDiff["status"], { glyph: string; color: string }> = {
  added: { color: "text-ok", glyph: "A" },
  deleted: { color: "text-destructive", glyph: "D" },
  modified: { color: "text-sky-400", glyph: "M" },
  renamed: { color: "text-warn", glyph: "R" },
};

export function sortChildren(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => {
    const af = a.path ? 1 : 0;
    const bf = b.path ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name);
  });
}

export function folderKey(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

export function collectFolderKeys(node: Node, parentPath: string, out: Set<string>): void {
  for (const child of node.children.values()) {
    if (!child.path) {
      const fk = folderKey(parentPath, child.name);
      out.add(fk);
      collectFolderKeys(child, fk, out);
    }
  }
}

export interface FlatRow {
  key: string;
  node: Node;
  depth: number;
  fKey?: string;
}

export function flattenNode(
  node: Node,
  depth: number,
  parentPath: string,
  openFolders: Set<string>,
  out: FlatRow[],
): void {
  const kids = sortChildren(node);
  for (const child of kids) {
    if (child.path) {
      out.push({ key: child.path, node: child, depth });
    } else {
      const fk = folderKey(parentPath, child.name);
      out.push({ key: `f:${fk}`, node: child, depth, fKey: fk });
      if (openFolders.has(fk)) {
        flattenNode(child, depth + 1, fk, openFolders, out);
      }
    }
  }
}
