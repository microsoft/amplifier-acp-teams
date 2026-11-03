import { randomUUID } from "node:crypto";
import { ensure } from "./config.js";
type Json = Record<string, any>;
export function validate(p: Json) {
  ensure(
    p && typeof p.message === "string" && p.message.length <= 8000,
    "Invalid question",
  );
  if (p.mode === "url") {
    ensure(
      typeof p.url === "string" &&
        p.url.length <= 8192 &&
        !/[\x00-\x20\x7f]/.test(p.url),
      "Invalid URL",
    );
    const u = new URL(p.url);
    ensure(
      !u.username &&
        !u.password &&
        (u.protocol === "https:" ||
          (u.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))),
      "Unsupported URL",
    );
    ensure(
      typeof p.elicitationId === "string" &&
        p.elicitationId.length > 0 &&
        p.elicitationId.length <= 1024,
      "Missing elicitation identifier",
    );
    return;
  }
  ensure(p.mode === "form", "Unsupported question mode");
  const s = p.requestedSchema;
  ensure(
    s?.type === "object" &&
      s.properties &&
      typeof s.properties === "object" &&
      !Array.isArray(s.properties) &&
      Object.keys(s.properties).length <= 30,
    "Unsupported form schema",
  );
  ensure(
    Object.keys(s).every((k) => ["type", "properties", "required"].includes(k)),
    "Unsupported form constraint",
  );
  for (const [name, f] of Object.entries(s.properties) as [string, Json][]) {
    ensure(
      name.length > 0 &&
        name.length <= 100 &&
        !["__proto__", "constructor", "prototype"].includes(name) &&
        !/password|secret|token|api.?key/i.test(name),
      "Secrets belong on the provider sign-in page",
    );
    ensure(
      f && ["string", "number", "integer", "boolean"].includes(f.type),
      "Unsupported field type",
    );
    ensure(
      Object.keys(f).every((k) =>
        [
          "type",
          "title",
          "description",
          "enum",
          "oneOf",
          "default",
          "minLength",
          "maxLength",
          "minimum",
          "maximum",
        ].includes(k),
      ),
      "Unsupported field constraint",
    );
    const choices = f.enum ?? f.oneOf?.map((v: Json) => v.const);
    if (choices !== undefined)
      ensure(
        f.type === "string" &&
          Array.isArray(choices) &&
          choices.length > 0 &&
          choices.length <= 100 &&
          choices.every((v) => typeof v === "string" && v.length <= 1000),
        "Unsupported choices",
      );
    if (f.oneOf)
      ensure(
        Array.isArray(f.oneOf) &&
          f.oneOf.every(
            (o: Json) =>
              o && Object.keys(o).every((k) => ["const", "title"].includes(k)),
          ),
        "Unsupported choice constraint",
      );
    for (const k of ["minLength", "maxLength", "minimum", "maximum"])
      if (f[k] !== undefined)
        ensure(
          typeof f[k] === "number" && Number.isFinite(f[k]),
          "Invalid field limit",
        );
  }
  ensure(
    s.required === undefined ||
      (Array.isArray(s.required) &&
        s.required.every(
          (k: any) => typeof k === "string" && Object.hasOwn(s.properties, k),
        )),
    "Invalid required fields",
  );
}
function content(s: Json, value: unknown) {
  ensure(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(value).length <= 32768,
    "Invalid form response",
  );
  const v = value as Json;
  for (const key of s.required ?? [])
    ensure(Object.hasOwn(v, key), "Complete the required fields");
  for (const [key, x] of Object.entries(v)) {
    ensure(Object.hasOwn(s.properties, key), "Unknown response field");
    const f = s.properties[key];
    if (f.type === "string") {
      ensure(
        typeof x === "string" &&
          x.length >= (f.minLength ?? 0) &&
          x.length <= (f.maxLength ?? 32768),
        "Invalid text length",
      );
      const opts = f.enum ?? f.oneOf?.map((v: Json) => v.const);
      if (opts) ensure(opts.includes(x), "Choose an offered option");
    } else if (f.type === "boolean")
      ensure(typeof x === "boolean", "Expected yes or no");
    else
      ensure(
        typeof x === "number" &&
          Number.isFinite(x) &&
          (f.type !== "integer" || Number.isInteger(x)) &&
          x >= (f.minimum ?? -Infinity) &&
          x <= (f.maximum ?? Infinity),
        "Invalid numeric response",
      );
  }
}
export class Questions {
  private pending = new Map<
    string,
    {
      job: string;
      value: Json;
      finish: (v: Json) => void;
      timer: NodeJS.Timeout;
    }
  >();
  list() {
    return [...this.pending.values()].map((p) => p.value);
  }
  request(job: string, params: Json) {
    validate(params);
    ensure(this.pending.size < 32, "Too many questions");
    const id = randomUUID();
    const answer = new Promise<Json>((resolve) => {
      const timer = setTimeout(() => this.answer(id, "cancel"), 120000);
      this.pending.set(id, {
        job,
        value: {
          id,
          job,
          mode: params.mode,
          message: params.message,
          requestedSchema: params.requestedSchema,
          url: params.url,
          elicitationId: params.elicitationId,
          expires_at: Date.now() + 120000,
        },
        finish: resolve,
        timer,
      });
    });
    return { id, answer };
  }
  answer(id: string, action: string, value?: unknown) {
    ensure(
      ["accept", "decline", "cancel"].includes(action),
      "Invalid response",
    );
    const p = this.pending.get(id);
    ensure(p, "Question closed");
    if (action === "accept" && p.value.mode === "form")
      content(p.value.requestedSchema, value);
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.finish({
      action,
      ...(action === "accept" && p.value.mode === "form"
        ? { content: value }
        : {}),
    });
  }
  cancelJob(job: string) {
    for (const [id, p] of this.pending)
      if (p.job === job) this.answer(id, "cancel");
  }
}
