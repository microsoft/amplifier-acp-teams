import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Questions, validate } from "../dist/questions.js";
import { initialize } from "../dist/config.js";
import { Store } from "../dist/store.js";
import { runTurn } from "../dist/acp.js";
const schema = {
  type: "object",
  properties: { count: { type: "integer", minimum: 1, maximum: 3 } },
  required: ["count"],
};
test("questions reject unsafe URLs, unknown constraints, secret fields and malformed answers", async () => {
  for (const url of [
    "javascript:alert(1)",
    "http://example.test",
    "https://a:b@example.test",
    "https://example.test/\n",
  ])
    assert.throws(() =>
      validate({ mode: "url", url, message: "Login", elicitationId: "one" }),
    );
  for (const properties of [
    { key: { type: "string", pattern: "x" } },
    { password: { type: "string" } },
    { key: { type: "object" } },
  ])
    assert.throws(() =>
      validate({
        mode: "form",
        message: "Input",
        requestedSchema: { type: "object", properties },
      }),
    );
  const h = new Questions(),
    q = h.request("job", {
      mode: "form",
      message: "Count",
      requestedSchema: schema,
      id: "override",
      job: "override",
    });
  assert.notEqual(h.list()[0].id, "override");
  assert.equal(h.list()[0].job, "job");
  assert.throws(() => h.answer(q.id, "accept", { count: 99 }));
  h.answer(q.id, "accept", { count: 2 });
  assert.deepEqual(await q.answer, { action: "accept", content: { count: 2 } });
  assert.throws(() => h.answer(q.id, "accept", { count: 2 }));
  const second = h.request("job", {
    mode: "form",
    message: "Count",
    requestedSchema: schema,
  });
  h.cancelJob("job");
  assert.deepEqual(await second.answer, { action: "cancel" });
  assert.equal(h.list().length, 0);
});
test("ordinary ACP auth and forms wait for owner decisions on the same connection", async () => {
  const home = mkdtempSync(join(tmpdir(), "teams-questions-"));
  const c = initialize(home);
  const store = new Store(home);
  try {
    c.acp.command = "/usr/bin/python3";
    c.acp.args = [resolve("tests/questions-fixture.py")];
    c.acp.timeout_seconds = 15;
    const job = {
      id: "question-job",
      key: "key",
      message: {
        key: "key",
        tenant: "tenant",
        conversation: "room",
        kind: "personal",
        text: "Help",
        attachments: [],
      },
    };
    const result = runTurn(c, home, store, job, new AbortController().signal);
    for (let stage = 0; stage < 3; stage++) {
      let question;
      for (let i = 0; i < 100; i++) {
        question = store.questions.list()[0];
        if (question) break;
        await delay(20);
      }
      assert(question, "Expected question");
      if (stage === 0)
        store.questions.answer(question.id, "accept", { method_id: "browser" });
      if (stage === 1) {
        assert.equal(question.mode, "url");
        store.questions.answer(question.id, "accept");
      }
      if (stage === 2)
        store.questions.answer(question.id, "accept", { count: 2 });
    }
    assert.equal((await result).text, "Owner answered");
    assert.equal(store.questions.list().length, 0);
  } finally {
    store.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
