// Wanted level and the units that answer it.
//
// Heat is a float from 0 to 5: firing a shot or shoving a car adds a little, a ram adds more,
// and it only cools once the player has broken line of sight for twenty seconds. From two stars
// up, police cars spawn off-screen, drive at the player and ram. Everything in here is steered
// by the same simple seek-and-push model as the player's car, so a chase stays readable.

import * as THREE from '../vendor/three.module.min.js';
import { ROAD_COORDS, BOUNDS } from './city.js';
import { createCar, policeBarMaterial } from './vehicles.js';

const ESCAPE_TIME = 20; // seconds out of sight before a star comes off
const SIGHT = 58; // how close a unit has to be to keep the heat on
const MAX_UNITS = 3;

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
  }

  get stars() {
    return THREE.MathUtils.clamp(Math.ceil(this.heat - 0.001), 0, 5);
  }

  get wanted() {
    return this.heat > 0.01;
  }

  addHeat(amount, reason = '') {
    const before = this.stars;
    this.heat = THREE.MathUtils.clamp(this.heat + amount, 0, 5);
    this.escapedFor = 0;
    if (reason) this.lastEvent = reason;
    if (this.stars > before && this.stars >= 2) this.spawnTimer = Math.min(this.spawnTimer, 1.2);
  }

  /** A shot fired into the air: the whole block hears it. */
  reportShot() {
    this.addHeat(0.6, 'Shots fired');
  }

  clear() {
    this.heat = 0;
    this.escapedFor = 0;
    this.#despawnAll();
  }

  // -- spawning ---------------------------------------------------------------------------

  #spawn() {
    const level = this.stars;
    const axis = Math.random() > 0.5 ? 'z' : 'x';
    // Pick the nearest road to the player on that axis, then a point 45-75 m along it.
    const target = this.targetPoint || new THREE.Vector3();
    let road = ROAD_COORDS[0];
    let best = Infinity;
    for (const c of ROAD_COORDS) {
      const d = Math.abs((axis === 'z' ? target.x : target.z) - c);
      if (d < best) {
        best = d;
        road = c;
      }
    }
    const sign = Math.random() > 0.5 ? 1 : -1;
    const along = (axis === 'z' ? target.z : target.x) + sign * (45 + Math.random() * 30);
    const offset = (Math.random() > 0.5 ? 1 : -1) * 3;

    const mesh = createCar({ police: true, color: 0xe9edf4 });
    const unit = {
      mesh,
      heading: 0,
      speed: 0,
      axis,
      road,
      offset,
      level,
      t: THREE.MathUtils.clamp(along, -BOUNDS, BOUNDS),
      ramTimer: 0,
    };
    const lane = road + offset;
    if (axis === 'z') mesh.position.set(lane, 0, unit.t);
    else mesh.position.set(unit.t, 0, lane);
    unit.heading = Math.atan2(target.x - mesh.position.x, target.z - mesh.position.z);
    mesh.rotation.y = unit.heading;

    this.group.add(mesh);
    this.units.push(unit);
  }

  #despawnAll() {
    for (const u of this.units) {
      this.group.remove(u.mesh);
      u.mesh.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    }
    this.units.length = 0;
  }

  #despawnUnit(unit) {
    this.group.remove(unit.mesh);
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
  }

  // -- simulation -------------------------------------------------------------------------

  update(dt, ctx) {
    const { playerPosition, car } = ctx;
    const target = car ? car.mesh.position : playerPosition;
    this.targetPoint = target;
    this.ramCooldown = Math.max(0, this.ramCooldown - dt);
    this.flash += dt * 7;

    // The bar flashes red and blue, all units together.
    const on = Math.sin(this.flash) > 0;
    policeFlash(on);
    this.separate();

    const near = this.units.reduce((min, u) => {
      const dx = u.mesh.position.x - playerPosition.x;
      const dz = u.mesh.position.z - playerPosition.z;
      return Math.min(min, Math.hypot(dx, dz));
    }, Infinity);

    // Escape: nothing within sight for twenty seconds takes a star off, once per interval.
    if (this.stars >= 1) {
      if (near > SIGHT) this.escapedFor += dt;
      else this.escapedFor = 0;

      if (this.escapedFor >= ESCAPE_TIME) {
        this.escapedFor = 0;
        this.heat = Math.max(0, Math.floor(this.heat) - 1);
        this.lastEvent = this.heat > 0 ? 'Lost one star' : 'You lost them';
      }
    } else {
      this.escapedFor = 0;
    }

    // Units retire below two stars, or when the player is far away and forgotten.
    if (this.stars < 2) {
      for (const unit of [...this.units]) this.#despawnUnit(unit);
    } else {
      for (const unit of [...this.units]) {
        const dx = unit.mesh.position.x - playerPosition.x;
        const dz = unit.mesh.position.z - playerPosition.z;
        if (Math.hypot(dx, dz) > 190) {
          this.#despawnUnit(unit);
          continue;
        }
        this.#stepUnit(unit, dt, target, car);
      }
    }

    // Reinforcements, one every few seconds up to the star count.
    this.spawnTimer -= dt;
    const wantedUnits = Math.min(MAX_UNITS, Math.max(0, this.stars - 1));
    if (this.stars >= 2 && this.units.length < wantedUnits && this.spawnTimer <= 0) {
      this.#spawn();
      this.spawnTimer = 5.5;
    }
  }

  #stepUnit(unit, dt, target, car) {
    const pos = unit.mesh.position;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);

    let delta = want - unit.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    unit.heading += delta * Math.min(1, 3.4 * dt);

    const maxSpeed = 17 + this.stars * 2.4;
    // Do not overshoot on the last few metres, or the unit orbits the player.
    const approach = THREE.MathUtils.clamp((dist - 4) * 0.55, 0, maxSpeed);
    unit.speed += (approach - unit.speed) * Math.min(1, 2.2 * dt);

    const fx = Math.sin(unit.heading);
    const fz = Math.cos(unit.heading);
    pos.x += fx * unit.speed * dt;
    pos.z += fz * unit.speed * dt;
    pos.y = 0;
    unit.mesh.rotation.y = unit.heading;

    // Keep the unit out of buildings: a fat circle push-out, same as the player's car.
    const R = 1.8;
    for (const b of this.city.buildings) {
      if (b.top < 0.6) continue;
      const cx = THREE.MathUtils.clamp(pos.x, b.x0, b.x1);
      const cz = THREE.MathUtils.clamp(pos.z, b.z0, b.z1);
      const ox = pos.x - cx;
      const oz = pos.z - cz;
      const d2 = ox * ox + oz * oz;
      if (d2 > R * R) continue;
      const d = Math.sqrt(d2) || 0.0001;
      pos.x += (ox / d) * (R - d);
      pos.z += (oz / d) * (R - d);
      unit.speed *= 0.45;
    }

    const limit = BOUNDS + 24;
    pos.x = THREE.MathUtils.clamp(pos.x, -limit, limit);
    pos.z = THREE.MathUtils.clamp(pos.z, -limit, BOUNDS + 20);

    // Ram: close the gap, shove the player's car, and sting.
    unit.ramTimer = Math.max(0, unit.ramTimer - dt);
    if (dist < 3.4 && unit.ramTimer === 0 && this.ramCooldown === 0) {
      unit.ramTimer = 1.6;
      this.ramCooldown = 0.6;
      if (car) {
        car.speed *= 0.45;
        car.mesh.position.x -= fx * 1.2;
        car.mesh.position.z -= fz * 1.2;
      }
      if (this.onDamage) this.onDamage(7, 'ram');
      this.addHeat(0.12);
      this.lastEvent = 'Rammed';
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
        if (d > 4.5 || d < 0.001) continue;
        const push = (4.5 - d) * 0.5;
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
    };
  }
}

// The roof bar is one shared material, so flashing every unit is a single write.
function policeFlash(red) {
  if (!policeBarMaterial) return;
  if (red) {
    policeBarMaterial.emissive.setHex(0xff2418);
    policeBarMaterial.color.setHex(0xff3a2a);
  } else {
    policeBarMaterial.emissive.setHex(0x2f6bff);
    policeBarMaterial.color.setHex(0x3a6bff);
  }
}

export default Police;