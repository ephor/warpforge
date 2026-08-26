import { diff } from "@codemirror/merge";
import { RangeSetBuilder, StateField, Text } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";

/** A contiguous changed block in the new file (1-based line numbers). */
export interface ChangeBlock {
  type: "added" | "modified";
  from: number;
  to: number;
  /** Old text that was replaced (for modified) — joined; empty for added. */
  oldText: string;
  oldLines: string[];
  newFromCh: number;
  newToCh: number;
  fragments: RawFragment[];
}

export interface DeletedBlock {
  type: "deleted";
  /** 1-based line in new file where deletion occurs (marker appears at this line; for empty file line=1). */
  line: number;
  oldText: string;
  oldLines: string[];
  oldFromCh: number;
  oldToCh: number;
  fragments: RawFragment[];
}

export interface GutterChanges {
  blocks: ChangeBlock[];
  deleted: DeletedBlock[];
}

export interface RawFragment {
  newFromCh: number;
  newToCh: number;
  oldFromCh: number;
  oldToCh: number;
  oldText: string;
  newText: string;
  type: "added" | "modified" | "deleted";
  newFromLine: number;
  newToLine: number;
}

function lineNumberAt(doc: Text, offset: number): number {
  if (doc.length === 0) return 1;
  const clamped = Math.max(0, Math.min(offset, doc.length - 1));
  return doc.lineAt(clamped).number;
}

function lineNumberAtStrict(newText: string, offset: number, doc: Text): number {
  if (newText.length === 0) return 1;
  if (offset >= doc.length) return doc.lines;
  if (offset < 0) return 1;
  return doc.lineAt(offset).number;
}

/**
 * Compute gutter changes from oldText (HEAD) vs newText (working tree / editor).
 * Uses CodeMirror's char-level diff then maps to line ranges.
 */
export function computeGutterChanges(oldText: string, newText: string): GutterChanges {
  if (oldText === newText) return { blocks: [], deleted: [] };

  // Use CodeMirror's diff (Myers) — fast, handles large files with scanLimit.
  let changes: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = [];
  try {
    changes = (diff as unknown as (a: string, b: string, cfg?: unknown) => typeof changes)(
      oldText,
      newText,
      {
        scanLimit: 20000,
        timeout: 250,
      },
    );
  } catch {
    changes = [];
  }
  if (!changes || changes.length === 0) return { blocks: [], deleted: [] };

  const newDoc = Text.of(newText.split("\n"));

  const raw: RawFragment[] = [];

  for (const c of changes) {
    const { fromA, toA, fromB, toB } = c;
    if (fromB === toB) {
      const oldTextSeg = oldText.slice(fromA, toA);
      // Intra-line pure deletion (no newline, file not empty) is a modification of that line, not a deleted line.
      const isIntraLine = !oldTextSeg.includes("\n") && newText.length !== 0;
      let line: number;
      if (newText.length === 0) line = 1;
      else if (fromB >= newDoc.length) line = newDoc.lines;
      else if (fromB === 0) line = 1;
      else line = lineNumberAt(newDoc, fromB);
      if (isIntraLine) {
        raw.push({
          newFromCh: fromB,
          newToCh: toB,
          oldFromCh: fromA,
          oldToCh: toA,
          oldText: oldTextSeg,
          newText: "",
          type: "modified",
          newFromLine: line,
          newToLine: line,
        });
      } else {
        raw.push({
          newFromCh: fromB,
          newToCh: toB,
          oldFromCh: fromA,
          oldToCh: toA,
          oldText: oldTextSeg,
          newText: "",
          type: "deleted",
          newFromLine: line,
          newToLine: line,
        });
      }
    } else if (fromA === toA) {
      const newTextSeg = newText.slice(fromB, toB);
      const isIntraLine = !newTextSeg.includes("\n") && oldText.length !== 0;
      const fromLine = lineNumberAtStrict(newText, fromB, newDoc);
      const toLine = lineNumberAtStrict(newText, Math.max(fromB, toB - 1), newDoc);
      if (isIntraLine) {
        raw.push({
          newFromCh: fromB,
          newToCh: toB,
          oldFromCh: fromA,
          oldToCh: toA,
          oldText: "",
          newText: newTextSeg,
          type: "modified",
          newFromLine: fromLine,
          newToLine: toLine,
        });
      } else {
        raw.push({
          newFromCh: fromB,
          newToCh: toB,
          oldFromCh: fromA,
          oldToCh: toA,
          oldText: "",
          newText: newTextSeg,
          type: "added",
          newFromLine: fromLine,
          newToLine: toLine,
        });
      }
    } else {
      const fromLine = lineNumberAtStrict(newText, fromB, newDoc);
      const toLine = lineNumberAtStrict(newText, Math.max(fromB, toB - 1), newDoc);
      const oldTextSeg = oldText.slice(fromA, toA);
      const newTextSeg = newText.slice(fromB, toB);
      raw.push({
        newFromCh: fromB,
        newToCh: toB,
        oldFromCh: fromA,
        oldToCh: toA,
        oldText: oldTextSeg,
        newText: newTextSeg,
        type: "modified",
        newFromLine: fromLine,
        newToLine: toLine,
      });
    }
  }

  raw.sort((a, b) => a.newFromCh - b.newFromCh || a.newToLine - b.newToLine);

  const blocks: ChangeBlock[] = [];
  const deleted: DeletedBlock[] = [];

  let i = 0;
  while (i < raw.length) {
    const cur = raw[i];
    if (cur.type === "deleted") {
      let line = cur.newFromLine;
      let fragments: RawFragment[] = [cur];
      let oldFrom = cur.oldFromCh;
      let oldTo = cur.oldToCh;
      let combinedOld = cur.oldText;
      let j = i + 1;
      while (j < raw.length && raw[j].type === "deleted" && raw[j].newFromLine === line) {
        fragments.push(raw[j]);
        combinedOld += raw[j].oldText;
        oldTo = raw[j].oldToCh;
        j++;
      }
      const lines = combinedOld.split("\n");
      deleted.push({
        type: "deleted",
        line,
        oldText: combinedOld,
        oldLines: lines,
        oldFromCh: oldFrom,
        oldToCh: oldTo,
        fragments,
      });
      i = j;
      continue;
    }

    let from = cur.newFromLine;
    let to = cur.newToLine;
    let oldFrom = cur.oldFromCh;
    let oldTo = cur.oldToCh;
    let fragments: RawFragment[] = [cur];
    let combinedType: "added" | "modified" = cur.type;
    let j = i + 1;
    while (j < raw.length && raw[j].type !== "deleted") {
      const nxt = raw[j];
      if (nxt.newFromLine <= to + 1) {
        to = Math.max(to, nxt.newToLine);
        oldFrom = Math.min(oldFrom, nxt.oldFromCh);
        oldTo = Math.max(oldTo, nxt.oldToCh);
        fragments.push(nxt);
        if (nxt.type === "modified") combinedType = "modified";
        j++;
      } else break;
    }
    let combinedOldText = "";
    if (combinedType === "modified") {
      // Reconstruct old text for the block by joining fragments' oldText with any unchanged gap?
      // For fragments that are within same block but separated by unchanged text (e.g., two words changed in same line),
      // the unchanged middle should be represented? However our fragments' oldText for each word alone doesn't include middle.
      // To get full old lines for display, slice from oldFrom to oldTo which includes middle unchanged.
      combinedOldText = oldText.slice(oldFrom, oldTo);
    }
    const oldLines = combinedOldText ? combinedOldText.split("\n") : [];
    blocks.push({
      type: combinedType,
      from,
      to,
      oldText: combinedOldText,
      oldLines,
      newFromCh: fragments[0].newFromCh,
      newToCh: fragments[fragments.length - 1].newToCh,
      fragments,
    });
    i = j;
  }

  return { blocks, deleted };
}

// ── CodeMirror gutter extension ───────────────────────────────────────────

class ChangeGutterMarker extends GutterMarker {
  constructor(public kind: "added" | "modified" | "deleted") {
    super();
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-changeGutter-marker cm-changeGutter-${this.kind}`;
    if (this.kind === "deleted") {
      // small triangle indicator like WebStorm
      el.textContent = "◢";
      el.setAttribute("aria-label", "deleted lines");
    } else {
      el.setAttribute("aria-label", this.kind);
    }
    return el;
  }
}

export interface ChangeGutterOptions {
  oldText: string;
  onMarkerClick?: (info: { block: ChangeBlock | DeletedBlock; line: number }) => void;
}

/**
 * Create a gutter that shows WebStorm-style change bars.
 * - Green bar for added/modified lines (no background on text).
 * - Small triangle for deleted lines.
 * Clicking the gutter calls onMarkerClick.
 */
export function changeGutterExtension(
  oldText: string,
  onMarkerClick?: (info: { block: ChangeBlock | DeletedBlock; line: number }) => void,
) {
  const changesField = StateField.define<GutterChanges>({
    create(state) {
      return computeGutterChanges(oldText, state.doc.toString());
    },
    update(value, tr) {
      if (tr.docChanged) {
        return computeGutterChanges(oldText, tr.newDoc.toString());
      }
      // Also recompute if oldText effects? oldText is closure, recreated on doc.path change so not needed.
      return value;
    },
  });

  const gutterExt = gutter({
    class: "cm-changeGutter",
    markers: (view) => {
      const changes = view.state.field(changesField);
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const b of changes.blocks) {
        for (let line = b.from; line <= b.to; line++) {
          if (line < 1 || line > view.state.doc.lines) continue;
          const lineObj = view.state.doc.line(line);
          builder.add(lineObj.from, lineObj.from, new ChangeGutterMarker(b.type));
        }
      }
      for (const d of changes.deleted) {
        const lineNum = Math.min(Math.max(d.line, 1), view.state.doc.lines);
        if (view.state.doc.lines === 0) continue;
        const lineObj = view.state.doc.line(lineNum);
        builder.add(lineObj.from, lineObj.from, new ChangeGutterMarker("deleted"));
      }
      return builder.finish();
    },
    initialSpacer: () => new ChangeGutterMarker("modified"),
    domEventHandlers: {
      mousedown(view, line, event) {
        const changes = view.state.field(changesField);
        const lineNum = view.state.doc.lineAt(line.from).number;
        // Find block containing this line
        let target: ChangeBlock | DeletedBlock | null = null;
        for (const b of changes.blocks) {
          if (lineNum >= b.from && lineNum <= b.to) {
            target = b;
            break;
          }
        }
        if (!target) {
          for (const d of changes.deleted) {
            if (d.line === lineNum) {
              target = d;
              break;
            }
          }
          // Also allow clicking near deleted gap: if line is just after deleted? For now only exact.
        }
        if (target && onMarkerClick) {
          onMarkerClick({ block: target, line: lineNum });
          // Prevent selection change
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  });

  const theme = EditorView.theme({
    ".cm-changeGutter": {
      width: "8px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
    },
    ".cm-changeGutter .cm-gutterElement": {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "0",
      cursor: "pointer",
    },
    ".cm-changeGutter-marker": {
      display: "block",
      cursor: "pointer",
    },
    ".cm-changeGutter-added": {
      width: "4px",
      minHeight: "100%",
      height: "100%",
      background: "#2ea043",
      borderRadius: "1px",
      marginLeft: "2px",
      cursor: "pointer",
    },
    ".cm-changeGutter-modified": {
      width: "4px",
      minHeight: "100%",
      height: "100%",
      background: "#1f6feb",
      borderRadius: "1px",
      marginLeft: "2px",
      cursor: "pointer",
    },
    ".cm-changeGutter-deleted": {
      color: "#8b949e",
      fontSize: "14px",
      lineHeight: "1",
      cursor: "pointer",
      filter: "drop-shadow(0 0 2px rgba(139,148,158,0.3))",
    },
    ".cm-changeGutter .cm-gutterElement:hover .cm-changeGutter-added": {
      background: "#3fb950",
      width: "5px",
    },
    ".cm-changeGutter .cm-gutterElement:hover .cm-changeGutter-modified": {
      background: "#388bfd",
      width: "5px",
    },
    ".cm-changeGutter .cm-gutterElement:hover .cm-changeGutter-deleted": {
      color: "#ff7b72",
      transform: "scale(1.15)",
    },
  });

  return [changesField, gutterExt, theme];
}

export function applyRevert(view: EditorView, block: ChangeBlock | DeletedBlock) {
  if (block.type === "deleted") {
    const del = block as DeletedBlock;
    // Insert combined oldText at first fragment's position
    const insertPos = del.fragments[0].newFromCh;
    // Clamp to doc length
    const pos = Math.max(0, Math.min(insertPos, view.state.doc.length));
    view.dispatch({
      changes: { from: pos, insert: del.oldText },
    });
    return;
  }
  const b = block as ChangeBlock;
  // Apply fragments in reverse order so offsets stay valid, or as single ChangeSet (simultaneous)
  // Use simultaneous changes: CodeMirror will handle.
  const changes = b.fragments.map((f) => ({
    from: f.newFromCh,
    to: f.newToCh,
    insert: f.oldText,
  }));
  // Sort descending to avoid offset shift if applied sequentially? For simultaneous set, order doesn't matter, but we provide as is.
  // Filter out no-op
  if (changes.length === 0) return;
  // For added blocks where oldText empty, this will delete.
  view.dispatch({ changes });
}

export function getGutterChanges(_view: EditorView): GutterChanges | null {
  return null;
}
