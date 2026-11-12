import test from "node:test";
import assert from "node:assert/strict";
import { listenerProof, nativeSettings, NativeAuth } from "../dist/native.js";
import { initialize, privateWrite } from "../dist/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("native listener proof matches shared Rust golden binding", () => {
  assert.equal(
    listenerProof(
      "installation",
      "http://127.0.0.1:4321",
      "a".repeat(64),
      "b".repeat(64),
    ),
    "12a53eddbd6b17397073581b4090df8a9b03827de69b16c0ff831bbd0d5564a5",
  );
  assert.notEqual(
    listenerProof(
      "other",
      "http://127.0.0.1:4321",
      "a".repeat(64),
      "b".repeat(64),
    ),
    listenerProof(
      "installation",
      "http://127.0.0.1:4321",
      "a".repeat(64),
      "b".repeat(64),
    ),
  );
  assert.throws(() =>
    listenerProof("id", "http://127.0.0.1:4321", "bad", "b".repeat(64)),
  );
});
test("native adoption is explicit and cannot silently rebind management", () => {
  const home = mkdtempSync(join(tmpdir(), "teams-native-contract-"));
  try {
    const c = initialize(home);
    assert.equal(nativeSettings(home, c), undefined);
    c.server.port = 4321;
    privateWrite(
      join(home, "native.json"),
      JSON.stringify({ schema: 1, id: c.id, origin: "http://127.0.0.1:4321" }),
    );
    assert.equal(nativeSettings(home, c).id, c.id);
    for (const change of [
      { ...c, server: { ...c.server, bind: "0.0.0.0" } },
      { ...c, server: { ...c.server, port: 4322 } },
      { ...c, id: "22222222-2222-4222-8222-222222222222" },
    ])
      assert.throws(() => nativeSettings(home, change));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("native public return navigation does not relax API or origin checks", () => {
  const auth = Object.create(NativeAuth.prototype);
  auth.settings = { origin: "http://127.0.0.1:4321" };
  const request = {
    method: "GET",
    url: "/",
    headers: {
      host: "127.0.0.1:4321",
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  };
  assert.equal(auth.allowed(request), true);
  for (const variant of [
    { ...request, url: "/api/config" },
    { ...request, method: "POST" },
    { ...request, headers: { ...request.headers, "sec-fetch-mode": "cors" } },
    { ...request, headers: { ...request.headers, "sec-fetch-dest": "iframe" } },
    {
      ...request,
      headers: { ...request.headers, origin: "http://127.0.0.1:4567" },
    },
    { ...request, headers: { ...request.headers, host: "attacker.invalid" } },
  ])
    assert.equal(auth.allowed(variant), false);
});
