// Small ACP fixture that reports the received prompt block types.
let buf = "";
const image = process.argv[2] !== "false";
const embeddedContext = process.argv[3] !== "false";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

process.stdin.on("data", (chunk) => {
  buf += chunk;
  let newline;
  while ((newline = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, newline).trim();
    buf = buf.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image, embeddedContext } } } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "inspect-session" } });
  } else if (message.method === "session/prompt") {
    const types = message.params.prompt.map((block) => block.type).join(",");
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "inspect-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `blocks:${types}` } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
}
