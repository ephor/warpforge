// Scripted ACP agent for workflow-engine tests.
//
// Usage: node mock-acp-workflow.mjs <state-file> <behavior> [behavior...]
//
// Each session/prompt consumes the next behavior from the shared state file,
// so consecutive stage processes driven by the same agent command (implement →
// fix, review round 1 → review round 2) continue one script. Prompts past the
// end of the script repeat the last behavior.
import { readFileSync, writeFileSync } from "node:fs";

const [stateFile, ...script] = process.argv.slice(2);
let buf = "";
const SID = "mock-session-workflow";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const update = (u) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID, update: u } });
const text = (t) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
const endTurn = (id) => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });

const nextBehavior = () => {
  let index = 0;
  try {
    index = parseInt(readFileSync(stateFile, "utf8"), 10) || 0;
  } catch {}
  writeFileSync(stateFile, String(index + 1));
  return script[Math.min(index, script.length - 1)];
};

process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: SID } });
  } else if (msg.method === "session/prompt") {
    const behavior = nextBehavior();
    switch (behavior) {
      case "impl":
        text("IMPL-DONE: implemented the change.");
        endTurn(msg.id);
        break;
      case "noisy-impl":
        // Narration, then work, then the real closing message — only the last
        // part is the summary the pipeline should carry forward.
        text("NARRATION: let me look at the files first.");
        update({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "read src/lib.rs",
          status: "completed",
        });
        text("CLOSING: implemented the change and ran the tests.");
        endTurn(msg.id);
        break;
      case "slow-impl":
        text("IMPL-DONE: implemented the change (slowly).");
        setTimeout(() => endTurn(msg.id), 600);
        break;
      case "fix":
        text("FIX-DONE: addressed the findings.");
        endTurn(msg.id);
        break;
      case "plan":
        text("PLAN: 1. edit a.rs  2. run tests");
        endTurn(msg.id);
        break;
      case "question":
        text('Before I plan this:\n```json\n{"need_user_input": "Which database?"}\n```');
        endTurn(msg.id);
        break;
      case "approve":
        text('Looks good.\n```json\n{"verdict": "approve", "findings": []}\n```');
        endTurn(msg.id);
        break;
      case "reject":
        text(
          'Found problems.\n```json\n{"verdict": "request_changes", "findings": [{"severity": "high", "file": "a.rs", "description": "bug here"}]}\n```'
        );
        endTurn(msg.id);
        break;
      case "reject-die":
        // Reject, then die shortly after: simulates a reviewer whose session
        // is gone by the time the next round wants to follow up in it.
        text(
          'Found problems.\n```json\n{"verdict": "request_changes", "findings": [{"severity": "high", "file": "a.rs", "description": "bug here"}]}\n```'
        );
        endTurn(msg.id);
        setTimeout(() => process.exit(0), 100);
        break;
      case "die":
        // Exit mid-turn without ever ending it: the agent process is lost
        // before the stage produces any verdict at all.
        process.exit(1);
        break;
      case "slow-fix":
        text("FIX-DONE: addressed the findings (slowly).");
        setTimeout(() => endTurn(msg.id), 600);
        break;
      case "garbage":
        text("looks fine to me, ship it");
        endTurn(msg.id);
        break;
      default:
        text(`unknown behavior: ${behavior}`);
        endTurn(msg.id);
    }
  }
}
