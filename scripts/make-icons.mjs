/**
 * Renders the extension icons from scratch — no image tooling, no binary blobs in git.
 * Chrome only accepts raster icons, so this draws each size procedurally and writes a
 * minimal PNG (deflate via the built-in zlib).
 *
 * The mark: a cream photo frame on a deep green tile, with a sun and hills behind a
 * diagonal stripe — "a picture, filtered".
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // supersampling factor per axis

const GREEN = [0x31, 0x5d, 0x4b];
const DEEP = [0x24, 0x48, 0x38];
const CREAM = [0xf6, 0xf3, 0xed];

/* --------------------------------------------------------------------- geometry */

function roundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** Colour of the icon at unit coordinates (0..1), or null for transparent. */
function sample(u, v) {
  if (!roundedRect(u, v, 0, 0, 1, 1, 0.22)) return null;

  const inFrame = roundedRect(u, v, 0.18, 0.2, 0.82, 0.8, 0.06);
  if (!inFrame) return GREEN;

  // Diagonal stripe across the frame marks the picture as filtered. It sits on top of
  // the scene, with a cream gap either side so it reads over both hills and sky.
  const stripe = Math.abs(u + v - 1);
  if (stripe < 0.055) return DEEP;
  if (stripe < 0.095) return CREAM;

  // Sun.
  if ((u - 0.32) ** 2 + (v - 0.33) ** 2 <= 0.072 ** 2) return GREEN;

  // Two overlapping hills rising from the bottom edge of the frame.
  const hill = (peakX, height) => v > 0.8 - Math.max(0, height - Math.abs(u - peakX) * 0.62);
  if (hill(0.38, 0.2) || hill(0.62, 0.32)) return GREEN;

  return CREAM;
}

/* ------------------------------------------------------------------------- PNG */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const colour = sample(
            (x + (sx + 0.5) / SAMPLES) / size,
            (y + (sy + 0.5) / SAMPLES) / size
          );
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }
      const covered = a / 255;
      const offset = (y * size + x) * 4;
      if (covered > 0) {
        rgba[offset] = Math.round(r / covered);
        rgba[offset + 1] = Math.round(g / covered);
        rgba[offset + 2] = Math.round(b / covered);
      }
      rgba[offset + 3] = Math.round(a / (SAMPLES * SAMPLES));
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), render(size));
}
console.log(`icons: wrote ${SIZES.map((s) => `${s}x${s}`).join(", ")} to icons/`);
