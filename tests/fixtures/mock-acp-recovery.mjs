import fs from "node:fs";

let buffer = "";
const logPath = process.argv[2];
const sessionId = process.argv[3] ?? "persisted-session";
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
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
  }
}
