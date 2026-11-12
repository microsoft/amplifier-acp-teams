import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { initialize, save } from "../dist/config.js";
import { manifest } from "../dist/manifest.js";
import { serve } from "../dist/server.js";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "teams-package-"));
  const config = initialize(home);
  config.teams.client_id = "22222222-2222-4222-8222-222222222222";
  config.teams.tenant_id = "11111111-1111-4111-8111-111111111111";
  config.server.public_url = "https://teams.example.invalid";
  config.teams.participation = "ambient";
  save(home, config);
  return { home, config };
}
function inspect(bytes, x) {
  const expected = join(x.home, "expected.json");
  writeFileSync(expected, JSON.stringify(manifest(x.config)));
  const result = spawnSync(
    process.env.TEAMS_TEST_PYTHON || "python3",
    [resolve("tests/inspect-manifest-package.py"), expected],
    { input: bytes, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

test("authorized package download preserves manifest and icon semantics without changing installation", async () => {
  const x = setup();
  const before = readFileSync(join(x.home, "adapter.json"));
  const running = await serve(x.home);
  const base = `http://127.0.0.1:${running.port}`;
  const headers = {
    authorization:
      "Bearer " + readFileSync(join(x.home, "secrets/control-token"), "utf8"),
  };
  try {
    assert.equal((await fetch(base + "/api/v1/manifest.zip")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/v1/manifest.zip", {
          headers: { ...headers, origin: "https://attacker.invalid" },
        })
      ).status,
      400,
    );
    const response = await fetch(base + "/api/v1/manifest.zip", { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="teams-agent.zip"',
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    inspect(Buffer.from(await response.arrayBuffer()), x);
    assert.deepEqual(readFileSync(join(x.home, "adapter.json")), before);
    assert.equal(
      running.store.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
      0,
    );
  } finally {
    await running.close();
    rmSync(x.home, { recursive: true, force: true });
  }
});

test("packaged CLI exports once, preserves an existing destination, and refuses incomplete registration", () => {
  const x = setup();
  const output = join(x.home, "agent package.zip");
  const run = () =>
    spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "manifest-package",
        "--home",
        x.home,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(output), first.stdout);
    const bytes = readFileSync(output);
    inspect(bytes, x);
    assert.notEqual(run().status, 0);
    assert.deepEqual(readFileSync(output), bytes);
    rmSync(output);
    x.config.teams.client_id = "";
    save(x.home, x.config);
    assert.notEqual(run().status, 0);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(x.home, { recursive: true, force: true });
  }
});
