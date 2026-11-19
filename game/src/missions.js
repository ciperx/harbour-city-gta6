// Four story missions, one at a time, each with an objective line and a payout.
//
//   1. HOT WIRE   take a car from the kerb and deliver it to the drop
//   2. DOCKS RUN  three stars on your tail, and the harbour gate at the end of the run
//   3. PACKAGES   five pickups against a clock
//   4. THE VAULT  bank ten thousand dollars at the tower
//
// Every mission gets a marker in the world: an additive beam the player can see over the roofs
// and a ring on the ground. Missions own the marker and the pickups, and nothing else: money and
// heat are applied through the player and the police the caller already holds.

import * as THREE from '../vendor/three.module.min.js';
import { ROAD_COORDS, BOUNDS, SIDEWALK_TOP, PITCH } from './city.js';

const BEAM_HEIGHT = 46;

function beamTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, 'rgba(255,196,120,0.85)');
  g.addColorStop(0.35, 'rgba(255,179,71,0.28)');
  g.addColorStop(1, 'rgba(255,179,71,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 128);
  return new THREE.CanvasTexture(canvas);
}

let beamMap = null;

export class Missions {
  constructor(city, player, vehicles, police) {
    this.city = city;
    this.player = player;
    this.vehicles = vehicles;
    this.police = police;

    this.group = new THREE.Group();
    this.group.name = 'missions';

    this.index = -1;
    this.state = 'idle'; // idle | active | done | failed | finished
    this.timer = 0;
    this.limit = 0;
    this.message = '';
    this.messageFor = 0;
    this.payout = 0;
    this.paidOut = 0; // rotating index into PAYOUT_LINES, so a replayed chain reads differently
    this.progress = 0;
    this.total = 0;
    this.idleFor = 2.5;
    this.pickups = [];
    this.marker = null;
    this.objectiveLine = 'Find a car and take it with F';

    this.buildMarker();
  }

  // -- the marker ---------------------------------------------------------------------------

  buildMarker() {
    if (!beamMap) {
      beamMap = beamTexture();
      beamMap.colorSpace = THREE.SRGBColorSpace;
    }
    const marker = new THREE.Group();
    marker.visible = false;

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.35, 2.0, BEAM_HEIGHT, 12, 1, true),
      new THREE.MeshBasicMaterial({
        map: beamMap,
        color: 0xffb347,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    beam.position.y = BEAM_HEIGHT / 2;
    beam.name = 'mission-beam';
    marker.add(beam);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.0, 4.2, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffc46a,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    marker.add(ring);

    marker.userData.beam = beam;
    marker.userData.ring = ring;
    this.group.add(marker);
    this.marker = marker;
  }

  setMarker(position) {
    if (!position) {
      this.marker.visible = false;
      return;
    }
    this.marker.position.set(position.x, this.city.groundAt(position.x, position.z), position.z);
    this.marker.visible = true;
  }

  // -- pickups ------------------------------------------------------------------------------

  spawnPickup(position) {
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.65, 0),
      new THREE.MeshStandardMaterial({
        color: 0xffd18a,
        emissive: 0xffa030,
        emissiveIntensity: 3.4,
        roughness: 0.35,
      }),
    );
    core.position.copy(position);
    core.position.y += 1.1;
    this.group.add(core);
    const entry = { mesh: core, taken: false, phase: Math.random() * 10 };
    this.pickups.push(entry);
    return entry;
  }

  clearPickups() {
    for (const p of this.pickups) {
      this.group.remove(p.mesh);
      p.mesh.geometry.dispose();
    }
    this.pickups.length = 0;
  }

  // -- mission definitions ------------------------------------------------------------------

  get definition() {
    return MISSIONS[this.index] || null;
  }

  start(index) {
    if (index < 0 || index >= MISSIONS.length) return;
    this.index = index;
    this.state = 'active';
    this.progress = 0;
    this.total = 0;
    this.timer = 0;
    this.limit = 0;
    this.payout = 0;
    this.clearPickups();
    MISSIONS[index].begin(this);
    this.message = MISSIONS[index].title;
    this.messageFor = 4;
  }

  next() {
    if (this.index + 1 >= MISSIONS.length) {
      this.state = 'finished';
      this.setMarker(null);
      this.objectiveLine = 'All four jobs done. The city is yours.';
      return;
    }
    this.start(this.index + 1);
  }

  /** Where the player is for distance checks: the car when driving, the body otherwise. */
  where(ctx) {
    return ctx.car ? ctx.car.mesh.position : this.player.position;
  }

  update(dt, ctx) {
    if (this.messageFor > 0) this.messageFor = Math.max(0, this.messageFor - dt);

    // Marker: slow spin and a breathing beam.
    if (this.marker.visible) {
      const beam = this.marker.userData.beam;
      const ring = this.marker.userData.ring;
      beam.material.opacity = 0.34 + Math.sin(performance.now() * 0.0022) * 0.12;
      ring.rotation.z += dt * 0.7;
      const pulse = 1 + Math.sin(performance.now() * 0.003) * 0.06;
      ring.scale.setScalar(pulse);
    }

    for (const p of this.pickups) {
      if (p.taken) continue;
      p.phase += dt;
      p.mesh.rotation.y += dt * 1.6;
      p.mesh.position.y += Math.sin(p.phase * 2.4) * dt * 0.35;
    }

    if (this.state !== 'active') {
      if (this.state === 'finished') return;
      // Between jobs the story takes a breath, then hands out the next one. Without this the
      // chain dead-ends on 'done' and the last three missions are unreachable.
      this.idleFor -= dt;
      if (this.idleFor <= 0) {
        this.state = 'idle';
        this.next();
      }
      return;
    }

    const def = MISSIONS[this.index];
    if (!def) return;

    if (this.limit > 0) {
      this.timer += dt;
      if (this.timer >= this.limit) {
        this.state = 'failed';
        this.setMarker(null);
        this.clearPickups();
        this.message = 'Job blown. Try the next one.';
        this.messageFor = 5;
        this.idleFor = 4;
        this.objectiveLine = 'Waiting for the next job…';
        return;
      }
    }

    def.tick(this, dt, ctx);
  }

  /** Called by a mission when its objective is met. */
  complete(ctx, payout) {
    this.state = 'done';
    this.payout = payout;
    this.player.money += payout;
    this.setMarker(null);
    this.clearPickups();
    // Same money, different wording every time: the job's own list, taken in rotation.
    const lines = PAYOUT_LINES[this.index] || ["paid"];
    const line = lines[this.paidOut % lines.length];
    this.paidOut++;
    this.message = `JOB PAID  +$${payout.toLocaleString('en-US')} — ${line}`;
    this.messageFor = 5;
    this.objectiveLine = 'Objective complete';
    this.idleFor = 5;
  }

  fail(reason) {
    this.state = 'failed';
    this.setMarker(null);
    this.clearPickups();
    this.message = reason;
    this.messageFor = 5;
    this.objectiveLine = 'Waiting for the next job…';
    this.idleFor = 4;
  }

  get objective() {
    return this.objectiveLine;
  }

  get activeTitle() {
    return this.definition ? this.definition.title : '';
  }

  get timeLeft() {
    if (this.limit <= 0 || this.state !== 'active') return 0;
    return Math.max(0, this.limit - this.timer);
  }

  stats() {
    return {
      index: this.index,
      state: this.state,
      objective: this.objectiveLine,
      timeLeft: Number(this.timeLeft.toFixed(1)),
      pickups: this.pickups.length,
      marker: this.marker.visible,
    };
  }
}

/** A point on a road, a little away from the player, that is not inside an intersection. */
function roadPointNear(origin, minDistance = 35, maxDistance = 120) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const axis = Math.random() > 0.5 ? 'z' : 'x';
    const road = ROAD_COORDS[Math.floor(Math.random() * ROAD_COORDS.length)];
    const along = -BOUNDS + 20 + Math.random() * (BOUNDS * 2 - 40);
    const x = axis === 'z' ? road : along;
    const z = axis === 'z' ? along : road;
    const d = Math.hypot(x - origin.x, z - origin.z);
    if (d < minDistance || d > maxDistance) continue;
    // Reject points sitting in an intersection.
    const nearX = ROAD_COORDS.some((c) => Math.abs(c - x) < 14);
    const nearZ = ROAD_COORDS.some((c) => Math.abs(c - z) < 14);
    if (nearX && nearZ) continue;
    return new THREE.Vector3(x, 0, z);
  }
  return new THREE.Vector3(ROAD_COORDS[2], 0, ROAD_COORDS[2]);
}

/**
 * What the till says. Four jobs, four idioms: the money is identical, but a docks run that paid
 * out with "clean handoff — the keys stay in it" would read as the wrong job. Each list rotates,
 * so running the chain twice does not produce the same four lines twice.
 */
const PAYOUT_LINES = [
  ["clean handoff", "keys still in it", "no questions asked"],
  ["docks money, still warm", "gate cleared", "envelope counted twice"],
  ["five drops, one payout", "all five logged", "the runner signs off"],
  ["large bills, no receipt", "banked and unseen", "the cameras woke late"],
];

const MISSIONS = [
  {
    title: 'HOT WIRE',
    blurb: 'Lift a car off the kerb and drop it at the harbour lock-up.',
    begin(m) {
      const drop = new THREE.Vector3(ROAD_COORDS[6], 0, BOUNDS - 22);
      m.drop = drop;
      m.delivered = false;
      m.setMarker(drop);
      m.objectiveLine = 'HOT WIRE: take any car with F';
    },
    tick(m, dt, ctx) {
      const d = m.where(ctx).distanceTo(m.drop);

      // The job is the car, not a walk to a pin. On foot the marker pays nothing, and stepping
      // out inside the ring only tells the player to get back behind the wheel.
      if (!ctx.car) {
        m.objectiveLine =
          d < 12
            ? 'HOT WIRE: get back in the car and roll it into the ring'
            : 'HOT WIRE: take any car with F';
        return;
      }

      if (d > 9) {
        m.objectiveLine = d < 22 ? `HOT WIRE: ease it into the ring — ${d.toFixed(0)} m` : 'HOT WIRE: deliver the car to the marker';
        return;
      }

      // Inside the ring: the car has to be brought to a stop. Rolling through at speed, or
      // stopping short of the pin, leaves the job unpaid.
      if (Math.abs(ctx.car.speed) > 4.5) {
        m.objectiveLine = 'HOT WIRE: stop the car inside the ring';
        return;
      }

      m.delivered = true;
      m.objectiveLine = 'HOT WIRE: car delivered';
      m.complete(ctx, 2500);
    },
  },
  {
    title: 'DOCKS RUN',
    blurb: 'Three stars, and a hundred seconds to reach the harbour gate.',
    begin(m) {
      m.police.addHeat(3, 'Docks run');
      m.limit = 100;
      m.dock = new THREE.Vector3(0, 0, BOUNDS - 4);
      m.setMarker(m.dock);
      m.objectiveLine = 'DOCKS RUN: reach the harbour gate, 100 s on the clock';
    },
    tick(m, dt, ctx) {
      const left = m.timeLeft.toFixed(0);
      m.objectiveLine = `DOCKS RUN: reach the harbour gate — ${left}s`;
      if (m.where(ctx).distanceTo(m.dock) < 13) m.complete(ctx, 4000);
    },
  },
  {
    title: 'PACKAGES',
    blurb: 'Five drops scattered across the district. Bring them in before the clock runs out.',
    begin(m) {
      m.limit = 130;
      m.progress = 0;
      m.total = 5;
      const origin = m.player.position;
      for (let i = 0; i < 5; i++) {
        const spot = roadPointNear(origin, 30, 150);
        spot.y = m.city.groundAt(spot.x, spot.z);
        m.spawnPickup(spot);
      }
      m.objectiveLine = 'PACKAGES: 0 / 5 collected — 130s';
    },
    tick(m, dt, ctx) {
      const where = m.where(ctx);
      for (const p of m.pickups) {
        if (p.taken) continue;
        if (where.distanceTo(p.mesh.position) > 4.2) continue;
        p.taken = true;
        p.mesh.visible = false;
        m.progress++;
      }
      const left = m.timeLeft.toFixed(0);
      m.objectiveLine = `PACKAGES: ${m.progress} / ${m.total} collected — ${left}s`;
      if (m.progress >= m.total) m.complete(ctx, 1500 + 400 * m.total);
    },
  },
  {
    title: 'THE VAULT',
    blurb: 'Ten thousand dollars, banked at the tower. Get the balance up, then walk in.',
    begin(m) {
      const block = m.city.blockAt(4, 4);
      m.vault = new THREE.Vector3(block.center.x, SIDEWALK_TOP, block.center.z + PITCH * 0.5);
      m.setMarker(m.vault);
      m.objectiveLine = `THE VAULT: bank $10,000 — balance $${Math.round(m.player.money).toLocaleString('en-US')}`;
    },
    tick(m, dt, ctx) {
      const bal = Math.round(m.player.money);
      const enough = m.player.money >= 10000;
      m.objectiveLine = `THE VAULT: bank $10,000 — balance $${bal.toLocaleString('en-US')}`;
      if (!enough) return;
      const d = m.where(ctx).distanceTo(m.vault);
      if (d < 14) m.complete(ctx, 6000);
      else m.objectiveLine = 'THE VAULT: get to the tower with the cash';
    },
  },
];

export default Missions;