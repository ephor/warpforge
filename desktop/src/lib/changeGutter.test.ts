// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { computeGutterChanges, applyRevert } from "./changeGutter";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

describe("computeGutterChanges", () => {
  it("modified single line", () => {
    const r = computeGutterChanges("a\nb\nc", "a\nx\nc");
    expect(r.blocks.length).toBe(1);
    expect(r.blocks[0].from).toBe(2);
    expect(r.blocks[0].type).toBe("modified");
    expect(r.deleted.length).toBe(0);
  });
  it("added line", () => {
    const r = computeGutterChanges("a\nc", "a\nb\nc");
    expect(r.blocks.length).toBe(1);
    expect(r.blocks[0].from).toBe(2);
    expect(r.blocks[0].type).toBe("added");
  });
  it("deleted line", () => {
    const r = computeGutterChanges("a\nb\nc", "a\nc");
    expect(r.deleted.length).toBe(1);
    expect(r.deleted[0].line).toBe(2);
    expect(r.deleted[0].oldText).toContain("b");
  });
  it("complex added project", () => {
    let old = "    #[serde(rename = \"file.save\")]\n    FileSave {\n        task_id: String,\n        path: String,\n        content: String,\n    },";
    let nw = "    #[serde(rename = \"file.save\")]\n    FileSave {\n        #[serde(default)]\n        task_id: String,\n        path: String,\n        content: String,\n        #[serde(default)]\n        project: Option<String>,\n    },";
    const r = computeGutterChanges(old, nw);
    expect(r.blocks.length).toBe(2);
    expect(r.blocks[0].from).toBe(3);
    expect(r.blocks[1].from).toBe(6);
  });
  it("revert modified", () => {
    const oldText = "a\nb\nc";
    const newText = "a\nx\nc";
    const changes = computeGutterChanges(oldText, newText);
    const view = new EditorView({ state: EditorState.create({ doc: newText }), parent: document.createElement("div") });
    const block = changes.blocks[0];
    applyRevert(view, block);
    expect(view.state.doc.toString()).toBe(oldText);
  });
  it("revert added", () => {
    const oldText = "a\nc";
    const newText = "a\nb\nc";
    const changes = computeGutterChanges(oldText, newText);
    const view = new EditorView({ state: EditorState.create({ doc: newText }), parent: document.createElement("div") });
    applyRevert(view, changes.blocks[0]);
    expect(view.state.doc.toString()).toBe(oldText);
  });
  it("revert deleted", () => {
    const oldText = "a\nb\nc";
    const newText = "a\nc";
    const changes = computeGutterChanges(oldText, newText);
    const view = new EditorView({ state: EditorState.create({ doc: newText }), parent: document.createElement("div") });
    applyRevert(view, changes.deleted[0]);
    expect(view.state.doc.toString()).toBe(oldText);
  });
});
