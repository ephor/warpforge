// Minimal ACP agent for tests: speaks newline-delimited JSON-RPC 2.0 over
// stdio, enough to exercise the daemon's ACP client end to end — initialize,
// session/new, session/prompt with streamed updates, a file edit, and a
// permission round-trip.

let buf = "";
let pendingPromptId = null;
let nextReqId = 100;
const SID = "mock-session-1";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID, update: u } });

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
    pendingPromptId = msg.id;
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it — editing main.rs." } });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Edit src/main.rs",
      status: "in_progress",
      kind: "edit",
      locations: [{ path: "src/main.rs" }],
    });
    update({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" });
    // Ask permission to run tests, then wait for the human's answer.
    send({
      jsonrpc: "2.0",
      id: nextReqId++,
      method: "session/request_permission",
      params: {
        sessionId: SID,
        toolCall: { toolCallId: "tc2", title: "Run `cargo test`" },
        options: [
          { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
          { optionId: "opt-always", name: "Always allow", kind: "allow_always" },
          { optionId: "opt-deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
  } else if (msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
    // Response to our permission request.
    const outcome = msg.result && msg.result.outcome;
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Got permission (${JSON.stringify(outcome)}). All done.` } });
    if (pendingPromptId !== null) {
      send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn" } });
      pendingPromptId = null;
    }
  }
}
