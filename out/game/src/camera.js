// Third-person orbit camera: drag to orbit, wheel to zoom (4 to 18 m), damped follow, a look-ahead
// that leans the frame the way the player is moving, and two separate guards against walls.
//
// Guard one is a ray from the head to the ideal position: the rig stops in front of the first
// building box it would enter, so the camera never films from inside concrete.
// Guard two is a coverage test: the buildings near the line of sight are projected into the frame
// and rasterised onto a coarse grid. If they fill more than a quarter of it, the rig tries a
// higher or shorter shot until they do not. That is what turns "the camera clipped through a wall"
// into "the camera steps up and keeps the street in frame".

import * as THREE from '../vendor/three.module.min.js';

const MIN_DISTANCE = 4;
const MAX_DISTANCE = 18;
const MIN_PITCH = 0.02; // just above the horizon
const MAX_PITCH = 1.32; // nearly overhead
const DEFAULT_PITCH = 0.46;
const ORBIT_SPEED = 0.0055;
const PITCH_SPEED = 0.0045;
const ORBIT_DAMPING = 7; // gentle: the view eases after the pointer
const FOLLOW_DAMPING = 9;
const POSITION_DAMPING = 11;
const LOOK_AHEAD_DAMPING = 3.2;
const LOOK_AHEAD_MAX = 4.5; // never lead the player by more than this
const MAX_COVERAGE = 0.25; // a wall may never own more than a quarter of the frame
// At or below this elevation the rig is a street-level camera, and the facades lining the avenue
// are the shot rather than an obstruction: the quarter-frame rule only applies above it, or when
// the lens itself is pinned against a wall.
const STREET_PITCH = 0.12;

const PROBE_RADIUS = 0.42;
const WALL_CLEARANCE = 0.5;
const MIN_PULLED_DISTANCE = 2.4;
// Backed against a facade there is no room for a two-metre pull: the rig is allowed to come in
// to shoulder distance rather than clamp back out through the wall.
const EMERGENCY_DISTANCE = 0.8;
const SNAP_IN = 26;
const RECOVER = 3.4;

// Coverage raster: 16x10 cells is fine for "is a wall eating the shot".
const GRID_W = 16;
const GRID_H = 10;

const _m4 = new THREE.Matrix4();

/**
 * Segment vs axis-aligned box (slab method). Returns the entry parameter in [0, 1], or 1 for a
 * clean miss, so the caller can take the minimum over every building.
 */
function segmentBox(ox, oy, oz, dx, dy, dz, b, pad) {
  const minX = b.x0 - pad;
  const maxX = b.x1 + pad;
  const minY = -pad;
  const maxY = b.top + pad;
  const minZ = b.z0 - pad;
  const maxZ = b.z1 + pad;

  let t0 = 0;
  let t1 = 1;

  const axes = [
    [ox, dx, minX, maxX],
    [oy, dy, minY, maxY],
    [oz, dz, minZ, maxZ],
  ];

  for (const [origin, dir, lo, hi] of axes) {
    if (Math.abs(dir) < 1e-8) {
      if (origin < lo || origin > hi) return 1;
      continue;
    }
    const inv = 1 / dir;
    let near = (lo - origin) * inv;
    let far = (hi - origin) * inv;
    if (near > far) {
      const tmp = near;
      near = far;
      far = tmp;
    }
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1) return 1;
  }

  return t0;
}

export class OrbitCamera {
  constructor(camera, element, options = {}) {
    this.camera = camera;
    this.element = element;
    this._yaw = options.yaw ?? Math.PI * 0.75;
    this._pitch = options.pitch ?? DEFAULT_PITCH;
    this.targetYaw = this._yaw;
    this.targetPitch = this._pitch;

    this.distance = options.distance ?? 9;
    this.targetDistance = this.distance;

    this.focus = new THREE.Vector3(0, 1.6, 0);
    this.desired = new THREE.Vector3(0, 1.6, 0);
    this.position = new THREE.Vector3();
    this.ahead = new THREE.Vector3();
    this.enabled = true;
    this.dragging = false;
    this.moved = false;

    this.pulledDistance = this.distance;
    this.blocked = false;
    this.coverage = 0;
    this.usedPitch = this._pitch;
    this.collide = options.collide ?? true;
    // A touch of speed: the lens opens as the car gets up to pace and settles again on foot. The
    // base is whatever the scene was built with, so a different starting FOV still works.
    this.baseFov = camera.fov;
    this._fov = this.baseFov;
    this.fovKick = 0;

    this._pointerId = null;
    this._lastX = 0;
    this._lastY = 0;
    this._offset = new THREE.Vector3();
    this._goal = new THREE.Vector3();
    this._ideal = new THREE.Vector3();
    this._ray = new THREE.Vector3();
    this._grid = new Uint8Array(GRID_W * GRID_H);
    this._aheadGoal = new THREE.Vector3();

    this.#bind();
    this.snap(this.focus);
  }

  get yaw() {
    return this._yaw;
  }

  /** External writes snap the aim; the pointer writes the target so the view eases. */
  set yaw(value) {
    this._yaw = value;
    this.targetYaw = value;
  }

  get pitch() {
    return this._pitch;
  }

  set pitch(value) {
    this._pitch = value;
    this.targetPitch = value;
  }

  #bind() {
    const el = this.element;
    if (!el) return;

    const down = (event) => {
      if (!this.enabled) return;
      if (event.button !== undefined && event.button !== 0 && event.pointerType === 'mouse') return;
      this.dragging = true;
      this.moved = false;
      this._pointerId = event.pointerId ?? null;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
      if (el.setPointerCapture && event.pointerId !== undefined) {
        try {
          el.setPointerCapture(event.pointerId);
        } catch {
          /* capture is a nicety, not a requirement */
        }
      }
      el.style.cursor = 'grabbing';
    };

    const move = (event) => {
      if (!this.dragging) return;
      const dx = event.clientX - this._lastX;
      const dy = event.clientY - this._lastY;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 1) this.moved = true;
      this.targetYaw -= dx * ORBIT_SPEED;
      this.targetPitch = THREE.MathUtils.clamp(this.targetPitch - dy * PITCH_SPEED, MIN_PITCH, MAX_PITCH);
    };

    const up = (event) => {
      if (!this.dragging) return;
      this.dragging = false;
      this._pointerId = null;
      el.style.cursor = 'grab';
      if (el.releasePointerCapture && event && event.pointerId !== undefined) {
        try {
          el.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
      }
    };

    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    el.addEventListener(
      'wheel',
      (event) => {
        if (!this.enabled) return;
        event.preventDefault();
        const step = Math.sign(event.deltaY) * Math.min(2.2, Math.abs(event.deltaY) * 0.006 + 0.5);
        this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + step, MIN_DISTANCE, MAX_DISTANCE);
      },
      { passive: false },
    );

    // Pinch to zoom on touch screens.
    let pinch = 0;
    el.addEventListener(
      'touchmove',
      (event) => {
        if (event.touches.length !== 2) return;
        const [a, b] = event.touches;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (pinch) {
          const delta = (pinch - d) * 0.02;
          this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + delta, MIN_DISTANCE, MAX_DISTANCE);
        }
        pinch = d;
        event.preventDefault();
      },
      { passive: false },
    );
    el.addEventListener('touchend', () => {
      pinch = 0;
    });
  }

  /** Jump straight to the ideal pose, used on the first frame and after a car is taken. */
  snap(focus, city = null) {
    this._yaw = this.targetYaw;
    this._pitch = this.targetPitch;
    this.distance = this.targetDistance;
    this.focus.copy(focus);
    this.ahead.set(0, 0, 0);
    const offset = this.#offsetFor(this.distance, this._pitch).clone();
    this.position.copy(focus).add(offset);
    if (city && this.collide) {
      const allowed = this.#allowedDistance(focus, this.position, this.distance, city);
      this.pulledDistance = allowed;
      if (allowed < this.distance) {
        this.position.copy(focus).addScaledVector(offset.normalize(), allowed);
      }
    }
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.focus);
  }

  /**
   * Pick the yaw with the most room behind the player. Used when the player enters the world or
   * steps out of a car: with a facade at their back the rig would otherwise open on a close-up
   * of the wall instead of the nine-metre third-person shot.
   */
  findClearYaw(city, focus, distance = this.targetDistance) {
    if (!city || !city.buildings) return this._yaw;
    const saved = this._yaw;
    const pitch = Math.max(this._pitch, DEFAULT_PITCH);
    let bestYaw = saved;
    let bestRoom = -1;
    for (let i = 0; i < 16; i++) {
      const yaw = saved + (i * Math.PI * 2) / 16;
      this._yaw = yaw;
      // One segment test per direction: how far back can we sit before a facade gets in the way.
      const room = this.#allowedDistance(focus, this.#goalAt(pitch, distance), distance, city);
      if (room > bestRoom) {
        bestRoom = room;
        bestYaw = yaw;
      }
      if (bestRoom >= distance - 0.05) break;
    }
    this._yaw = this.targetYaw = bestYaw;
    this._pitch = this.targetPitch = pitch;
    return bestYaw;
  }

  #offsetFor(distance, pitch = this._pitch) {
    const cp = Math.cos(pitch);
    this._offset.set(
      -Math.sin(this._yaw) * cp * distance,
      Math.sin(pitch) * distance + 0.35,
      -Math.cos(this._yaw) * cp * distance,
    );
    return this._offset;
  }

  /** How much of `distance` survives the ray from the focus to the ideal camera position. */
  #allowedDistance(focus, goal, distance, city) {
    const buildings = city && city.buildings;
    if (!buildings || !buildings.length) return distance;

    const dx = goal.x - focus.x;
    const dy = goal.y - focus.y;
    const dz = goal.z - focus.z;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-4) return distance;

    let hit = 1;
    for (const b of buildings) {
      if (b.top < Math.min(focus.y, goal.y) - 0.5) continue;
      const t = segmentBox(focus.x, focus.y, focus.z, dx, dy, dz, b, PROBE_RADIUS);
      if (t < hit) hit = t;
    }
    if (hit >= 1) return distance;

    return Math.max(EMERGENCY_DISTANCE, hit * distance - WALL_CLEARANCE);
  }

  /**
   * Fraction of the frame covered by building boxes, measured by casting one ray through the
   * centre of every cell of the frame grid and counting the ones that land on a wall. This is
   * exact: a block behind the camera simply is not hit, and a camera buried inside one hits on
   * the first cell, which is the answer we need either way.
   */
  #coverageFrom(pos, focus, city) {
    if (!city || !city.buildings || !city.buildings.length) return 0;
    const near = this.#nearby(city.buildings, focus);
    if (!near.length) return 0;
    const cam = this.camera;
    cam.position.copy(pos);
    cam.lookAt(focus);
    cam.updateMatrixWorld();

    const tanY = Math.tan((cam.fov * Math.PI) / 360);
    const tanX = tanY * cam.aspect;
    const quaternion = cam.quaternion;
    const dir = this._ray;
    const far = 60;
    let hits = 0;

    for (let r = 0; r < GRID_H; r++) {
      const ny = 1 - ((r + 0.5) / GRID_H) * 2;
      for (let c = 0; c < GRID_W; c++) {
        const nx = ((c + 0.5) / GRID_W) * 2 - 1;
        dir.set(nx * tanX, ny * tanY, -1).normalize().applyQuaternion(quaternion);
        if (this.#rayBlocked(pos, dir, far, near)) hits++;
      }
    }
    return hits / (GRID_W * GRID_H);
  }

  /** Buildings close enough to the shot to matter, so the ray pass does not scan the whole city. */
  #nearby(buildings, focus) {
    const near = this._near || (this._near = []);
    near.length = 0;
    for (const b of buildings) {
      if (b.top < 0.6) continue;
      const cx = (b.x0 + b.x1) * 0.5;
      const cz = (b.z0 + b.z1) * 0.5;
      if (Math.abs(cx - focus.x) > 90 || Math.abs(cz - focus.z) > 90) continue;
      near.push(b);
    }
    return near;
  }

  #rayBlocked(pos, dir, far, boxes) {
    const dx = dir.x * far;
    const dy = dir.y * far;
    const dz = dir.z * far;
    for (const b of boxes) {
      if (b.top < 0.6) continue;
      if (segmentBox(pos.x, pos.y, pos.z, dx, dy, dz, b, 0) < 1) return true;
    }
    return false;
  }

  /** Forward direction on the ground plane, matching the yaw used for movement. */
  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
  }

  /** Nudge the aim; used by the title fly-around and by the car chase camera. */
  rotate(dyaw, dpitch = 0) {
    this.targetYaw += dyaw;
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + dpitch, MIN_PITCH, MAX_PITCH);
  }

  update(dt, target, city = null, lookAhead = null, speed = 0) {
    const step = Math.min(dt, 0.1);
    const walls = this.collide ? city : null;

    // Speed widens the lens: 0 on foot, 1 at about forty metres per second. Eased on a slow
    // spring so a hard brake does not snap the frame, and the projection is only rebuilt when
    // the angle actually moved.
    const wantedKick = THREE.MathUtils.clamp(Math.abs(speed) / 40, 0, 1) * 9;
    this.fovKick += (wantedKick - this.fovKick) * (1 - Math.exp(-3.2 * step));
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(fov - this._fov) > 0.02) {
      this._fov = fov;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // Damped orbit: the view eases after the pointer instead of snapping with it.
    const orbitRate = this.dragging ? 22 : ORBIT_DAMPING;
    const orbitT = 1 - Math.exp(-orbitRate * step);
    let dYaw = this.targetYaw - this._yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    this._yaw += dYaw * orbitT;
    this._pitch += (this.targetPitch - this._pitch) * orbitT;

    // Look-ahead: the frame leans the way the player is going, capped and smoothed.
    this._aheadGoal.set(0, 0, 0);
    if (lookAhead) {
      this._aheadGoal.copy(lookAhead);
      const len = this._aheadGoal.length();
      if (len > LOOK_AHEAD_MAX) this._aheadGoal.multiplyScalar(LOOK_AHEAD_MAX / len);
    }
    this.ahead.lerp(this._aheadGoal, 1 - Math.exp(-LOOK_AHEAD_DAMPING * step));

    if (target) {
      this.desired.set(target.x + this.ahead.x, target.y + 0.25, target.z + this.ahead.z);
      const followT = 1 - Math.exp(-FOLLOW_DAMPING * step);
      this.focus.lerp(this.desired, followT);
    }

    const distT = 1 - Math.exp(-8 * step);
    this.distance += (this.targetDistance - this.distance) * distT;

    let pitch = this._pitch;
    let allowed = this.distance;
    if (walls) {
      allowed = this.#allowedDistance(this.focus, this.#goalAt(pitch, this.distance), this.distance, walls);
      if (allowed < this.distance * 0.6) {
        for (const lift of [0.22, 0.44]) {
          const candidate = Math.min(MAX_PITCH, this._pitch + lift);
          const clear = this.#allowedDistance(this.focus, this.#goalAt(candidate, this.distance), this.distance, walls);
          if (clear > allowed) {
            allowed = clear;
            pitch = candidate;
          }
          if (allowed >= this.distance * 0.75) break;
        }
      }
      allowed = Math.max(EMERGENCY_DISTANCE, allowed);
    }
    this.blocked = allowed < this.distance - 0.05;

    const rate = allowed < this.pulledDistance ? SNAP_IN : RECOVER;
    const pullT = 1 - Math.exp(-rate * step);
    this.pulledDistance += (allowed - this.pulledDistance) * pullT;
    this.pulledDistance = Math.min(this.pulledDistance, this.distance);

    const safeDistance = Math.max(EMERGENCY_DISTANCE, this.pulledDistance);

    // The quarter-frame rule: if the shot is still buried in a wall, step up and shorten until
    // it is not. Candidates are tried in order of least disruption to the player's framing.
    // A head-height shot down a street is not a buried one — the facades at the edge of the
    // frame are the point of it — so the rule stands down while the lens has room and the aim is
    // already at street level. It still reports what the low shot sees.
    let bestPitch = pitch;
    let bestDistance = safeDistance;
    let coverage = 0;
    if (walls && !this.blocked && pitch <= STREET_PITCH) {
      coverage = this.#coverageFrom(this.#goalAt(pitch, safeDistance), this.focus, city);
    } else if (walls) {
      const candidates = [
        [pitch, safeDistance],
        [Math.min(MAX_PITCH, pitch + 0.22), safeDistance * 0.92],
        [Math.min(MAX_PITCH, pitch + 0.42), safeDistance * 0.8],
        [Math.min(MAX_PITCH, pitch + 0.62), safeDistance * 0.68],
        [Math.min(MAX_PITCH, pitch + 0.5), 1.6],
        [Math.min(MAX_PITCH, pitch + 0.3), 1.1],
        [MAX_PITCH, safeDistance * 0.55],
      ];
      let best = null;
      for (const [candidatePitch, candidateDistance] of candidates) {
        const pos = this.focus.clone().add(this.#offsetFor(candidateDistance, candidatePitch));
        const frac = this.#coverageFrom(pos, this.focus, city);
        if (!best || frac < best.frac) best = { frac, pitch: candidatePitch, distance: candidateDistance };
        if (frac <= MAX_COVERAGE) break;
      }
      bestPitch = best.pitch;
      bestDistance = best.distance;
      coverage = best.frac;
    }
    this.coverage = coverage;
    this.usedPitch = bestPitch;

    const posT = 1 - Math.exp(-POSITION_DAMPING * step);
    // The pose is `focus + offset(distance, pitch)`, the same one snap() lands on: normalising a
    // one-metre offset would divide the fixed 0.35 m lift back into the distance and hoist the
    // lens by nearly three metres at eight metres out, which is what made a low shot impossible.
    this._goal.copy(this.focus).add(this.#offsetFor(bestDistance, bestPitch));
    this.position.lerp(this._goal, posT);
    if (this.position.y < 0.75) this.position.y = 0.75;

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.focus);
  }

  #goalAt(pitch, distance) {
    return this._ideal.copy(this.focus).add(this.#offsetFor(distance, pitch));
  }
}

export default OrbitCamera;