import test from "node:test";
import assert from "node:assert/strict";
import { listenerProof, nativeSettings } from "../dist/native.js";
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
