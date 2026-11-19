// Thirty pedestrians on the sidewalk ring, walking the block edges in a straight corridor and
// stopping at the kerb until the crossing light is with them.
//
// A pedestrian is a corridor, not a pathfinder: an axis, a line to walk along (mid-sidewalk), a
// direction and a position along it. That is enough for a sidewalk that runs to the horizon, and
// it means the crossing rule is one comparison against the same traffic-light clock the cars use.
//
// A pedestrian also reads the wanted level. From three stars up the corridor is abandoned: every
// body on the street picks the direction away from the player and runs, with a per-pedestrian
// wobble so the crowd fans out instead of filing down one line. When the heat drops they walk
// back onto the nearest sidewalk and carry on as if nothing happened.

import * as THREE from '../vendor/three.module.min.js';
import { ROAD_COORDS, ROAD_WIDTH, BOUNDS, SIDEWALK, SIDEWALK_TOP, BLOCK } from './city.js';

const WALK_LINE = ROAD_WIDTH / 2 + (BLOCK / 2 - SIDEWALK / 2) - 0.4; // mid-sidewalk, 7.8 m off the centre line
const WALK_SPEED_MIN = 1.15;
const WALK_SPEED_MAX = 1.75;
const PANIC_AT = 3; // stars at which the street clears
const RUN_SPEED_MIN = 3.0;
const RUN_SPEED_MAX = 4.4;

const ITEM_SIZE = { position: 3, normal: 3, uv: 2, color: 3 };

function paint(geom, color) {
  const count = geom.getAttribute('position').count;
  const array = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    array[i * 3] = color.r;
    array[i * 3 + 1] = color.g;
    array[i * 3 + 2] = color.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(array, 3));
  return geom;
}

function merge(geoms) {
  let total = 0;
  for (const g of geoms) total += g.getAttribute('position').count;
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'color']) {
    const size = ITEM_SIZE[name];
    const array = new Float32Array(total * size);
    let offset = 0;
    for (const g of geoms) {
      const attr = g.getAttribute(name);
      array.set(attr.array, offset);
      offset += attr.array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  merged.computeBoundingSphere();
  return merged;
}

const skin = [0xe0b492, 0xc98f66, 0x8a5a3b, 0xf0c9a8];
const clothes = [0x3f5a78, 0x6a3a44, 0x39493c, 0x8a6a3a, 0x4a4a55, 0x2f3d4e, 0x7a4a2a, 0x535f6a];
const trousers = [0x2c323d, 0x3a3f4a, 0x2a3038, 0x4a4438];

function makePed(rng) {
  const skinTone = new THREE.Color(skin[Math.floor(rng() * skin.length)]);
  const coat = new THREE.Color(clothes[Math.floor(rng() * clothes.length)]);
  const legs = new THREE.Color(trousers[Math.floor(rng() * trousers.length)]);
  const parts = [];
  const push = (geom, color) => parts.push(paint(geom.toNonIndexed(), color));

  const torso = new THREE.BoxGeometry(0.46, 0.62, 0.28);
  torso.translate(0, 1.16, 0);
  push(torso, coat);

  const hips = new THREE.BoxGeometry(0.4, 0.2, 0.26);
  hips.translate(0, 0.82, 0);
  push(hips, legs);

  const legL = new THREE.BoxGeometry(0.17, 0.72, 0.18);
  legL.translate(-0.11, 0.36, 0);
  push(legL, legs);
  const legR = new THREE.BoxGeometry(0.17, 0.72, 0.18);
  legR.translate(0.11, 0.36, 0);
  push(legR, legs);

  const armL = new THREE.BoxGeometry(0.13, 0.56, 0.15);
  armL.translate(-0.3, 1.12, 0);
  push(armL, coat);
  const armR = new THREE.BoxGeometry(0.13, 0.56, 0.15);
  armR.translate(0.3, 1.12, 0);
  push(armR, coat);

  const neck = new THREE.BoxGeometry(0.12, 0.1, 0.12);
  neck.translate(0, 1.5, 0);
  push(neck, skinTone);

  const head = new THREE.BoxGeometry(0.26, 0.28, 0.26);
  head.translate(0, 1.68, 0);
  push(head, skinTone);

  const hair = new THREE.BoxGeometry(0.28, 0.1, 0.28);
  hair.translate(0, 1.82, -0.01);
  push(hair, new THREE.Color(0x22242a));

  return merge(parts);
}

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

export class Peds {
  constructor(city, trafficLights, count = 30, seed = 7) {
    this.city = city;
    this.lights = trafficLights;
    this.group = new THREE.Group();
    this.group.name = 'peds';
    this.peds = [];
    this.threat = 0; // stars, as last read from the street
    const rng = mulberry32(seed);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.02,
    });

    for (let i = 0; i < count; i++) {
      const axis = rng() > 0.5 ? 'z' : 'x';
      const road = ROAD_COORDS[1 + Math.floor(rng() * (ROAD_COORDS.length - 2))];
      const side = rng() > 0.5 ? 1 : -1;
      const mesh = new THREE.Mesh(makePed(rng), this.material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const ped = {
        axis,
        line: road + side * WALK_LINE,
        dir: rng() > 0.5 ? 1 : -1,
        t: -BOUNDS + rng() * BOUNDS * 2,
        speed: WALK_SPEED_MIN + rng() * (WALK_SPEED_MAX - WALK_SPEED_MIN),
        mesh,
        phase: rng() * Math.PI * 2,
        waiting: false,
        flee: false,
        free: new THREE.Vector3(),
        fleeYaw: 0,
        runSpeed: 0,
        wobble: (rng() - 0.5) * 1.1,
      };
      this.peds.push(ped);
      this.group.add(mesh);
      this.#place(ped, 0);
    }
  }

  /** The street's copy of the wanted level; main also passes it in on every tick. */
  setWanted(n) {
    this.threat = THREE.MathUtils.clamp(Math.round(Number(n) || 0), 0, 5);
  }

  get panicking() {
    return this.threat >= PANIC_AT;
  }

  #place(ped, dt) {
    const x = ped.axis === 'z' ? ped.line : ped.t;
    const z = ped.axis === 'z' ? ped.t : ped.line;
    const ground = this.city.groundAt(x, z);
    const bob = ped.waiting ? 0 : Math.abs(Math.sin(ped.phase)) * 0.05;
    ped.mesh.position.set(x, ground + bob, z);
    if (ped.axis === 'z') ped.mesh.rotation.y = ped.dir > 0 ? 0 : Math.PI;
    else ped.mesh.rotation.y = ped.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  }

  /**
   * Distance along the corridor to the kerb of the next cross street, or Infinity.
   * Only returns gates that are still ahead and outside the intersection box.
   */
  #nextKerb(ped) {
    let best = Infinity;
    for (const c of ROAD_COORDS) {
      const ahead = (c - ped.t) * ped.dir;
      const kerb = ahead - (ROAD_WIDTH / 2 + 1.1);
      if (kerb < -0.2 || kerb > 40) continue;
      if (kerb < best) best = kerb;
    }
    return best;
  }

  /** The corridor line nearest a coordinate, and how far off it that coordinate sits. */
  #nearestCorridor(v) {
    let best = { road: ROAD_COORDS[1], side: 1, miss: Infinity };
    for (const c of ROAD_COORDS) {
      const side = v >= c ? 1 : -1;
      const miss = Math.abs(Math.abs(v - c) - WALK_LINE);
      if (miss < best.miss) best = { road: c, side, miss };
    }
    return best;
  }

  /** Run from the player: straight away from them, fanned out by each pedestrian's wobble. */
  #flee(ped, dt, playerPosition) {
    const origin = playerPosition || { x: 0, z: 0 };

    if (!ped.flee) {
      // Join the panic from wherever the walk left them.
      ped.flee = true;
      ped.free.set(ped.mesh.position.x, 0, ped.mesh.position.z);
      ped.runSpeed = RUN_SPEED_MIN + Math.random() * (RUN_SPEED_MAX - RUN_SPEED_MIN);
      ped.waiting = false;
    }

    let ax = ped.free.x - origin.x;
    let az = ped.free.z - origin.z;
    let d = Math.hypot(ax, az);
    if (d < 1e-4) {
      ax = Math.sin(ped.phase);
      az = Math.cos(ped.phase);
      d = 1;
    }

    // Away, plus a wobble, so thirty bodies scatter instead of leaving in a column.
    const yaw = Math.atan2(ax / d, az / d) + ped.wobble * 0.45;
    ped.fleeYaw = yaw;

    const step = ped.runSpeed * dt;
    let nx = ped.free.x + Math.sin(yaw) * step;
    let nz = ped.free.z + Math.cos(yaw) * step;

    // Keep out of the facades: the same cheap push-out the cars use, at body width.
    const R = 0.5;
    for (const b of this.city.buildings) {
      if (b.top < 0.6) continue;
      const cx = THREE.MathUtils.clamp(nx, b.x0, b.x1);
      const cz = THREE.MathUtils.clamp(nz, b.z0, b.z1);
      const ox = nx - cx;
      const oz = nz - cz;
      const d2 = ox * ox + oz * oz;
      if (d2 > R * R) continue;
      if (d2 < 1e-6) {
        nz += (nz > (b.z0 + b.z1) / 2 ? 1 : -1) * (R + 0.02);
        continue;
      }
      const dd = Math.sqrt(d2);
      nx += (ox / dd) * (R - dd);
      nz += (oz / dd) * (R - dd);
    }

    const limit = BOUNDS - 2;
    nx = THREE.MathUtils.clamp(nx, -limit, limit);
    nz = THREE.MathUtils.clamp(nz, -limit, BOUNDS - 3);

    ped.free.set(nx, 0, nz);
    ped.phase += dt * 13;
    const ground = this.city.groundAt(nx, nz);
    ped.mesh.position.set(nx, ground + Math.abs(Math.sin(ped.phase)) * 0.11, nz);
    ped.mesh.rotation.y = yaw;
  }

  /** Back onto the nearest sidewalk, facing the way they were running. */
  #resume(ped) {
    ped.flee = false;
    const x = ped.mesh.position.x;
    const z = ped.mesh.position.z;
    const byX = this.#nearestCorridor(x);
    const byZ = this.#nearestCorridor(z);

    if (byX.miss <= byZ.miss) {
      // A corridor running along z: walk at a fixed x, along z.
      ped.axis = 'z';
      ped.line = byX.road + byX.side * WALK_LINE;
      ped.t = THREE.MathUtils.clamp(z, -BOUNDS + 4, BOUNDS - 4);
      ped.dir = Math.cos(ped.fleeYaw || 0) > 0 ? 1 : -1;
    } else {
      ped.axis = 'x';
      ped.line = byZ.road + byZ.side * WALK_LINE;
      ped.t = THREE.MathUtils.clamp(x, -BOUNDS + 4, BOUNDS - 4);
      ped.dir = Math.sin(ped.fleeYaw || 0) > 0 ? 1 : -1;
    }
    ped.waiting = false;
    this.#place(ped, 0);
  }

  /** The old walk: corridor, kerb, crossing light. */
  #walk(ped, dt) {
    const gate = this.#nextKerb(ped);
    let step = ped.speed * dt;

    if (gate < Infinity && gate < 1.2) {
      // At the kerb: cross only when the road we are crossing has been given a walk phase.
      const canCross = this.lights.walk(ped.axis === 'z' ? 'x' : 'z');
      if (!canCross) {
        ped.waiting = true;
        ped.phase += dt * 1.4;
        this.#place(ped, dt);
        return;
      }
    }
    ped.waiting = false;

    if (gate < step) step = Math.max(0, gate - 0.05); // stop on the kerb, not in the road
    ped.t += step * ped.dir;

    if (ped.t > BOUNDS - 4) {
      ped.t = BOUNDS - 4;
      ped.dir = -1;
    } else if (ped.t < -BOUNDS + 4) {
      ped.t = -BOUNDS + 4;
      ped.dir = 1;
    }

    ped.phase += dt * (ped.speed * 4.4);
    this.#place(ped, dt);
  }

  update(dt, ctx = {}) {
    const wanted = Number.isFinite(ctx.wanted) ? ctx.wanted : this.threat;
    this.setWanted(wanted);
    const panic = this.panicking;
    const playerPosition = ctx.playerPosition || null;

    for (const ped of this.peds) {
      if (panic) {
        this.#flee(ped, dt, playerPosition);
      } else {
        if (ped.flee) this.#resume(ped);
        this.#walk(ped, dt);
      }
    }
  }

  stats() {
    return {
      peds: this.peds.length,
      waiting: this.peds.filter((p) => p.waiting).length,
      fleeing: this.peds.filter((p) => p.flee).length,
      threat: this.threat,
    };
  }
}

export default Peds;