import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { buildApng } from "../src/apng.ts";

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// A 2×2 RGB PNG filled with one colour.
function png(r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, r, g, b, r, g, b]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat([row, row]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunks(file: Buffer): { type: string; data: Buffer }[] {
  const out = [];
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    const data = file.subarray(at + 8, at + 8 + length);
    assert.equal(file.readUInt32BE(at + 8 + length), crc32(file.subarray(at + 4, at + 8 + length)) >>> 0, `${type} CRC`);
    out.push({ type, data });
    at += 12 + length;
  }
  return out;
}

test("APNG: one fcTL per frame, fdAT after the first, sequence numbers in order, exact delay", () => {
  const file = buildApng([png(255, 0, 0), png(0, 255, 0), png(0, 0, 255)], 30);
  const list = chunks(file);
  assert.deepEqual(
    list.map((c) => c.type),
    ["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"],
  );
  assert.equal(list[1]!.data.readUInt32BE(0), 3);
  const sequences = list.filter((c) => c.type === "fcTL" || c.type === "fdAT").map((c) => c.data.readUInt32BE(0));
  assert.deepEqual(sequences, [0, 1, 2, 3, 4]);
  const fctl = list[2]!.data;
  assert.equal(fctl.readUInt16BE(20) / fctl.readUInt16BE(22), 1 / 30);
});

test("APNG refuses frames of different sizes", () => {
  const big = png(0, 0, 0);
  big.writeUInt32BE(3, 16);
  assert.throws(() => buildApng([png(0, 0, 0), big], 30), /differs in size or format/);
});
