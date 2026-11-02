#!/usr/bin/env node
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import {
  ensure,
  initialize,
  load,
  privateWrite,
  save,
  validate,
} from "./config.js";
import { serve } from "./server.js";
import { check } from "./acp.js";
import { manifest } from "./manifest.js";

async function main() {
  const args = process.argv.slice(2),
    command = args.shift();
  const take = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return;
    ensure(args[i + 1], "Missing " + name + " value");
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const home = resolve(take("--home") ?? ".teams-adapter");
  if (command === "init") {
    ensure(args.length === 0, "Unknown option");
    const c = initialize(home);
    console.log(
      JSON.stringify(
        {
          id: c.id,
          home,
          next: "Edit adapter.json or use config --file. Save client-secret with secret --name client-secret < secret-file. Then run serve.",
        },
        null,
        2,
      ),
    );
  } else if (command === "config") {
    const file = take("--file");
    ensure(args.length === 0, "Unknown option");
    if (!file) {
      console.log(JSON.stringify(load(home), null, 2));
      return;
    }
    const c = validate(JSON.parse(readFileSync(resolve(file), "utf8"))),
      old = load(home);
    ensure(
      c.id === old.id && c.revision === old.revision,
      "Keep installation identity and current revision",
    );
    ensure(
      !c.enabled && !old.enabled,
      "Pause before editing and use the lifecycle API to resume",
    );
    c.revision++;
    save(home, c);
    console.log(
      "Configuration saved. Restart a running service to reload file changes.",
    );
  } else if (command === "secret") {
    const name = take("--name");
    ensure(
      args.length === 0 &&
        name &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(name) &&
        name !== "control-token",
      "Choose a private secret name; control token rotation requires a stopped service",
    );
    const value = readFileSync(0, "utf8");
    ensure(value.length > 0 && value.length <= 16000, "Invalid secret input");
    privateWrite(join(home, "secrets", name), value.trimEnd());
    console.log("Private value stored. Restart to reload.");
  } else if (command === "check") {
    ensure(args.length === 0, "Unknown option");
    console.log(JSON.stringify(await check(load(home), home), null, 2));
  } else if (command === "manifest") {
    ensure(args.length === 0, "Unknown option");
    console.log(JSON.stringify(manifest(load(home)), null, 2));
  } else if (command === "serve") {
    ensure(args.length === 0, "Unknown option");
    const running = await serve(home);
    console.log(
      JSON.stringify({
        listening: running.port,
        dashboard: `http://127.0.0.1:${running.port}`,
        teams_path: "/api/messages",
      }),
    );
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => {
        if (closing) return;
        closing = true;
        void running.close().then(() => process.exit(0));
      });
  } else
    console.log(
      "acp-teams-adapter init|config|secret|check|manifest|serve --home <installation-folder>",
    );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Operation failed");
  process.exitCode = 1;
});
