import fs from "node:fs";

// Advertises session/load, then rejects it the way an agent does when the saved
// session no longer exists on its side.
let buffer = "";
const logPath = process.argv[2];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const record = (message) =>
  fs.appendFileSync(logPath, `${JSON.stringify({ method: message.method, params: message.params })}\n`);

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(message) {
  record(message);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
  } else if (message.method === "session/load") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32002,
        message: "Resource not found: gone-session",
        data: { uri: "gone-session" },
      },
    });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fresh-session" } });
  } else if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
}
