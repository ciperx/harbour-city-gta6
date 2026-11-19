// Third-person orbit camera: drag to orbit, wheel to zoom (4 to 18 m), damped follow of the
// player's head, clamped pitch, and a pull-in that stops buildings from swallowing the frame.
//
// The camera sits *behind* the player along -forward, so the yaw it exposes is the same yaw the
// player uses for camera-relative movement. When the ideal position would be inside a building
// the rig walks a ray from the head to that position, stops in front of the first box it hits,
// and leans the pitch down a little: the shot comes over the player's shoulder instead of
// through a wall.

import * as THREE from '../vendor/three.module.min.js';

const MIN_DISTANCE = 4;
const MAX_DISTANCE = 18;
const MIN_PITCH = 0.02; // just above the horizon
const MAX_PITCH = 1.32; // nearly overhead
const DEFAULT_PITCH = 0.46; // slightly above the old 0.34: more road, less blank wall
const ORBIT_SPEED = 0.0055;
const PITCH_SPEED = 0.0045;
const FOLLOW_DAMPING = 9;
const POSITION_DAMPING = 11;

const PROBE_RADIUS = 0.42; // the camera's near-plane footprint, inflating every box it tests
const WALL_CLEARANCE = 0.5; // how far in front of a wall the camera is allowed to stop
const MIN_PULLED_DISTANCE = 2.4; // never closer than this to the player's head
const SNAP_IN = 26; // how fast the camera ducks in front of a wall
const RECOVER = 3.4; // how slowly it lets the distance back out again

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
      // Parallel to this slab: outside it means the whole segment misses.
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
    this.yaw = options.yaw ?? Math.PI * 0.75;
    this.pitch = options.pitch ?? DEFAULT_PITCH;
    this.distance = options.distance ?? 9;
    this.targetDistance = this.distance;

    this.focus = new THREE.Vector3(0, 1.6, 0); // smoothed look-at point
    this.desired = new THREE.Vector3(0, 1.6, 0);
    this.position = new THREE.Vector3();
    this.enabled = true;
    this.dragging = false;
    this.moved = false;

    this.pulledDistance = this.distance; // what the collider last allowed
    this.blocked = false;
    // The title fly-around looks past the rooftops on purpose, so it can opt out of the pull-in.
    this.collide = options.collide ?? true;

    this._pointerId = null;
    this._lastX = 0;
    this._lastY = 0;
    this._offset = new THREE.Vector3();
    this._goal = new THREE.Vector3();
    this._ideal = new THREE.Vector3();

    this.#bind();
    this.snap(this.focus);
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
      this.yaw -= dx * ORBIT_SPEED;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * PITCH_SPEED, MIN_PITCH, MAX_PITCH);
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

  /** Jump straight to the ideal pose, used on the first frame and on respawn. */
  snap(focus, city = null) {
    this.focus.copy(focus);
    const offset = this.#offsetFor(this.distance).clone();
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

  #offsetFor(distance, pitch = this.pitch) {
    const cp = Math.cos(pitch);
    // Behind the player: forward is (sin yaw, cos yaw), so the camera sits at -forward * d.
    this._offset.set(
      -Math.sin(this.yaw) * cp * distance,
      Math.sin(pitch) * distance + 0.35,
      -Math.cos(this.yaw) * cp * distance,
    );
    return this._offset;
  }

  /**
   * How much of `distance` survives the ray from the focus to the ideal camera position.
   * Every building box is inflated by the near-plane footprint, and the answer stops
   * WALL_CLEARANCE in front of the first hit.
   */
  #allowedDistance(focus, goal, distance, city) {
    const buildings = city && city.buildings;
    if (!buildings || !buildings.length) return distance;

    const dx = goal.x - focus.x;
    const dy = goal.y - focus.y;
    const dz = goal.z - focus.z;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-4) return distance;

    let hit = 1;
    for (const b of buildings) {
      if (b.top < Math.min(focus.y, goal.y) - 0.5) continue; // entirely below the ray
      const t = segmentBox(focus.x, focus.y, focus.z, dx, dy, dz, b, PROBE_RADIUS);
      if (t < hit) hit = t;
    }
    if (hit >= 1) return distance;

    return Math.max(MIN_PULLED_DISTANCE, hit * distance - WALL_CLEARANCE);
  }

  /** Forward direction on the ground plane, matching the yaw used for movement. */
  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  update(dt, target, city = null) {
    const walls = this.collide ? city : null;
    if (target) {
      this.desired.set(target.x, target.y + 0.25, target.z);
      const followT = 1 - Math.exp(-FOLLOW_DAMPING * Math.min(dt, 0.1));
      this.focus.lerp(this.desired, followT);
    }

    const step = Math.min(dt, 0.1);
    const distT = 1 - Math.exp(-8 * step);
    this.distance += (this.targetDistance - this.distance) * distT;

    // Pull in first; only lean up when a wall is eating most of the frame, and never by so much
    // that the shot turns overhead. Pulling in front of the wall is the primary fix, the lean is
    // the fallback, and the cap keeps the horizon in the frame.
    let pitch = this.pitch;
    let allowed = this.distance;
    if (walls) {
      allowed = this.#allowedDistance(this.focus, this.#goalAt(pitch, this.distance), this.distance, walls);
      if (allowed < this.distance * 0.6) {
        for (const lift of [0.22, 0.44]) {
          const candidate = Math.min(MAX_PITCH, this.pitch + lift);
          const clear = this.#allowedDistance(this.focus, this.#goalAt(candidate, this.distance), this.distance, walls);
          if (clear > allowed) {
            allowed = clear;
            pitch = candidate;
          }
          if (allowed >= this.distance * 0.75) break;
        }
      }
      allowed = Math.max(MIN_PULLED_DISTANCE, allowed);
    }
    this.blocked = allowed < this.distance - 0.05;

    // Damp the pull-in asymmetrically: snap in fast so a wall never films the player, ease
    // back out slowly so walking past a doorway does not make the camera lurch.
    const rate = allowed < this.pulledDistance ? SNAP_IN : RECOVER;
    const pullT = 1 - Math.exp(-rate * step);
    this.pulledDistance += (allowed - this.pulledDistance) * pullT;
    this.pulledDistance = Math.min(this.pulledDistance, this.distance);

    const posT = 1 - Math.exp(-POSITION_DAMPING * step);
    const safeDistance = Math.max(MIN_PULLED_DISTANCE, this.pulledDistance);
    const dir = this.#offsetFor(1, pitch).normalize();
    this._goal.copy(this.focus).addScaledVector(dir, safeDistance);
    this.position.lerp(this._goal, posT);

    // Never let the camera dip under the street or end up inside the collider's pull-in.
    if (this.position.y < 0.75) this.position.y = 0.75;

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.focus);
  }

  #goalAt(pitch, distance) {
    return this._ideal.copy(this.focus).add(this.#offsetFor(distance, pitch));
  }
}

export default OrbitCamera;