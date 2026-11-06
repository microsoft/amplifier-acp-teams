import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpClient } from "../dist/acp.js";
import { initialize } from "../dist/config.js";

async function peer(run) {
  const home = mkdtempSync(join(tmpdir(), "teams-sdk-"));
  const config = initialize(home);
  config.acp.command = process.execPath;
  config.acp.args = [resolve("tests/sdk-agent.mjs")];
  const client = new AcpClient(config, home);
  try {
    await client.initialize();
    await client.request("session/new", { cwd: home, mcpServers: [] });
    await run(client);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
}
const prompt = (text) => ({
  sessionId: "sdk-session",
  prompt: [{ type: "text", text }],
});

test(
  "SDK updates and metadata arrive before the prompt terminal response",
  { timeout: 5000 },
  async () => {
    await peer(async (client) => {
      const seen = [];
      client.onUpdate = (event) => seen.push(event.update._meta.example.index);
      assert.equal(
        (await client.request("session/prompt", prompt("normal"))).stopReason,
        "end_turn",
      );
      assert.deepEqual(
        seen,
        Array.from({ length: 20 }, (_, i) => i),
      );
      assert.equal(client.activeRequests.size, 0);
    });
  },
);
test(
  "SDK owns concurrent extension correlation and permission callbacks",
  { timeout: 5000 },
  async () => {
    await peer(async (client) => {
      const seen = [];
      client.onUpdate = (event) => seen.push(event.update.content.text);
      const work = client.request("session/prompt", prompt("permission"));
      const echoes = await Promise.all(
        Array.from({ length: 12 }, (_, i) => client.request("_echo", { i })),
      );
      assert.deepEqual(
        echoes,
        Array.from({ length: 12 }, (_, i) => ({ i })),
      );
      assert.equal((await work).stopReason, "end_turn");
      assert.deepEqual(seen, ["cancelled"]);
    });
  },
);
test(
  "SDK cancellation settles only the original prompt",
  { timeout: 5000 },
  async () => {
    await peer(async (client) => {
      const work = client.request("session/prompt", prompt("wait"));
      await client.request("_echo", { ready: true });
      await client.connection.agent.notify("session/cancel", {
        sessionId: "sdk-session",
      });
      assert.equal((await work).stopReason, "cancelled");
      assert.deepEqual(await client.request("_echo", { next: true }), {
        next: true,
      });
    });
  },
);
test(
  "SDK errors are redacted and process loss is never success",
  { timeout: 5000 },
  async () => {
    await peer(async (client) => {
      await assert.rejects(
        client.request("session/prompt", prompt("error")),
        (error) =>
          /ACP request rejected/.test(error.message) &&
          !error.message.includes("PRIVATE_PROVIDER_ERROR_CANARY"),
      );
      await assert.rejects(
        client.request("session/prompt", prompt("disconnect")),
        /closed/,
      );
    });
  },
);
