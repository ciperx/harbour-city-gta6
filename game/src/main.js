// Harbour City: entry point.
//
// Sets up the renderer, the dusk lighting rig and the sky dome, builds the city, drops the
// player on a sidewalk, and runs a fixed 1/60 s simulation loop with an accumulator so physics
// does not depend on the frame rate. `window.game.start()` leaves the title camera and hands
// control to the player; `window.game.stats()` reports what the frame actually cost.

import * as THREE from '../vendor/three.module.min.js';
import { City, BOUNDS, ROAD_COORDS } from './city.js';
import { Player } from './player.js';
import { OrbitCamera } from './camera.js';
import { HUD } from './hud.js';
import { Vehicles } from './vehicles.js';
import { Police } from './police.js';
import { Missions } from './missions.js';
import { Peds } from './peds.js';

const FIXED_STEP = 1 / 60;
const MAX_STEPS = 5; // never simulate more than five frames in one rAF burst
// Low sun, raking almost straight down the north-south avenues: that is what puts a lit
// corridor down the road and throws long cross-street shadows, instead of shading every street
// behind the next building row.
const SUN_DIR = new THREE.Vector3(0.3, 0.42, 0.86).normalize();

// The sun's shadow frustum is fitted to the radius the player can actually see across, and its
// map is 2048 square: at 140 m that is ~0.14 m per texel, which is enough for a crisp kerb
// shadow without shimmering once the centre is snapped to the texel grid.
const SHADOW_RADIUS = 140;
const SHADOW_MAP = 2048;
const SHADOW_TEXEL = (SHADOW_RADIUS * 2) / SHADOW_MAP;
const SUN_DISTANCE = 300;

// Sky stops: a violet zenith over an orange horizon, so the city sits inside dusk instead of
// inside a black box. The fog colour is sampled from these, so the far city dissolves into
// exactly the band of sky it sits against instead of into an unrelated grey.
const SKY_TOP = new THREE.Color(0x2a2350);
const SKY_MID = new THREE.Color(0x6b4d7d);
const SKY_HORIZON = new THREE.Color(0xf59a5c);
const SKY_HAZE = new THREE.Color(0x8a5f72);
const DUSK_FOG = SKY_HORIZON.clone().lerp(SKY_MID, 0.58).lerp(SKY_HAZE, 0.22);
const FOG_DENSITY = 0.0026;

const MOON_DIR = new THREE.Vector3(-0.52, 0.46, -0.72).normalize();

const canvas = document.getElementById('scene');
const hudCanvas = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const playButton = document.getElementById('play');
const statusEl = document.getElementById('status');

const state = {
  started: false,
  running: true,
  paused: false,
  time: 0,
  frames: 0,
  fps: 60,
};

// --- renderer --------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  stencil: false,
});

// Resolution is a budget, not a constant: the ratio walks between the display's own value and a
// floor two thirds of it, trading pixels for frame rate when the frame loop starts to sag and
// taking them back when there is headroom. A city with 2048 px shadows is exactly the case where
// an invisible notch of resolution beats a visible stutter, and the ratio is capped at 2 so a
// 4K laptop panel never shades sixteen million pixels for the same picture.
let pixelRatioCap = Math.min(2, window.devicePixelRatio || 1);
let pixelRatioFloor = pixelRatioCap * 0.65;
let pixelRatio = pixelRatioCap;
const PIXEL_RATIO_HOLD = 1.2; // seconds between notches: settling, not oscillating
let ratioHold = PIXEL_RATIO_HOLD;

/**
 * Move the render resolution one notch. Called by the frame loop and by resize, so the size the
 * canvas backs itself with and the size the CSS stretches it to stay in step.
 */
function setPixelRatio(value) {
  const next = THREE.MathUtils.clamp(value, pixelRatioFloor, pixelRatioCap);
  if (Math.abs(next - pixelRatio) < 0.01) return;
  pixelRatio = next;
  renderer.setPixelRatio(pixelRatio);
}

renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.6;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(DUSK_FOG.getHex(), FOG_DENSITY);

// --- environment -----------------------------------------------------------------------

// A 256x128 equirect painted from the same sky stops, pushed through PMREM. Without something
// for them to reflect, metalness turns a surface black: this is what lets the wet asphalt carry
// a streak of sunset and the glass facades pick up the horizon instead of reading as paint.
function buildEnvironment(source) {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#2a2350');
  sky.addColorStop(0.4, '#6b4d7d');
  sky.addColorStop(0.5, '#e08a5c');
  sky.addColorStop(0.58, '#7a5568');
  sky.addColorStop(0.78, '#33283a');
  sky.addColorStop(1, '#161219');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Sun hotspot on the sun's own azimuth, so the reflection lands on the correct side of the road.
  const u = ((Math.atan2(SUN_DIR.x, SUN_DIR.z) / (Math.PI * 2) + 0.5) % 1) * w;
  for (const offset of [-w, 0, w]) {
    const cx = u + offset;
    const glow = ctx.createRadialGradient(cx, h * 0.5, 0, cx, h * 0.5, w * 0.24);
    glow.addColorStop(0, 'rgba(255,196,132,0.95)');
    glow.addColorStop(0.4, 'rgba(255,158,96,0.34)');
    glow.addColorStop(1, 'rgba(255,140,90,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - w * 0.24, h * 0.26, w * 0.48, h * 0.46);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(source);
  const target = pmrem.fromEquirectangular(texture);
  texture.dispose();
  pmrem.dispose();
  return target.texture;
}

scene.environment = buildEnvironment(renderer);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.12, 2600);
camera.position.set(60, 40, 90);

// --- sky dome --------------------------------------------------------------------------

const skyUniforms = {
  topColor: { value: SKY_TOP.clone() },
  midColor: { value: SKY_MID.clone() },
  horizonColor: { value: SKY_HORIZON.clone() },
  hazeColor: { value: SKY_HAZE.clone() },
  fogColor: { value: DUSK_FOG.clone() },
  sunColor: { value: new THREE.Color(0xffd7a0) },
  sunDir: { value: SUN_DIR.clone() },
};

const skyMaterial = new THREE.ShaderMaterial({
  uniforms: skyUniforms,
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 topColor;
    uniform vec3 midColor;
    uniform vec3 horizonColor;
    uniform vec3 hazeColor;
    uniform vec3 fogColor;
    uniform vec3 sunColor;
    uniform vec3 sunDir;
    varying vec3 vDir;

    void main() {
      vec3 d = normalize(vDir);
      float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);

      // The warm band is deliberately tall: at 15-30 degrees above the horizon the sky should
      // still be sunset, otherwise a street canyon only ever sees the cold top of the dome.
      vec3 col = mix(horizonColor, midColor, smoothstep(0.5, 0.78, h));
      col = mix(col, topColor, smoothstep(0.74, 1.0, h));

      float sun = max(dot(d, normalize(sunDir)), 0.0);
      col += sunColor * pow(sun, 6.0) * 0.42;
      col += sunColor * pow(sun, 90.0) * 0.9;
      col += sunColor * pow(sun, 900.0) * 4.0;

      // warm haze hugging the horizon, so distant blocks dissolve into the sunset
      float haze = exp(-abs(d.y) * 6.0);
      col = mix(col, hazeColor, haze * 0.30);

      // the very bottom of the dome fades to the fog colour so the ground edge is invisible
      col = mix(col, fogColor, smoothstep(0.18, -0.15, d.y));

      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});

const skyDome = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 20), skyMaterial);
skyDome.frustumCulled = false;
skyDome.renderOrder = -1000;
skyDome.name = 'sky';
scene.add(skyDome);

// --- moon ------------------------------------------------------------------------------

const moonGlowCanvas = document.createElement('canvas');
moonGlowCanvas.width = 256;
moonGlowCanvas.height = 256;
{
  const ctx = moonGlowCanvas.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.12, 'rgba(226,236,255,0.42)');
  g.addColorStop(0.4, 'rgba(176,200,255,0.10)');
  g.addColorStop(1, 'rgba(150,180,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
}
const moonGlowTexture = new THREE.CanvasTexture(moonGlowCanvas);
moonGlowTexture.colorSpace = THREE.SRGBColorSpace;

const moon = new THREE.Group();
moon.name = 'moon';
const moonDisc = new THREE.Mesh(
  new THREE.SphereGeometry(17, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0xfff4de, fog: false, depthWrite: false }),
);
const moonHalo = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: moonGlowTexture,
    color: 0xbcd2ff,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  }),
);
moonHalo.scale.set(260, 260, 1);
moon.add(moonDisc, moonHalo);
moon.renderOrder = -900;
moon.frustumCulled = false;
scene.add(moon);

// --- lights ----------------------------------------------------------------------------

// Dusk: a low warm sun doing the real work, a cool sky dome for fill, a warm bounce from the
// horizon that keeps the shaded faces from going blue-black, and almost no flat ambient.
const hemi = new THREE.HemisphereLight(0xaecdf5, 0x5a4560, 2.9);
hemi.position.set(0, 120, 0);
scene.add(hemi);

const ambient = new THREE.AmbientLight(0x5a5580, 1.05);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffbe86, 4.6);
sun.castShadow = true;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = SUN_DISTANCE + SHADOW_RADIUS * 2 + 120;
sun.shadow.camera.left = -SHADOW_RADIUS;
sun.shadow.camera.right = SHADOW_RADIUS;
sun.shadow.camera.top = SHADOW_RADIUS;
sun.shadow.camera.bottom = -SHADOW_RADIUS;
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.00035;
sun.shadow.normalBias = 0.045;
sun.shadow.radius = 2;
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);

// Basis for snapping the shadow frustum to its own texel grid, so edges do not crawl.
const SUN_RIGHT = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
const SUN_UP = new THREE.Vector3().crossVectors(SUN_DIR, SUN_RIGHT).normalize();
const sunAnchor = new THREE.Vector3();

/** Park the shadow frustum on the player, quantised to whole shadow texels. */
function updateSun(focus) {
  const a = Math.round(focus.dot(SUN_RIGHT) / SHADOW_TEXEL) * SHADOW_TEXEL;
  const b = Math.round(focus.dot(SUN_UP) / SHADOW_TEXEL) * SHADOW_TEXEL;
  const c = focus.dot(SUN_DIR);
  sunAnchor
    .copy(SUN_RIGHT)
    .multiplyScalar(a)
    .addScaledVector(SUN_UP, b)
    .addScaledVector(SUN_DIR, c);
  sun.target.position.copy(sunAnchor);
  sun.position.copy(sunAnchor).addScaledVector(SUN_DIR, SUN_DISTANCE);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
}

// Cool counter-light from behind the camera so the shaded faces are not black.
const fill = new THREE.DirectionalLight(0x8fa8dc, 1.9);
fill.position.set(-140, 110, -120);
scene.add(fill);

// Warm fill from the opposite azimuth: this is what stops the shadow side reading as navy ink.
const warmFill = new THREE.DirectionalLight(0xffa870, 1.15);
warmFill.position.set(150, 62, 140);
warmFill.target.position.set(0, 0, 0);
scene.add(warmFill);
scene.add(warmFill.target);

// A dim bounce off the asphalt, which is what sells the dusk palette.
const bounce = new THREE.DirectionalLight(0xff8a52, 0.42);
bounce.position.set(30, -60, 130);
scene.add(bounce);

// --- spawn and opening shot --------------------------------------------------------------

// Play opens on the avenue, not on a random sidewalk: the player stands on the asphalt beside
// the driver's door of a parked car, facing the way it is parked, and the lens sits eight metres
// back at head height so the street and the lit facades behind them fill the first frame.
const SPAWN_CAR_ACROSS = 1.55; // metres from the parked car's centre line, towards the road
const SPAWN_CAR_ALONG = 1.0; // metres from the parked car's centre line, down the road
const START_DISTANCE = 8; // camera metres behind the player
const START_PITCH = 0.02; // just above the horizon: about 2.2 m of lens height at 8 m

/** Nearest point on the road lattice: the roads are the lines x = ROAD_COORDS[i], z = ROAD_COORDS[j]. */
function nearestRoadPoint(x, z) {
  let rx = ROAD_COORDS[0];
  let rz = ROAD_COORDS[0];
  for (const c of ROAD_COORDS) {
    if (Math.abs(c - x) < Math.abs(rx - x)) rx = c;
    if (Math.abs(c - z) < Math.abs(rz - z)) rz = c;
  }
  // Stay inside the apron at the ends of the grid rather than teleporting onto the pavement.
  const alongZ = THREE.MathUtils.clamp(z, -BOUNDS + 8, BOUNDS - 8);
  const alongX = THREE.MathUtils.clamp(x, -BOUNDS + 8, BOUNDS - 8);
  if (Math.abs(rz - z) < Math.abs(rx - x)) return new THREE.Vector3(alongX, 0, rz);
  return new THREE.Vector3(rx, 0, alongZ);
}

/**
 * Pick the parked car with the longest run of avenue in front of it and stand the player at its
 * door, facing the way it is parked. Falls back to a sidewalk spawn if the fleet has no cars.
 */
function spawnBesideParkedCar(city, vehicles) {
  let best = null;
  for (const car of vehicles.cars) {
    if (car.kind !== 'parked' || car.occupied) continue;
    // Mid-block only: parking on an intersection puts a crossing in the middle of the shot.
    if (ROAD_COORDS.some((c) => Math.abs(c - car.t) < 14)) continue;
    const run = car.dir > 0 ? BOUNDS - car.t : car.t + BOUNDS;
    if (!best || run > best.run) best = { car, run };
  }
  const car = best ? best.car : vehicles.cars.find((c) => c.kind === 'parked');

  if (!car) return { point: city.randomSpawnPoint(), yaw: 0 };

  // The car is parked dir * (ROAD_WIDTH / 2 - 1.25) out from the road's centre line, so stepping
  // back towards the centre line lands the player on the asphalt, ~0.4 m clear of the bodywork.
  const across = -car.dir * SPAWN_CAR_ACROSS;
  const along = car.dir * SPAWN_CAR_ALONG;
  const x = car.axis === 'z' ? car.mesh.position.x + across : car.t + along;
  const z = car.axis === 'z' ? car.t + along : car.mesh.position.z + across;
  const point = new THREE.Vector3(x, 0, z);
  point.y = city.groundAt(x, z);
  return { point, yaw: car.heading };
}

// --- world -----------------------------------------------------------------------------

const city = new City(1, renderer);
scene.add(city.group);

// Traffic is built before the player because the spawn is chosen from the parked cars.
const vehicles = new Vehicles(city, { parked: 28, driving: 24 });
scene.add(vehicles.group);

const spawn = spawnBesideParkedCar(city, vehicles);
const player = new Player(spawn.point, city);
player.yaw = spawn.yaw;
player.group.rotation.y = spawn.yaw;
scene.add(player.group);
// Foot dust lives in world space, not on the body: a puff hangs where the boot landed while the
// player carries on walking, so it gets its own layer next to the character.
scene.add(player.effects);

// Soft rim on the character: a small cool light that sits between the camera and the player,
// high enough to catch the shoulders and hair so the silhouette stays readable against a wall.
const rimLight = new THREE.PointLight(0xa8c8ff, 11, 7.5, 2);
rimLight.castShadow = false;
scene.add(rimLight);

const orbit = new OrbitCamera(camera, canvas, {
  yaw: Math.PI * 0.82,
  pitch: 0.3,
  distance: 68,
});

const hud = new HUD(hudCanvas);

// --- gameplay --------------------------------------------------------------------------

const police = new Police(city, vehicles);
scene.add(police.group);
// Vehicles must see police cruisers to collide with them during a pursuit.
vehicles.policeUnits = police.units;
police.onDamage = (amount) => {
  player.health = Math.max(0, player.health - amount);
};

const missions = new Missions(city, player, vehicles, police);
scene.add(missions.group);

const peds = new Peds(city, vehicles.trafficLights, 30);
scene.add(peds.group);

// Bumping another car with your own puts heat on you.
vehicles.onBump = () => {
  police.addHeat(0.35, 'Traffic collision');
};

// A wall hit at speed costs blood as well as paint; the fleet already smoked the nose.
vehicles.onImpact = (speed, what) => {
  if (what !== 'building' || speed <= 12) return;
  player.health = Math.max(0, player.health - (speed - 12) * 1.6);
  police.addHeat(0.12, 'Hit a wall');
};

// A rooftop drop on foot: the knees take anything over four metres, health anything over ten.
player.onLand = (impact) => {
  if (impact <= 10) return;
  player.health = Math.max(0, player.health - (impact - 10) * 3.2);
  police.addHeat(0.05, 'Fell off a roof');
};

// --- input -----------------------------------------------------------------------------

const keys = new Set();
let jumpQueued = false;

const isDown = (...codes) => codes.some((c) => keys.has(c));

function readInput() {
  const forward = (isDown('KeyW', 'ArrowUp') ? 1 : 0) - (isDown('KeyS', 'ArrowDown') ? 1 : 0);
  const strafe = (isDown('KeyD', 'ArrowRight') ? 1 : 0) - (isDown('KeyA', 'ArrowLeft') ? 1 : 0);
  const sprint = isDown('ShiftLeft', 'ShiftRight');
  const jump = jumpQueued;
  jumpQueued = false;
  return { forward, strafe, sprint, jump, handbrake: isDown('Space') };
}

/** Take the nearest car within `radius`: parked, or stopped in traffic. */
function enterNearestCar(radius) {
  const car = vehicles.nearest(player.position, radius);
  if (!car) return null;
  vehicles.enter(car);
  player.velocity.set(0, 0, 0);
  player.speed = 0;
  player.yaw = car.heading;
  player.group.visible = false;
  orbit.targetDistance = 9;
  orbit.yaw = car.heading;
  orbit.pitch = 0.34;
  orbit.snap(new THREE.Vector3(car.mesh.position.x, 1.4, car.mesh.position.z), city);
  return car;
}

function toggleCar() {
  if (!state.started) return;
  if (vehicles.driving) {
    const car = vehicles.driving;
    const heading = car.heading;
    // Out beside the door, facing away from the car: the exit point comes back from the fleet
    // as the first clear spot beside the sill (driver's door, then passenger, then the boot).
    vehicles.exit(player.position);
    player.yaw = heading + Math.PI / 2;
    player.group.rotation.y = player.yaw;
    player.velocity.set(0, 0, 0);
    player.speed = 0;
    player.group.visible = true;
    player.position.y = city.groundAt(player.position.x, player.position.z);
    orbit.targetDistance = 9;
    const eye = player.eyePosition(new THREE.Vector3());
    orbit.findClearYaw(city, eye);
    orbit.snap(eye, city);
    return;
  }
  enterNearestCar(4.0);
}

/**
 * P freezes the world without touching the title screen: the frame loop stops simulating and
 * drawing, and the HUD puts a badge over the last frame it drew. Resuming resets the clock so the
 * pause does not arrive as one enormous dt.
 */
function togglePause() {
  if (!state.started) return;
  state.paused = !state.paused;
  if (!state.paused) last = performance.now();
  hud.showPaused(state.paused);
  if (statusEl) statusEl.textContent = state.paused ? 'Paused. Press P to carry on.' : 'Back on the street.';
}

window.addEventListener('keydown', (event) => {
  if (event.repeat) {
    keys.add(event.code);
    return;
  }
  if (event.code === 'Space') event.preventDefault();
  keys.add(event.code);
  if (event.code === 'Space') jumpQueued = true;
  if (event.code === 'KeyF') toggleCar();
  if (event.code === 'KeyP') togglePause();
  if (!state.started && (event.code === 'Enter' || event.code === 'Space')) start();
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});

window.addEventListener('blur', () => keys.clear());

// --- shooting --------------------------------------------------------------------------

// A shot into the air is enough to put the block on edge; there is no target to hit, the point
// is the noise. One tracer and one muzzle flash, both reused.
const tracerGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const tracerMaterial = new THREE.LineBasicMaterial({
  color: 0xffd27a,
  transparent: true,
  opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const tracer = new THREE.Line(tracerGeometry, tracerMaterial);
tracer.frustumCulled = false;
scene.add(tracer);

const muzzle = new THREE.Sprite(
  new THREE.SpriteMaterial({
    color: 0xffd9a0,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
muzzle.scale.set(1.6, 1.6, 1);
scene.add(muzzle);

let tracerLife = 0;
const tracerFrom = new THREE.Vector3();
const tracerTo = new THREE.Vector3();

function fire() {
  if (!state.started) return;
  police.reportShot();
  const eye = player.eyePosition(new THREE.Vector3());
  const dir = new THREE.Vector3(Math.sin(orbit.yaw), 0.08, Math.cos(orbit.yaw)).normalize();
  tracerFrom.copy(eye);
  tracerTo.copy(eye).addScaledVector(dir, 45);
  tracerGeometry.setFromPoints([tracerFrom, tracerTo]);
  tracerMaterial.opacity = 0.9;
  muzzle.position.copy(eye).addScaledVector(dir, 0.6);
  muzzle.material.opacity = 0.85;
  tracerLife = 0.09;
}

canvas.addEventListener('pointerdown', (event) => {
  if (!state.started || event.button !== 0) return;
  // A drag orbits the camera; a click fires. Fire on the press while the view is not in use.
  if (!orbit.dragging) fire();
});

canvas.addEventListener('click', () => {
  if (!state.started) return;
  canvas.focus?.();
});

// --- simulation ------------------------------------------------------------------------

const focusPoint = new THREE.Vector3();
const lookAhead = new THREE.Vector3();
const cameraFocus = new THREE.Vector3();
const rimOffset = new THREE.Vector3();

function step(dt) {
  state.time += dt;

  const onFoot = !vehicles.driving;
  const input = state.started
    ? readInput()
    : { forward: 0, strafe: 0, sprint: false, jump: false, handbrake: false };

  if (!onFoot) {
    const car = vehicles.driving;
    vehicles.update(dt, car.mesh.position, input);
    player.position.copy(car.mesh.position);
    player.position.y = 0;
    player.velocity.set(0, 0, 0);
    player.speed = 0;
    player.group.visible = false;
  } else {
    player.group.visible = true;
    player.update(dt, input, orbit.yaw, city);
    vehicles.update(dt, player.position, null);
  }

  police.update(dt, { playerPosition: player.position, car: vehicles.driving });
  missions.update(dt, { player, vehicles, police, car: vehicles.driving });
  // The street reads the stars: from three up, everyone within earshot runs from the player.
  peds.update(dt, { playerPosition: player.position, wanted: police.stars });

  // Camera target: the car when driving, the eyes when walking.
  if (vehicles.driving) {
    const car = vehicles.driving;
    cameraFocus.set(car.mesh.position.x, 1.45, car.mesh.position.z);
    orbit.targetYaw = car.heading;
    orbit.pitch += (0.34 - orbit.pitch) * Math.min(1, dt * 2.4);
    lookAhead.set(Math.sin(car.heading) * 5.5, 0, Math.cos(car.heading) * 5.5);
  } else {
    player.eyePosition(cameraFocus);
    lookAhead.set(player.velocity.x * 0.5, 0, player.velocity.z * 0.5);
  }

  // The collider only guards the gameplay camera; the title shot flies past the rooftops.
  orbit.collide = state.started;

  if (!state.started) {
    orbit.rotate(dt * 0.055, Math.sin(state.time * 0.22) * 0.05);
    orbit.targetDistance = 74;
    focusPoint.set(0, 26, 0);
    lookAhead.set(0, 0, 0);
  } else {
    focusPoint.copy(cameraFocus);
  }

  // The lens opens with speed: the car's speed behind the wheel, a sprint on foot.
  const camSpeed = vehicles.driving ? Math.abs(vehicles.speed) : player.speed;
  orbit.update(dt, focusPoint, city, lookAhead, camSpeed);

  // When the rig has to come in to shoulder distance the character would fill the frame;
  // hide them instead of filming the back of their head.
  if (!vehicles.driving) player.group.visible = orbit.pulledDistance > 1.15;

  // Rim light: between the camera and the player, a little above the shoulders.
  rimOffset.copy(camera.position).sub(player.position);
  rimOffset.y = 0;
  if (rimOffset.lengthSq() > 0.01) rimOffset.normalize();
  rimLight.position.set(
    player.position.x + rimOffset.x * 1.7,
    player.position.y + 2.15,
    player.position.z + rimOffset.z * 1.7,
  );
  rimLight.visible = !vehicles.driving;

  // Tracer fade.
  if (tracerLife > 0) {
    tracerLife = Math.max(0, tracerLife - dt);
    tracerMaterial.opacity = (tracerLife / 0.09) * 0.9;
    muzzle.material.opacity = (tracerLife / 0.09) * 0.85;
  } else {
    tracerMaterial.opacity = 0;
    muzzle.material.opacity = 0;
  }

  // Traffic, the recycled lamp lights, the bloom cloud and the sky/moon/shadow rig all follow
  // the viewer.
  city.update(dt, player.position);
  skyDome.position.copy(camera.position);
  moon.position.copy(camera.position).addScaledVector(MOON_DIR, 1250);
  updateSun(player.position);

  // Death: wake up on a different corner with a clean record.
  if (player.health <= 0) {
    if (vehicles.driving) {
      vehicles.exit(player.position);
      player.group.visible = true;
    }
    player.health = 100;
    player.money = Math.max(0, player.money - 500);
    police.clear();
    const respawn = city.randomSpawnPoint();
    player.position.copy(respawn);
    player.velocity.set(0, 0, 0);
    const eye = player.eyePosition(new THREE.Vector3());
    orbit.findClearYaw(city, eye);
    orbit.snap(eye, city);
    if (statusEl) statusEl.textContent = 'Patched up at the corner. The record is clean.';
  }
}

// --- frame loop ------------------------------------------------------------------------

let last = performance.now();
let accumulator = 0;
let fpsAccum = 0;
let fpsFrames = 0;
let promptCar = null;

/** Everything the HUD draws, read off the live world once per frame. */
function refreshHud(dt) {
  hud.update(dt, {
    health: player.health,
    money: player.money,
    speed: vehicles.driving ? vehicles.speed : player.speed,
    inCar: Boolean(vehicles.driving),
    yaw: vehicles.driving ? vehicles.driving.heading : player.yaw,
    x: player.position.x,
    z: player.position.z,
    wanted: police.stars,
    wantedHeat: police.heat,
    objective: missions.objective,
    message: missions.messageFor > 0 ? missions.message : '',
    prompt: vehicles.driving ? 'F to get out' : promptCar ? 'F to take this car' : '',
    marker: missions.marker.visible ? { x: missions.marker.position.x, z: missions.marker.position.z } : null,
    police: police.units.map((u) => ({ x: u.mesh.position.x, z: u.mesh.position.z })),
  });
}

/**
 * FPS-adaptive resolution: the frame rate that stats() already reports is spent here. Below 48 fps
 * take a notch off the pixel ratio, above 58 give one back, at most once per hold window so the
 * loop cannot hunt between two neighbouring ratios.
 */
function adaptPixelRatio(dt) {
  ratioHold -= dt;
  if (ratioHold > 0) return;
  const step = pixelRatioCap * 0.12;
  if (state.fps < 48 && pixelRatio > pixelRatioFloor + 0.01) {
    setPixelRatio(pixelRatio - step);
    ratioHold = PIXEL_RATIO_HOLD;
  } else if (state.fps > 58 && pixelRatio < pixelRatioCap - 0.01) {
    setPixelRatio(pixelRatio + step);
    ratioHold = PIXEL_RATIO_HOLD * 1.5;
  }
}

function frame(now) {
  requestAnimationFrame(frame);

  const elapsed = Math.max(0, (now - last) / 1000);
  last = now;
  if (state.paused) return;
  const dt = Math.min(0.1, elapsed);

  if (state.running) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < MAX_STEPS) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0; // drop the backlog rather than spiral
  }

  promptCar = state.started && !vehicles.driving ? vehicles.nearest(player.position, 4.0) : null;

  refreshHud(dt);

  renderer.render(scene, camera);

  state.frames++;
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    state.fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }
  adaptPixelRatio(dt);
}

// --- resize ----------------------------------------------------------------------------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Moving to a display with a different ratio rescales the whole budget rather than snapping the
  // canvas back to full resolution: the adaptive ratio has to stay inside the new bounds.
  const cap = Math.min(2, window.devicePixelRatio || 1);
  if (Math.abs(cap - pixelRatioCap) > 0.01) {
    pixelRatioCap = cap;
    pixelRatioFloor = cap * 0.65;
    pixelRatio = Math.min(pixelRatio, cap);
    ratioHold = PIXEL_RATIO_HOLD;
  }
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  hud.resize(w, h);
}

window.addEventListener('resize', resize);
resize();

// --- start -----------------------------------------------------------------------------

function start() {
  if (state.started) return;
  state.started = true;
  orbit.collide = true;
  overlay.classList.add('hidden');
  playButton.blur();
  // Low third-person down the avenue: eight metres back, lens just above head height, the street
  // running away from the frame and the parked car beside the player. The spawn already faces
  // the way the car is parked, so the rig starts behind them looking down the road it points at
  // instead of across the sunset from up high.
  orbit.targetDistance = START_DISTANCE;
  orbit.pitch = START_PITCH;
  orbit.yaw = player.yaw;
  const eye = player.eyePosition(new THREE.Vector3());
  orbit.snap(eye, city);
  if (statusEl) statusEl.textContent = 'Harbour City. Take a car with F, and watch the stars.';
  canvas.focus?.();
}

playButton.addEventListener('click', start);

// The title camera starts far out; pull it in smoothly on load.
orbit.snap(new THREE.Vector3(0, 26, 0), city);

requestAnimationFrame(frame);

// --- public surface --------------------------------------------------------------------

window.game = {
  start,
  fire,
  toggleCar,
  /** Move the player onto the nearest point of the road lattice, clear of the kerb. */
  teleport(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    if (!state.started) start();
    if (vehicles.driving) {
      vehicles.exit(player.position);
      player.group.visible = true;
    }
    const point = nearestRoadPoint(x, z);
    player.position.set(point.x, city.groundAt(point.x, point.z), point.z);
    player.velocity.set(0, 0, 0);
    player.speed = 0;
    // Land in the same low pose Play opens with, so a jump is always a usable screenshot rather
    // than a shot from wherever the last car chase left the rig.
    orbit.targetDistance = START_DISTANCE;
    orbit.pitch = START_PITCH;
    orbit.snap(player.eyePosition(new THREE.Vector3()), city);
    return { x: Number(player.position.x.toFixed(2)), z: Number(player.position.z.toFixed(2)) };
  },
  /** Take the nearest parked or stopped car within forty metres, whatever the walk-up range. */
  enterCar() {
    if (!state.started) start();
    return enterNearestCar(40);
  },
  /** Set the wanted level outright: the wave answering it is on the street before this returns. */
  wanted(n) {
    const level = THREE.MathUtils.clamp(Math.round(Number(n) || 0), 0, 5);
    if (!state.started) start();
    // Not queued for the next tick: 2-4 cars are placed inside the sixty-metre ring right here,
    // and wanted(0) clears the street on the spot.
    police.setWanted(level, player.position);
    return police.stars;
  },
  /** Start mission i (0 is HOT WIRE). Out-of-range indices are ignored. */
  mission(i) {
    const index = Math.round(Number(i));
    if (!Number.isInteger(index)) return null;
    if (!state.started) start();
    missions.start(index);
    return missions.index === index ? missions.stats() : null;
  },
  stop() {
    state.running = false;
  },
  resume() {
    state.running = true;
    last = performance.now();
  },
  /** Freeze the loop and draw one frame: used for screenshots and for poking at the world. */
  pause() {
    state.paused = true;
    hud.showPaused(true);
  },
  unpause() {
    state.paused = false;
    last = performance.now();
    hud.showPaused(false);
  },
  renderOnce() {
    renderer.render(scene, camera);
    return renderer.info.render.calls;
  },
  /**
   * Run the sim forward by hand: fixed steps, no waiting on a frame. A hidden tab never gets
   * requestAnimationFrame, and a deterministic clock is also what a screenshot run wants.
   */
  advance(seconds = 1) {
    if (!state.started) start();
    const count = Math.max(1, Math.min(3600, Math.round((Number(seconds) || 0) / FIXED_STEP)));
    for (let i = 0; i < count; i++) step(FIXED_STEP);
    promptCar = state.started && !vehicles.driving ? vehicles.nearest(player.position, 4.0) : null;
    refreshHud(FIXED_STEP);
    renderer.render(scene, camera);
    return count;
  },
  stats() {
    const info = renderer.info;
    return {
      fps: Math.round(state.fps),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      buildings: city.stats().buildings,
      blocks: city.stats().blocks,
      lamps: city.stats().lamps,
      palms: city.stats().palms,
      cars: city.stats().cars,
      glowPoints: city.stats().glowPoints,
      lampLights: city.stats().lampLights,
      exposure: renderer.toneMappingExposure,
      pixelRatio: Number(pixelRatio.toFixed(2)),
      pixelRatioCap: Number(pixelRatioCap.toFixed(2)),
      bloomPoints: city.bloom ? city.bloom.geometry.getAttribute('position').count : 0,
      cameraDistance: Number(orbit.distance.toFixed(2)),
      cameraPulled: Number(orbit.pulledDistance.toFixed(2)),
      cameraBlocked: orbit.blocked,
      cameraCoverage: Number(orbit.coverage.toFixed(3)),
      shadowMap: sun.shadow.mapSize.x,
      shadowRadius: SHADOW_RADIUS,
      fogDensity: scene.fog.density,
      fogColor: `#${scene.fog.color.getHexString()}`,
      player: {
        x: Number(player.position.x.toFixed(2)),
        y: Number(player.position.y.toFixed(2)),
        z: Number(player.position.z.toFixed(2)),
        speed: Number(player.speed.toFixed(2)),
        grounded: player.grounded,
        health: Math.round(player.health),
        money: Math.round(player.money),
      },
      vehicles: vehicles.stats(),
      police: police.stats(),
      wanted: police.stars,
      missions: missions.stats(),
      peds: peds.stats(),
      started: state.started,
      bounds: BOUNDS,
    };
  },
  get scene() {
    return scene;
  },
  get player() {
    return player;
  },
  get orbit() {
    return orbit;
  },
  get sun() {
    return sun;
  },
  get city() {
    return city;
  },
  get camera() {
    return camera;
  },
  get renderer() {
    return renderer;
  },
  get vehicles() {
    return vehicles;
  },
  get police() {
    return police;
  },
  get missions() {
    return missions;
  },
  get peds() {
    return peds;
  },
};

window.addEventListener('beforeunload', () => {
  state.running = false;
});

if (statusEl) statusEl.textContent = 'Harbour City loaded. Press Play to begin.';