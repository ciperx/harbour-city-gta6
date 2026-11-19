// Traffic: parked cars at the kerb, moving cars that keep to their lane, stop at the lights and
// leave an eight-metre gap, and one of them can be taken with F.
//
// Each car body is merged into a single vertex-coloured mesh that shares one material across the
// whole fleet, so a car costs one draw call plus a headlight cone and a tail glow. The headlights
// that actually light the asphalt are four recycled spotlights that follow the nearest cars.

import * as THREE from '../vendor/three.module.min.js';
import { ROAD_COORDS, ROAD_WIDTH, BOUNDS } from './city.js';

export const LANE = 2.75; // lane centre, measured from the road centre line
const WRAP_LO = -BOUNDS - 30;
const WRAP_SPAN = (BOUNDS + 30) * 2;
const BRAKE_DISTANCE = 8; // the gap a car keeps to the one in front

// Tail-light levels. The lens is built at 0.6 opacity on a 2 m sprite; under braking it goes to
// full and swells, which is what a filament in a red lens actually looks like at dusk.
const TAIL_BASE_OPACITY = 0.6;
const TAIL_BRAKE_OPACITY = 1;
const TAIL_BASE_SCALE = 2;
const TAIL_BRAKE_SCALE = 2.7;

// --- shared assets ---------------------------------------------------------------------

function radialCanvas(size, stops) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

let _glow = null;
function glowTexture() {
  if (!_glow) {
    _glow = new THREE.CanvasTexture(
      radialCanvas(64, [
        [0, 'rgba(255,255,255,1)'],
        [0.3, 'rgba(255,255,255,0.5)'],
        [0.65, 'rgba(255,255,255,0.12)'],
        [1, 'rgba(255,255,255,0)'],
      ]),
    );
    _glow.colorSpace = THREE.SRGBColorSpace;
  }
  return _glow;
}

// Smoke: a soft grey puff, deliberately softer and wider than the headlight glow so a tyre
// cloud reads as vapour instead of another lamp.
let _smoke = null;
function smokeTexture() {
  if (!_smoke) {
    _smoke = new THREE.CanvasTexture(
      radialCanvas(64, [
        [0, 'rgba(255,255,255,0.9)'],
        [0.42, 'rgba(255,255,255,0.34)'],
        [0.72, 'rgba(255,255,255,0.09)'],
        [1, 'rgba(255,255,255,0)'],
      ]),
    );
    _smoke.colorSpace = THREE.SRGBColorSpace;
  }
  return _smoke;
}

const SMOKE_POOL = 28;

// The cone hangs off the nose: apex at +2.1 m, mouth ten metres down the road.
const coneGeometry = new THREE.ConeGeometry(2.3, 10, 12, 1, true);
coneGeometry.rotateX(-Math.PI / 2); // apex towards -Z
coneGeometry.translate(0, 0.78, 7.1); // apex at 2.1 m, mouth at 12.1 m: a 10 m throw
coneGeometry.userData.sharedGeometry = true;
const coneMaterial = new THREE.MeshBasicMaterial({
  color: 0xfff0cd,
  transparent: true,
  opacity: 0.075,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  fog: false,
});

const bodyMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.31,
  metalness: 0.55,
  envMapIntensity: 1.3,
});

const POLICE_BAR_RED = new THREE.Color(0xff2a1e);
const POLICE_BAR_BLUE = new THREE.Color(0x2a6bff);
const policeBarMaterial = new THREE.MeshStandardMaterial({
  color: 0xff3a2a,
  emissive: 0xff1a10,
  emissiveIntensity: 4,
  roughness: 0.35,
});
export { policeBarMaterial };

// --- small helpers ---------------------------------------------------------------------

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

const ITEM_SIZE = { position: 3, normal: 3, uv: 2, color: 3 };

function merge(geoms) {
  if (!geoms.length) return null;
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
  for (const g of geoms) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/** A small additive sprite: just enough to read as a glowing lens at night. */
function glowSprite(color, size, opacity) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  sprite.scale.set(size, size, 1);
  return sprite;
}

// --- the car factory -------------------------------------------------------------------

const PALETTE = [0xb9c3cc, 0x8d2028, 0x1d2a3c, 0xd8d3c4, 0x2f3a30, 0x44484f, 0xa9661f, 0x6c1f3a, 0xe0dcd0];

/**
 * Build one car, nose pointing at +Z. Returns the group plus the bit of it that animates.
 * Police cars take the same body in white with a roof bar on their own emissive material.
 */
export function createCar({ color = 0xb9c3cc, police = false, headlights = true } = {}) {
  const group = new THREE.Group();
  group.name = police ? 'police-car' : 'car';

  const base = new THREE.Color(police ? 0xe9edf4 : color);
  const parts = [];
  const push = (geom, tint) => parts.push(paint(geom.toNonIndexed(), tint));

  const hull = new THREE.BoxGeometry(1.9, 0.6, 4.3);
  hull.translate(0, 0.68, 0);
  push(hull, base);

  const skirt = new THREE.BoxGeometry(1.72, 0.24, 4.0);
  skirt.translate(0, 0.4, 0);
  push(skirt, base.clone().multiplyScalar(0.5));

  const cabin = new THREE.BoxGeometry(1.62, 0.52, 2.0);
  cabin.translate(0, 1.2, -0.16);
  push(cabin, new THREE.Color(0x27303c));

  const roof = new THREE.BoxGeometry(1.5, 0.1, 1.86);
  roof.translate(0, 1.47, -0.16);
  push(roof, police ? new THREE.Color(0x1b1f27) : base);

  const bumperF = new THREE.BoxGeometry(1.78, 0.22, 0.2);
  bumperF.translate(0, 0.56, 2.14);
  push(bumperF, new THREE.Color(0x1a1d22));

  const bumperR = new THREE.BoxGeometry(1.78, 0.22, 0.2);
  bumperR.translate(0, 0.56, -2.14);
  push(bumperR, new THREE.Color(0x1a1d22));

  for (const sx of [-1, 1]) {
    for (const sz of [-1.34, 1.34]) {
      const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 10);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(sx * 0.9, 0.36, sz);
      push(wheel, new THREE.Color(0x121418));
    }
    // Lenses: warm at the nose, red at the tail. They are painted, and the glows hang off them.
    const lens = new THREE.BoxGeometry(0.44, 0.16, 0.08);
    lens.translate(sx * 0.58, 0.76, 2.17);
    push(lens, new THREE.Color(0xfff4d6));

    const tail = new THREE.BoxGeometry(0.4, 0.14, 0.08);
    tail.translate(sx * 0.6, 0.82, -2.17);
    push(tail, new THREE.Color(0xff3a20));
  }

  const body = new THREE.Mesh(merge(parts), bodyMaterial);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  if (police) {
    // Two lenses on two materials, not one shared bar: the police system flashes every unit
    // independently, and a material shared across the fleet would light all of them in lockstep.
    const red = policeBarMaterial.clone();
    red.color.copy(POLICE_BAR_RED);
    red.emissive.copy(POLICE_BAR_RED);
    red.emissiveIntensity = 9;
    const blue = policeBarMaterial.clone();
    blue.color.copy(POLICE_BAR_BLUE);
    blue.emissive.copy(POLICE_BAR_BLUE);
    blue.emissiveIntensity = 0.25;

    const barRed = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.16, 0.34), red);
    barRed.position.set(-0.29, 1.61, -0.1);
    const barBlue = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.16, 0.34), blue);
    barBlue.position.set(0.29, 1.61, -0.1);
    group.add(barRed, barBlue);

    // Halos plus one point light, so the bar throws colour onto the asphalt and the facades.
    const redGlow = glowSprite(0xff2a1e, 3.2, 0.85);
    redGlow.position.set(-0.3, 1.66, -0.1);
    const blueGlow = glowSprite(0x2a6bff, 3.2, 0.06);
    blueGlow.position.set(0.3, 1.66, -0.1);
    group.add(redGlow, blueGlow);

    const light = new THREE.PointLight(0xff2418, 14, 17, 2);
    light.castShadow = false;
    light.position.set(0, 2.05, -0.1);
    group.add(light);

    group.userData.siren = { red, blue, redGlow, blueGlow, light };
    // Only these materials belong to this one car; the body shares the fleet material.
    group.userData.ownedMaterials = [red, blue, redGlow.material, blueGlow.material];
  }

  const cone = headlights ? new THREE.Mesh(coneGeometry, coneMaterial) : null;
  if (cone) {
    cone.userData.sharedGeometry = true;
    cone.renderOrder = 3;
    cone.frustumCulled = false;
    group.add(cone);
  }

  const headGlow = headlights ? glowSprite(0xfff3d0, 2.6, 0.75) : null;
  if (headGlow) headGlow.position.set(0, 0.76, 2.4);
  if (headGlow) group.add(headGlow);

  const tailGlow = glowSprite(0xff4a22, 2.0, 0.6);
  tailGlow.position.set(0, 0.82, -2.36);
  group.add(tailGlow);

  group.userData.cone = cone;
  group.userData.tailGlow = tailGlow;
  group.userData.headGlow = headGlow;
  return group;
}

// --- traffic lights --------------------------------------------------------------------

const GREEN = 11.5;
const YELLOW = 2.6;
const ALL_RED = 1.2;
const SEGMENT = GREEN + YELLOW + ALL_RED;

/**
 * Two-phase signals for the whole grid: every north-south road is green at the same time, then
 * amber, then everything is red for a beat, then east-west. Driving cars and pedestrians read
 * the same clock, which is what makes a crossing look deliberate instead of random.
 */
export class TrafficLights {
  constructor(city) {
    this.time = 0;
    this.group = new THREE.Group();
    this.group.name = 'traffic-lights';

    this.nsMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a6b3f,
      emissive: 0x39ff88,
      emissiveIntensity: 3.4,
      roughness: 0.4,
    });
    this.ewMaterial = this.nsMaterial.clone();

    this.#build(city);
    this.#paint();
  }

  #build(city) {
    const poles = [];
    const nsLenses = [];
    const ewLenses = [];
    const off = ROAD_WIDTH / 2 + 1.1;
    const H = 3.5;

    for (const cx of ROAD_COORDS) {
      for (const cz of ROAD_COORDS) {
        // One post on two opposite corners; each carries a lens for each axis.
        for (const [sx, sz] of [
          [1, 1],
          [-1, -1],
        ]) {
          const px = cx + sx * off;
          const pz = cz + sz * off;

          const pole = new THREE.CylinderGeometry(0.09, 0.12, H, 6);
          pole.translate(px, H / 2, pz);
          poles.push(pole.toNonIndexed());
          pole.dispose();

          // Housing for the north-south face, and a lens that faces the traffic.
          const housing = new THREE.BoxGeometry(0.34, 0.78, 0.3);
          housing.translate(px, H - 0.5, pz);
          poles.push(housing.toNonIndexed());
          housing.dispose();

          const nsLens = new THREE.BoxGeometry(0.2, 0.2, 0.06);
          nsLens.translate(px, H - 0.28, pz + sz * 0.16);
          nsLenses.push(nsLens.toNonIndexed());
          nsLens.dispose();

          const ewLens = new THREE.BoxGeometry(0.06, 0.2, 0.2);
          ewLens.translate(px + sx * 0.16, H - 0.72, pz);
          ewLenses.push(ewLens.toNonIndexed());
          ewLens.dispose();
        }
      }
    }

    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x1e2228, roughness: 0.6, metalness: 0.5 });
    this.group.add(new THREE.Mesh(merge(poles.map((g) => paint(g, new THREE.Color(0x1e2228)))), poleMaterial));

    const nsMesh = new THREE.Mesh(
      merge(nsLenses.map((g) => paint(g, new THREE.Color(0xffffff)))),
      this.nsMaterial,
    );
    nsMesh.name = 'signals-ns';
    this.group.add(nsMesh);

    const ewMesh = new THREE.Mesh(
      merge(ewLenses.map((g) => paint(g, new THREE.Color(0xffffff)))),
      this.ewMaterial,
    );
    ewMesh.name = 'signals-ew';
    this.group.add(ewMesh);
  }

  /** 'green' | 'yellow' | 'red' for a road running along `axis` ('z' or 'x'). */
  stateFor(axis) {
    const t = this.time % (SEGMENT * 2);
    const primaryGreen = t < GREEN;
    const primaryYellow = t >= GREEN && t < GREEN + YELLOW;
    const secondaryLive = t >= SEGMENT;
    const secondaryYellow = t >= SEGMENT + GREEN && t < SEGMENT + GREEN + YELLOW;

    const isPrimary = axis === 'z';
    if (isPrimary) {
      if (primaryGreen) return 'green';
      if (primaryYellow) return 'yellow';
      return 'red';
    }
    if (!secondaryLive) return 'red';
    if (secondaryYellow) return 'yellow';
    return 'green';
  }

  /** Pedestrians cross a road running along `axis` while that axis is stopped. */
  walk(axis) {
    const other = axis === 'z' ? 'x' : 'z';
    return this.stateFor(axis) === 'red' && this.stateFor(other) === 'green';
  }

  #paint() {
    const ns = this.stateFor('z');
    const ew = this.stateFor('x');
    const apply = (material, state) => {
      if (state === 'green') {
        material.color.setHex(0x2a6b3f);
        material.emissive.setHex(0x39ff88);
        material.emissiveIntensity = 3.2;
      } else if (state === 'yellow') {
        material.color.setHex(0x7a5a1c);
        material.emissive.setHex(0xffcc33);
        material.emissiveIntensity = 3.6;
      } else {
        material.color.setHex(0x6b2222);
        material.emissive.setHex(0xff3324);
        material.emissiveIntensity = 3.0;
      }
    };
    apply(this.nsMaterial, ns);
    apply(this.ewMaterial, ew);
  }

  update(dt) {
    this.time += dt;
    this.#paint();
  }
}

// --- the vehicle system ----------------------------------------------------------------

export class Vehicles {
  constructor(city, options = {}) {
    this.city = city;
    this.group = new THREE.Group();
    this.group.name = 'vehicles';
    this.cars = [];
    this.driving = null;
    this.prompt = null; // set when the player is close enough to take a car
    this.onBump = null; // (otherCar) => void, wired by main to the wanted system
    this.onImpact = null; // (speed, what) => void, wired by main to heat and health
    this.bumpCooldown = 0;
    this.impactCooldown = 0;
    this.impacts = 0;
    this.lastExit = null;
    this.smoke = [];
    this.smokeCursor = 0;
    this.policeUnits = null; // live reference to police.units, wired by main after both exist

    this.trafficLights = new TrafficLights(city);
    this.group.add(this.trafficLights.group);

    this.headlights = [];
    this.#buildParked(options.parked ?? 7);
    this.#buildTraffic(options.driving ?? 9);
    this.#buildHeadlights(4);
    this.#buildSmoke();
  }

  // -- construction ---------------------------------------------------------------------

  #buildParked(count) {
    const palette = PALETTE;
    let placed = 0;
    let attempts = 0;
    // Parked cars are placed by probing the road ahead of the spot first: a car nosed into a
    // wall, or boxed in behind the fence at the end of an avenue, is a trap rather than a ride.
    while (placed < count && attempts < count * 8) {
      attempts++;
      const axis = placed % 2 === 0 ? 'z' : 'x';
      const road = ROAD_COORDS[1 + Math.floor(Math.random() * (ROAD_COORDS.length - 2))];
      const dir = Math.random() > 0.5 ? 1 : -1;
      // Kerbside: just inside the road edge, nose pointing along the traffic direction.
      const offset = dir * (ROAD_WIDTH / 2 - 1.25);
      const t = -BOUNDS + 25 + Math.random() * (BOUNDS * 2 - 50);

      const slot = this.#positionOf({ axis, road, dir, t, offset });
      // The last pass accepts whatever it can get, so a crowded city still has cars in it.
      if (attempts < count * 6 && this.clearAhead(slot, slot.heading, 26) < 14) continue;

      const mesh = createCar({ color: palette[Math.floor(Math.random() * palette.length)] });
      const car = {
        kind: 'parked',
        mesh,
        axis,
        road,
        dir,
        t,
        offset,
        speed: 0,
        cruise: 0,
        occupied: false,
        heading: 0,
      };
      this.#place(car);
      this.cars.push(car);
      this.group.add(mesh);
      placed++;
    }
  }

  #buildTraffic(count) {
    for (let i = 0; i < count; i++) {
      const axis = i % 2 === 0 ? 'z' : 'x';
      const road = ROAD_COORDS[Math.floor(Math.random() * ROAD_COORDS.length)];
      const dir = Math.random() > 0.5 ? 1 : -1;
      const mesh = createCar({ color: PALETTE[Math.floor(Math.random() * PALETTE.length)] });
      const car = {
        kind: 'traffic',
        mesh,
        axis,
        road,
        dir,
        t: -BOUNDS + Math.random() * BOUNDS * 2,
        offset: axis === 'z' ? -dir * LANE : dir * LANE,
        speed: 8,
        cruise: 9.5 + Math.random() * 4.5,
        occupied: false,
        heading: 0,
      };
      this.#place(car);
      this.cars.push(car);
      this.group.add(mesh);
    }
  }

  #buildHeadlights(count) {
    for (let i = 0; i < count; i++) {
      const spot = new THREE.SpotLight(0xffe9c2, 0, 46, 0.52, 0.62, 1.6);
      spot.castShadow = false;
      spot.target.position.set(0, 0, 18);
      this.group.add(spot);
      this.group.add(spot.target);
      this.headlights.push(spot);
    }
  }

  // -- smoke ----------------------------------------------------------------------------

  #buildSmoke() {
    for (let i = 0; i < SMOKE_POOL; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: smokeTexture(),
          color: 0xc9ced7,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          fog: true,
        }),
      );
      sprite.visible = false;
      sprite.renderOrder = 2;
      this.group.add(sprite);
      this.smoke.push({ sprite, life: 0, maxLife: 1, rise: 1, grow: 2, size: 0.6, strength: 1 });
    }
  }

  /**
   * A puff of tyre smoke at a point: used by a hard crash into a facade, a shove from another
   * car, and by the police when they put a bumper in. Pooled and additive-free, so twenty of
   * them cost nothing.
   */
  spawnSmoke(position, count = 3, strength = 1) {
    if (!position) return;
    const hold = THREE.MathUtils.clamp(strength, 0.2, 1.4);
    for (let i = 0; i < count; i++) {
      const puff = this.smoke[this.smokeCursor % this.smoke.length];
      this.smokeCursor++;
      const spread = 0.9;
      puff.sprite.position.set(
        position.x + (Math.random() - 0.5) * spread,
        0.5 + Math.random() * 0.55,
        position.z + (Math.random() - 0.5) * spread,
      );
      puff.sprite.visible = true;
      puff.maxLife = 0.85 + Math.random() * 0.75;
      puff.life = puff.maxLife;
      puff.rise = 1.0 + Math.random() * 1.0;
      puff.grow = 1.5 + Math.random() * 1.6;
      puff.strength = hold;
      puff.size = 0.55 + Math.random() * 0.45;
      puff.sprite.scale.setScalar(puff.size);
      puff.sprite.material.opacity = 0.5 * hold;
    }
  }

  #updateSmoke(dt) {
    for (const puff of this.smoke) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      if (puff.life <= 0) {
        puff.sprite.visible = false;
        puff.sprite.material.opacity = 0;
        continue;
      }
      const age = 1 - puff.life / puff.maxLife;
      puff.sprite.position.y += puff.rise * dt;
      puff.sprite.position.x += Math.sin(age * 4.2 + puff.maxLife * 3) * 0.22 * dt;
      puff.sprite.scale.setScalar(puff.size * (1 + puff.grow * age));
      puff.sprite.material.opacity = 0.5 * puff.strength * (1 - age) * (1 - age);
    }
  }

  /** Count of puffs currently in the air, for stats(). */
  get smokeCount() {
    return this.smoke.reduce((n, p) => n + (p.life > 0 ? 1 : 0), 0);
  }

  // -- brake lights ----------------------------------------------------------------------

  /**
   * Show or hide a car's brake lights. `brake` is the eased 0..1 amount: lights snap on with a
   * tap of the pedal and fade back over a beat, because a hard cut reads as a rendering glitch.
   * The parked fleet never calls this, so an abandoned car sits with its tail dim.
   */
  #setBrake(car, want, dt) {
    const target = want ? 1 : 0;
    const rate = want ? 15 : 4.5;
    car.brake = (car.brake || 0) + (target - (car.brake || 0)) * (1 - Math.exp(-rate * Math.min(dt, 0.1)));
    const glow = car.mesh.userData.tailGlow;
    if (!glow) return;
    glow.material.opacity = TAIL_BASE_OPACITY + (TAIL_BRAKE_OPACITY - TAIL_BASE_OPACITY) * car.brake;
    const size = TAIL_BASE_SCALE + (TAIL_BRAKE_SCALE - TAIL_BASE_SCALE) * car.brake;
    glow.scale.set(size, size, 1);
  }

  // -- placement ------------------------------------------------------------------------

  /** Lane position in world space for a car's current road parameter. */
  #positionOf(car) {
    const lane = car.road + car.offset;
    if (car.axis === 'z') return { x: lane, z: car.t, heading: car.dir > 0 ? 0 : Math.PI };
    return { x: car.t, z: lane, heading: car.dir > 0 ? Math.PI / 2 : -Math.PI / 2 };
  }

  #place(car) {
    const p = this.#positionOf(car);
    car.mesh.position.set(p.x, 0, p.z);
    car.mesh.rotation.y = p.heading;
    car.heading = p.heading;
  }

  /**
   * Metres of clear road in front of a point facing `heading`, capped at `maxMetres`. A probe
   * every 2.5 m gives up on a facade, on the edge of the grid, or on another car parked in the
   * way. This is what "a spot with room to pull out" means for a kerbside car.
   */
  clearAhead(position, heading, maxMetres = 26) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const limit = BOUNDS + 16;
    let clear = 0;
    for (let d = 2.5; d <= maxMetres; d += 2.5) {
      const x = position.x + fx * d;
      const z = position.z + fz * d;
      if (Math.abs(x) > limit || Math.abs(z) > limit) break;

      let hit = false;
      for (const b of this.city.buildings) {
        if (b.top < 0.6) continue;
        if (x > b.x0 - 1.3 && x < b.x1 + 1.3 && z > b.z0 - 1.3 && z < b.z1 + 1.3) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const other of this.cars) {
          if (other.occupied) continue;
          const dx = other.mesh.position.x - x;
          const dz = other.mesh.position.z - z;
          if (dx * dx + dz * dz < 3.4 * 3.4) {
            hit = true;
            break;
          }
        }
      }
      if (hit) break;
      clear = d;
    }
    return clear;
  }

  // -- simulation -----------------------------------------------------------------------

  /** Distance to the stop line of the next intersection ahead, or Infinity. */
  #stopDistance(car) {
    let best = Infinity;
    for (const c of ROAD_COORDS) {
      const ahead = (c - car.t) * car.dir;
      if (ahead < 0.4 || ahead > 48) continue;
      const d = ahead - (ROAD_WIDTH / 2 + 1.6);
      if (d < best) best = Math.max(0, d);
    }
    return best;
  }

  /** Gap, in metres, to the nearest car in the same lane travelling the same way. */
  #leadGap(car) {
    let best = Infinity;
    for (const other of this.cars) {
      if (other === car || other.kind === 'parked' || other.occupied) continue;
      if (other.axis !== car.axis || other.dir !== car.dir) continue;
      if (Math.abs(other.road + other.offset - (car.road + car.offset)) > 1.2) continue;
      const ahead = (other.t - car.t) * car.dir;
      if (ahead > 0 && ahead < best) best = ahead;
    }
    return best;
  }

  #stepTraffic(car, dt) {
    let target = car.cruise;

    const state = this.trafficLights.stateFor(car.axis);
    if (state !== 'green') {
      const stop = this.#stopDistance(car);
      if (stop < 26) target = Math.min(target, Math.max(0, (stop - 0.8) * 0.9));
    }

    const gap = this.#leadGap(car);
    if (gap < 24) target = Math.min(target, Math.max(0, (gap - BRAKE_DISTANCE) * 1.6));

    const accel = target > car.speed ? 5.5 : 16;
    const before = car.speed;
    car.speed += THREE.MathUtils.clamp(target - car.speed, -accel * dt, accel * dt);

    // Brake lights: on while slowing, and held on at a standstill — a car waiting at a red light
    // with its foot off the pedal in real traffic is exactly what looks wrong on screen.
    const slowed = car.speed < before - 0.35;
    this.#setBrake(car, slowed || car.speed < 0.8, dt);

    car.t += car.speed * car.dir * dt;
    if (car.t > WRAP_LO + WRAP_SPAN) car.t -= WRAP_SPAN;
    else if (car.t < WRAP_LO) car.t += WRAP_SPAN;
    this.#place(car);
  }

  /**
   * Find a car the player can get into. Closest wins, but a parked car sitting on a road with
   * room in front of it beats a boxed-in one or a car idling in traffic: the point of taking a
   * car is to be able to drive away in it.
   */
  nearest(position, maxDistance = 3.8) {
    let best = null;
    let bestScore = Infinity;
    for (const car of this.cars) {
      if (car.occupied) continue;
      if (car.kind === 'traffic' && car.speed > 1.8) continue;
      const dx = car.mesh.position.x - position.x;
      const dz = car.mesh.position.z - position.z;
      const d = Math.hypot(dx, dz);
      if (d > maxDistance) continue;

      const run = this.clearAhead(car.mesh.position, car.heading, 30);
      let score = d;
      if (car.kind !== 'parked') score += 3.5; // a kerbside car is the intended way out
      score += Math.max(0, 24 - run) * 0.55; // and only if it has road in front of it
      if (score < bestScore) {
        bestScore = score;
        best = car;
      }
    }
    return best;
  }

  enter(car) {
    if (!car || this.driving) return false;
    car.occupied = true;
    car.driverSpeed = 0;
    car.velocity = new THREE.Vector3();
    this.driving = car;
    if (car.mesh.userData.headGlow) car.mesh.userData.headGlow.material.opacity = 0.9;
    return true;
  }

  /**
   * Get out beside the driver's door: 1.55 m clear of the sill on the driver's side, and if that
   * is a wall, the passenger door, then the rear. The car is left where it stands and stops
   * being traffic, so it does not drive off on its own the moment the door shuts.
   */
  exit(playerPosition) {
    const car = this.driving;
    if (!car) return null;
    car.occupied = false;
    this.driving = null;
    car.speed = 0;
    if (car.mesh.userData.headGlow) car.mesh.userData.headGlow.material.opacity = 0.75;
    // An abandoned car is scenery: no pedal held, so the tail lens drops back to its parked level.
    car.brake = 0;
    const tail = car.mesh.userData.tailGlow;
    if (tail) {
      tail.material.opacity = TAIL_BASE_OPACITY;
      tail.scale.set(TAIL_BASE_SCALE, TAIL_BASE_SCALE, 1);
    }

    const heading = car.heading;
    const base = car.mesh.position;
    // Door side first, then a ring of twelve bearings at two reaches: a car jammed nose-first
    // into a facade still has to let the driver out somewhere that is not inside a wall.
    const candidates = [
      [heading + Math.PI / 2, 1.55], // driver's door, left-hand drive
      [heading - Math.PI / 2, 1.55], // passenger door
      [heading + Math.PI, 2.7], // behind the boot
      [heading, 3.1], // in front of the bonnet
    ];
    for (const reach of [2.4, 3.2]) {
      for (let i = 0; i < 12; i++) candidates.push([heading + (Math.PI / 6) * i, reach]);
    }

    let step = null;
    for (const [angle, reach] of candidates) {
      const x = base.x + Math.sin(angle) * reach;
      const z = base.z + Math.cos(angle) * reach;
      if (Math.abs(x) > BOUNDS + 6 || Math.abs(z) > BOUNDS + 6) continue;
      if (this.#insideBuilding(x, z, 0.55)) continue;
      step = { x, z };
      break;
    }
    // Nothing clear within 3.2 m: stand at the car rather than inside the nearest wall.
    if (!step) step = { x: base.x, z: base.z };

    playerPosition.set(step.x, this.city.groundAt(step.x, step.z), step.z);
    this.lastExit = { x: step.x, z: step.z, heading };
    // An abandoned car stays put: it stops being traffic and becomes scenery.
    if (car.kind === 'traffic') car.kind = 'parked';
    return car;
  }

  /** Is this point inside a building footprint, with `pad` metres of clearance? */
  #insideBuilding(x, z, pad = 0) {
    // The city owns the footprints; one test, one place, so the fleet and the spawn agree.
    return !this.city.isClear(x, z, pad);
  }

  // -- player driving -------------------------------------------------------------------

  #stepPlayerCar(car, input, dt) {
    const throttle = input.forward || 0;
    const steer = input.strafe || 0;
    const handbrake = Boolean(input.handbrake);

    const MAX_FORWARD = 30;
    const MAX_REVERSE = -9;
    const accel = car.speed < 0 ? 16 : 11.5;
    const before = car.speed;

    if (throttle > 0) car.speed += accel * dt;
    else if (throttle < 0) car.speed -= accel * 0.85 * dt;
    else car.speed *= Math.exp(-1.5 * dt);

    if (handbrake) car.speed *= Math.exp(-3.4 * dt);
    car.speed = THREE.MathUtils.clamp(car.speed, MAX_REVERSE, MAX_FORWARD);

    // Brake lights for the player's car: pedal, handbrake, or anything that costs speed — a shunt
    // from a police bumper included.
    this.#setBrake(car, throttle < 0 || handbrake || car.speed < before - 0.35, dt);

    // Steering scales with speed: no turning on the spot, and it tightens as the car slows.
    const grip = handbrake ? 0.45 : 1;
    const turn = THREE.MathUtils.clamp(Math.abs(car.speed) / 7, 0, 1);
    car.heading -= steer * 1.75 * turn * grip * dt * Math.sign(car.speed || 1);

    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const next = new THREE.Vector3(
      car.mesh.position.x + fx * car.speed * dt,
      car.mesh.position.y,
      car.mesh.position.z + fz * car.speed * dt,
    );

    // Buildings: a two-circle capsule rather than one fat circle. A single 1.7 m disc either
    // lets the nose sink into a facade or shoves a kerbside car off its parking spot; circles at
    // the two axles keep both ends out of the wall and still leave room to park 1.25 m from it.
    const R = 1.0;
    const AXLE = 1.15;
    const impactSpeed = Math.abs(car.speed);
    let scraped = false;
    for (const b of this.city.buildings) {
      if (b.top < 0.6) continue;
      for (const s of [AXLE, -AXLE]) {
        const px = next.x + fx * s;
        const pz = next.z + fz * s;
        const cx = THREE.MathUtils.clamp(px, b.x0, b.x1);
        const cz = THREE.MathUtils.clamp(pz, b.z0, b.z1);
        const dx = px - cx;
        const dz = pz - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R) continue;
        if (d2 < 1e-6) {
          // Centre buried in the box: shove it out through the nearest face and stop it there.
          const midZ = (b.z0 + b.z1) / 2;
          next.z += (pz > midZ ? 1 : -1) * (R + 0.02);
          car.speed *= 0.35;
          scraped = true;
          continue;
        }
        const d = Math.sqrt(d2);
        const push = (R - d) / d;
        next.x += dx * push;
        next.z += dz * push;
        car.speed *= 0.6;
        scraped = true;
      }
    }

    // A wall hit at speed: a cloud off the nose, and the caller hears about it (heat, damage).
    if (scraped && impactSpeed > 8) this.#crash(car, impactSpeed);

    // Other cars: a nudge, not a physics engine.
    for (const other of this.cars) {
      if (other === car) continue;
      const ox = other.mesh.position.x - next.x;
      const oz = other.mesh.position.z - next.z;
      const d = Math.hypot(ox, oz);
      if (d > 3.4 || d < 0.001) continue;
      const push = (3.4 - d) / d;
      next.x -= ox * push;
      next.z -= oz * push;
      if (Math.abs(car.speed) > 3 && this.bumpCooldown === 0) {
        this.bumpCooldown = 0.8;
        // A hard shunt smokes at the point of contact; a gentle nudge does not.
        if (Math.abs(car.speed) > 9) {
          this.spawnSmoke(
            { x: (next.x + other.mesh.position.x) / 2, z: (next.z + other.mesh.position.z) / 2 },
            3,
            Math.min(1.1, Math.abs(car.speed) / 14),
          );
        }
        if (this.onBump) this.onBump(other, car);
      }
      car.speed *= 0.4;
      other.speed = Math.max(other.speed * 0.5, 0);
    }

    // Police cruisers are not in this.cars — they belong to the police system — so without this
    // loop the player's car drove clean through a roadblock. Same radius, split between the two
    // bodies so a ram shoves both, and the same bump cooldown so one hit does not pay out twice.
    for (const unit of this.policeUnits || []) {
      const p = unit && unit.mesh && unit.mesh.position;
      if (!p) continue;
      const ox = p.x - next.x;
      const oz = p.z - next.z;
      const d = Math.hypot(ox, oz);
      if (d > 3.4 || d < 0.001) continue;
      const push = ((3.4 - d) / d) * 0.5;
      next.x -= ox * push;
      next.z -= oz * push;
      p.x += ox * push;
      p.z += oz * push;
      if (Math.abs(car.speed) > 9) {
        this.spawnSmoke(
          { x: (next.x + p.x) / 2, z: (next.z + p.z) / 2 },
          3,
          Math.min(1.1, Math.abs(car.speed) / 14),
        );
      }
      car.speed *= 0.5;
      unit.speed = Math.max(unit.speed * 0.5, 0);
      if (Math.abs(car.speed) > 3 && this.bumpCooldown === 0) {
        this.bumpCooldown = 0.8;
        if (this.onBump) this.onBump(unit, car);
      }
    }

    const limit = BOUNDS + 26;
    next.x = THREE.MathUtils.clamp(next.x, -limit, limit);
    next.z = THREE.MathUtils.clamp(next.z, -limit, BOUNDS + 22);

    car.mesh.position.copy(next);
    car.mesh.rotation.y = car.heading;

    // Nose of the car sits a little ahead of the centre, and that is what the camera wants.
    car.nose = new THREE.Vector3(
      car.mesh.position.x + fx * 1.2,
      1.1,
      car.mesh.position.z + fz * 1.2,
    );
  }

  /** A hard hit into a facade: smoke off the nose and a call out to whatever owns the damage. */
  #crash(car, speed) {
    if (this.impactCooldown > 0) return;
    this.impactCooldown = 0.5;
    this.impacts++;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const strength = Math.min(1.3, speed / 13);
    this.spawnSmoke(
      { x: car.mesh.position.x + fx * 1.9, z: car.mesh.position.z + fz * 1.9 },
      Math.min(6, 2 + Math.round(speed / 6)),
      strength,
    );
    if (this.onImpact) this.onImpact(speed, 'building');
  }

  update(dt, playerPosition, input = null) {
    this.trafficLights.update(dt);
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);

    for (const car of this.cars) {
      if (car === this.driving) continue;
      if (car.kind === 'traffic' && !car.occupied) this.#stepTraffic(car, dt);
    }

    if (this.driving) this.#stepPlayerCar(this.driving, input || { forward: 0, strafe: 0 }, dt);

    this.#updateSmoke(dt);
    this.#updateHeadlights(playerPosition);
  }

  /** Four spotlights hop to the nearest cars (or the player's own, which lights the road ahead). */
  #updateHeadlights(playerPosition) {
    const candidates = [];
    for (const car of this.cars) {
      if (car.kind === 'parked' && car !== this.driving) continue;
      const dx = car.mesh.position.x - playerPosition.x;
      const dz = car.mesh.position.z - playerPosition.z;
      candidates.push({ car, d2: dx * dx + dz * dz });
    }
    candidates.sort((a, b) => a.d2 - b.d2);

    for (let i = 0; i < this.headlights.length; i++) {
      const spot = this.headlights[i];
      const pick = candidates[i];
      if (!pick || pick.d2 > 220 * 220) {
        spot.intensity = 0;
        continue;
      }
      const car = pick.car;
      const fx = Math.sin(car.heading);
      const fz = Math.cos(car.heading);
      spot.position.set(car.mesh.position.x + fx * 2.0, 0.85, car.mesh.position.z + fz * 2.0);
      spot.target.position.set(car.mesh.position.x + fx * 22, 0.1, car.mesh.position.z + fz * 22);
      spot.target.updateMatrixWorld();
      const fade = 1 - THREE.MathUtils.clamp((Math.sqrt(pick.d2) - 120) / 100, 0, 1);
      spot.intensity = 240 * fade;
    }
  }

  get speed() {
    return this.driving ? Math.abs(this.driving.speed) : 0;
  }

  stats() {
    const traffic = this.cars.filter((c) => c.kind === 'traffic').length;
    const parked = this.cars.filter((c) => c.kind === 'parked').length;
    return {
      cars: this.cars.length,
      traffic,
      parked,
      headlights: this.headlights.length,
      driving: Boolean(this.driving),
      speed: Number(this.speed.toFixed(2)),
      signal: this.trafficLights.stateFor('z'),
      clearAhead: this.driving ? this.clearAhead(this.driving.mesh.position, this.driving.heading, 30) : 0,
      smoke: this.smokeCount,
      impacts: this.impacts,
    };
  }
}

export default Vehicles;