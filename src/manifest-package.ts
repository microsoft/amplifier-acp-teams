import { deflateRawSync, deflateSync } from "node:zlib";
import { type Config } from "./config.js";
import { manifest } from "./manifest.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Same RGBA artwork as ops/package-manifest.py; no file or user-supplied paths.
function icon(size: number, outline: boolean): Buffer {
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mark =
        (x >= size / 4 &&
          x < (3 * size) / 4 &&
          y >= size / 4 &&
          y < (3 * size) / 8) ||
        (x >= (7 * size) / 16 &&
          x < (9 * size) / 16 &&
          y >= size / 4 &&
          y < (3 * size) / 4);
      const rgba = mark
        ? [255, 255, 255, 255]
        : outline
          ? [0, 0, 0, 0]
          : [23, 93, 87, 255];
      rows.set(rgba, y * (1 + size * 4) + 1 + x * 4);
    }
  }
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A bounded three-file Teams package, using only this registration's manifest. */
export function manifestPackage(config: Config): Buffer {
  const entries: [string, Buffer][] = [
    ["manifest.json", Buffer.from(JSON.stringify(manifest(config), null, 2))],
    ["color.png", icon(192, false)],
    ["outline.png", icon(32, true)],
  ];
  const files: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name),
      compressed = deflateRawSync(data),
      crc = crc32(data);
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12); // DEFLATE; 1980-01-01.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    files.push(local, filename, compressed);
    directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const index = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}
