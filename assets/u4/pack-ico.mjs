// Packs square PNG files into one ICO file with PNG entries. ImageMagick writes BMP entries,
// which make the favicon about 20 times larger.
// Usage: node pack-ico.mjs <output.ico> <16.png> <24.png> ...
import * as NodeFS from "node:fs";

const [output, ...inputs] = process.argv.slice(2);
const images = inputs.map((path) => {
  const data = NodeFS.readFileSync(path);
  // A PNG stores its width as a big-endian integer at byte 16, in the IHDR chunk.
  return { data, size: data.readUInt32BE(16) };
});

const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ data, size }, index) => {
  const entry = 6 + 16 * index;
  // The ICO format stores 256 as 0.
  header.writeUInt8(size % 256, entry);
  header.writeUInt8(size % 256, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += data.length;
});

NodeFS.writeFileSync(output, Buffer.concat([header, ...images.map(({ data }) => data)]));
