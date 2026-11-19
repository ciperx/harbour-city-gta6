// Harbour City: a procedural dusk district on a 9x9 grid.
//
// The layout is a lattice of 12 m roads (10 of them per axis, so 9x9 blocks between them),
// with sidewalks, curbs, lane dashes, crosswalks, street lamps, palms and one landmark tower.
// Everything static is merged into a handful of big meshes so the whole city draws in about
// twenty calls; per-building variation comes from a vertex-colour tint plus six shared facade
// textures whose window grid is emitted into an emissive map, which is what makes the city
// light up at dusk.

import * as THREE from '../vendor/three.module.min.js';

export const GRID = 9; // blocks per side
export const ROAD_WIDTH = 12; // metres of asphalt between blocks
export const BLOCK = 34; // metres of block footprint (sidewalk included)
export const PITCH = ROAD_WIDTH + BLOCK; // block-to-block spacing, 46 m
export const BOUNDS = (GRID * PITCH) / 2; // half the city, 207 m
export const SIDEWALK = 3.6; // walkable strip between curb and building line
export const SIDEWALK_TOP = 0.32; // height of the kerb the player stands on

// Centre line of every road on both axes: 10 lines from -207 to +207.
export const ROAD_COORDS = Array.from({ length: GRID + 1 }, (_, i) => -BOUNDS + i * PITCH);

const LOT = BLOCK - SIDEWALK * 2; // 26.8 m of buildable lot per block
const WATER_Z = BOUNDS + 18; // where the promenade ends and the harbour starts

const BUILDING_COUNT = 170;
const LANDMARK_BLOCK = [4, 4];
const PARK_BLOCKS = new Set(['1,7', '7,1', '8,0']);

// --- small utilities -------------------------------------------------------------------

/** Deterministic 32-bit PRNG so a seed always rebuilds the same city. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Merge a list of non-indexed geometries that share the same attributes. */
function mergeGeometries(geoms) {
  if (!geoms.length) return null;
  const names = ['position', 'normal', 'uv'];
  if (geoms[0].getAttribute('color')) names.push('color');

  let total = 0;
  for (const g of geoms) total += g.getAttribute('position').count;

  const merged = new THREE.BufferGeometry();
  for (const name of names) {
    const itemSize = geoms[0].getAttribute(name).itemSize;
    const array = new Float32Array(total * itemSize);
    let offset = 0;
    for (const g of geoms) {
      const attr = g.getAttribute(name);
      array.set(attr.array, offset);
      offset += attr.array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }
  for (const g of geoms) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * BoxGeometry face order is +X, -X, +Y, -Y, +Z, -Z; six vertices each once non-indexed.
 * `horizontal` is the [u, v] repeat for the roof and floor (gravel at a constant density),
 * defaulting to untitled so a facade atlas is not smeared across a rooftop.
 */
function scaleBoxUV(geom, uReps, vReps, horizontal = null) {
  const uv = geom.getAttribute('uv');
  const arr = uv.array;
  for (let face = 0; face < 6; face++) {
    const flat = face === 2 || face === 3;
    const su = flat ? (horizontal ? horizontal[0] : 1) : uReps;
    const sv = flat ? (horizontal ? horizontal[1] : 1) : vReps;
    for (let v = 0; v < 6; v++) {
      const i = (face * 6 + v) * 2;
      arr[i] *= su;
      arr[i + 1] *= sv;
    }
  }
  uv.needsUpdate = true;
  return geom;
}

/** Cut one contiguous group of faces (6 verts each) out of a non-indexed box. */
function sliceFaces(geom, startFace, faceCount) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const attr = geom.getAttribute(name);
    const from = startFace * 6 * attr.itemSize;
    const to = (startFace + faceCount) * 6 * attr.itemSize;
    out.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(from, to), attr.itemSize));
  }
  return out;
}

/** Paint a flat colour into a per-vertex colour attribute. */
function paint(geom, color) {
  const count = geom.getAttribute('position').count;
  const array = new Float32Array(count * 3);
  // THREE.Color already holds a linear working-space value in r152+, and vertex colours are
  // consumed as linear, so this must NOT be converted again (that crushed the facades to black).
  for (let i = 0; i < count; i++) {
    array[i * 3] = color.r;
    array[i * 3 + 1] = color.g;
    array[i * 3 + 2] = color.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(array, 3));
  return geom;
}

// --- procedural textures -----------------------------------------------------------------
//
// Every surface in the city is painted here, at load, into offscreen canvases: no image files
// to fetch, no network, and the whole palette stays in one place. Each texture is built for a
// physical size in metres (asphalt tile 9 m, paving tile 1 m, gravel tile 6 m) and the caller
// sets `repeat` or bakes the count into the UVs, so the grain is the same size everywhere.

/** Wrap a 2D canvas as a repeating texture with the renderer's best anisotropy. */
function canvasTexture(canvas, anisotropy = 4, srgb = true) {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.max(1, anisotropy);
  tex.needsUpdate = true;
  return tex;
}

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** Grit: thousands of sub-pixel specks, which is what stops a flat fill reading as plastic. */
function scatter(ctx, rng, w, h, count, light, dark, maxSize = 2) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = rng() > 0.5 ? light : dark;
    const s = 0.5 + rng() * maxSize;
    ctx.fillRect(rng() * w, rng() * h, s, s);
  }
}

/** Soft radial stains, for tar patches and oil drips. */
function blotches(ctx, rng, w, h, count, color, radius, alpha) {
  for (let i = 0; i < count; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = radius * (0.4 + rng());
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = alpha * (0.4 + rng() * 0.6);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }
}

/** A radial falloff on a transparent canvas: lamp pools, window bloom, contact shadows. */
function radialTexture(size, stops) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Asphalt: cold grey grit, patched tar, and the wet reflection streaks that run along the
 * road. The albedo carries the streaks as a faint blue sheen; the roughness map makes the
 * same streaks glossy (dark = smooth in a roughness map), so the low sun and the street lamps
 * smear across them the way they do on a street that is still wet.
 */
function makeAsphalt(rng) {
  const S = 512;
  const canvas = makeCanvas(S, S);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#2c3037';
  ctx.fillRect(0, 0, S, S);

  // Aggregate: coarse grit in a couple of tones, then finer sand.
  scatter(ctx, rng, S, S, 5200, 'rgba(190,198,208,0.10)', 'rgba(0,0,0,0.16)', 2);
  scatter(ctx, rng, S, S, 9000, 'rgba(210,218,228,0.05)', 'rgba(0,0,0,0.10)', 1.2);

  // Resurfacing patches and oil drips.
  blotches(ctx, rng, S, S, 16, 'rgba(16,18,22,1)', 60, 0.35);
  blotches(ctx, rng, S, S, 9, 'rgba(70,76,86,1)', 42, 0.18);
  blotches(ctx, rng, S, S, 7, 'rgba(8,9,12,1)', 26, 0.30);

  // Tar seams: long, slightly wandering cracks.
  ctx.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    ctx.strokeStyle = `rgba(10,11,14,${0.18 + rng() * 0.3})`;
    ctx.lineWidth = 0.8 + rng() * 1.8;
    let x = rng() * S;
    let y = rng() * S;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 4 + Math.floor(rng() * 5);
    for (let s = 0; s < steps; s++) {
      x += (rng() - 0.5) * 70;
      y += (rng() - 0.5) * 70;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Wet sheen: vertical streaks (a tyre-worn band) plus a few long diagonal glints.
  for (let i = 0; i < 26; i++) {
    const x = rng() * S;
    const w = 6 + rng() * 34;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, `rgba(150,180,215,${0.03 + rng() * 0.05})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, w, S);
  }
  for (let i = 0; i < 10; i++) {
    const y = rng() * S;
    const h = 3 + rng() * 12;
    ctx.fillStyle = `rgba(170,200,235,${0.02 + rng() * 0.03})`;
    ctx.fillRect(0, y, S, h);
  }

  // Roughness: mid-grey asphalt, glossy in the streaks and puddles.
  const rough = makeCanvas(S, S);
  const rctx = rough.getContext('2d');
  rctx.fillStyle = '#c4c4c4';
  rctx.fillRect(0, 0, S, S);
  scatter(rctx, rng, S, S, 4000, 'rgba(255,255,255,0.10)', 'rgba(0,0,0,0.16)', 2);
  blotches(rctx, rng, S, S, 22, 'rgba(40,40,40,1)', 40, 0.55);
  for (let i = 0; i < 18; i++) {
    const x = rng() * S;
    const w = 10 + rng() * 40;
    const g = rctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(40,40,40,0)');
    g.addColorStop(0.5, 'rgba(30,30,30,0.75)');
    g.addColorStop(1, 'rgba(40,40,40,0)');
    rctx.fillStyle = g;
    rctx.fillRect(x, 0, w, S);
  }

  return { canvas, rough };
}

/**
 * Paving: 4x4 slabs of a metre each, with grout, chipped corners and the stains that collect
 * where the kerb meets the road. Baked at 1 m per tile so it is consistent across blocks.
 */
function makeSidewalk(rng) {
  const S = 512;
  const TILES = 4;
  const tile = S / TILES;
  const canvas = makeCanvas(S, S);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#6d7278'; // grout
  ctx.fillRect(0, 0, S, S);

  for (let iy = 0; iy < TILES; iy++) {
    for (let ix = 0; ix < TILES; ix++) {
      const tone = 138 + Math.floor(rng() * 26);
      ctx.fillStyle = `rgb(${tone},${tone + 3},${tone + 8})`;
      ctx.fillRect(ix * tile + 2, iy * tile + 2, tile - 4, tile - 4);

      // A soft edge highlight along the top-left of each slab catches the sun.
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(ix * tile + 2, iy * tile + 2, tile - 4, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(ix * tile + 2, iy * tile + tile - 4, tile - 4, 2);

      // Chipped corner + a hairline crack on some slabs.
      if (rng() > 0.55) {
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.beginPath();
        ctx.moveTo(ix * tile + 2, iy * tile + 2);
        ctx.lineTo(ix * tile + 2 + 8 + rng() * 10, iy * tile + 2);
        ctx.lineTo(ix * tile + 2, iy * tile + 2 + 6 + rng() * 8);
        ctx.closePath();
        ctx.fill();
      }
      if (rng() > 0.7) {
        ctx.strokeStyle = 'rgba(20,22,26,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        let x = ix * tile + rng() * tile;
        let y = iy * tile + rng() * tile;
        ctx.moveTo(x, y);
        for (let s = 0; s < 3; s++) {
          x += (rng() - 0.5) * 30;
          y += (rng() - 0.5) * 30;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }

  // Grime and gum spots.
  scatter(ctx, rng, S, S, 5200, 'rgba(255,255,255,0.05)', 'rgba(0,0,0,0.10)', 2);
  blotches(ctx, rng, S, S, 10, 'rgba(30,32,36,1)', 46, 0.16);

  return canvas;
}

/** Roof gravel: pebbles, tar seams and a couple of rust patches, at 6 m per tile. */
function makeRoofGravel(rng) {
  const S = 256;
  const canvas = makeCanvas(S, S);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#3b3e44';
  ctx.fillRect(0, 0, S, S);
  scatter(ctx, rng, S, S, 5200, 'rgba(180,186,196,0.30)', 'rgba(0,0,0,0.30)', 2.2);
  scatter(ctx, rng, S, S, 2600, 'rgba(210,214,222,0.16)', 'rgba(10,10,14,0.24)', 3.4);
  blotches(ctx, rng, S, S, 8, 'rgba(18,19,24,1)', 34, 0.28);
  blotches(ctx, rng, S, S, 4, 'rgba(96,74,52,1)', 22, 0.16);

  ctx.strokeStyle = 'rgba(14,15,18,0.5)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, S * 0.42);
  ctx.lineTo(S, S * 0.46);
  ctx.moveTo(S * 0.7, 0);
  ctx.lineTo(S * 0.74, S);
  ctx.stroke();

  return canvas;
}

// --- facade textures -------------------------------------------------------------------

const GLASS = ['#36435f', '#2f3a52', '#3c4a67', '#2a3448'];
const LIT = ['#ffd39a', '#ffe3bd', '#cfe4ff', '#ffc477', '#f6f0dd', '#a8d8ff'];

// Three brightness tiers, so a facade reads as occupied without every window glowing equally.
const TIER_DIM = 0.34;
const TIER_MID = 0.66;
const TIER_BRIGHT = 1.0;

/**
 * Six facade variants. Each returns an albedo canvas (concrete, glazing, grime), a matching
 * emissive canvas where only the lit windows are painted, and the list of those lit windows in
 * texture UV space so the bloom layer can put a glow sprite exactly on them.
 *
 * Every window gets a state: dark, or one of three brightness tiers. Rows and columns are
 * switched in blocks first, so whole floors are dark and stairwell columns are always lit —
 * that clustering is what makes a facade look inhabited rather than randomly sprinkled.
 */
function makeFacade(variant, rng) {
  const W = 256;
  const H = 576;
  const cols = 8;
  const rows = 16;
  const cw = W / cols;
  const ch = H / rows;

  const albedo = makeCanvas(W, H);
  const a = albedo.getContext('2d');

  const glow = makeCanvas(W, H);
  const g = glow.getContext('2d');

  const base = ['#d3d7dd', '#c9cfd8', '#dcd6cc', '#c3cbd6', '#d8cfc6', '#c8ccd2'][variant % 6];
  const grad = a.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, base);
  grad.addColorStop(0.55, '#b9bec6');
  grad.addColorStop(1, '#8f959e');
  a.fillStyle = grad;
  a.fillRect(0, 0, W, H);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, W, H);

  // Concrete grain so the walls are not perfectly flat under the sun.
  for (let i = 0; i < 3400; i++) {
    a.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.05)';
    a.fillRect(rng() * W, rng() * H, 1 + rng() * 3, 1 + rng() * 3);
  }

  // Which storeys and which columns are in use at all.
  const rowLit = [];
  const colLit = [];
  for (let r = 0; r < rows; r++) rowLit.push(rng() > 0.24);
  for (let c = 0; c < cols; c++) colLit.push(rng() > 0.34);

  const banded = variant % 3 === 2; // ribbon glazing: one continuous window band per storey
  const insetX = banded ? 2 : cw * (0.16 + rng() * 0.06);
  const insetY = banded ? ch * 0.26 : ch * (0.2 + rng() * 0.08);
  const winW = banded ? W - insetX * 2 : cw - insetX * 2;
  const winH = ch - insetY * 2;

  const lit = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = banded ? insetX : col * cw + insetX;
      const y = row * ch + insetY;

      // Recessed frame, then the glass.
      a.fillStyle = 'rgba(0,0,0,0.18)';
      a.fillRect(x - 1.5, y - 1.5, winW + 3, winH + 3);
      a.fillStyle = GLASS[Math.floor(rng() * GLASS.length)];
      a.fillRect(x, y, winW, winH);

      // A hint of sky in the upper part of each pane, and a mullion.
      a.fillStyle = 'rgba(150,190,230,0.14)';
      a.fillRect(x, y, winW, winH * 0.34);
      a.fillStyle = 'rgba(255,255,255,0.06)';
      a.fillRect(x, y + winH * 0.5, winW, 1);

      const occupied = rowLit[row] && colLit[col];
      if (!occupied) continue;

      const p = rng();
      let tier = 0;
      if (p > 0.86) tier = TIER_BRIGHT;
      else if (p > 0.69) tier = TIER_MID;
      else if (p > 0.5) tier = TIER_DIM;
      if (tier === 0) continue;

      const light = LIT[Math.floor(rng() * LIT.length)];
      g.globalAlpha = tier;
      g.fillStyle = light;
      g.fillRect(x, y, winW, winH);
      // the glow bleeds a little past the frame, the way a lit pane does at dusk
      g.globalAlpha = tier * 0.32;
      g.fillRect(x - 2, y - 2, winW + 4, winH + 4);
      g.globalAlpha = 1;

      // Curtains and blinds break the flat rectangle of light.
      if (rng() > 0.55) {
        g.globalAlpha = tier * 0.5;
        g.fillStyle = 'rgba(0,0,0,0.55)';
        const blind = winH * (0.18 + rng() * 0.42);
        g.fillRect(x, y, winW, blind);
        g.globalAlpha = 1;
      }

      lit.push({
        u: (x + winW * 0.5) / W,
        v: 1 - (y + winH * 0.5) / H,
        tier,
        color: light,
      });
    }
  }

  // Floor bands: a darker line at every storey boundary reads as a slab edge, heavier every
  // fourth floor so the building has a rhythm instead of an even grid.
  for (let row = 0; row <= rows; row++) {
    a.fillStyle = 'rgba(0,0,0,0.10)';
    a.fillRect(0, row * ch - 1, W, 2);
    if (row % 4 === 0) {
      a.fillStyle = 'rgba(0,0,0,0.16)';
      a.fillRect(0, row * ch - 2, W, 3);
      a.fillStyle = 'rgba(255,255,255,0.10)';
      a.fillRect(0, row * ch + 1, W, 1);
    }
  }

  // Grime: rain streaks running down from the sill of every window, heavier near the roof.
  for (let i = 0; i < 220; i++) {
    const x = rng() * W;
    const y = rng() * H * 0.9;
    const len = 12 + rng() * 90;
    const w = 0.6 + rng() * 2.6;
    const s = a.createLinearGradient(0, y, 0, y + len);
    s.addColorStop(0, `rgba(38,40,44,${0.05 + rng() * 0.09})`);
    s.addColorStop(1, 'rgba(38,40,44,0)');
    a.fillStyle = s;
    a.fillRect(x, y, w, len);
  }
  // Soot under the parapet, dirt where the street splashes the ground floor.
  const soot = a.createLinearGradient(0, 0, 0, H * 0.16);
  soot.addColorStop(0, 'rgba(24,26,30,0.34)');
  soot.addColorStop(1, 'rgba(24,26,30,0)');
  a.fillStyle = soot;
  a.fillRect(0, 0, W, H * 0.16);
  const dirt = a.createLinearGradient(0, H, 0, H * 0.82);
  dirt.addColorStop(0, 'rgba(28,28,32,0.42)');
  dirt.addColorStop(1, 'rgba(28,28,32,0)');
  a.fillStyle = dirt;
  a.fillRect(0, H * 0.82, W, H * 0.18);

  // Ground-floor shopfront: a warm band across the bottom of every third fabric.
  if (variant % 3 === 0) {
    a.fillStyle = 'rgba(28,34,44,0.92)';
    a.fillRect(0, H - ch * 1.7, W, ch * 1.7);
    for (let i = 0; i < 6; i++) {
      g.globalAlpha = 0.85;
      g.fillStyle = i % 2 ? '#ffd9a2' : '#bfe4ff';
      g.fillRect(6 + i * (W / 6), H - ch * 1.45, W / 6 - 10, ch * 0.95);
      g.globalAlpha = 1;
      lit.push({
        u: (6 + i * (W / 6) + (W / 6 - 10) * 0.5) / W,
        v: 1 - (H - ch * 1.45 + ch * 0.95 * 0.5) / H,
        tier: TIER_BRIGHT,
        color: i % 2 ? '#ffd9a2' : '#bfe4ff',
      });
    }
  }

  const map = canvasTexture(albedo, 4);
  const emissiveMap = canvasTexture(glow, 4);

  return { map, emissiveMap, lit };
}

// --- city ------------------------------------------------------------------------------

export class City {
  constructor(seed = 1, renderer = null) {
    this.seed = seed;
    this.random = mulberry32(seed);
    this.buildings = []; // collision boxes: { x0, x1, z0, z1, top }
    this.blockList = []; // per-block data for spawning and the minimap
    this.group = new THREE.Group();
    this.group.name = 'city';
    this.detail = { lamps: 0, palms: 0, boats: 0, cars: 0, glow: 0 };
    this.maxAnisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
    this.time = 0;

    // Facade atlases: albedo + emissive + the list of lit windows used for the bloom layer.
    this.facades = [];
    for (let v = 0; v < 6; v++) this.facades.push(makeFacade(v, this.random));
    for (const f of this.facades) {
      f.map.anisotropy = this.maxAnisotropy;
      f.emissiveMap.anisotropy = this.maxAnisotropy;
    }

    // Surface textures, all painted here at load.
    const aniso = this.maxAnisotropy;
    const asphalt = makeAsphalt(this.random);
    this.textures = {
      asphaltMap: canvasTexture(asphalt.canvas, aniso),
      asphaltRough: canvasTexture(asphalt.rough, aniso, false),
      sidewalk: canvasTexture(makeSidewalk(this.random), aniso),
      roof: canvasTexture(makeRoofGravel(this.random), aniso),
      glow: canvasTexture(
        radialTexture(64, [
          [0, 'rgba(255,255,255,1)'],
          [0.28, 'rgba(255,236,200,0.55)'],
          [0.62, 'rgba(255,214,160,0.14)'],
          [1, 'rgba(255,200,140,0)'],
        ]),
        aniso,
      ),
      pool: canvasTexture(
        radialTexture(128, [
          [0, 'rgba(255,214,158,0.72)'],
          [0.35, 'rgba(255,196,132,0.34)'],
          [0.72, 'rgba(255,178,110,0.09)'],
          [1, 'rgba(255,170,100,0)'],
        ]),
        aniso,
      ),
      contact: canvasTexture(
        radialTexture(128, [
          [0, 'rgba(0,0,0,0.85)'],
          [0.45, 'rgba(0,0,0,0.45)'],
          [0.8, 'rgba(0,0,0,0.12)'],
          [1, 'rgba(0,0,0,0)'],
        ]),
        aniso,
      ),
    };

    this.blocks(); // records blockList first so buildings can attach to it
    this.ground();
    this.sidewalks();
    this.markings();
    this.buildingsForBlocks();
    this.landmark();
    this.lamps();
    this.palms();
    this.waterfront();
    this.cars();
    this.skyline();
    this.windowGlow();
    this.lampLightPool();
  }

  // -- block bookkeeping ----------------------------------------------------------------

  blocks() {
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const cx = ROAD_COORDS[i] + PITCH / 2;
        const cz = ROAD_COORDS[j] + PITCH / 2;
        const key = `${i},${j}`;
        this.blockList.push({
          ix: i,
          iz: j,
          key,
          center: new THREE.Vector3(cx, SIDEWALK_TOP, cz),
          park: PARK_BLOCKS.has(key),
          landmark: i === LANDMARK_BLOCK[0] && j === LANDMARK_BLOCK[1],
          buildings: [],
        });
      }
    }
  }

  blockAt(i, j) {
    return this.blockList[i * GRID + j];
  }

  // -- asphalt ---------------------------------------------------------------------------

  ground() {
    const span = BOUNDS * 2 + 60;
    const asphaltMap = this.textures.asphaltMap;
    const asphaltRough = this.textures.asphaltRough;
    // One tile is 9 m of road, so grain and streaks keep a constant physical size.
    const reps = span / 9;
    asphaltMap.repeat.set(reps, reps);
    asphaltRough.repeat.set(reps, reps);

    const asphalt = new THREE.Mesh(
      new THREE.BoxGeometry(span, 0.6, span),
      new THREE.MeshStandardMaterial({
        map: asphaltMap,
        roughnessMap: asphaltRough,
        roughness: 1,
        metalness: 0.16, // enough to pick up the low sun in the wet streaks
        color: 0xc6ccd6,
        envMapIntensity: 1.15, // the wet sheen is the environment, not the albedo
      }),
    );
    asphalt.position.set(0, -0.3, 0);
    asphalt.receiveShadow = true;
    asphalt.castShadow = false;
    asphalt.name = 'asphalt';
    this.group.add(asphalt);

    // A pale ring of pavement beyond the outermost road, so the lattice does not end in void.
    const apron = new THREE.Mesh(
      new THREE.RingGeometry(BOUNDS + 28, BOUNDS + 44, 64, 1),
      new THREE.MeshStandardMaterial({ color: 0x2a2f37, roughness: 0.9 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = 0.02;
    apron.receiveShadow = true;
    this.group.add(apron);
  }

  // -- sidewalks, curbs and park grass ---------------------------------------------------

  sidewalks() {
    const slabs = [];
    const curbs = [];
    const grass = [];
    const half = BLOCK / 2;
    const curbW = 0.5;
    const pavingReps = BLOCK / 4; // the paving texture is four 1 m tiles across

    for (const block of this.blockList) {
      const { x, z } = block.center;
      const slab = new THREE.BoxGeometry(BLOCK, SIDEWALK_TOP, BLOCK);
      slab.translate(x, SIDEWALK_TOP / 2, z);
      const slabGeom = slab.toNonIndexed();
      slab.dispose();
      scaleBoxUV(slabGeom, pavingReps, SIDEWALK_TOP / 4, [pavingReps, pavingReps]);
      (block.park ? grass : slabs).push(slabGeom);

      // Curb stones: a lighter rim along the four road-facing edges.
      const rim = [
        [BLOCK, curbW, curbW, 0, 0, -half + curbW / 2],
        [BLOCK, curbW, curbW, 0, 0, half - curbW / 2],
        [curbW, curbW, BLOCK, -half + curbW / 2, 0, 0],
        [curbW, curbW, BLOCK, half - curbW / 2, 0, 0],
      ];
      for (const [w, h, d, dx, , dz] of rim) {
        const g = new THREE.BoxGeometry(w, h, d);
        g.translate(x + dx, SIDEWALK_TOP / 2 + 0.02, z + dz);
        const cg = g.toNonIndexed();
        g.dispose();
        scaleBoxUV(cg, Math.max(w, d) / 4, 0.2, [Math.max(w, d) / 4, 0.2]);
        curbs.push(cg);
      }
    }

    const add = (geoms, material, name) => {
      const merged = mergeGeometries(geoms);
      if (!merged) return;
      const mesh = new THREE.Mesh(merged, material);
      mesh.receiveShadow = true;
      mesh.name = name;
      this.group.add(mesh);
    };

    add(
      slabs,
      new THREE.MeshStandardMaterial({
        map: this.textures.sidewalk,
        color: 0xcfd3d8,
        roughness: 0.86,
        metalness: 0.04,
        envMapIntensity: 0.45,
      }),
      'sidewalks',
    );
    add(
      curbs,
      new THREE.MeshStandardMaterial({
        map: this.textures.sidewalk,
        color: 0xe4e6e9,
        roughness: 0.72,
        envMapIntensity: 0.5,
      }),
      'curbs',
    );
    add(
      grass,
      new THREE.MeshStandardMaterial({ color: 0x3c5a3a, roughness: 0.95 }),
      'parks',
    );
  }

  // -- lane markings and crosswalks -----------------------------------------------------

  markings() {
    const dashes = [];
    const walks = [];
    const dashGeo = (w, d, x, y, z) => {
      const g = new THREE.BoxGeometry(w, 0.02, d);
      g.translate(x, y, z);
      return g.toNonIndexed();
    };

    // Dashed centre line, 3 m painted / 4 m gap, along every road on both axes.
    const DASH = 3;
    const GAP = 4;
    for (const c of ROAD_COORDS) {
      for (let t = -BOUNDS + 8; t < BOUNDS - 8; t += DASH + GAP) {
        // skip the dashes that fall inside an intersection
        const nearIntersection = ROAD_COORDS.some((r) => Math.abs(r - (t + DASH / 2)) < ROAD_WIDTH * 0.75);
        if (nearIntersection) continue;
        dashes.push(dashGeo(0.3, DASH, c, 0.03, t + DASH / 2)); // road running along z
        dashes.push(dashGeo(DASH, 0.3, t + DASH / 2, 0.03, c)); // road running along x
      }
    }

    // Crosswalk bars on all four approaches of every intersection.
    const BARS = 7;
    for (const cx of ROAD_COORDS) {
      for (const cz of ROAD_COORDS) {
        for (const side of [-1, 1]) {
          for (let b = 0; b < BARS; b++) {
            const off = -ROAD_WIDTH / 2 + 1.1 + b * 1.45;
            // approach from +/-z, bars span x
            walks.push(dashGeo(1.0, 2.6, cx + off, 0.032, cz + side * (ROAD_WIDTH / 2 - 1.9)));
            // approach from +/-x, bars span z
            walks.push(dashGeo(2.6, 1.0, cx + side * (ROAD_WIDTH / 2 - 1.9), 0.032, cz + off));
          }
        }
      }
    }

    const dashMesh = new THREE.Mesh(
      mergeGeometries(dashes),
      new THREE.MeshStandardMaterial({ color: 0xd9d2bf, roughness: 0.7, emissive: 0x2a2620, emissiveIntensity: 0.5 }),
    );
    dashMesh.name = 'lane-dashes';
    dashMesh.receiveShadow = true;
    this.group.add(dashMesh);

    const walkMesh = new THREE.Mesh(
      mergeGeometries(walks),
      new THREE.MeshStandardMaterial({
        color: 0xcfcabb,
        roughness: 0.75,
        transparent: true,
        opacity: 0.72,
      }),
    );
    walkMesh.name = 'crosswalks';
    walkMesh.receiveShadow = true;
    this.group.add(walkMesh);
  }

  // -- buildings -------------------------------------------------------------------------

  /** Split a block lot into 2 or 3 footprints, then extrude each one. */
  buildingsForBlocks() {
    const wallGeoms = Array.from({ length: 6 }, () => []);
    const roofGeoms = [];
    const tint = [
      0xe2e8f2, 0xd8e0ee, 0xe8dfd2, 0xccd8ec, 0xe6d8cc, 0xd6d6e2, 0xc6cede, 0xece2d4,
      0xc0c8d8, 0xe0d0c6, 0xd0dcea, 0xe8ded2,
    ];

    // Exactly BUILDING_COUNT buildings: 2 per block, plus a third on enough blocks to reach it.
    const buildable = this.blockList.filter((b) => !b.landmark && !b.park);
    const extras = BUILDING_COUNT - buildable.length * 2;
    const extraSet = new Set();
    while (extraSet.size < extras) {
      extraSet.add(Math.floor(this.random() * buildable.length));
    }

    for (let bi = 0; bi < buildable.length; bi++) {
      const block = buildable[bi];
      const rects = this.subdivideLot(extraSet.has(bi) ? 3 : 2, block);
      const variant = Math.floor(this.random() * 6);
      const color = new THREE.Color(tint[Math.floor(this.random() * tint.length)]);

      for (const rect of rects) {
        const w = Math.max(6, rect.x1 - rect.x0);
        const d = Math.max(6, rect.z1 - rect.z0);
        const r = this.random();
        // 8 m walk-ups through to 70 m towers, with most of the city in the low teens.
        const h = clamp(8 + 62 * Math.pow(r, 2.55), 8, 70);
        const cx = (rect.x0 + rect.x1) / 2;
        const cz = (rect.z0 + rect.z1) / 2;

        // The atlas covers 24 m across and 57.6 m up, so windows stay ~3 m x 3.6 m.
        const uReps = Math.max(1, Math.round(w / 24));
        const vReps = Math.max(0.35, h / 57.6);

        const box = new THREE.BoxGeometry(w, h, d);
        box.translate(cx, h / 2, cz);
        const geom = box.toNonIndexed();
        box.dispose();
        // Roof and floor faces tile the gravel at 6 m, the walls use the facade atlas.
        scaleBoxUV(geom, uReps, vReps, [w / 6, d / 6]);

        const walls = paint(sliceFaces(geom, 0, 4), color);
        const roof = sliceFaces(geom, 4, 2);
        geom.dispose();

        wallGeoms[variant].push(walls);
        // a parapet lip so rooftops read as silhouettes against the sky
        const parapet = new THREE.BoxGeometry(w + 0.4, 0.7, d + 0.4);
        parapet.translate(cx, h + 0.35, cz);
        roofGeoms.push(parapet.toNonIndexed());
        parapet.dispose();
        roofGeoms.push(roof);

        const entry = {
          x0: rect.x0,
          x1: rect.x1,
          z0: rect.z0,
          z1: rect.z1,
          top: h,
          width: w,
          depth: d,
          height: h,
          variant, // which facade atlas this footprint uses, for the window bloom layer
          uReps,
          vReps,
        };
        this.buildings.push(entry);
        block.buildings.push(entry);
      }
    }

    const roofMesh = new THREE.Mesh(
      mergeGeometries(roofGeoms),
      new THREE.MeshStandardMaterial({
        map: this.textures.roof,
        color: 0xb9bec6,
        roughness: 0.96,
        metalness: 0.04,
        envMapIntensity: 0.25,
      }),
    );
    roofMesh.castShadow = true;
    roofMesh.receiveShadow = true;
    roofMesh.name = 'roofs';
    this.group.add(roofMesh);

    for (let v = 0; v < 6; v++) {
      const merged = mergeGeometries(wallGeoms[v]);
      if (!merged) continue;
      const material = new THREE.MeshStandardMaterial({
        map: this.facades[v].map,
        emissiveMap: this.facades[v].emissiveMap,
        emissive: new THREE.Color(0xffc98a),
        emissiveIntensity: 1.8,
        vertexColors: true,
        roughness: 0.5,
        metalness: 0.18,
        envMapIntensity: 0.9,
      });
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `facades-${v}`;
      this.group.add(mesh);
    }
  }

  /** Split the buildable lot into `count` rectangles with a random guillotine cut. */
  subdivideLot(count, block) {
    const half = LOT / 2;
    const cx = block.center.x;
    const cz = block.center.z;
    let rects = [{ x0: cx - half, x1: cx + half, z0: cz - half, z1: cz + half }];

    while (rects.length < count) {
      // Always split the largest rectangle so the footprints stay balanced.
      rects.sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0));
      const rect = rects.shift();
      const w = rect.x1 - rect.x0;
      const d = rect.z1 - rect.z0;
      const alongX = w > d ? true : w < d ? false : this.random() > 0.5;
      const cut = lerp(0.38, 0.62, this.random());
      if (alongX) {
        const mid = rect.x0 + w * cut;
        rects.push({ x0: rect.x0, x1: mid, z0: rect.z0, z1: rect.z1 });
        rects.push({ x0: mid, x1: rect.x1, z0: rect.z0, z1: rect.z1 });
      } else {
        const mid = rect.z0 + d * cut;
        rects.push({ x0: rect.x0, x1: rect.x1, z0: rect.z0, z1: mid });
        rects.push({ x0: rect.x0, x1: rect.x1, z0: mid, z1: rect.z1 });
      }
    }

    // Pull each footprint back from its neighbours so there are alleys, not shared walls.
    return rects.map((r) => {
      const inset = 0.5 + this.random() * 1.2;
      return {
        x0: r.x0 + inset,
        x1: r.x1 - inset,
        z0: r.z0 + inset,
        z1: r.z1 - inset,
      };
    });
  }

  /** One stepped glass tower on the centre block, 70 m to the tip of its spire. */
  landmark() {
    const block = this.blockAt(LANDMARK_BLOCK[0], LANDMARK_BLOCK[1]);
    const cx = block.center.x;
    const cz = block.center.z;
    const stone = new THREE.MeshStandardMaterial({ color: 0x30363f, roughness: 0.8 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x2a3a4e,
      roughness: 0.25,
      metalness: 0.55,
      emissive: 0x16324a,
      emissiveIntensity: 0.9,
    });
    const neon = new THREE.MeshStandardMaterial({
      color: 0xffd9a5,
      emissive: 0xff9d4d,
      emissiveIntensity: 2.4,
      roughness: 0.4,
    });

    const podium = new THREE.Mesh(new THREE.BoxGeometry(24, 6, 24), stone);
    podium.position.set(cx, 3, cz);
    podium.castShadow = true;
    podium.receiveShadow = true;
    this.group.add(podium);
    this.buildings.push({ x0: cx - 12, x1: cx + 12, z0: cz - 12, z1: cz + 12, top: 6, height: 6 });

    const tiers = [
      { w: 17, h: 26, y: 6 },
      { w: 13.4, h: 18, y: 32 },
      { w: 10, h: 12, y: 50 },
    ];
    for (const t of tiers) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(t.w, t.h, t.d || t.w), glass);
      box.position.set(cx, t.y + t.h / 2, cz);
      box.castShadow = true;
      box.receiveShadow = true;
      this.group.add(box);
      this.buildings.push({
        x0: cx - t.w / 2,
        x1: cx + t.w / 2,
        z0: cz - t.w / 2,
        z1: cz + t.w / 2,
        top: t.y + t.h,
        height: t.y + t.h,
      });
      // an emissive band at the crown of every tier
      const band = new THREE.Mesh(new THREE.BoxGeometry(t.w + 0.6, 0.6, t.w + 0.6), neon);
      band.position.set(cx, t.y + t.h - 0.4, cz);
      this.group.add(band);
    }

    // Spire + antenna to 70 m.
    const spire = new THREE.Mesh(new THREE.ConeGeometry(3.2, 8, 8), glass);
    spire.position.set(cx, 62 + 4, cz);
    spire.castShadow = true;
    this.group.add(spire);

    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.24, 6, 6), stone);
    antenna.position.set(cx, 70 + 2, cz);
    this.group.add(antenna);

    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.44, 10, 8), neon);
    beacon.position.set(cx, 73.4, cz);
    this.group.add(beacon);

    const glow = new THREE.PointLight(0xff9d4d, 26, 46, 2);
    glow.position.set(cx, 66, cz);
    this.group.add(glow);

    block.landmark = true;
  }

  // -- street lamps ----------------------------------------------------------------------

  lamps() {
    const poles = [];
    const heads = [];
    const discs = [];
    this.lampHeads = [];

    // A lamp is a post with a 1.5 m arm; dir is the unit direction the arm reaches out in.
    const lamp = (x, z, dx, dz) => {
      const H = 6.4;
      const pole = new THREE.CylinderGeometry(0.11, 0.16, H, 6);
      pole.translate(x, H / 2 + SIDEWALK_TOP, z);
      poles.push(pole.toNonIndexed());
      pole.dispose();

      const armLen = 1.5;
      const arm = new THREE.BoxGeometry(dx ? armLen : 0.12, 0.12, dz ? armLen : 0.12);
      arm.translate(x + dx * armLen * 0.5, H + SIDEWALK_TOP - 0.1, z + dz * armLen * 0.5);
      poles.push(arm.toNonIndexed());
      arm.dispose();

      const hx = x + dx * armLen;
      const hz = z + dz * armLen;
      const hy = H + SIDEWALK_TOP - 0.05;
      const head = new THREE.SphereGeometry(0.3, 8, 6);
      head.translate(hx, hy, hz);
      heads.push(head.toNonIndexed());
      head.dispose();

      const pos = new THREE.Vector3(hx, hy, hz);
      this.lampHeads.push(pos);

      // The pool on the ground: a flat additive disc, one merged draw for every lamp in the
      // city, so 240 lamps cost one draw call instead of 240 lights.
      const gy = this.groundAt(hx, hz) + 0.045;
      const disc = new THREE.CircleGeometry(3.1 + this.random() * 0.7, 18);
      disc.rotateX(-Math.PI / 2);
      disc.translate(hx, gy, hz);
      discs.push(disc.toNonIndexed());
      disc.dispose();

      this.detail.lamps++;
    };

    for (const c of ROAD_COORDS) {
      for (let t = -BOUNDS + 20; t <= BOUNDS - 20; t += 34) {
        const nearIntersection = ROAD_COORDS.some((r) => Math.abs(r - t) < 10);
        if (nearIntersection) continue;
        // lamps on both kerbs of every road, staggered so the light pools interleave
        lamp(c - ROAD_WIDTH / 2 + 0.6, t, 1, 0);
        lamp(c + ROAD_WIDTH / 2 - 0.6, t + 17, -1, 0);
        lamp(t, c - ROAD_WIDTH / 2 + 0.6, 0, 1);
        lamp(t + 17, c + ROAD_WIDTH / 2 - 0.6, 0, -1);
      }
    }

    const poleMesh = new THREE.Mesh(
      mergeGeometries(poles),
      new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.55, metalness: 0.6 }),
    );
    poleMesh.castShadow = true;
    poleMesh.receiveShadow = true;
    poleMesh.name = 'lamps';
    this.group.add(poleMesh);

    const headMesh = new THREE.Mesh(
      mergeGeometries(heads),
      new THREE.MeshStandardMaterial({
        color: 0xffe0b0,
        emissive: 0xffb066,
        emissiveIntensity: 4.2,
        roughness: 0.3,
      }),
    );
    headMesh.name = 'lamp-heads';
    this.group.add(headMesh);

    const poolMesh = new THREE.Mesh(
      mergeGeometries(discs),
      new THREE.MeshBasicMaterial({
        map: this.textures.pool,
        color: 0xffb877,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true,
      }),
    );
    poolMesh.name = 'lamp-pools';
    poolMesh.renderOrder = 4;
    this.group.add(poolMesh);
  }

  /**
   * Six real point lights for the whole city, recycled every frame onto the nearest lamp heads
   * to the player. The discs and the emissive heads carry the look; these carry the actual
   * falloff on the asphalt, the kerb and the player as they walk under a lamp.
   */
  lampLightPool(size = 6) {
    this.lampLights = [];
    for (let i = 0; i < size; i++) {
      const light = new THREE.PointLight(0xffb374, 0, 26, 2);
      light.castShadow = false;
      light.name = `lamp-light-${i}`;
      this.group.add(light);
      this.lampLights.push(light);
    }
    this.updateLampLights(new THREE.Vector3());
  }

  /** Nearest-N assignment: a partial selection, so the cost does not grow with the sort. */
  updateLampLights(playerPosition) {
    if (!this.lampLights || !this.lampLights.length) return;
    const px = playerPosition.x;
    const pz = playerPosition.z;

    // Keep the six smallest squared distances without sorting the whole list.
    const best = [];
    for (let i = 0; i < this.lampHeads.length; i++) {
      const head = this.lampHeads[i];
      const dx = head.x - px;
      const dz = head.z - pz;
      const d2 = dx * dx + dz * dz;
      if (best.length < this.lampLights.length) {
        best.push({ d2, head });
        best.sort((a, b) => a.d2 - b.d2);
      } else if (d2 < best[best.length - 1].d2) {
        best[best.length - 1] = { d2, head };
        best.sort((a, b) => a.d2 - b.d2);
      }
    }

    for (let i = 0; i < this.lampLights.length; i++) {
      const light = this.lampLights[i];
      const pick = best[i];
      if (!pick) {
        light.intensity = 0;
        continue;
      }
      light.position.copy(pick.head);
      // Fade out towards the edge of the pool so a lamp swapping in never pops.
      const fade = 1 - THREE.MathUtils.clamp((Math.sqrt(pick.d2) - 70) / 40, 0, 1);
      light.intensity = 24 * fade * fade;
    }
  }

  // -- palms -----------------------------------------------------------------------------

  palms() {
    const trunks = [];
    const fronds = [];

    const palm = (x, z, scale) => {
      const h = (4.6 + this.random() * 2.6) * scale;
      const trunk = new THREE.CylinderGeometry(0.13 * scale, 0.28 * scale, h, 6, 1);
      trunk.translate(x, h / 2 + SIDEWALK_TOP, z);
      trunks.push(trunk.toNonIndexed());
      trunk.dispose();

      const blades = 7;
      for (let i = 0; i < blades; i++) {
        const blade = new THREE.PlaneGeometry(2.9 * scale, 0.62 * scale);
        const m = new THREE.Matrix4();
        const droop = -0.42 - this.random() * 0.3;
        m.makeRotationZ(droop);
        m.premultiply(new THREE.Matrix4().makeRotationY((i / blades) * Math.PI * 2 + this.random() * 0.3));
        m.setPosition(
          x + Math.cos((i / blades) * Math.PI * 2) * 1.2 * scale,
          h + SIDEWALK_TOP - 0.2,
          z + Math.sin((i / blades) * Math.PI * 2) * 1.2 * scale,
        );
        blade.applyMatrix4(m);
        fronds.push(blade.toNonIndexed());
        blade.dispose();
      }
      this.detail.palms++;
    };

    // waterfront promenade
    for (let x = -BOUNDS + 14; x <= BOUNDS - 14; x += 16) {
      palm(x, BOUNDS + 7.5, 1);
      palm(x + 8, BOUNDS + 13.5, 0.86);
    }
    // parks and a few street corners
    for (const key of PARK_BLOCKS) {
      const [i, j] = key.split(',').map(Number);
      const b = this.blockAt(i, j);
      for (let k = 0; k < 9; k++) {
        palm(
          b.center.x + (this.random() - 0.5) * (LOT - 4),
          b.center.z + (this.random() - 0.5) * (LOT - 4),
          0.8 + this.random() * 0.5,
        );
      }
    }
    for (const c of ROAD_COORDS) {
      for (const d of ROAD_COORDS) {
        if (this.random() > 0.35) continue;
        palm(c + ROAD_WIDTH / 2 + 1.2, d + ROAD_WIDTH / 2 + 1.2, 0.72 + this.random() * 0.2);
      }
    }

    const trunkMesh = new THREE.Mesh(
      mergeGeometries(trunks),
      new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 0.9 }),
    );
    trunkMesh.castShadow = true;
    trunkMesh.name = 'palm-trunks';
    this.group.add(trunkMesh);

    const frondMesh = new THREE.Mesh(
      mergeGeometries(fronds),
      new THREE.MeshStandardMaterial({
        color: 0x2f5233,
        roughness: 0.85,
        side: THREE.DoubleSide,
        emissive: 0x121d12,
        emissiveIntensity: 0.6,
      }),
    );
    frondMesh.castShadow = true;
    frondMesh.name = 'palm-fronds';
    this.group.add(frondMesh);
  }

  // -- waterfront ------------------------------------------------------------------------

  waterfront() {
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(BOUNDS * 2 + 40, 0.34, 26),
      new THREE.MeshStandardMaterial({ color: 0xa9a49a, roughness: 0.85 }),
    );
    deck.position.set(0, 0.17, BOUNDS + 12);
    deck.receiveShadow = true;
    this.group.add(deck);

    // Quay wall dropping into the water.
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(BOUNDS * 2 + 40, 4.4, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x4c4f55, roughness: 0.95 }),
    );
    wall.position.set(0, -1.9, WATER_Z);
    wall.receiveShadow = true;
    this.group.add(wall);

    // Railing: posts plus a continuous top rail.
    const posts = [];
    const rails = [];
    for (let x = -BOUNDS - 18; x <= BOUNDS + 18; x += 3.4) {
      const post = new THREE.BoxGeometry(0.09, 1.05, 0.09);
      post.translate(x, SIDEWALK_TOP + 0.52, WATER_Z - 0.9);
      posts.push(post.toNonIndexed());
      post.dispose();
    }
    const rail = new THREE.BoxGeometry(BOUNDS * 2 + 40, 0.09, 0.09);
    rail.translate(0, SIDEWALK_TOP + 1.05, WATER_Z - 0.9);
    rails.push(rail.toNonIndexed());
    rail.dispose();

    const railMat = new THREE.MeshStandardMaterial({ color: 0x35393f, roughness: 0.5, metalness: 0.6 });
    const postMesh = new THREE.Mesh(mergeGeometries(posts), railMat);
    postMesh.name = 'railing-posts';
    this.group.add(postMesh);
    const railMesh = new THREE.Mesh(mergeGeometries(rails), railMat);
    railMesh.castShadow = true;
    this.group.add(railMesh);

    // Harbour water.
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(BOUNDS * 2 + 900, 620),
      new THREE.MeshStandardMaterial({
        color: 0x0b1b28,
        roughness: 0.18,
        metalness: 0.85,
        emissive: 0x0d2436,
        emissiveIntensity: 0.55,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, -0.7, WATER_Z + 290);
    water.name = 'water';
    this.group.add(water);

    // Long warm reflection streaks from the setting sun.
    const streaks = [];
    for (let i = 0; i < 26; i++) {
      const w = 2 + this.random() * 9;
      const d = 6 + this.random() * 26;
      const g = new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      g.translate((this.random() - 0.5) * 260, -0.66, WATER_Z + 14 + this.random() * 300);
      streaks.push(g);
    }
    const streakMesh = new THREE.Mesh(
      mergeGeometries(streaks),
      new THREE.MeshBasicMaterial({
        color: 0xffb070,
        transparent: true,
        opacity: 0.13,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.group.add(streakMesh);

    // Lighthouse at the end of the quay.
    const lx = BOUNDS - 30;
    const lz = WATER_Z + 16;
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(2.6, 3.4, 4, 12),
      new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.9 }),
    );
    base.position.set(lx, 1.2, lz);
    base.castShadow = true;
    this.group.add(base);

    const tower = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.2, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xe7e2d6, roughness: 0.7 }),
    );
    tower.position.set(lx, 9.2, lz);
    tower.castShadow = true;
    this.group.add(tower);

    const lantern = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 12, 10),
      new THREE.MeshStandardMaterial({
        color: 0xfff0cf,
        emissive: 0xffc46a,
        emissiveIntensity: 5,
        roughness: 0.3,
      }),
    );
    lantern.position.set(lx, 16.4, lz);
    this.group.add(lantern);

    const lampLight = new THREE.PointLight(0xffcf8a, 30, 60, 2);
    lampLight.position.set(lx, 16.4, lz);
    this.group.add(lampLight);
    this.buildings.push({ x0: lx - 2.6, x1: lx + 2.6, z0: lz - 2.6, z1: lz + 2.6, top: 16, height: 16 });

    // Three moored boats, low-poly silhouettes against the sun.
    const hulls = [];
    const cabins = [];
    const boatSpots = [-96, 18, 128];
    for (const bx of boatSpots) {
      const bz = WATER_Z + 26 + this.random() * 18;
      const len = 7 + this.random() * 6;
      const hull = new THREE.BoxGeometry(3.1, 1.3, len);
      hull.translate(bx, -0.2, bz);
      hulls.push(hull.toNonIndexed());
      hull.dispose();
      const cabin = new THREE.BoxGeometry(2.1, 1.7, len * 0.42);
      cabin.translate(bx, 1.2, bz - len * 0.1);
      cabins.push(cabin.toNonIndexed());
      cabin.dispose();
      const mast = new THREE.CylinderGeometry(0.06, 0.08, 7 + this.random() * 3, 5);
      mast.translate(bx, 4.4, bz + len * 0.3);
      cabins.push(mast.toNonIndexed());
      mast.dispose();
      this.detail.boats++;
    }
    const hullMesh = new THREE.Mesh(
      mergeGeometries(hulls),
      new THREE.MeshStandardMaterial({ color: 0x22262d, roughness: 0.7 }),
    );
    hullMesh.castShadow = true;
    this.group.add(hullMesh);
    const cabinMesh = new THREE.Mesh(
      mergeGeometries(cabins),
      new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.6, metalness: 0.3 }),
    );
    cabinMesh.castShadow = true;
    this.group.add(cabinMesh);
  }

  // -- traffic ---------------------------------------------------------------------------

  /**
   * Parked-up traffic: a dozen cars on the grid, each one a single merged mesh with per-vertex
   * paint so the whole fleet shares one material, plus a soft contact disc under the tyres.
   * They cast real shadows, so at this sun angle each car throws a long stripe down the road.
   */
  cars(count = 14) {
    this.cars = [];
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.3,
      metalness: 0.62,
      envMapIntensity: 1.35,
    });
    const palette = [0xb9c3cc, 0x8d2028, 0x1d2a3c, 0xd8d3c4, 0x2f3a30, 0x44484f, 0xa9661f, 0x6c1f3a];

    for (let i = 0; i < count; i++) {
      const color = new THREE.Color(palette[Math.floor(this.random() * palette.length)]);
      const parts = [];
      const push = (geom, tint) => {
        const g = geom.toNonIndexed();
        geom.dispose();
        parts.push(paint(g, tint));
      };

      // Hull, cabin, wheels, lamps — all in local space, nose pointing at +Z.
      const hull = new THREE.BoxGeometry(1.86, 0.58, 4.32);
      hull.translate(0, 0.66, 0);
      push(hull, color);

      const skirt = new THREE.BoxGeometry(1.7, 0.22, 4.0);
      skirt.translate(0, 0.4, 0);
      push(skirt, color.clone().multiplyScalar(0.55));

      const cabin = new THREE.BoxGeometry(1.62, 0.5, 2.05);
      cabin.translate(0, 1.16, -0.18);
      push(cabin, new THREE.Color(0x2a3442));

      const roof = new THREE.BoxGeometry(1.5, 0.08, 1.9);
      roof.translate(0, 1.42, -0.18);
      push(roof, color);

      for (const sx of [-1, 1]) {
        for (const sz of [-1.32, 1.32]) {
          const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10);
          wheel.rotateZ(Math.PI / 2);
          wheel.translate(sx * 0.88, 0.34, sz);
          push(wheel, new THREE.Color(0x14161a));
        }
        const nose = new THREE.BoxGeometry(0.3, 0.14, 0.08);
        nose.translate(sx * 0.6, 0.72, 2.16);
        push(nose, new THREE.Color(0xfff0cf));
        const tail = new THREE.BoxGeometry(0.28, 0.12, 0.08);
        tail.translate(sx * 0.62, 0.78, -2.16);
        push(tail, new THREE.Color(0xff5a3c));
      }

      const mesh = new THREE.Mesh(mergeGeometries(parts), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `car-${i}`;

      // Contact darkening: a soft disc under the tyres, which is what pins the car to the road.
      const disc = new THREE.Mesh(
        new THREE.PlaneGeometry(3.1, 5.4),
        new THREE.MeshBasicMaterial({
          map: this.textures.contact,
          transparent: true,
          opacity: 0.62,
          depthWrite: false,
          color: 0x000000,
        }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.035;
      disc.renderOrder = 5;
      mesh.add(disc);

      // Lay the car out on a random lane, heading one way along that road.
      const along = this.random() > 0.5;
      const road = ROAD_COORDS[Math.floor(this.random() * ROAD_COORDS.length)];
      const dir = this.random() > 0.5 ? 1 : -1;
      const lane = (this.random() > 0.5 ? 1 : -1) * ROAD_WIDTH * 0.25;
      const span = BOUNDS * 2 + 70;
      const start = -BOUNDS - 35 + this.random() * span;

      const car = {
        mesh,
        along,
        road: road + lane,
        dir,
        speed: 5.5 + this.random() * 8,
        t: start,
      };
      this.#placeCar(car);
      this.group.add(mesh);
      this.cars.push(car);
      this.detail.cars++;
    }
  }

  #placeCar(car) {
    const m = car.mesh;
    if (car.along) {
      // travelling along Z on a road at x = car.road
      m.position.set(car.road, 0, car.t);
      m.rotation.y = car.dir > 0 ? 0 : Math.PI;
    } else {
      m.position.set(car.t, 0, car.road);
      m.rotation.y = car.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
  }

  updateCars(dt) {
    if (!this.cars) return;
    const span = BOUNDS * 2 + 70;
    const lo = -BOUNDS - 35;
    for (const car of this.cars) {
      car.t += car.speed * car.dir * dt;
      if (car.t > lo + span) car.t -= span;
      else if (car.t < lo) car.t += span;
      this.#placeCar(car);
    }
  }

  // -- distance: skyline silhouettes and window bloom -------------------------------------

  /**
   * A ring of far blocks past the fog line, drawn with a flat basic material so they read as
   * silhouettes against the gradient rather than lit geometry. They are what gives the horizon
   * depth: the city ends, the harbour glints, and another district sits behind it.
   */
  skyline() {
    const rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0); // its own stream: the layout is unchanged
    const geoms = [];
    this.farGlow = [];

    for (let i = 0; i < 170; i++) {
      const angle = rng() * Math.PI * 2;
      const radius = 330 + Math.pow(rng(), 0.7) * 470;
      const w = 16 + rng() * 52;
      const d = 16 + rng() * 52;
      const h = 14 + Math.pow(rng(), 1.8) * 140;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const box = new THREE.BoxGeometry(w, h, d);
      box.translate(x, h / 2, z);
      const g = box.toNonIndexed();
      box.dispose();
      geoms.push(g);

      // A couple of lit windows per far block keep the silhouette from being a dead cut-out.
      if (rng() > 0.45) {
        const glows = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < glows; k++) {
          this.farGlow.push({ x: x + (rng() - 0.5) * w * 0.9, y: h * (0.25 + rng() * 0.6), z: z + d * 0.5 });
        }
      }
    }

    const mesh = new THREE.Mesh(
      mergeGeometries(geoms),
      new THREE.MeshBasicMaterial({ color: 0x161c2b, fog: true }),
    );
    mesh.name = 'skyline';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  /**
   * Bloom-like glow: one additive, camera-facing point cloud whose sprites sit exactly on the
   * lit windows of the facades (they come from the atlas generator, so they line up) plus one
   * halo per street lamp and a scatter over the far skyline. A single draw call for the whole
   * thing — the cheap stand-in for a bloom pass.
   */
  windowGlow() {
    const positions = [];
    const colors = [];
    const push = (x, y, z, color, scale = 1) => {
      positions.push(x, y, z);
      colors.push(color.r * scale, color.g * scale, color.b * scale);
    };

    const white = new THREE.Color(1, 1, 1);

    for (const b of this.buildings) {
      if (b.variant === undefined) continue; // landmark tiers have no window atlas
      const lit = this.facades[b.variant].lit;
      if (!lit.length) continue;

      const samples = 3 + Math.floor(this.random() * 4);
      const uReps = Math.max(1, Math.round(b.uReps));
      for (let i = 0; i < samples; i++) {
        const win = lit[Math.floor(this.random() * lit.length)];
        const y = win.v * 57.6; // the atlas is 57.6 m tall
        if (y > b.height - 1.5 || y < 1.2) continue;
        const u = (Math.floor(this.random() * uReps) + win.u) / uReps;
        const c = new THREE.Color(win.color).multiplyScalar(0.35 + win.tier * 0.65);
        switch (Math.floor(this.random() * 4)) {
          case 0:
            push(b.x1 + 0.09, y, b.z0 + u * b.depth, c);
            break;
          case 1:
            push(b.x0 - 0.09, y, b.z0 + u * b.depth, c);
            break;
          case 2:
            push(b.x0 + u * b.width, y, b.z1 + 0.09, c);
            break;
          default:
            push(b.x0 + u * b.width, y, b.z0 - 0.09, c);
            break;
        }
      }
    }

    // Lamp halos: the emissive heads alone read as flat dots from a distance.
    for (const head of this.lampHeads) {
      push(head.x, head.y - 0.05, head.z, white, 0.85);
    }

    // Distant skyline specks, dimmer so they stay behind the fog.
    for (const g of this.farGlow || []) {
      push(g.x, g.y, g.z, white, 0.28);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));

    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        map: this.textures.glow,
        size: 2.6,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.62,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexColors: true,
        fog: true,
      }),
    );
    points.name = 'window-glow';
    points.renderOrder = 6;
    this.detail.glow = positions.length / 3;
    this.group.add(points);
  }

  /** Per-frame work: traffic, and recycling the lamp light pool onto the nearest heads. */
  update(dt, playerPosition) {
    this.time += dt;
    this.updateCars(dt);
    if (playerPosition) this.updateLampLights(playerPosition);
  }

  // -- walkable ground -------------------------------------------------------------------

  /** Height of the pavement under a point: kerb height on a block, 0 on the asphalt. */
  groundAt(x, z) {
    const localX = x + BOUNDS - ROAD_WIDTH / 2;
    const localZ = z + BOUNDS - ROAD_WIDTH / 2;
    const ix = Math.floor(localX / PITCH);
    const iz = Math.floor(localZ / PITCH);
    const offX = localX - ix * PITCH;
    const offZ = localZ - iz * PITCH;
    const onBlock =
      ix >= 0 && ix < GRID && iz >= 0 && iz < GRID && offX >= 0 && offX <= BLOCK && offZ >= 0 && offZ <= BLOCK;
    if (onBlock) return SIDEWALK_TOP;
    if (z > BOUNDS && z < WATER_Z) return 0.34; // harbour promenade deck
    return 0;
  }

  /** A point on a sidewalk clear of buildings, for the player and for props. */
  randomSpawnPoint() {
    const block = this.blockList[Math.floor(this.random() * this.blockList.length)];
    const ring = LOT / 2 + SIDEWALK / 2; // middle of the sidewalk strip
    const side = Math.floor(this.random() * 4);
    const along = (this.random() - 0.5) * (BLOCK - 4);
    let x = block.center.x;
    let z = block.center.z;
    if (side === 0) z -= ring;
    else if (side === 1) z += ring;
    else if (side === 2) x -= ring;
    else x += ring;
    if (side < 2) x += along;
    else z += along;

    // Nudge out of any footprint we happen to land in.
    for (const b of this.buildings) {
      if (x > b.x0 - 0.4 && x < b.x1 + 0.4 && z > b.z0 - 0.4 && z < b.z1 + 0.4) {
        x = block.center.x;
        z = block.center.z + ring;
        break;
      }
    }
    return new THREE.Vector3(x, SIDEWALK_TOP, z);
  }

  stats() {
    return {
      blocks: this.blockList.length,
      buildings: this.buildings.length,
      lamps: this.detail.lamps,
      palms: this.detail.palms,
      cars: this.detail.cars,
      glowPoints: this.detail.glow,
      lampLights: this.lampLights ? this.lampLights.length : 0,
      bounds: BOUNDS,
    };
  }
}

export default City;