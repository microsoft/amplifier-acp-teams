import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

let cancelled;
const connection = acp
  .agent()
  .onRequest("*", async ({ method, params, client }) => {
    if (method === "initialize")
      return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    if (method === "session/new") return { sessionId: "sdk-session" };
    if (method === "session/load") return {};
    if (method === "_echo") return params;
    if (method !== "session/prompt")
      throw acp.RequestError.methodNotFound(method);
    const mode = params.prompt[0].text;
    if (mode === "error")
      throw new acp.RequestError(-32001, "PRIVATE_PROVIDER_ERROR_CANARY");
    if (mode === "disconnect") process.exit(0);
    if (mode === "wait") {
      await new Promise((resolve) => {
        cancelled = resolve;
      });
      return { stopReason: "cancelled" };
    }
    if (mode === "permission") {
      const answer = await client.request("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "write", title: "Write file" },
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
      });
      await client.notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: answer.outcome.outcome },
        },
      });
    } else {
      for (let i = 0; i < 20; i++)
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: String(i) },
            _meta: { example: { index: i } },
          },
        });
    }
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {
    cancelled?.();
  })
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin),
    ),
  );
await connection.closed;
