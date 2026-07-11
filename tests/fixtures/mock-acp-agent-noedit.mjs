// Minimal ACP agent for tests: a pure Q&A turn — streams a text answer and
// ends the turn WITHOUT editing any file or requesting permission. Used to
// assert the daemon parks such a task in `Idle` (nothing to review), not
// `NeedsReview`.

let buf = "";
const SID = "mock-session-noedit";

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
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It's 4000, no changes needed." } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
}
