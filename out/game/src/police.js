// Wanted level and the units that answer it.
//
// Heat is a float from 0 to 5: firing a shot or shoving a car adds a little, a ram adds more,
// and it only cools once the player has broken line of sight for twenty seconds. From two stars
// up a wave of two to four cars is called in inside a sixty-metre radio radius, and those cars
// drive at the player and hit them: they steer for the target, they slow for the last few metres
// instead of orbiting it, and they shove the player's car on contact. Every car carries its own
// red/blue bar, so the sirens flash per unit instead of all units sharing one material.
//
// The wave is rebuilt whenever the star count changes, and torn down the moment the player is
// clean at zero stars.

import * as THREE from '../vendor/three.module.min.js';
import { ROAD_COORDS, BOUNDS } from './city.js';
import { createCar, LANE } from './vehicles.js';

const ESCAPE_TIME = 20; // seconds out of sight before a star comes off
const SIGHT = 58; // how close a unit has to be to keep the heat on
const MAX_UNITS = 4; // at five stars
const MIN_UNITS = 2; // at two stars
const SPAWN_MIN = 22; // metres: far enough that a unit never appears in the player's lap
const SPAWN_MAX = 56; // metres: inside the sixty-metre call
const RETIRE = 190; // a unit this far behind is re-called, not dragged across the map
const RAM_RANGE = 3.7;
const SPAWN_GAP = 2.2; // seconds between replacement units during a chase

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Is this point inside any collision box, with `pad` metres of clearance? */
function blocked(x, z, buildings, pad = 0) {
  for (const b of buildings) {
    if (b.top < 0.6) continue;
    if (x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad) return true;
  }
  return false;
}

export class Police {
  constructor(city, vehicles) {
    this.city = city;
    this.vehicles = vehicles;
    this.group = new THREE.Group();
    this.group.name = 'police';
    this.units = [];
    this.heat = 0;
    this.escapedFor = 0;
    this.spawnTimer = 0;
    this.ramCooldown = 0;
    this.flash = 0;
    this.lastEvent = '';
    this.onDamage = null; // (amount, source) => void, wired by main to the player's health
    this.targetPoint = new THREE.Vector3();
  }

  get stars() {
    return THREE.MathUtils.clamp(Math.ceil(this.heat - 0.001), 0, 5);
  }

  get wanted() {
    return this.heat > 0.01;
  }

  /** How many cars the current star count calls for: two at two stars, four at the top. */
  get waveSize() {
    const stars = this.stars;
    if (stars < 2) return 0;
    return THREE.MathUtils.clamp(stars, MIN_UNITS, MAX_UNITS);
  }

  addHeat(amount, reason = '') {
    const before = this.stars;
    this.heat = THREE.MathUtils.clamp(this.heat + amount, 0, 5);
    this.escapedFor = 0;
    if (reason) this.lastEvent = reason;
    // Crossing into two stars calls the first wave at once rather than on the next refresh.
    if (this.stars > before && this.stars >= 2) this.#callWave();
  }

  /** A shot fired into the air: the whole block hears it. */
  reportShot() {
    this.addHeat(0.6, 'Shots fired');
  }

  /**
   * Set the wanted level outright and answer it on this tick: `wanted(3)` puts three cars in
   * the street immediately, `wanted(0)` sends every unit home. Used by window.game.wanted().
   */
  setWanted(level, origin = null) {
    const stars = THREE.MathUtils.clamp(Math.round(Number(level) || 0), 0, 5);
    this.heat = stars;
    this.escapedFor = 0;
    this.ramCooldown = 0;
    this.lastEvent = stars > 0 ? `Wanted ${stars}` : 'Record clean';
    if (origin) this.targetPoint.copy(origin);
    if (stars < 2) {
      this.#despawnAll();
      this.spawnTimer = 0;
      return 0;
    }
    this.#callWave();
    return this.units.length;
  }

  clear() {
    this.heat = 0;
    this.escapedFor = 0;
    this.spawnTimer = 0;
    this.lastEvent = '';
    this.#despawnAll();
  }

  // -- spawning ---------------------------------------------------------------------------

  /**
   * A spot on the road lattice between SPAWN_MIN and SPAWN_MAX from the origin, clear of
   * buildings and clear of the units already out. Returns null if the block is too tight.
   */
  #spawnPoint(origin) {
    let fallback = null;
    let fallbackScore = -Infinity;

    for (let attempt = 0; attempt < 80; attempt++) {
      const axis = Math.random() > 0.5 ? 'z' : 'x';
      // The nearest road to the player on that axis, give or take a street, so a wave can come
      // down a parallel avenue instead of stacking on one line.
      let road = ROAD_COORDS[0];
      let best = Infinity;
      for (const c of ROAD_COORDS) {
        const d = Math.abs((axis === 'z' ? origin.x : origin.z) - c);
        if (d < best) {
          best = d;
          road = c;
        }
      }
      const roadIndex = ROAD_COORDS.indexOf(road);
      if (Math.random() > 0.55) {
        const shift = Math.random() > 0.5 ? 1 : -1;
        const next = ROAD_COORDS[roadIndex + shift];
        if (next !== undefined) road = next;
      }

      const sign = Math.random() > 0.5 ? 1 : -1;
      const base = axis === 'z' ? origin.z : origin.x;
      const along = base + sign * (SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN));
      const lane = road + (Math.random() > 0.5 ? LANE : -LANE);

      const x = axis === 'z' ? lane : along;
      const z = axis === 'z' ? along : lane;
      if (Math.abs(x) > BOUNDS + 20 || Math.abs(z) > BOUNDS + 20) continue;

      const distance = Math.hypot(x - origin.x, z - origin.z);
      if (distance < SPAWN_MIN || distance > SPAWN_MAX) continue;
      if (blocked(x, z, this.city.buildings, 2.4)) continue;

      let crowded = false;
      for (const unit of this.units) {
        const dx = unit.mesh.position.x - x;
        const dz = unit.mesh.position.z - z;
        if (dx * dx + dz * dz < 9 * 9) {
          crowded = true;
          break;
        }
      }
      if (crowded) continue;

      // Prefer the middle of the band: close enough to arrive, far enough to read as a call.
      const score = -Math.abs(distance - 38);
      if (score > fallbackScore) {
        fallbackScore = score;
        fallback = { x, z, axis, distance };
      }
      if (Math.random() > 0.35) return fallback;
    }
    return fallback;
  }

  #spawn(origin) {
    const spot = this.#spawnPoint(origin);
    if (!spot) return null;

    const mesh = createCar({ police: true, color: 0xe9edf4 });
    const unit = {
      mesh,
      heading: 0,
      speed: 0,
      ramTimer: 0,
      sirenPhase: Math.random() * Math.PI * 2, // not perfectly in step with its partners
      siren: mesh.userData.siren || null,
      born: 0,
    };

    mesh.position.set(spot.x, 0, spot.z);
    unit.heading = Math.atan2(origin.x - spot.x, origin.z - spot.z);
    mesh.rotation.y = unit.heading;

    this.group.add(mesh);
    this.units.push(unit);
    return unit;
  }

  /** Rebuild the wave for the current star count on this tick. */
  #callWave(origin = null) {
    const from = origin || this.targetPoint;
    const wanted = this.waveSize;

    // Too many cars for the stars: retire the furthest ones first.
    while (this.units.length > wanted) {
      let worst = 0;
      let worstD = -1;
      for (let i = 0; i < this.units.length; i++) {
        const p = this.units[i].mesh.position;
        const d = Math.hypot(p.x - from.x, p.z - from.z);
        if (d > worstD) {
          worstD = d;
          worst = i;
        }
      }
      this.#despawnUnit(this.units[worst]);
    }

    let guard = 0;
    while (this.units.length < wanted && guard++ < 10) {
      if (!this.#spawn(from)) break;
    }
    this.spawnTimer = SPAWN_GAP;
  }

  #despawnAll() {
    for (const u of [...this.units]) this.#despawnUnit(u);
    this.units.length = 0;
  }

  #disposeUnit(mesh) {
    this.group.remove(mesh);
    const held = mesh.userData.ownedMaterials;
    mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    // Bodies share one material across the fleet; only the per-unit siren materials are ours.
    if (Array.isArray(held)) {
      for (const material of held) material.dispose?.();
    }
    mesh.userData.ownedMaterials = null;
  }

  #despawnUnit(unit) {
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
    this.#disposeUnit(unit.mesh);
  }

  // -- simulation -------------------------------------------------------------------------

  update(dt, ctx) {
    const { playerPosition, car } = ctx;
    const target = car ? car.mesh.position : playerPosition;
    this.targetPoint.copy(target);
    this.ramCooldown = Math.max(0, this.ramCooldown - dt);
    this.flash += dt;

    const stars = this.stars;

    // Escaping: nothing within sight for twenty seconds takes a star off, once per interval.
    if (stars >= 1) {
      let near = Infinity;
      for (const u of this.units) {
        const dx = u.mesh.position.x - playerPosition.x;
        const dz = u.mesh.position.z - playerPosition.z;
        near = Math.min(near, Math.hypot(dx, dz));
      }
      if (near > SIGHT) this.escapedFor += dt;
      else this.escapedFor = 0;

      if (this.escapedFor >= ESCAPE_TIME) {
        this.escapedFor = 0;
        this.heat = Math.max(0, Math.floor(this.heat) - 1);
        this.lastEvent = this.heat > 0 ? 'Lost one star' : 'You lost them';
        // Losing a star can drop the ceiling, and dropping to zero clears the street outright.
        if (this.stars < 2) this.#despawnAll();
        else if (this.units.length > this.waveSize) this.#callWave(this.targetPoint);
      }
    } else {
      this.escapedFor = 0;
    }

    // Clean at zero stars means nobody on the payroll is still driving around.
    if (this.stars === 0) {
      if (this.units.length) this.#despawnAll();
      this.spawnTimer = 0;
      return;
    }

    if (this.stars < 2) {
      // One star: the heat is on paper, not on the road.
      if (this.units.length) this.#despawnAll();
      return;
    }

    this.separate();

    for (const unit of [...this.units]) {
      const p = unit.mesh.position;
      if (Math.hypot(p.x - playerPosition.x, p.z - playerPosition.z) > RETIRE) {
        // Too far behind: replace it rather than let a stale car trail the player forever.
        this.#despawnUnit(unit);
        continue;
      }
      this.#stepUnit(unit, dt, target, car, playerPosition);
      this.#flashSiren(unit);
    }

    // Reinforcements: keep the wave at strength, one replacement at a time.
    this.spawnTimer -= dt;
    if (this.units.length < this.waveSize && this.spawnTimer <= 0) {
      this.#spawn(this.targetPoint);
      this.spawnTimer = SPAWN_GAP;
    }
  }

  /** Steer round a building instead of grinding against it. */
  #avoid(heading, pos) {
    const probe = 7.5;
    const free = (a) => {
      const x = pos.x + Math.sin(a) * probe;
      const z = pos.z + Math.cos(a) * probe;
      return !blocked(x, z, this.city.buildings, 1.3);
    };
    if (free(heading)) return heading;
    for (const turn of [0.45, -0.45, 0.9, -0.9, 1.35, -1.35]) {
      if (free(heading + turn)) return heading + turn;
    }
    return heading + Math.PI * 0.5;
  }

  #stepUnit(unit, dt, target, car, playerPosition) {
    const pos = unit.mesh.position;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz) || 0.0001;

    let want = Math.atan2(dx, dz);
    want = this.#avoid(want, pos);

    let delta = wrapAngle(want - unit.heading);
    const turnRate = 1.9 + 2.1 * Math.min(1, unit.speed / 14);
    unit.heading = wrapAngle(unit.heading + THREE.MathUtils.clamp(delta, -turnRate * dt, turnRate * dt));

    // Fast at range, still committed up close: a unit that brakes to a crawl never lands a hit.
    const top = 15.5 + this.stars * 2.6;
    const targetSpeed = Math.max(7.5, top * THREE.MathUtils.clamp(dist / 15, 0.42, 1));
    const accel = targetSpeed > unit.speed ? 9.5 : 14;
    unit.speed += THREE.MathUtils.clamp(targetSpeed - unit.speed, -accel * dt, accel * dt);

    const fx = Math.sin(unit.heading);
    const fz = Math.cos(unit.heading);
    pos.x += fx * unit.speed * dt;
    pos.z += fz * unit.speed * dt;

    // Keep the bodywork out of the facades: the same two-axle capsule the player's car uses.
    const R = 1.05;
    const AXLE = 1.2;
    for (const b of this.city.buildings) {
      if (b.top < 0.6) continue;
      for (const s of [AXLE, -AXLE]) {
        const px = pos.x + fx * s;
        const pz = pos.z + fz * s;
        const cx = THREE.MathUtils.clamp(px, b.x0, b.x1);
        const cz = THREE.MathUtils.clamp(pz, b.z0, b.z1);
        const ox = px - cx;
        const oz = pz - cz;
        const d2 = ox * ox + oz * oz;
        if (d2 > R * R) continue;
        if (d2 < 1e-6) {
          pos.z += (pz > (b.z0 + b.z1) / 2 ? 1 : -1) * (R + 0.02);
          unit.speed *= 0.4;
          continue;
        }
        const d = Math.sqrt(d2);
        pos.x += (ox / d) * (R - d);
        pos.z += (oz / d) * (R - d);
        unit.speed *= 0.55;
      }
    }

    const limit = BOUNDS + 24;
    pos.x = THREE.MathUtils.clamp(pos.x, -limit, limit);
    pos.z = THREE.MathUtils.clamp(pos.z, -limit, BOUNDS + 20);
    pos.y = 0;
    unit.mesh.rotation.y = unit.heading;

    // Ram: shove the target along the unit's own heading, sting the player, and let the tyres
    // smoke. The push is forward (the direction the car is travelling), not back along the
    // nose, so a hit actually moves the target out of the way.
    unit.ramTimer = Math.max(0, unit.ramTimer - dt);
    const reach = car ? RAM_RANGE + 0.6 : RAM_RANGE;
    if (dist < reach && unit.ramTimer === 0) {
      unit.ramTimer = 1.5;
      const impact = Math.min(1, unit.speed / 18);

      if (car) {
        car.speed *= 0.42;
        car.mesh.position.x += fx * (1.5 + 1.4 * impact);
        car.mesh.position.z += fz * (1.5 + 1.4 * impact);
        // A nudge sideways as well, so the hit reads as a pit manoeuvre rather than a nudge.
        const swerve = (Math.random() > 0.5 ? 1 : -1) * (0.5 + 0.7 * impact);
        car.mesh.position.x += -fz * swerve * 0.5;
        car.mesh.position.z += fx * swerve * 0.5;
        if (this.vehicles && this.vehicles.spawnSmoke) {
          this.vehicles.spawnSmoke(car.mesh.position, 4, 1.2);
        }
      }

      unit.speed *= 0.5;
      if (this.ramCooldown === 0) {
        this.ramCooldown = 0.5;
        if (this.onDamage) this.onDamage(6 + 7 * impact, 'ram');
      }
      this.addHeat(0.1);
      this.lastEvent = 'Rammed';
    }

    // A unit sitting on top of the player on foot should not stack up inside them.
    if (!car) {
      const px = pos.x - playerPosition.x;
      const pz = pos.z - playerPosition.z;
      const d = Math.hypot(px, pz);
      if (d < 2.2 && d > 0.001) {
        pos.x = playerPosition.x + (px / d) * 2.2;
        pos.z = playerPosition.z + (pz / d) * 2.2;
      }
    }
  }

  /** Per-unit siren: red and blue alternate, each unit on its own phase. */
  #flashSiren(unit) {
    const siren = unit.siren;
    if (!siren) return;
    const phase = this.flash * 7.4 + unit.sirenPhase;
    const redOn = Math.sin(phase) > 0;

    siren.red.emissiveIntensity = redOn ? 9 : 0.25;
    siren.blue.emissiveIntensity = redOn ? 0.25 : 9;

    if (siren.redGlow) siren.redGlow.material.opacity = redOn ? 0.85 : 0.06;
    if (siren.blueGlow) siren.blueGlow.material.opacity = redOn ? 0.06 : 0.85;

    if (siren.light) {
      siren.light.color.setHex(redOn ? 0xff2418 : 0x2a6bff);
      siren.light.intensity = 14;
    }
  }

  /** Separation between units, so a chase does not stack into one car. */
  separate() {
    for (let i = 0; i < this.units.length; i++) {
      for (let j = i + 1; j < this.units.length; j++) {
        const a = this.units[i].mesh.position;
        const b = this.units[j].mesh.position;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d > 5 || d < 0.001) continue;
        const push = (5 - d) * 0.5;
        a.x -= (dx / d) * push;
        a.z -= (dz / d) * push;
        b.x += (dx / d) * push;
        b.z += (dz / d) * push;
      }
    }
  }

  stats() {
    return {
      stars: this.stars,
      heat: Number(this.heat.toFixed(2)),
      units: this.units.length,
      escapedFor: Number(this.escapedFor.toFixed(1)),
      wave: this.waveSize,
      lastEvent: this.lastEvent,
      sirenPhase: Number((this.flash * 7.4).toFixed(2)),
    };
  }
}

export default Police;