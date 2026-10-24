// Seeded procedural DataTexture generators. No canvas/document: Node-safe.
import {
  DataTexture, RGBAFormat, UnsignedByteType, RepeatWrapping, ClampToEdgeWrapping,
  LinearFilter, LinearMipmapLinearFilter, NearestFilter, SRGBColorSpace, Color,
} from 'three';
import { mulberry32 } from '../utils/prng.js';

function checkSize(size) {
  if (!Number.isInteger(size) || size < 2) throw new Error(`Invalid texture size: ${size}`);
}

function makeTexture(data, width, height, { repeat = true, mipmaps = true, nearest = false, srgb = false } = {}) {
  const tex = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  const wrap = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  tex.magFilter = nearest ? NearestFilter : LinearFilter;
  tex.minFilter = nearest ? NearestFilter : (mipmaps ? LinearMipmapLinearFilter : LinearFilter);
  tex.generateMipmaps = mipmaps && !nearest;
  if (srgb) tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const smooth = (t) => t * t * (3 - 2 * t);

// Tileable value noise grid in [0,1], `cells` lattice points per side.
function makeNoise(rng, cells) {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  return (u, v) => {
    const x = (((u % 1) + 1) % 1) * cells;
    const y = (((v % 1) + 1) % 1) * cells;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
    const a = grid[y0 * cells + x0], b = grid[y0 * cells + x1];
    const c = grid[y1 * cells + x0], d = grid[y1 * cells + x1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
}

// Tileable fBm height field, returned as Float32Array in ~[0,1].
function heightField(rng, size, baseCells, octaves) {
  const noises = [];
  for (let o = 0; o < octaves; o++) noises.push(makeNoise(rng, baseCells * 2 ** o));
  const h = new Float32Array(size * size);
  let norm = 0;
  for (let o = 0; o < octaves; o++) norm += 0.5 ** o;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (let o = 0; o < octaves; o++) v += noises[o](x / size, y / size) * 0.5 ** o;
      h[y * size + x] = v / norm;
    }
  }
  return h;
}

const toByte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Tileable asphalt tangent-space normal map (grain + fine speckle). */
export function createAsphaltNormalMap(seed = 1, size = 128, strength = 2.5) {
  checkSize(size);
  const rng = mulberry32(seed);
  const h = heightField(rng, size, 8, 4);
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = toByte((-dx / len) * 0.5 + 0.5);
      data[i + 1] = toByte((-dy / len) * 0.5 + 0.5);
      data[i + 2] = toByte((1 / len) * 0.5 + 0.5);
      data[i + 3] = 255;
    }
  }
  return makeTexture(data, size, size);
}

/**
 * Roughness variation map. G = roughness variation (glTF/three roughnessMap
 * channel), R = puddle mask (1 = standing water), B = 0, A = 255.
 */
export function createRoughnessMap(seed = 2, size = 128, puddleCoverage = 0.3) {
  checkSize(size);
  const rng = mulberry32(seed);
  const grain = heightField(rng, size, 16, 3);
  const blobs = heightField(rng, size, 3, 3);
  const threshold = 1 - Math.max(0, Math.min(1, puddleCoverage));
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const puddle = Math.max(0, Math.min(1, (blobs[i] - (threshold - 0.04)) / 0.08));
    const o = i * 4;
    data[o] = toByte(puddle);
    data[o + 1] = toByte(0.55 + grain[i] * 0.45);
    data[o + 2] = 0;
    data[o + 3] = 255;
  }
  return makeTexture(data, size, size);
}

/**
 * Emissive window atlas: cols x rows cells, each a window; random lit state
 * and warm/cool tint. Unlit cells are black. Frames are black cell borders.
 */
export function createWindowAtlas(seed = 3, cols = 8, rows = 16, cellSize = 8, litRatio = 0.35) {
  checkSize(cellSize);
  if (cols < 1 || rows < 1) throw new Error('Window atlas needs at least 1 col and row');
  const rng = mulberry32(seed);
  const w = cols * cellSize, h = rows * cellSize;
  const data = new Uint8Array(w * h * 4);
  const tints = [[1, 0.82, 0.5], [1, 0.9, 0.7], [0.7, 0.85, 1], [1, 0.65, 0.4]];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lit = rng() < litRatio;
      const bright = 0.5 + rng() * 0.5;
      const tint = tints[Math.min(tints.length - 1, Math.floor(rng() * tints.length))];
      for (let y = 0; y < cellSize; y++) {
        for (let x = 0; x < cellSize; x++) {
          const border = x === 0 || y === 0 || x === cellSize - 1 || y === cellSize - 1;
          const on = lit && !border;
          const o = ((r * cellSize + y) * w + c * cellSize + x) * 4;
          data[o] = on ? toByte(tint[0] * bright) : 0;
          data[o + 1] = on ? toByte(tint[1] * bright) : 0;
          data[o + 2] = on ? toByte(tint[2] * bright) : 0;
          data[o + 3] = 255;
        }
      }
    }
  }
  return makeTexture(data, w, h, { mipmaps: false, nearest: true, srgb: true });
}

/** 1D neon colour ramp (width x 1): colours blended in sequence, looping. */
export function createNeonRamp(colors, width = 64) {
  if (!Array.isArray(colors) || colors.length === 0) throw new Error('createNeonRamp: colors required');
  checkSize(width);
  const stops = colors.map((c) => new Color(c));
  const out = new Color();
  const data = new Uint8Array(width * 4);
  for (let x = 0; x < width; x++) {
    const t = (x / width) * stops.length;
    const i = Math.floor(t);
    out.copy(stops[i % stops.length]).lerp(stops[(i + 1) % stops.length], smooth(t - i));
    out.convertLinearToSRGB();
    data[x * 4] = toByte(out.r);
    data[x * 4 + 1] = toByte(out.g);
    data[x * 4 + 2] = toByte(out.b);
    data[x * 4 + 3] = 255;
  }
  return makeTexture(data, width, 1, { repeat: false, mipmaps: false, srgb: true });
}
