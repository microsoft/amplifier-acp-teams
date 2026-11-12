import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type {
  IHttpServerAdapter,
  HttpMethod,
  HttpRouteHandler,
} from "@microsoft/teams.apps";
import { ensure } from "./config.js";

export async function body(req: IncomingMessage, limit = 100000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    ensure(size <= limit, "Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
export function json(res: ServerResponse, status: number, data: unknown) {
  const encoded = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(encoded);
}
/** Wire adapter only. Teams SDK validates the JWT before its activity handler.
 * Never set the SDK's pre-authenticated `token` field from an HTTP request. */
export class Transport implements IHttpServerAdapter {
  routes = new Map<string, HttpRouteHandler>();
  server = createServer((req, res) => void this.handle(req, res));
  constructor(
    readonly bind: string,
    readonly manage: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => Promise<void>,
  ) {
    this.server.requestTimeout = 20000;
    this.server.headersTimeout = 10000;
  }
  registerRoute(method: HttpMethod, path: string, handler: HttpRouteHandler) {
    this.routes.set(method + " " + path, handler);
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const path = new URL(req.url ?? "/", "http://local").pathname;
      if (path === "/api/messages") {
        const handler = this.routes.get((req.method ?? "GET") + " " + path);
        if (!handler) {
          json(res, 503, { error: "Teams registration is not configured" });
          return;
        }
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter(([, v]) => v !== undefined),
        ) as Record<string, string | string[]>;
        const result = await handler({
          body: await body(req, 1024 * 1024),
          headers,
        });
        json(res, result.status, result.body ?? {});
        return;
      }
      await this.manage(req, res);
    } catch {
      if (!res.headersSent)
        json(res, 400, { error: "Request could not be processed" });
      else res.end();
    }
  }
  async start(port: number | string) {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(Number(port), this.bind, resolve);
    });
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }
  address() {
    const a = this.server.address();
    return a && typeof a === "object" ? a.port : 0;
  }
}
