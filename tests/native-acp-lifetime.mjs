// Actual Windows supervisor and private Node, never a provider/model connection.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AcpClient } from "../dist/acp.js";
import { defaults } from "../dist/config.js";
assert.equal(
  process.platform,
  "win32",
  "This fixture qualifies actual Windows only",
);
const [binary, base] = process.argv.slice(2),
  home = fs.mkdtempSync(path.join(os.tmpdir(), "Teams ACP tree "));
const saved = process.env.ACP_TEAMS_NATIVE_LAUNCHER;
let client, pid;
const live = (id) => {
  try {
    process.kill(id, 0);
    return true;
  } catch {
    return false;
  }
};
try {
  const c = defaults();
  const marker = path.join(home, "grandchild.pid");
  const script = path.join(home, "engine.cjs");
  fs.writeFileSync(
    script,
    `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[2],String(child.pid));process.stdin.resume();setInterval(()=>{},1000);`,
  );
  c.id = randomUUID();
  c.acp.command = process.execPath;
  c.acp.args = [script, marker];
  c.acp.cwd = home;
  fs.writeFileSync(path.join(home, "adapter.json"), JSON.stringify(c));
  fs.writeFileSync(
    path.join(home, "native.json"),
    JSON.stringify({ schema: 1, id: c.id, origin: "http://127.0.0.1:1" }),
  );
  process.env.ACP_TEAMS_NATIVE_LAUNCHER = binary;
  client = new AcpClient(c, home);
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(marker) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  assert(fs.existsSync(marker), "Immediate grandchild actually started");
  pid = Number(fs.readFileSync(marker, "utf8"));
  assert(live(pid));
  await client.close();
  assert.equal(
    live(pid),
    false,
    "Per-operation close must stop its descendant before reporting completion",
  );
  assert.equal(
    (await fetch(base + "/auth/session")).status,
    200,
    "The separate Teams app remains available",
  );
  console.log(
    JSON.stringify({
      passed: true,
      platform: process.platform,
      arch: process.arch,
      checks: [
        "actual immediate grandchild starts only inside nested job",
        "individual ACP close waits for descendant exit",
        "Teams app remains available",
      ],
      model_calls: 0,
    }),
  );
} finally {
  if (client) await client.close().catch(() => {});
  if (pid && live(pid)) process.kill(pid, "SIGKILL");
  if (saved === undefined) delete process.env.ACP_TEAMS_NATIVE_LAUNCHER;
  else process.env.ACP_TEAMS_NATIVE_LAUNCHER = saved;
  fs.rmSync(home, { recursive: true, force: true });
}
