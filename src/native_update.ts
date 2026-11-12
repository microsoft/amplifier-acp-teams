/** Installation-owned native package cutover. No package paths or commands in HTTP. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensure } from "./config.js";

export function updateRecord(home: string, id: string): any | undefined {
  const file = join(home, "native-update.json");
  if (!existsSync(file)) return;
  const raw = readFileSync(file, "utf8");
  ensure(raw.length <= 4 * 1024 * 1024, "Update record exceeds bound");
  const j = JSON.parse(raw);
  ensure(
    j.schema === 1 &&
      j.installation_id === id &&
      /^[a-f0-9-]{36}$/.test(j.request_id),
    "Native update identity changed",
  );
  return j;
}
export function updateHeld(home: string, id: string): boolean {
  const j = updateRecord(home, id);
  return (
    !!j && !["prepared", "deferred", "applied", "rolled_back"].includes(j.phase)
  );
}
export function updateIdle(
  active: number,
  polling: boolean,
  mutations: number,
  pending: number,
): boolean {
  return active === 0 && !polling && mutations === 0 && pending === 0;
}
export function matchingUpdate(
  home: string,
  id: string,
  input: any,
  phases: string[],
): any {
  ensure(
    input &&
      Object.keys(input).length === 1 &&
      typeof input.request_id === "string",
    "Use the prepared update request",
  );
  const j = updateRecord(home, id);
  ensure(
    j && j.request_id === input.request_id && phases.includes(j.phase),
    "Update is not in the required phase",
  );
  return j;
}
