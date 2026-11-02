import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export interface GraphTarget {
  kind: "chat" | "channel";
  conversation_id: string;
  chat_id?: string;
  team_id?: string;
  channel_id?: string;
}
export interface Config {
  schema: 1;
  id: string;
  label: string;
  revision: number;
  enabled: boolean;
  server: { bind: string; port: number; public_url: string };
  teams: {
    client_id: string;
    tenant_id: string;
    allow_personal: boolean;
    conversations: string[];
    participation: "mentions" | "ambient";
  };
  graph: {
    enabled: boolean;
    poll_seconds: number;
    include_bots: boolean;
    targets: GraphTarget[];
  };
  media: {
    incoming: boolean;
    outgoing: boolean;
    max_files: number;
    max_file_bytes: number;
    download_hosts: string[];
  };
  acp: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    secret_env: Record<string, string>;
    timeout_seconds: number;
  };
  attention: {
    parallel_conversations: number;
    max_replies_per_hour: number;
    max_pending: number;
  };
}
export function defaults(): Config {
  return {
    schema: 1,
    id: randomUUID(),
    label: "Teams connection",
    revision: 1,
    enabled: false,
    server: { bind: "127.0.0.1", port: 0, public_url: "" },
    teams: {
      client_id: "",
      tenant_id: "",
      allow_personal: true,
      conversations: [],
      participation: "mentions",
    },
    graph: {
      enabled: false,
      poll_seconds: 30,
      include_bots: true,
      targets: [],
    },
    media: {
      incoming: false,
      outgoing: false,
      max_files: 4,
      max_file_bytes: 2 * 1024 * 1024,
      download_hosts: [],
    },
    acp: {
      command: "",
      args: [],
      cwd: "",
      env: {},
      secret_env: {},
      timeout_seconds: 300,
    },
    attention: {
      parallel_conversations: 2,
      max_replies_per_hour: 60,
      max_pending: 100,
    },
  };
}
export function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validate(value: unknown): Config {
  const c = value as Config;
  if (c && c.schema === 1) {
    c.graph ??= defaults().graph;
    c.media ??= defaults().media;
  }
  ensure(
    c && c.schema === 1 && uuid.test(c.id),
    "Invalid connection schema or identity",
  );
  ensure(
    typeof c.label === "string" &&
      c.label.trim().length > 0 &&
      c.label.length <= 100,
    "Choose a connection name",
  );
  ensure(
    Number.isSafeInteger(c.revision) &&
      c.revision > 0 &&
      typeof c.enabled === "boolean",
    "Invalid revision or enabled setting",
  );
  ensure(
    ["127.0.0.1", "::1", "0.0.0.0", "::"].includes(c.server?.bind),
    "Use a loopback or wildcard bind address",
  );
  ensure(
    Number.isInteger(c.server.port) &&
      c.server.port >= 0 &&
      c.server.port <= 65535,
    "Invalid port",
  );
  if (c.server.public_url) {
    const u = new URL(c.server.public_url);
    ensure(
      u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === "/",
      "Public URL must be an HTTPS origin",
    );
  }
  ensure(
    c.teams &&
      (!c.teams.client_id || uuid.test(c.teams.client_id)) &&
      (!c.teams.tenant_id || uuid.test(c.teams.tenant_id)),
    "Client and tenant IDs must be UUIDs",
  );
  ensure(
    typeof c.teams.allow_personal === "boolean" &&
      ["mentions", "ambient"].includes(c.teams.participation),
    "Invalid Teams participation",
  );
  ensure(
    Array.isArray(c.teams.conversations) &&
      c.teams.conversations.length <= 200 &&
      c.teams.conversations.every(
        (v) => typeof v === "string" && v.length > 0 && v.length < 1000,
      ),
    "Invalid conversation allowlist",
  );
  ensure(
    c.acp &&
      typeof c.acp.command === "string" &&
      c.acp.command.length < 4000 &&
      typeof c.acp.cwd === "string",
    "Invalid ACP command",
  );
  ensure(
    !c.acp.cwd || isAbsolute(c.acp.cwd),
    "ACP working directory must be absolute",
  );
  ensure(
    Array.isArray(c.acp.args) &&
      c.acp.args.length <= 100 &&
      c.acp.args.every((v) => typeof v === "string" && v.length < 8000),
    "Invalid ACP argument list",
  );
  for (const map of [c.acp.env, c.acp.secret_env]) {
    ensure(
      map && typeof map === "object" && !Array.isArray(map),
      "Invalid ACP environment",
    );
    for (const [k, v] of Object.entries(map))
      ensure(
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) &&
          typeof v === "string" &&
          v.length < 16000,
        "Invalid environment entry",
      );
  }
  for (const name of Object.values(c.acp.secret_env))
    ensure(/^[a-zA-Z0-9_-]{1,100}$/.test(name), "Invalid secret reference");
  ensure(
    Number.isInteger(c.acp.timeout_seconds) &&
      c.acp.timeout_seconds >= 1 &&
      c.acp.timeout_seconds <= 3600,
    "ACP timeout must be 1–3600 seconds",
  );
  ensure(
    c.attention &&
      Number.isInteger(c.attention.parallel_conversations) &&
      c.attention.parallel_conversations >= 1 &&
      c.attention.parallel_conversations <= 8,
    "Parallel conversations must be 1–8",
  );
  ensure(
    Number.isInteger(c.attention.max_replies_per_hour) &&
      c.attention.max_replies_per_hour >= 1 &&
      c.attention.max_replies_per_hour <= 1000,
    "Invalid reply budget",
  );
  ensure(
    Number.isInteger(c.attention.max_pending) &&
      c.attention.max_pending >= 1 &&
      c.attention.max_pending <= 1000,
    "Invalid queue limit",
  );
  ensure(
    c.graph &&
      typeof c.graph.enabled === "boolean" &&
      typeof c.graph.include_bots === "boolean" &&
      Number.isInteger(c.graph.poll_seconds) &&
      c.graph.poll_seconds >= 15 &&
      c.graph.poll_seconds <= 3600,
    "Graph polling interval must be 15–3600 seconds",
  );
  ensure(
    Array.isArray(c.graph.targets) && c.graph.targets.length <= 20,
    "Choose at most 20 Graph conversations",
  );
  for (const t of c.graph.targets) {
    ensure(
      t &&
        ["chat", "channel"].includes(t.kind) &&
        typeof t.conversation_id === "string" &&
        t.conversation_id.length > 0 &&
        t.conversation_id.length <= 1000 &&
        !t.conversation_id.includes(";messageid="),
      "Graph targets use a base conversation ID",
    );
    const validId = (v: unknown) =>
      typeof v === "string" &&
      v.length > 0 &&
      v.length < 1000 &&
      ![".", ".."].includes(v) &&
      !/[\u0000-\u0020/#?\\]/.test(v);
    ensure(
      t.kind === "chat"
        ? validId(t.chat_id) &&
            t.chat_id === t.conversation_id &&
            t.team_id === undefined &&
            t.channel_id === undefined
        : uuid.test(t.team_id ?? "") &&
            validId(t.channel_id) &&
            t.channel_id === t.conversation_id &&
            t.chat_id === undefined,
      "Graph resource IDs must match the explicitly allowed conversation",
    );
    ensure(
      c.teams.conversations.includes(t.conversation_id),
      "Each Graph target must also be in the Teams conversation allowlist",
    );
    ensure(
      Object.keys(t).every((k) =>
        [
          "kind",
          "conversation_id",
          "chat_id",
          "team_id",
          "channel_id",
        ].includes(k),
      ),
      "Unknown Graph target field",
    );
  }
  ensure(
    new Set(c.graph.targets.map((t) => t.conversation_id)).size ===
      c.graph.targets.length,
    "Duplicate Graph conversation",
  );
  ensure(
    c.media &&
      typeof c.media.incoming === "boolean" &&
      typeof c.media.outgoing === "boolean" &&
      Number.isInteger(c.media.max_files) &&
      c.media.max_files >= 1 &&
      c.media.max_files <= 4 &&
      Number.isInteger(c.media.max_file_bytes) &&
      c.media.max_file_bytes >= 1 &&
      c.media.max_file_bytes <= 2 * 1024 * 1024,
    "Invalid attachment limits",
  );
  ensure(
    Array.isArray(c.media.download_hosts) &&
      c.media.download_hosts.length <= 20 &&
      c.media.download_hosts.every(
        (h) =>
          typeof h === "string" &&
          /^[a-z0-9.-]+$/.test(h) &&
          (h.endsWith(".sharepoint.com") || h.endsWith(".1drv.com")) &&
          !h.includes(".."),
      ),
    "Choose exact tenant SharePoint/OneDrive download hosts",
  );
  if (c.enabled)
    ensure(
      c.teams.client_id && c.teams.tenant_id && c.acp.command && c.acp.cwd,
      "Set up Teams identity and the ACP endpoint before enabling",
    );
  // Round-trip the known shape; unknown fields should not silently appear saved.
  function keys(o: object, allowed: string[]) {
    ensure(
      Object.keys(o).every((k) => allowed.includes(k)),
      "Unknown configuration field",
    );
  }
  keys(c, [
    "schema",
    "id",
    "label",
    "revision",
    "enabled",
    "server",
    "teams",
    "acp",
    "attention",
    "graph",
    "media",
  ]);
  keys(c.graph, ["enabled", "poll_seconds", "include_bots", "targets"]);
  keys(c.media, [
    "incoming",
    "outgoing",
    "max_files",
    "max_file_bytes",
    "download_hosts",
  ]);
  keys(c.server, ["bind", "port", "public_url"]);
  keys(c.teams, [
    "client_id",
    "tenant_id",
    "allow_personal",
    "conversations",
    "participation",
  ]);
  keys(c.acp, [
    "command",
    "args",
    "cwd",
    "env",
    "secret_env",
    "timeout_seconds",
  ]);
  keys(c.attention, [
    "parallel_conversations",
    "max_replies_per_hour",
    "max_pending",
  ]);
  return c;
}
export function privateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}
export function privateWrite(path: string, value: string) {
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, path);
}
export function readPrivate(path: string) {
  const s = statSync(path);
  ensure(
    s.isFile() && (process.platform === "win32" || (s.mode & 0o077) === 0),
    "Secret file must be readable only by its owner",
  );
  return readFileSync(path, "utf8").trimEnd();
}
export function load(home: string): Config {
  return validate(JSON.parse(readFileSync(join(home, "adapter.json"), "utf8")));
}
export function save(home: string, c: Config) {
  privateWrite(
    join(home, "adapter.json"),
    JSON.stringify(validate(c), null, 2) + "\n",
  );
}
export function initialize(home: string) {
  privateDir(home);
  privateDir(join(home, "secrets"));
  privateDir(join(home, "workspace"));
  ensure(
    !existsSync(join(home, "adapter.json")),
    "This installation already exists",
  );
  const c = defaults();
  c.acp.cwd = join(home, "workspace");
  save(home, c);
  privateWrite(
    join(home, "secrets", "control-token"),
    randomBytes(32).toString("base64url"),
  );
  return c;
}
export function ready(home: string, c: Config) {
  ensure(
    c.teams.client_id && c.teams.tenant_id && c.acp.command && c.acp.cwd,
    "Configure the Teams bot and an ACP endpoint",
  );
  ensure(
    readPrivate(join(home, "secrets", "client-secret")).length > 0,
    "Store the Teams client secret",
  );
}
export function endpointKey(c: Config) {
  return JSON.stringify(c.acp);
}
