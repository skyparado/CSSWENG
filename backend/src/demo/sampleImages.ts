import { deflateSync } from 'node:zlib';

/**
 * Tiny synthetic PNGs for the demo. They are drawn from maths, not from real
 * patients or real scans, so they are safe to ship and carry no personal data.
 * No image library: a PNG is a signature, an IHDR, zlib-compressed rows and an IEND.
 */
export type ImageKind = 'fundus' | 'oct' | 'slit' | 'topography' | 'external';

const W = 640;
const H = 480;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

type Rgb = [number, number, number];
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** Deterministic pseudo-noise so every run produces the same picture. */
function noise(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function pixel(kind: ImageKind, x: number, y: number): Rgb {
  const cx = W / 2;
  const cy = H / 2;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  const n = noise(x, y) * 10;

  switch (kind) {
    case 'fundus': {
      const R = 220;
      if (r > R) return [8, 6, 6];
      const glow = 1 - (r / R) * 0.45;
      let c: Rgb = [210 * glow, 85 * glow, 40 * glow];
      // Optic disc, nasal side.
      const disc = Math.hypot(x - (cx + 95), y - (cy - 10));
      if (disc < 34) c = [250, 215 - disc, 120];
      // Vessels radiating from the disc.
      const ang = Math.atan2(y - (cy - 10), x - (cx + 95));
      const vessel = Math.abs(Math.sin(ang * 6 + disc * 0.02));
      if (disc > 30 && vessel < 0.07 && disc < 300) c = [110, 20, 18];
      // A few hemorrhage dots.
      if (Math.hypot(x - (cx - 40), y - (cy + 30)) < 6 || Math.hypot(x - (cx - 80), y - (cy - 20)) < 5) c = [120, 10, 10];
      return [clamp(c[0] + n), clamp(c[1] + n), clamp(c[2] + n)];
    }
    case 'oct': {
      // Layered retina with a foveal dip.
      const dip = 38 * Math.exp(-(dx * dx) / 9000);
      const top = 150 + dip + 8 * Math.sin(x / 40);
      const band = y - top;
      let v = 12;
      if (band > 0 && band < 130) {
        const layer = Math.sin(band / 5.5);
        v = 70 + 90 * Math.max(0, layer);
        if (band > 112) v = 210; // RPE line
      }
      return [clamp(v + n), clamp(v + n), clamp(v + n)];
    }
    case 'slit': {
      const beam = Math.abs(dx - 40 - dy * 0.25);
      const lens = r < 200 ? 30 : 6;
      const b = beam < 22 ? 230 - beam * 6 : lens;
      return [clamp(b * 0.9 + n), clamp(b * 0.95 + n), clamp(b + 20 + n)];
    }
    case 'topography': {
      // Concentric colour rings with an off-centre steep area (cone).
      const cone = Math.hypot(x - (cx + 20), y - (cy + 55));
      const v = Math.min(r, 230) / 230;
      const hot = Math.exp(-(cone * cone) / 5000);
      const t = Math.min(1, v * 0.6 + hot * 0.8);
      const ring = (Math.sin(r / 7) + 1) / 2;
      if (r > 235) return [20, 20, 24];
      return [clamp(255 * t + ring * 12), clamp(200 * (1 - Math.abs(t - 0.5) * 2) + ring * 12), clamp(255 * (1 - t) + ring * 12)];
    }
    case 'external': {
      // Skin tone, an eye shape, an iris and a swollen lid margin.
      const eye = (dx * dx) / (190 * 190) + (dy * dy) / (70 * 70);
      let c: Rgb = [214, 168, 138];
      if (eye < 1) c = [238, 232, 228];
      if (Math.hypot(dx, dy) < 58 && eye < 1) c = [74, 52, 38];
      if (Math.hypot(dx, dy) < 22 && eye < 1) c = [10, 8, 8];
      if (Math.abs(eye - 1) < 0.08) c = [170, 90, 80];
      if (Math.hypot(x - (cx + 90), y - (cy - 78)) < 18) c = [200, 90, 80];
      return [clamp(c[0] + n), clamp(c[1] + n), clamp(c[2] + n)];
    }
  }
}

export function samplePng(kind: ImageKind): Buffer {
  const rows = Buffer.alloc((W * 3 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    rows[o++] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const [r, g, b] = pixel(kind, x, y);
      rows[o++] = r;
      rows[o++] = g;
      rows[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
