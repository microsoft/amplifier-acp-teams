import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initialize, endpointKey } from "../dist/config.js";
import { Store } from "../dist/store.js";
import { Runtime } from "../dist/runtime.js";
import { inspectSubmissions, sourceReference } from "../dist/submissions.js";

function fixture(mode) {
  const home = mkdtempSync(join(tmpdir(), "teams-session-"));
  const c = initialize(home);
  c.enabled = true;
  c.teams.client_id = "22222222-2222-2222-2222-222222222222";
  c.teams.tenant_id = "11111111-1111-1111-1111-111111111111";
  const modeFile = join(home, "mode"),
    log = join(home, "calls.jsonl");
  writeFileSync(modeFile, mode);
  c.acp.command = process.env.TEAMS_TEST_PYTHON || "python3";
  c.acp.args = [resolve("tests/session-fixture.py"), modeFile, log];
  c.acp.timeout_seconds = mode === "timeout" ? 1 : 5;
  const store = new Store(home),
    sent = [];
  const message = (id) => ({
    id,
    key: "tenant:room",
    tenant: c.teams.tenant_id,
    conversation: "room",
    service_url: "https://smba.trafficmanager.net/amer/",
    bot_id: c.teams.client_id,
    kind: "personal",
    sender: "human",
    sender_name: "Human",
    text: "Fresh input " + id,
    addressed: true,
    attachments: [],
    time: Date.now(),
  });
  const runtime = new Runtime(
    home,
    store,
    () => c,
    async (m, text) => {
      sent.push({ id: m.id, text });
      return "sent-" + m.id;
    },
  );
  const calls = () =>
    readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  return {
    home,
    c,
    store,
    sent,
    runtime,
    message,
    calls,
    mode(value) {
      writeFileSync(modeFile, value);
    },
    async close() {
      await runtime.close();
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
async function settled(x, id) {
  for (let i = 0; i < 150; i++) {
    const row = x.store.db
      .prepare("SELECT * FROM jobs WHERE json_extract(message,'$.id')=?")
      .get(id);
    if (
      row &&
      !["pending", "running", "sending"].includes(row.status) &&
      !x.runtime.active.size
    )
      return row;
    await delay(30);
  }
  throw new Error("Fixture job did not settle");
}

for (const mode of ["reject", "method-missing", "disconnect", "timeout"]) {
  test(`advertised load ${mode} preserves the original session and never replaces or prompts`, async () => {
    const x = fixture(mode);
    try {
      x.store.bindSession("tenant:room", endpointKey(x.c), "original-session");
      x.runtime.receiveMessage(x.message("failed-input"));
      const failed = await settled(x, "failed-input");
      assert.equal(failed.status, "failed");
      assert.match(failed.note, /saved ACP session.*not.*loaded/i);
      assert.doesNotMatch(failed.note, /PRIVATE ENDPOINT/);
      assert.equal(
        x.store.session("tenant:room", endpointKey(x.c)),
        "original-session",
      );
      assert.deepEqual(
        x.calls().map((c) => c.method),
        ["initialize", "session/load"],
      );
      assert.equal(x.sent.length, 0);
      const transition = JSON.parse(failed.session_transition);
      assert.equal(transition.kind, "load_failed");
      assert.equal(transition.previous_session_id, "original-session");
      assert.equal(transition.session_id, null);

      x.mode("success");
      x.runtime.receiveMessage(x.message("fresh-next-input"));
      assert.equal((await settled(x, "fresh-next-input")).status, "sent");
      assert.equal(
        x.store.session("tenant:room", endpointKey(x.c)),
        "original-session",
      );
      const prompts = x.calls().filter((c) => c.method === "session/prompt");
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].params.sessionId, "original-session");
      assert.equal(
        JSON.parse(prompts[0].params.prompt[0].text.split("\n").at(-1)).trigger
          .id,
        "fresh-next-input",
      );
      assert.equal(
        x.store.db.prepare("SELECT status FROM jobs WHERE id=?").get(failed.id)
          .status,
        "failed",
      );
    } finally {
      await x.close();
    }
  });
}

test("a lost prompt outcome retains the binding and only a new input is prompted later", async () => {
  const x = fixture("prompt-disconnect");
  try {
    x.store.bindSession("tenant:room", endpointKey(x.c), "original-session");
    x.runtime.receiveMessage(x.message("unknown-input"));
    const failed = await settled(x, "unknown-input");
    assert.equal(failed.status, "failed");
    assert.equal(
      x.store.session("tenant:room", endpointKey(x.c)),
      "original-session",
    );
    x.mode("success");
    x.runtime.receiveMessage(x.message("new-input"));
    await settled(x, "new-input");
    assert.equal(x.calls().filter((c) => c.method === "session/new").length, 0);
    const prompts = x.calls().filter((c) => c.method === "session/prompt");
    assert.equal(prompts.length, 2);
    assert.deepEqual(
      prompts.map(
        (c) =>
          JSON.parse(c.params.prompt[0].text.split("\n").at(-1)).trigger.id,
      ),
      ["unknown-input", "new-input"],
    );
    assert.equal(x.sent.length, 1);
  } finally {
    await x.close();
  }
});

test("unsupported loading creates a disclosed new session without claiming old recovery", async () => {
  const x = fixture("unsupported");
  try {
    x.store.bindSession("tenant:room", endpointKey(x.c), "original-session");
    x.runtime.receiveMessage(x.message("fresh-input"));
    const first = await settled(x, "fresh-input");
    assert.equal(first.status, "sent");
    const transition = JSON.parse(first.session_transition);
    assert.equal(transition.kind, "replacement");
    assert.equal(transition.reason, "load_not_advertised");
    assert.equal(transition.previous_session_id, "original-session");
    assert.equal(transition.session_id, first.session_id);
    assert.notEqual(first.session_id, "original-session");
    assert.equal(
      x.store.session("tenant:room", endpointKey(x.c)),
      first.session_id,
    );
    const inspected = inspectSubmissions(x.store, x.c, {
      sources: [sourceReference(JSON.parse(first.message))],
    });
    assert.deepEqual(inspected.items[0].attempts[0].session, {
      id: first.session_id,
      transition,
    });
    const prompt = x.calls().find((c) => c.method === "session/prompt").params
      .prompt[0].text;
    assert.match(prompt, /new ACP session/);
    assert.match(prompt, /not.*recovered/i);
    x.runtime.receiveMessage(x.message("second-fresh-input"));
    const second = await settled(x, "second-fresh-input");
    assert.equal(
      JSON.parse(second.session_transition).previous_session_id,
      first.session_id,
    );
    assert.equal(
      x.calls().filter((c) => c.method === "session/load").length,
      0,
    );
    assert.equal(x.calls().filter((c) => c.method === "session/new").length, 2);
  } finally {
    await x.close();
  }
});

test("restart retains interrupted session bindings and uncertain sends without replay", async () => {
  const x = fixture("success");
  try {
    x.c.enabled = false;
    const m = x.message("interrupted");
    x.store.ingest(m, true, 10);
    const job = x.store.claim(new Set());
    x.store.bindSession(m.key, endpointKey(x.c), "original-session");
    x.store.db
      .prepare("UPDATE jobs SET session_id=? WHERE id=?")
      .run("original-session", job.id);
    x.store.ingest(x.message("sending"), true, 10);
    x.store.db
      .prepare(
        "UPDATE jobs SET status='sending' WHERE json_extract(message,'$.id')='sending'",
      )
      .run();
    x.store.recover();
    assert.equal(x.store.session(m.key, endpointKey(x.c)), "original-session");
    assert.equal(
      x.store.db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id)
        .status,
      "interrupted",
    );
    assert.equal(
      x.store.db
        .prepare(
          "SELECT status FROM jobs WHERE json_extract(message,'$.id')='sending'",
        )
        .get().status,
      "uncertain",
    );
    assert.equal(x.store.claim(new Set()), undefined);
    assert.equal(x.sent.length, 0);
    x.c.enabled = true;
    x.runtime.receiveMessage(x.message("fresh-after-restart"));
    assert.equal((await settled(x, "fresh-after-restart")).status, "sent");
    assert.deepEqual(
      x.calls().map((c) => c.method),
      ["initialize", "session/load", "session/prompt"],
    );
    assert.equal(x.calls().at(-1).params.sessionId, "original-session");
    assert.equal(
      x.store.db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id)
        .status,
      "interrupted",
    );
    assert.equal(
      x.store.db
        .prepare(
          "SELECT status FROM jobs WHERE json_extract(message,'$.id')='sending'",
        )
        .get().status,
      "uncertain",
    );
  } finally {
    await x.close();
  }
});

test("explicit pause still cancels work and clears the active binding", async () => {
  const x = fixture("prompt-wait");
  try {
    x.store.bindSession("tenant:room", endpointKey(x.c), "original-session");
    x.runtime.receiveMessage(x.message("paused-input"));
    let prompted = false;
    for (let i = 0; i < 100; i++) {
      try {
        prompted = x.calls().some((c) => c.method === "session/prompt");
      } catch {}
      if (prompted) break;
      await delay(30);
    }
    assert.equal(prompted, true);
    x.c.enabled = false;
    await x.runtime.pause();
    assert.equal((await settled(x, "paused-input")).status, "cancelled");
    assert.equal(x.store.session("tenant:room", endpointKey(x.c)), undefined);
    assert.equal(x.sent.length, 0);
  } finally {
    await x.close();
  }
});
