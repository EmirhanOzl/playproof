import { crc32 } from "node:zlib";

// Animated PNG from same-sized PNG frames, without re-encoding: each frame's compressed image data is moved into
// the animation as-is. Browsers (and GitHub) play APNG; tools that do not, show the first frame.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  type: string;
  data: Buffer;
}

function readChunks(png: Buffer): Chunk[] {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  const chunks: Chunk[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// fps must divide evenly into the delay fraction; any positive number works (delay = 1/fps s).
export function buildApng(frames: Buffer[], fps: number): Buffer {
  if (!frames.length) throw new Error("no frames");
  const parsed = frames.map(readChunks);
  const header = parsed[0]!.find((c) => c.type === "IHDR")!.data;
  for (const [i, chunks] of parsed.entries()) {
    if (!chunks.find((c) => c.type === "IHDR")!.data.equals(header)) throw new Error(`frame ${i + 1} differs in size or format from frame 1`);
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  // Delay as a fraction of a second: 1/30, 1/60, ... (scaled to integers for fractional fps).
  const delayDen = Math.round(fps * 100);
  const delayNum = 100;

  const out: Buffer[] = [SIGNATURE, chunk("IHDR", header)];
  // Colour information from the first frame (sRGB, gAMA, ...) applies to the whole animation.
  for (const c of parsed[0]!) if (!["IHDR", "IDAT", "IEND", "acTL", "fcTL", "fdAT"].includes(c.type)) out.push(chunk(c.type, c.data));
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(0, 4); // loop forever
  out.push(chunk("acTL", actl));

  let sequence = 0;
  parsed.forEach((chunks, index) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(sequence++, 0);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt32BE(0, 12);
    fctl.writeUInt32BE(0, 16);
    fctl.writeUInt16BE(delayNum, 20);
    fctl.writeUInt16BE(delayDen, 22);
    fctl.writeUInt8(0, 24); // dispose: none
    fctl.writeUInt8(0, 25); // blend: source (every frame is a full picture)
    out.push(chunk("fcTL", fctl));
    for (const c of chunks.filter((c) => c.type === "IDAT")) {
      if (index === 0) {
        out.push(chunk("IDAT", c.data));
      } else {
        const seq = Buffer.alloc(4);
        seq.writeUInt32BE(sequence++, 0);
        out.push(chunk("fdAT", Buffer.concat([seq, c.data])));
      }
    }
  });
  out.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(out);
}
