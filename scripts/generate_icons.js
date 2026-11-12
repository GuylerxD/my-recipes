import fs from 'node:fs';
import zlib from 'node:zlib';

function createPng(width, height, r, g, b) {
  // Simple PNG generator with pure node.js zlib
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function crc32(buf) {
    let table = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    return (crc ^ (-1)) >>> 0;
  }

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const combined = Buffer.concat([typeBuf, data]);
    const crcVal = crc32(combined);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal, 0);
    return Buffer.concat([lenBuf, combined, crcBuf]);
  }

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = makeChunk('IHDR', ihdr);

  // Raw image data with scanline filters (filter byte 0 per line)
  const lineSize = 1 + width * 3;
  const rawData = Buffer.alloc(height * lineSize);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * lineSize;
    rawData[rowOffset] = 0; // None filter
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 3;
      // Border or circle emblem
      const dx = x - width / 2;
      const dy = y - height / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < width * 0.45) {
        rawData[pxOffset] = r;
        rawData[pxOffset + 1] = g;
        rawData[pxOffset + 2] = b;
      } else {
        rawData[pxOffset] = 247;
        rawData[pxOffset + 1] = 246;
        rawData[pxOffset + 2] = 242; // Cream White background
      }
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Ensure icons folder exists
fs.mkdirSync('icons', { recursive: true });
fs.mkdirSync('src/public/icons', { recursive: true });

// Mint Green (#10b981 -> 16, 185, 129) icon
const png192 = createPng(192, 192, 16, 185, 129);
const png512 = createPng(512, 512, 16, 185, 129);

fs.writeFileSync('icons/icon-192.png', png192);
fs.writeFileSync('icons/icon-512.png', png512);
fs.writeFileSync('src/public/icons/icon-192.png', png192);
fs.writeFileSync('src/public/icons/icon-512.png', png512);

// Also write crisp SVG icon
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="128" fill="#10b981"/>
  <rect x="64" y="64" width="384" height="384" rx="64" fill="#f7f6f2"/>
  <path d="M190 140h132v40H190zM160 220h192v36H160zM160 290h192v36H160zM160 360h130v36H160z" fill="#10b981"/>
  <circle cx="340" cy="378" r="28" fill="#059669"/>
</svg>`;

fs.writeFileSync('icons/icon.svg', svg, 'utf8');
fs.writeFileSync('src/public/icons/icon.svg', svg, 'utf8');

console.log('Successfully generated PWA icons.');
