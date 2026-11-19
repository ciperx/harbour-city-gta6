// The player: a low-poly humanoid with a walk cycle, gravity, jump, sprint, and capsule-vs-box
// collision against the city's building footprints.
//
// Movement is camera-relative: the caller passes the camera yaw so W always walks away from the
// viewer. Collision is resolved in two passes, horizontal push-out on XZ after moving, then a
// vertical pass that lands the player on the pavement, the kerb or a rooftop.

import * as THREE from '../vendor/three.module.min.js';

export const EYE = 1.66; // eye height above the player's feet
export const RADIUS = 0.38; // capsule radius for collision
export const HEIGHT = 1.78; // total standing height of the capsule

const DUST_POOL = 16; // pooled footfall puffs, reused in a ring

const GRAVITY = 22;
const JUMP_SPEED = 6.6;
const WALK_SPEED = 4.4;
const SPRINT_SPEED = 8.6;
const ACCEL_GROUND = 14;
const ACCEL_AIR = 4.5;
const TURN_RATE = 12;

export class Player {
  constructor(spawn, city = null) {
    this.group = new THREE.Group();
    this.group.name = 'player';

    this.position = spawn ? spawn.clone() : new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.speed = 0;
    this.grounded = true;
    this.health = 100;
    this.money = 4820;
    this.animPhase = 0;
    this.city = city;
    // Landing feedback: the fastest fall since the feet left the ground, and how deep the knees
    // are still bent from the last touchdown.
    this.fallSpeed = 0;
    this.landDip = 0;
    this.onLand = null; // (impactSpeed) => void, wired by main to health

    // Footfall dust: a world-space layer, so a puff stays where the boot struck instead of riding
    // along with the character. main adds this to the scene next to the player group.
    this.effects = new THREE.Group();
    this.effects.name = 'player-effects';
    this.dust = [];
    this.dustCursor = 0;
    this.stepMark = 0; // which half-stride the last puff belonged to

    this.#build();

    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;
  }

  #build() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0b492, roughness: 0.72 });
    const jacket = new THREE.MeshStandardMaterial({ color: 0x4a7396, roughness: 0.62, metalness: 0.08 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0x33485e, roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x333b4a, roughness: 0.88 });
    const shoe = new THREE.MeshStandardMaterial({ color: 0x1d222b, roughness: 0.6 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x24272f, roughness: 0.9 });
    const pack = new THREE.MeshStandardMaterial({ color: 0x6b5748, roughness: 0.85 });

    const box = (w, h, d, mat, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };

    // torso: chest and hips
    this.group.add(box(0.58, 0.4, 0.32, jacket, 0, 1.28, 0)); // chest
    this.group.add(box(0.46, 0.16, 0.28, pants, 0, 1.0, 0)); // waist
    this.group.add(box(0.2, 0.12, 0.3, shirt, 0, 1.5, 0.01)); // collar

    // head with a hair cap
    this.head = new THREE.Group();
    this.head.position.set(0, 1.56, 0);
    this.head.add(box(0.3, 0.3, 0.3, skin, 0, 0.15, 0));
    const hairCap = box(0.34, 0.14, 0.34, hair, 0, 0.29, -0.01);
    this.head.add(hairCap);
    this.head.add(box(0.32, 0.06, 0.12, hair, 0, 0.19, -0.16)); // back of the head
    this.group.add(this.head);

    // backpack
    this.group.add(box(0.34, 0.38, 0.16, pack, 0, 1.3, -0.23));

    // arms: pivot at the shoulder so the whole limb swings
    const arm = (side) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.36, 1.44, 0);
      const upper = box(0.15, 0.42, 0.16, jacket, 0, -0.21, 0);
      const fore = box(0.13, 0.34, 0.14, jacket, 0, -0.56, 0.01);
      const hand = box(0.13, 0.12, 0.14, skin, 0, -0.78, 0.01);
      pivot.add(upper, fore, hand);
      this.group.add(pivot);
      return pivot;
    };
    this.armL = arm(-1);
    this.armR = arm(1);

    // legs: pivot at the hip
    const leg = (side) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.15, 0.92, 0);
      const thigh = box(0.19, 0.44, 0.2, pants, 0, -0.22, 0);
      const shin = box(0.17, 0.4, 0.18, pants, 0, -0.63, 0.01);
      const foot = box(0.18, 0.1, 0.3, shoe, 0, -0.86, 0.06);
      pivot.add(thigh, shin, foot);
      this.group.add(pivot);
      return pivot;
    };
    this.legL = leg(-1);
    this.legR = leg(1);

    // A soft contact disc: geometry alone cannot darken the pavement the way a real shadow does
    // at this sun angle, and it keeps the character readable when the sun is behind them.
    const blobCanvas = document.createElement('canvas');
    blobCanvas.width = 128;
    blobCanvas.height = 128;
    const bctx = blobCanvas.getContext('2d');
    const bgrad = bctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    bgrad.addColorStop(0, 'rgba(0,0,0,0.92)');
    bgrad.addColorStop(0.4, 'rgba(0,0,0,0.55)');
    bgrad.addColorStop(0.75, 'rgba(0,0,0,0.16)');
    bgrad.addColorStop(1, 'rgba(0,0,0,0)');
    bctx.fillStyle = bgrad;
    bctx.fillRect(0, 0, 128, 128);

    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(blobCanvas),
        color: 0x000000,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    blob.renderOrder = 5;
    this.blob = blob;
    this.group.add(blob);

    this.#buildDust();
  }

  /**
   * The dust pool: sixteen sprites sharing one soft square-grit texture. Pooled rather than
   * allocated per step, because a sprint puts a boot down eight times a second and a garbage
   * collection in the middle of a chase is exactly the frame you notice.
   */
  #buildDust() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.34)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.09)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);

    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;

    for (let i = 0; i < DUST_POOL; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map,
          color: 0xcfc6b6,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      sprite.visible = false;
      sprite.renderOrder = 4;
      this.effects.add(sprite);
      this.dust.push({ sprite, life: 0, maxLife: 1, vx: 0, vz: 0, rise: 0.4, size: 0.3, alpha: 0.3 });
    }
  }

  /** One boot strike's worth of grit at a world point, lifted into the pooled sprites. */
  #puff(x, y, z, count, strength) {
    for (let i = 0; i < count; i++) {
      const puff = this.dust[this.dustCursor % this.dust.length];
      this.dustCursor++;
      puff.sprite.position.set(x + (Math.random() - 0.5) * 0.22, y + Math.random() * 0.08, z + (Math.random() - 0.5) * 0.22);
      puff.sprite.visible = true;
      puff.maxLife = 0.45 + Math.random() * 0.35;
      puff.life = puff.maxLife;
      puff.size = 0.22 + Math.random() * 0.16;
      puff.rise = 0.3 + Math.random() * 0.35;
      puff.alpha = 0.34 * strength;
      puff.vx = (Math.random() - 0.5) * 0.5;
      puff.vz = (Math.random() - 0.5) * 0.5;
      puff.sprite.scale.setScalar(puff.size);
      puff.sprite.material.opacity = puff.alpha;
    }
  }

  #updateDust(dt) {
    for (const puff of this.dust) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      if (puff.life <= 0) {
        puff.sprite.visible = false;
        puff.sprite.material.opacity = 0;
        continue;
      }
      const age = 1 - puff.life / puff.maxLife;
      puff.sprite.position.y += puff.rise * dt;
      puff.sprite.position.x += puff.vx * dt;
      puff.sprite.position.z += puff.vz * dt;
      const drag = Math.exp(-2.6 * dt);
      puff.vx *= drag;
      puff.vz *= drag;
      puff.sprite.scale.setScalar(puff.size * (1 + 1.8 * age));
      puff.sprite.material.opacity = puff.alpha * (1 - age) * (1 - age);
    }
  }

  /** Where the camera should look: just below the eyes. */
  eyePosition(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + EYE, this.position.z);
  }

  update(dt, input, cameraYaw, city = this.city) {
    const forward = input.forward || 0;
    const strafe = input.strafe || 0;
    const sprinting = Boolean(input.sprint) && (forward !== 0 || strafe !== 0);
    const wasGrounded = this.grounded;

    // Camera-relative desired direction.
    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);
    let dirX = strafe * cos + forward * sin;
    let dirZ = strafe * -sin + forward * cos;
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-4) {
      dirX /= len;
      dirZ /= len;
    }

    const targetSpeed = len > 1e-4 ? (sprinting ? SPRINT_SPEED : WALK_SPEED) : 0;
    const accel = this.grounded ? ACCEL_GROUND : ACCEL_AIR;
    const blend = 1 - Math.exp(-accel * dt);

    this.velocity.x += (dirX * targetSpeed - this.velocity.x) * blend;
    this.velocity.z += (dirZ * targetSpeed - this.velocity.z) * blend;
    if (Math.abs(this.velocity.x) < 0.01) this.velocity.x = 0;
    if (Math.abs(this.velocity.z) < 0.01) this.velocity.z = 0;

    // Face the way we are going, not the way the camera looks.
    if (targetSpeed > 0.01) {
      const want = Math.atan2(dirX, dirZ);
      let delta = want - this.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.yaw += delta * Math.min(1, TURN_RATE * dt);
    }

    // Jump before the vertical integration so the first frame already leaves the ground.
    if (input.jump && this.grounded) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }

    // Horizontal move, then resolve against footprints.
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    if (city) this.#resolveHorizontal(city);

    // Vertical move: remember where we were so a rooftop only catches us from above.
    const prevY = this.position.y;
    this.velocity.y -= GRAVITY * dt;
    this.position.y += this.velocity.y * dt;

    let groundY = city && city.groundAt ? city.groundAt(this.position.x, this.position.z) : 0;
    if (city) {
      const r = RADIUS * 0.7;
      for (const b of city.buildings) {
        if (b.top <= groundY) continue;
        if (this.position.x < b.x0 - r || this.position.x > b.x1 + r) continue;
        if (this.position.z < b.z0 - r || this.position.z > b.z1 + r) continue;
        // Only a roof we were above a moment ago can hold us.
        if (prevY >= b.top - 0.06 && this.position.y <= b.top) groundY = b.top;
      }
    }

    if (this.position.y <= groundY) {
      const wasFalling = this.velocity.y <= 0;
      this.position.y = groundY;
      if (wasFalling) this.velocity.y = 0;
      this.grounded = true;
    } else if (this.position.y - groundY > 0.05) {
      this.grounded = false;
    }

    // Touchdown: a rooftop drop bends the knees and, past about four metres, costs health. The
    // fall is measured at its fastest, not at the final frame, so a landing on a kerb still counts.
    if (!this.grounded) {
      this.fallSpeed = Math.min(this.fallSpeed, this.velocity.y);
    } else if (!wasGrounded) {
      const impact = Math.max(0, -this.fallSpeed);
      this.fallSpeed = 0;
      if (impact > 4) {
        this.landDip = Math.min(0.36, impact * 0.022);
        // A rooftop or a jump landing kicks up a ring of grit, sized by the fall.
        this.#puff(
          this.position.x,
          groundY + 0.05,
          this.position.z,
          Math.min(7, 3 + Math.round(impact / 3)),
          Math.min(1.2, impact / 10),
        );
        if (this.onLand) this.onLand(impact);
      }
    }

    // Keep the player on the map: no swimming.
    const limit = 232;
    this.position.x = THREE.MathUtils.clamp(this.position.x, -limit, limit);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -limit, 226);

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;
    this.#animate(dt); // adds the walk bob on top of the settled position

    // Contact disc: sits on whatever is under the feet, fading and spreading with jump height
    // so it reads as ambient occlusion rather than a painted circle.
    const air = Math.max(0, this.position.y - groundY);
    this.blob.position.y = groundY - this.position.y + 0.02;
    this.blob.material.opacity = 0.62 * THREE.MathUtils.clamp(1 - air / 3.2, 0.1, 1);
    this.blob.scale.setScalar(1 + Math.min(1.2, air * 0.24));

    // Footfall dust: the walk cycle crosses a multiple of PI twice per stride, one for each boot.
    // Emitted at the foot rather than at the hips, so it reads as contact with the pavement.
    const mark = Math.floor(this.animPhase / Math.PI);
    if (this.grounded && this.speed > 0.9) {
      if (mark !== this.stepMark) {
        this.stepMark = mark;
        const side = mark % 2 === 0 ? -1 : 1; // left foot, then right
        const bx = this.position.x + Math.cos(this.yaw) * side * 0.16;
        const bz = this.position.z - Math.sin(this.yaw) * side * 0.16;
        this.#puff(bx, groundY + 0.04, bz, this.speed > 6.5 ? 3 : 2, THREE.MathUtils.clamp(this.speed / 8.6, 0.3, 1));
      }
    } else {
      // Standing still must not fire a puff as the phase drifts past the next mark.
      this.stepMark = mark;
    }

    this.#updateDust(dt);
  }

  /** Push the capsule out of any building box it overlaps, along the shallower axis. */
  #resolveHorizontal(city) {
    const feet = this.position.y;
    for (const b of city.buildings) {
      if (feet >= b.top - 0.06) continue; // standing on this roof
      // Anything whose top is below mid-shin is a step, not a wall: groundAt lifts the feet over
      // it, so it must not also shove the body sideways.
      if (b.top <= feet + 0.35) continue;
      const x0 = b.x0 - RADIUS;
      const x1 = b.x1 + RADIUS;
      const z0 = b.z0 - RADIUS;
      const z1 = b.z1 + RADIUS;
      if (this.position.x <= x0 || this.position.x >= x1) continue;
      if (this.position.z <= z0 || this.position.z >= z1) continue;

      const pushRight = x1 - this.position.x;
      const pushLeft = this.position.x - x0;
      const pushFar = z1 - this.position.z;
      const pushNear = this.position.z - z0;
      const minX = Math.min(pushRight, pushLeft);
      const minZ = Math.min(pushFar, pushNear);

      if (minX < minZ) {
        this.position.x = pushRight < pushLeft ? x1 : x0;
        this.velocity.x = 0;
      } else {
        this.position.z = pushFar < pushNear ? z1 : z0;
        this.velocity.z = 0;
      }
    }
  }

  /** Limb swing, head bob and run lean. */
  #animate(dt) {
    const moving = this.speed > 0.2;
    const rate = this.speed > 6.5 ? 13 : 9.5;
    if (moving) this.animPhase += dt * rate * (0.6 + this.speed / SPRINT_SPEED);
    else this.animPhase += dt * 1.6;

    const blend = 1 - Math.exp(-11 * dt);
    const amp = moving ? Math.min(0.85, 0.24 + this.speed * 0.1) : 0.05;
    const swing = Math.sin(this.animPhase) * amp;
    const swing2 = Math.sin(this.animPhase + Math.PI) * amp;

    // In the air the legs tuck instead of cycling; a fresh landing folds both knees.
    const air = this.grounded ? 0 : 1;
    this.landDip *= Math.exp(-7 * dt);
    const crouch = this.grounded ? this.landDip * 1.6 : 0;
    const targetLegL = (this.grounded ? swing : -0.55) + crouch;
    const targetLegR = (this.grounded ? swing2 : 0.35) + crouch;
    const targetArmL = this.grounded ? swing2 * 0.9 : -0.9;
    const targetArmR = this.grounded ? swing * 0.9 : -0.9;

    this.legL.rotation.x += (targetLegL - this.legL.rotation.x) * blend;
    this.legR.rotation.x += (targetLegR - this.legR.rotation.x) * blend;
    this.armL.rotation.x += (targetArmL - this.armL.rotation.x) * blend;
    this.armR.rotation.x += (targetArmR - this.armR.rotation.x) * blend;
    this.armL.rotation.z = 0.06 + air * 0.12;
    this.armR.rotation.z = -0.06 - air * 0.12;

    // Bob and a slight lean into the run; a fresh landing pulls the whole body down for a beat
    // and lets it spring back, so a drop off a roof reads in the body as well as the health bar.
    const bob = moving ? Math.abs(Math.sin(this.animPhase)) * 0.045 : 0;
    this.group.position.y = this.position.y + bob - this.landDip;
    this.head.rotation.x = this.grounded ? -0.02 - this.speed * 0.008 : 0.06;
    this.group.rotation.z = -(this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw)) * 0.006;
  }
}

export default Player;