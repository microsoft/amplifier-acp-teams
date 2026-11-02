import type { Attachment as TeamsAttachment } from "@microsoft/teams.api";
import { randomUUID } from "node:crypto";
import { ensure, type Config } from "./config.js";
import { boundedBody, GraphClient, type Fetch } from "./graph.js";
import { type Attachment, type Inbound, projection, Store } from "./store.js";

type Json = Record<string, any>;
export interface OutputFile {
  name: string;
  mime_type: string;
  data: string;
}
export function filename(value: unknown) {
  return (
    String(value ?? "attachment")
      .replace(/[\x00-\x1f\x7f/\\]/g, "")
      .slice(0, 120) || "attachment"
  );
}
export function isText(mime: string) {
  return [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
  ].includes(mime);
}
export function validBytes(mime: string, b: Buffer) {
  const starts = (value: string) =>
    b.subarray(0, value.length).equals(Buffer.from(value, "binary"));
  const valid =
    mime === "image/png"
      ? starts("\x89PNG\r\n\x1a\n")
      : mime === "image/jpeg"
        ? starts("\xff\xd8\xff")
        : mime === "image/gif"
          ? starts("GIF87a") || starts("GIF89a")
          : mime === "image/webp"
            ? starts("RIFF") && b.subarray(8, 12).toString() === "WEBP"
            : ["audio/wav", "audio/x-wav"].includes(mime)
              ? starts("RIFF") && b.subarray(8, 12).toString() === "WAVE"
              : mime === "audio/mpeg"
                ? starts("ID3") || (b[0] === 255 && ((b[1] ?? 0) & 224) === 224)
                : mime === "application/pdf"
                  ? starts("%PDF-")
                  : isText(mime)
                    ? b.length <= 200000 &&
                      !b.includes(0) &&
                      Buffer.from(b.toString("utf8")).equals(b)
                    : false;
  ensure(
    valid && b.length > 0,
    "Unsupported attachment type or mismatched content",
  );
}
export function decode(data: string, limit: number) {
  ensure(
    typeof data === "string" &&
      data.length <= Math.ceil(limit / 3) * 4 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(data),
    "Invalid attachment data",
  );
  const b = Buffer.from(data, "base64");
  ensure(
    b.length > 0 && b.length <= limit && b.toString("base64") === data,
    "Invalid attachment size or encoding",
  );
  return b;
}
export function inputContent(c: Config, m: Inbound, caps: Json) {
  const blocks: Json[] = [];
  for (const [index, a] of m.attachments.entries()) {
    let reason = !c.media.incoming
      ? "Attachment reading is disabled"
      : index >= c.media.max_files
        ? "Attachment count limit reached"
        : a.note;
    if (!reason && !a.data)
      reason = "The connector has metadata only for this attachment";
    if (
      !reason &&
      !isText(a.content_type) &&
      !(a.content_type.startsWith("image/") && caps.image) &&
      !(a.content_type.startsWith("audio/") && caps.audio) &&
      !(a.content_type === "application/pdf" && caps.embeddedContext)
    )
      reason = "The agent does not advertise support for this attachment type";
    if (reason) {
      blocks.push({
        type: "text",
        text: `Attachment ${a.name} was not read: ${reason}.`,
      });
      continue;
    }
    try {
      const b = decode(a.data!, c.media.max_file_bytes);
      validBytes(a.content_type, b);
      const uri = `teams-file://${m.key}/${encodeURIComponent(m.id)}/${index}`;
      if (isText(a.content_type))
        blocks.push(
          caps.embeddedContext
            ? {
                type: "resource",
                resource: {
                  uri,
                  mimeType: a.content_type,
                  text: b.toString("utf8"),
                },
              }
            : {
                type: "text",
                text: `Attachment ${a.name} (untrusted document content):\n${b.toString("utf8")}`,
              },
        );
      else if (
        a.content_type.startsWith("image/") ||
        a.content_type.startsWith("audio/")
      )
        blocks.push({
          type: a.content_type.startsWith("image/") ? "image" : "audio",
          mimeType: a.content_type,
          data: a.data,
        });
      else
        blocks.push({
          type: "resource",
          resource: { uri, mimeType: a.content_type, blob: a.data },
        });
    } catch {
      blocks.push({
        type: "text",
        text: `Attachment ${a.name} was not read: invalid or oversized content.`,
      });
    }
  }
  return blocks;
}
export function outputFile(c: Config, content: Json): OutputFile | undefined {
  if (!c.media.outgoing) return;
  let mime = content.mimeType,
    data = content.data,
    name = content.name;
  if (content.type === "resource") {
    const r = content.resource ?? {};
    mime = r.mimeType;
    data =
      typeof r.text === "string"
        ? Buffer.from(r.text).toString("base64")
        : r.blob;
    name = r.name ?? r.uri?.split("/").at(-1);
  } else if (!["image", "audio"].includes(content.type)) return;
  if (typeof mime !== "string" || typeof data !== "string") return;
  const bytes = decode(data, c.media.max_file_bytes);
  validBytes(mime, bytes);
  const ext: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/json": "json",
  };
  return {
    name: filename(name ?? `agent-output.${ext[mime] ?? "bin"}`),
    mime_type: mime,
    data,
  };
}
export function fileUrl(c: Config, value: unknown) {
  ensure(
    typeof value === "string" && value.length <= 12000,
    "Invalid Teams file location",
  );
  const u = new URL(value);
  ensure(
    u.protocol === "https:" &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.hash &&
      c.media.download_hosts.includes(u.hostname),
    "File host has not been allowed for this tenant",
  );
  return u;
}
const extensionMime: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};
export async function hydrateActivity(
  c: Config,
  m: Inbound,
  raw: any,
  fetcher: Fetch = fetch,
): Promise<Inbound> {
  if (!c.media.incoming) return m;
  const attachments: Attachment[] = [];
  for (const [i, a] of (raw.attachments ?? []).slice(0, 8).entries()) {
    const item: Attachment = {
      name: filename(a.name),
      content_type: String(a.contentType ?? "unknown").slice(0, 100),
    };
    if (i >= c.media.max_files) {
      item.note = "Attachment count limit reached";
      attachments.push(item);
      continue;
    }
    // Personal Teams file cards supply a short-lived URL. It is used only here,
    // never persisted or passed to the agent/history API, and never gets OAuth.
    if (
      m.kind === "personal" &&
      a.contentType === "application/vnd.microsoft.teams.file.download.info" &&
      a.content?.downloadUrl
    ) {
      try {
        const u = fileUrl(c, a.content.downloadUrl);
        const response = await fetcher(u, {
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        ensure(response.ok, "File download failed");
        const bytes = await boundedBody(response, c.media.max_file_bytes);
        item.content_type =
          extensionMime[String(a.content.fileType ?? "").toLowerCase()] ??
          response.headers.get("content-type")?.split(";")[0] ??
          "unknown";
        validBytes(item.content_type, bytes);
        item.data = bytes.toString("base64");
      } catch {
        item.note =
          "File unavailable, unsupported, oversized, or its tenant download host is not configured";
      }
    } else
      item.note =
        "Metadata only; use the configured Graph path for inline channel images or a personal file upload";
    attachments.push(item);
  }
  return { ...m, attachments };
}
export async function hydrateGraph(
  c: Config,
  m: Inbound,
  path: string,
  raw: any,
  graph: GraphClient,
) {
  if (
    !c.media.incoming ||
    raw.deletedDateTime ||
    !String(raw.body?.content ?? "").includes("hostedContents/")
  )
    return m;
  const result = { ...m, attachments: [...m.attachments] };
  try {
    const list = await graph.collection(path + "/hostedContents", 1);
    for (const content of list.items) {
      if (result.attachments.length >= c.media.max_files) break;
      if (typeof content.id !== "string" || content.id.length > 2000) continue;
      const item: Attachment = {
        name: "Inline image",
        content_type: "unknown",
      };
      try {
        const { bytes, mime } = await graph.response(
          path +
            "/hostedContents/" +
            encodeURIComponent(content.id) +
            "/$value",
          c.media.max_file_bytes,
        );
        validBytes(mime, bytes);
        item.content_type = mime;
        item.data = bytes.toString("base64");
      } catch {
        item.note =
          "Inline content could not be retrieved with this app’s existing permissions";
      }
      result.attachments.push(item);
    }
  } catch {
    result.attachments.push({
      name: "Inline media",
      content_type: "unknown",
      note: "Graph hosted-content access was not granted; no additional permissions were requested",
    });
  }
  return result;
}
export function inlineImage(mime: string, bytes: Buffer) {
  // Keep embedded payloads small and enforce Teams' documented 1024px limit.
  // Larger images and animated/unknown formats use the file-consent path.
  if (bytes.length > 12000) return false;
  if (mime === "image/png" && bytes.length >= 24) {
    const w = bytes.readUInt32BE(16),
      h = bytes.readUInt32BE(20);
    return w > 0 && h > 0 && w <= 1024 && h <= 1024;
  }
  if (mime === "image/jpeg") {
    for (let i = 2; i + 8 < bytes.length; ) {
      if (bytes[i] !== 255) return false;
      const marker = bytes[i + 1]!;
      if (marker === 216 || marker === 217) {
        i += 2;
        continue;
      }
      const length = bytes.readUInt16BE(i + 2);
      if (length < 2 || i + 2 + length > bytes.length) return false;
      if ([192, 193, 194].includes(marker)) {
        const h = bytes.readUInt16BE(i + 5),
          w = bytes.readUInt16BE(i + 7);
        return w > 0 && h > 0 && w <= 1024 && h <= 1024;
      }
      i += 2 + length;
    }
  }
  return false;
}
export function prepareDelivery(
  c: Config,
  store: Store,
  m: Inbound,
  files: OutputFile[],
) {
  const attachments: TeamsAttachment[] = [];
  const notices: string[] = [];
  for (const file of files.slice(0, c.media.max_files)) {
    const bytes = decode(file.data, c.media.max_file_bytes);
    validBytes(file.mime_type, bytes);
    if (m.kind !== "personal") {
      // Small inline images are supported by Bot Framework in all scopes. Larger
      // files need a SharePoint destination and explicit grants; never publish a
      // private download endpoint or silently broaden tenant permissions.
      if (inlineImage(file.mime_type, bytes) && attachments.length === 0)
        attachments.push({
          contentType: file.mime_type,
          name: file.name,
          contentUrl: `data:${file.mime_type};base64,${file.data}`,
        });
      else
        notices.push(
          `${file.name}: this group needs a configured file destination; ask for the file in a personal chat.`,
        );
      continue;
    }
    if (!c.media.download_hosts.length) {
      notices.push(
        `${file.name}: configure this tenant’s file transfer hosts before accepting file delivery.`,
      );
      continue;
    }
    const id = randomUUID();
    store.db
      .prepare("INSERT INTO file_deliveries VALUES(?,?,?,'pending',?,NULL)")
      .run(
        id,
        JSON.stringify(projection(m)),
        JSON.stringify(file),
        Date.now() + 30 * 60 * 1000,
      );
    attachments.push({
      contentType: "application/vnd.microsoft.teams.card.file.consent",
      name: file.name,
      content: {
        description: "File created by the connected agent",
        sizeInBytes: bytes.length,
        acceptContext: { delivery_id: id },
        declineContext: { delivery_id: id },
      },
    });
  }
  return { attachments, notices };
}
export async function fileConsent(
  c: Config,
  store: Store,
  a: any,
  fetcher: Fetch = fetch,
): Promise<TeamsAttachment | undefined> {
  ensure(c.enabled && c.media.outgoing, "File delivery is paused");
  const id = a.value?.context?.delivery_id;
  ensure(
    typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
    "Invalid file delivery",
  );
  const row = store.db
    .prepare("SELECT * FROM file_deliveries WHERE id=?")
    .get(id) as any;
  ensure(
    row && row.status === "pending" && row.expires > Date.now(),
    "File delivery expired or already handled",
  );
  const message: Inbound = JSON.parse(row.message);
  ensure(
    a.channelId === "msteams" &&
      (a.channelData?.tenant?.id ?? a.conversation?.tenantId) ===
        message.tenant &&
      a.conversation?.id === message.conversation &&
      a.conversation?.conversationType === "personal" &&
      a.from?.id === message.sender &&
      a.recipient?.id === message.bot_id,
    "File consent belongs to another participant or conversation",
  );
  if (a.value?.action === "decline") {
    store.db
      .prepare(
        "UPDATE file_deliveries SET status='declined',file='{}' WHERE id=?",
      )
      .run(id);
    return;
  }
  ensure(a.value?.action === "accept", "Invalid file consent action");
  const info = a.value.uploadInfo ?? {};
  const upload = fileUrl(c, info.uploadUrl),
    visible = fileUrl(c, info.contentUrl);
  ensure(
    !visible.search,
    "Teams file display link must not contain a private download query",
  );
  ensure(
    typeof info.uniqueId === "string" && info.uniqueId.length < 2000,
    "Missing Teams file identity",
  );
  const file: OutputFile = JSON.parse(row.file),
    bytes = decode(file.data, c.media.max_file_bytes);
  validBytes(file.mime_type, bytes);
  const claimed = store.db
    .prepare(
      "UPDATE file_deliveries SET status='uploading' WHERE id=? AND status='pending'",
    )
    .run(id);
  ensure(claimed.changes === 1, "File delivery was already handled");
  try {
    const response = await fetcher(upload, {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
      },
      body: new Uint8Array(bytes),
    });
    ensure(
      response.ok && response.status !== 202,
      "Teams file upload did not complete",
    );
    store.db
      .prepare(
        "UPDATE file_deliveries SET status='uploaded',file='{}' WHERE id=?",
      )
      .run(id);
    store.audit("file_uploaded", { delivery: id });
    return {
      contentType: "application/vnd.microsoft.teams.card.file.info",
      name: file.name,
      contentUrl: visible.toString(),
      content: {
        uniqueId: info.uniqueId,
        fileType: file.name.split(".").at(-1),
      },
    };
  } catch {
    store.db
      .prepare(
        "UPDATE file_deliveries SET status='uncertain',file='{}' WHERE id=?",
      )
      .run(id);
    store.audit("file_upload_uncertain", { delivery: id });
    throw new Error(
      "File upload did not receive confirmation; it will not be repeated automatically",
    );
  }
}
