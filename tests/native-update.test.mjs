import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  updateHeld,
  updateIdle,
  matchingUpdate,
} from "../dist/native_update.js";
import { Transport } from "../dist/transport.js";
test("update identity and critical phases retain admission until confirmed terminal", () => {
  const home = mkdtempSync(join(tmpdir(), "teams-update-")),
    id = randomUUID(),
    request = randomUUID();
  try {
    for (const phase of [
      "stopping",
      "swapping",
      "starting",
      "rolling_back",
      "rollback_starting",
      "recovery_required",
    ]) {
      writeFileSync(
        join(home, "native-update.json"),
        JSON.stringify({
          schema: 1,
          request_id: request,
          installation_id: id,
          phase,
        }),
      );
      assert.equal(updateHeld(home, id), true);
    }
    for (const phase of ["prepared", "deferred", "applied", "rolled_back"]) {
      writeFileSync(
        join(home, "native-update.json"),
        JSON.stringify({
          schema: 1,
          request_id: request,
          installation_id: id,
          phase,
        }),
      );
      assert.equal(updateHeld(home, id), false);
    }
    assert.throws(() =>
      matchingUpdate(home, id, { request_id: randomUUID() }, ["rolled_back"]),
    );
    assert.throws(() =>
      matchingUpdate(home, id, { request_id: request, command: "bad" }, [
        "rolled_back",
      ]),
    );
    assert.throws(() => updateHeld(home, randomUUID()));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("inflight HTTP mutations and runtime/poller/delivery work independently defer cutover", () => {
  assert.equal(updateIdle(0, false, 0, 0), true);
  for (const args of [
    [1, false, 0, 0],
    [0, true, 0, 0],
    [0, false, 1, 0],
    [0, false, 0, 1],
  ])
    assert.equal(updateIdle(...args), false);
});
test("actual transport drains admitted mutation and refuses fresh platform activity during cutover", async () => {
  let release, entered;
  const started = new Promise((resolve) => (entered = resolve));
  const work = new Promise((resolve) => (release = resolve));
  const transport = new Transport("127.0.0.1", async (req, res) => {
    if (req.url === "/mutation") {
      entered();
      await work;
    }
    res.end("ok");
  });
  await transport.start(0);
  const base = "http://127.0.0.1:" + transport.address();
  try {
    const pending = fetch(base + "/mutation", { method: "POST" });
    await started;
    assert.equal(transport.activeMutations, 1);
    transport.updateHold = true;
    assert.equal(
      (await fetch(base + "/api/messages", { method: "POST", body: "{}" }))
        .status,
      503,
    );
    assert.equal(
      (await fetch(base + "/auth/login", { method: "POST" })).status,
      200,
    );
    assert.equal((await fetch(base + "/status")).status, 200);
    release();
    await pending;
    assert.equal(transport.activeMutations, 0);
  } finally {
    release();
    await transport.stop();
  }
});
