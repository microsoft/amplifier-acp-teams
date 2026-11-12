/** Native installation controls. Existing bearer-managed installs remain unchanged. */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { ensure, privateWrite, readPrivate } from "./config.js";
import type { Store } from "./store.js";
import { body, json } from "./transport.js";
export const PROOF_DOMAIN = "acp-teams-adapter.local-proof/1";
export function listenerProof(
  id: string,
  origin: string,
  nonce: string,
  secret: string,
) {
  ensure(/^[a-f0-9]{64}$/.test(nonce), "Invalid challenge");
  return createHmac("sha256", secret)
    .update([PROOF_DOMAIN, id, origin, nonce].join("\n"))
    .digest("hex");
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
const random = () => randomBytes(32).toString("hex");
export interface NativeSettings {
  schema: 1;
  id: string;
  origin: string;
}
export function nativeSettings(
  home: string,
  config: Config,
): NativeSettings | undefined {
  const path = join(home, "native.json");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  ensure(raw.length < 4096, "Invalid native configuration");
  const s = JSON.parse(raw);
  ensure(
    s.schema === 1 &&
      s.id === config.id &&
      config.server.bind === "127.0.0.1" &&
      config.server.port > 0 &&
      s.origin === `http://127.0.0.1:${config.server.port}` &&
      Object.keys(s).every((k) => ["schema", "id", "origin"].includes(k)),
    "Native management must keep its saved loopback identity and address",
  );
  return s;
}
function createPrivate(path: string, value: string) {
  // The native launcher created this private directory with an inherited Windows DACL.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== "win32") {
    const fd = openSync(join(path, ".."), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
export class NativeAuth {
  readonly settings: NativeSettings | undefined;
  private hashes = 0;
  private attempts: number[] = [];
  constructor(
    readonly home: string,
    config: Config,
    readonly store: Store,
    readonly token: string,
  ) {
    this.settings = nativeSettings(home, config);
    if (this.settings)
      store.db.exec(
        "CREATE TABLE IF NOT EXISTS native_web_sessions(id TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL)",
      );
  }
  allowed(req: IncomingMessage) {
    if (!this.settings) return true;
    return (
      req.headers.host === new URL(this.settings.origin).host &&
      (!req.headers.origin || req.headers.origin === this.settings.origin) &&
      (!req.headers["sec-fetch-site"] ||
        ["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))
    );
  }
  cookieName() {
    return "teams_" + this.settings?.id.replaceAll("-", "");
  }
  firstNeeded() {
    return (
      !!this.settings &&
      !existsSync(join(this.home, "secrets/local-password.json"))
    );
  }
  session(
    req: IncomingMessage,
  ): { id: string; csrf: string; expires: number } | undefined {
    if (!this.settings) return;
    const value = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(this.cookieName() + "="))
      ?.slice(this.cookieName().length + 1);
    if (!value || !/^[a-f0-9]{64}$/.test(value)) return;
    return this.store.db
      .prepare("SELECT * FROM native_web_sessions WHERE id=? AND expires>?")
      .get(hash(value), Date.now()) as any;
  }
  authorize(req: IncomingMessage) {
    if (!this.allowed(req)) return false;
    const session = this.session(req);
    return (
      !!session &&
      (["GET", "HEAD"].includes(req.method ?? "GET") ||
        equal(String(req.headers["x-csrf-token"] ?? ""), session.csrf))
    );
  }
  private signedIn(res: ServerResponse) {
    const token = random(),
      csrf = random(),
      expires = Date.now() + 12 * 3600 * 1000;
    this.store.db
      .prepare("DELETE FROM native_web_sessions WHERE expires<?")
      .run(Date.now());
    this.store.db
      .prepare("INSERT INTO native_web_sessions VALUES(?,?,?)")
      .run(hash(token), csrf, expires);
    res.setHeader(
      "set-cookie",
      `${this.cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
    );
    json(res, 200, {
      authenticated: true,
      csrf,
      auth_mode: "local_password",
      first_account_needed: false,
    });
  }
  private async helper(
    action: "hash-password" | "verify-password" | "startup",
    input?: unknown,
    enabled = false,
  ): Promise<any> {
    const executable = process.env.ACP_TEAMS_NATIVE_LAUNCHER;
    ensure(
      executable && isAbsolute(executable),
      "Open this installation with its native app",
    );
    const args =
      action === "startup"
        ? ["--home", this.home, "startup", ...(enabled ? ["--enabled"] : [])]
        : [action];
    const content = input === undefined ? "" : JSON.stringify(input);
    ensure(Buffer.byteLength(content) <= 8192, "Local request exceeds bound");
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = Buffer.alloc(0),
        settled = false;
      const finish = (err?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("Local operation did not finish"));
      }, 15000);
      child.stdout.on("data", (b) => {
        output = Buffer.concat([output, b]);
        if (output.length > 8192) {
          child.kill();
          finish(new Error("Local operation exceeded its output bound"));
        }
      });
      child.stderr.resume();
      child.on("error", () =>
        finish(new Error("Local operation could not start")),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(content);
      child.on("close", (code) => {
        if (code !== 0) {
          finish(new Error("Local operation failed"));
          return;
        }
        try {
          finish(undefined, JSON.parse(output.toString()));
        } catch {
          finish(new Error("Invalid local operation response"));
        }
      });
    });
  }
  private async password(
    action: "hash-password" | "verify-password",
    input: unknown,
  ) {
    ensure(
      this.hashes < 2,
      "Another sign-in is being checked; try again shortly",
    );
    this.hashes++;
    try {
      return await this.helper(action, input);
    } finally {
      this.hashes--;
    }
  }
  async startup(enabled: boolean) {
    try {
      const result = await this.helper("startup", undefined, enabled);
      privateWrite(
        join(this.home, "startup.json"),
        JSON.stringify({
          requested: enabled,
          configured: enabled,
          error: null,
        }),
      );
      return result;
    } catch (e) {
      privateWrite(
        join(this.home, "startup.json"),
        JSON.stringify({
          requested: enabled,
          configured: null,
          error: "Startup could not be changed",
        }),
      );
      throw e;
    }
  }
  async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    if (path === "/auth/session" && req.method === "GET") {
      const session = this.session(req);
      json(res, 200, {
        authenticated: !!session,
        csrf: session?.csrf ?? null,
        auth_mode: this.settings ? "local_password" : "bearer",
        first_account_needed: this.firstNeeded(),
      });
      return true;
    }
    if (!this.settings) return false;
    if (path === "/api/v1/local-proof" && req.method === "GET") {
      const nonce = url.searchParams.get("nonce") ?? "";
      ensure(
        url.searchParams.size === 1 && /^[a-f0-9]{64}$/.test(nonce),
        "Invalid local proof challenge",
      );
      json(res, 200, {
        id: this.settings.id,
        origin: this.settings.origin,
        nonce,
        proof: listenerProof(
          this.settings.id,
          this.settings.origin,
          nonce,
          this.token,
        ),
      });
      return true;
    }
    if (
      ["/auth/login", "/auth/first-account"].includes(path) &&
      req.method === "POST"
    ) {
      if (req.headers.origin !== this.settings.origin) {
        json(res, 403, { error: "Use this installation’s local page" });
        return true;
      }
      this.attempts = this.attempts.filter((t) => t > Date.now() - 60000);
      if (this.attempts.length >= 10) {
        json(res, 429, { error: "Please wait a minute before trying again" });
        return true;
      }
      this.attempts.push(Date.now());
      const input = await body(req, 8192);
      ensure(
        typeof input.password === "string" &&
          Buffer.byteLength(input.password) <= 1024 &&
          !input.password.includes("\0"),
        "Invalid password",
      );
      if (path === "/auth/first-account") {
        ensure(
          Object.keys(input).every((k) =>
            ["password", "setup_token", "start_at_signin"].includes(k),
          ) && typeof input.start_at_signin === "boolean",
          "Invalid account setup request",
        );
        if (!this.firstNeeded()) {
          json(res, 409, {
            error: "This account already exists. Sign in with its password.",
          });
          return true;
        }
        const setup = JSON.parse(
          readPrivate(join(this.home, "secrets/first-account.json")),
        );
        if (
          setup.id !== this.settings.id ||
          !Number.isSafeInteger(setup.expires_at) ||
          setup.expires_at <= Date.now() ||
          typeof input.setup_token !== "string" ||
          !equal(input.setup_token, setup.token)
        ) {
          json(res, 403, {
            error: "Open the native app again to continue setup",
          });
          return true;
        }
        const hashed = await this.password("hash-password", {
          password: input.password,
        });
        try {
          createPrivate(
            join(this.home, "secrets/local-password.json"),
            JSON.stringify({ schema: 1, encoded: hashed.encoded }),
          );
        } catch (e: any) {
          if (e.code === "EEXIST") {
            json(res, 409, {
              error: "This account already exists. Sign in with its password.",
            });
            return true;
          }
          throw e;
        }
        unlinkSync(join(this.home, "secrets/first-account.json"));
        if (input.start_at_signin) {
          try {
            await this.startup(true);
          } catch {
            /* Account is complete even if OS startup is unavailable. */
          }
        }
      } else {
        ensure(
          Object.keys(input).every((k) => k === "password"),
          "Invalid sign-in request",
        );
        if (this.firstNeeded()) {
          json(res, 401, { error: "Finish local account setup first" });
          return true;
        }
        const saved = JSON.parse(
          readPrivate(join(this.home, "secrets/local-password.json")),
        );
        const result = await this.password("verify-password", {
          encoded: saved.encoded,
          password: input.password,
        });
        if (!result.valid) {
          json(res, 401, { error: "The password did not match" });
          return true;
        }
      }
      this.signedIn(res);
      return true;
    }
    if (path === "/auth/logout" && req.method === "POST") {
      if (!this.authorize(req)) {
        json(res, 403, { error: "Sign in again before changing this session" });
        return true;
      }
      const session = this.session(req);
      if (session)
        this.store.db
          .prepare("DELETE FROM native_web_sessions WHERE id=?")
          .run(session.id);
      res.setHeader(
        "set-cookie",
        `${this.cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      );
      json(res, 200, { authenticated: false });
      return true;
    }
    return false;
  }
}
