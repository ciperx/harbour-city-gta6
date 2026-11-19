// Harbour City: entry point.
//
// Sets up the renderer, the dusk lighting rig and the sky dome, builds the city, drops the
// player on a sidewalk, and runs a fixed 1/60 s simulation loop with an accumulator so physics
// does not depend on the frame rate. `window.game.start()` leaves the title camera and hands
// control to the player; `window.game.stats()` reports what the frame actually cost.

import * as THREE from '../vendor/three.module.min.js';
import { City, BOUNDS } from './city.js';
import { Player } from './player.js';
import { OrbitCamera } from './camera.js';
import { HUD } from './hud.js';

const FIXED_STEP = 1 / 60;
const MAX_STEPS = 5; // never simulate more than five frames in one rAF burst
const SUN_DIR = new THREE.Vector3(0.44, 0.24, 0.86).normalize();

// The sun's shadow frustum is fitted to the radius the player can actually see across, and its
// map is 2048 square: at 140 m that is ~0.14 m per texel, which is enough for a crisp kerb
// shadow without shimmering once the centre is snapped to the texel grid.
const SHADOW_RADIUS = 140;
const SHADOW_MAP = 2048;
const SHADOW_TEXEL = (SHADOW_RADIUS * 2) / SHADOW_MAP;
const SUN_DISTANCE = 300;

// Sky stops. The fog colour is sampled from these, so the far city dissolves into exactly the
// band of sky it sits against instead of into an unrelated grey.
const SKY_TOP = new THREE.Color(0x0e1730);
const SKY_MID = new THREE.Color(0x3d4a72);
const SKY_HORIZON = new THREE.Color(0xe08a52);
const SKY_HAZE = new THREE.Color(0x6a5568);
const DUSK_FOG = SKY_HORIZON.clone().lerp(SKY_MID, 0.62).lerp(SKY_HAZE, 0.25);
const FOG_DENSITY = 0.0028;

const MOON_DIR = new THREE.Vector3(-0.52, 0.46, -0.72).normalize();

const canvas = document.getElementById('scene');
const hudCanvas = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const playButton = document.getElementById('play');
const statusEl = document.getElementById('status');

const state = {
  started: false,
  running: true,
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
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
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
  sky.addColorStop(0, '#0b1224');
  sky.addColorStop(0.44, '#2f3d5c');
  sky.addColorStop(0.52, '#b9744a');
  sky.addColorStop(0.6, '#5d4a4c');
  sky.addColorStop(0.78, '#26222c');
  sky.addColorStop(1, '#101014');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Sun hotspot on the sun's own azimuth, so the reflection lands on the correct side of the road.
  const u = ((Math.atan2(SUN_DIR.x, SUN_DIR.z) / (Math.PI * 2) + 0.5) % 1) * w;
  for (const offset of [-w, 0, w]) {
    const cx = u + offset;
    const glow = ctx.createRadialGradient(cx, h * 0.5, 0, cx, h * 0.5, w * 0.22);
    glow.addColorStop(0, 'rgba(255,186,120,0.95)');
    glow.addColorStop(0.4, 'rgba(255,150,90,0.34)');
    glow.addColorStop(1, 'rgba(255,140,90,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - w * 0.22, h * 0.28, w * 0.44, h * 0.44);
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

      vec3 col = mix(horizonColor, midColor, smoothstep(0.46, 0.62, h));
      col = mix(col, topColor, smoothstep(0.58, 0.98, h));

      float sun = max(dot(d, normalize(sunDir)), 0.0);
      col += sunColor * pow(sun, 6.0) * 0.30;
      col += sunColor * pow(sun, 90.0) * 0.85;
      col += sunColor * pow(sun, 900.0) * 4.0;

      // warm haze hugging the horizon, so distant blocks dissolve into the sunset
      float haze = exp(-abs(d.y) * 11.0);
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

// A cold moon opposite the sunset: it is what stops the sky reading as a flat orange gradient,
// and it is the only bright object in the frame that never moves with the camera's yaw.
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

// Dusk: a low warm sun doing the real work, a cool sky dome for fill, and almost no flat
// ambient so the shadow side of every building stays readable but obviously unlit.
const hemi = new THREE.HemisphereLight(0xaecdf5, 0x4a4058, 2.45);
hemi.position.set(0, 120, 0);
scene.add(hemi);

const ambient = new THREE.AmbientLight(0x4a5c7e, 0.85);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffb377, 3.5);
sun.castShadow = true;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = SUN_DISTANCE + SHADOW_RADIUS * 2 + 120;
sun.shadow.camera.left = -SHADOW_RADIUS;
sun.shadow.camera.right = SHADOW_RADIUS;
sun.shadow.camera.top = SHADOW_RADIUS;
sun.shadow.camera.bottom = -SHADOW_RADIUS;
sun.shadow.camera.updateProjectionMatrix();
// Tuned against 0.14 m texels: peter-panning stays invisible while facades do not self-shadow.
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
const fill = new THREE.DirectionalLight(0x7a97cf, 1.75);
fill.position.set(-140, 110, -120);
scene.add(fill);

// A dim bounce off the asphalt, which is what sells the dusk palette.
const bounce = new THREE.DirectionalLight(0xff8a52, 0.32);
bounce.position.set(30, -60, 130);
scene.add(bounce);

// --- world -----------------------------------------------------------------------------

const city = new City(1, renderer);
scene.add(city.group);

const spawn = city.randomSpawnPoint();
const player = new Player(spawn, city);
scene.add(player.group);

const orbit = new OrbitCamera(camera, canvas, {
  yaw: Math.PI * 0.82,
  pitch: 0.3,
  distance: 68,
});

const hud = new HUD(hudCanvas);

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
  return { forward, strafe, sprint, jump };
}

window.addEventListener('keydown', (event) => {
  if (event.repeat) {
    keys.add(event.code);
    return;
  }
  if (event.code === 'Space') event.preventDefault();
  keys.add(event.code);
  if (event.code === 'Space') jumpQueued = true;
  if (!state.started && (event.code === 'Enter' || event.code === 'Space' || event.code === 'KeyP')) start();
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});

window.addEventListener('blur', () => keys.clear());

// Clicking the city after the game has started is a no-op for the camera (drag orbits it),
// but it keeps the page focused so the keyboard works straight after the overlay closes.
canvas.addEventListener('click', () => {
  if (!state.started) return;
  canvas.focus?.();
});

// --- simulation ------------------------------------------------------------------------

const focusPoint = new THREE.Vector3();

function step(dt) {
  state.time += dt;

  const input = state.started ? readInput() : { forward: 0, strafe: 0, sprint: false, jump: false };
  player.update(dt, input, orbit.yaw, city);

  // The collider only guards the gameplay camera; the title shot flies past the rooftops.
  orbit.collide = state.started;

  if (!state.started) {
    // Title shot: a slow orbit around the landmark tower.
    orbit.yaw += dt * 0.055;
    orbit.pitch = 0.42 + Math.sin(state.time * 0.22) * 0.05;
    orbit.targetDistance = 74;
    focusPoint.set(0, 26, 0);
  } else {
    player.eyePosition(focusPoint);
  }

  orbit.update(dt, focusPoint, city);

  // Traffic, the recycled lamp lights, and the sky/moon/shadow rig all follow the viewer.
  city.update(dt, player.position);
  skyDome.position.copy(camera.position);
  moon.position.copy(camera.position).addScaledVector(MOON_DIR, 1250);
  updateSun(player.position);
}

// --- frame loop ------------------------------------------------------------------------

let last = performance.now();
let accumulator = 0;
let fpsAccum = 0;
let fpsFrames = 0;

function frame(now) {
  requestAnimationFrame(frame);

  const elapsed = Math.max(0, (now - last) / 1000);
  last = now;
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

  hud.update(dt, {
    health: player.health,
    money: player.money,
    speed: player.speed,
    yaw: player.yaw,
    x: player.position.x,
    z: player.position.z,
  });

  renderer.render(scene, camera);

  state.frames++;
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    state.fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }
}

// --- resize ----------------------------------------------------------------------------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
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
  orbit.targetDistance = 9.5;
  orbit.pitch = 0.44; // higher than the title shot: over the shoulder, road in frame
  // Sit across the sunset rather than into it: rim light on the buildings, sun in frame edge.
  orbit.yaw = player.yaw + 1.15;
  orbit.snap(player.eyePosition(new THREE.Vector3()), city);
  if (statusEl) statusEl.textContent = 'Exploring Harbour City. Drag to look around.';
  canvas.focus?.();
}

playButton.addEventListener('click', start);

// The title camera starts far out; pull it in smoothly on load.
orbit.snap(new THREE.Vector3(0, 26, 0), city);

requestAnimationFrame(frame);

// --- public surface --------------------------------------------------------------------

window.game = {
  start,
  stop() {
    state.running = false;
  },
  resume() {
    state.running = true;
    last = performance.now();
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
      cameraDistance: Number(orbit.distance.toFixed(2)),
      cameraPulled: Number(orbit.pulledDistance.toFixed(2)),
      cameraBlocked: orbit.blocked,
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
      },
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
};

window.addEventListener('beforeunload', () => {
  state.running = false;
});

if (statusEl) statusEl.textContent = 'Harbour City loaded. Press Play to begin.';