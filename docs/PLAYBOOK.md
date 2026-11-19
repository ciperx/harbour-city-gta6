# Harbour City Playbook

This is the operational reference for the Harbour City Three.js sandbox: controls, missions, wanted system, architecture, debug surface, and verification workflow.

## Quick start

From the repo root:

```bash
python3 -m http.server 8765 --directory .
# then open http://localhost:8765/game/
```

The game is plain ES modules served over HTTP. `game/` is the runtime app, `out/` is a static mirror/copy target, and `game/vendor/three.module.min.js` is the only bundled dependency.

---

## Controls

### On foot
| Input | Action |
|---|---|
| **W / A / S / D** (or Arrow keys) | Move (camera-relative) |
| **Shift** | Sprint |
| **Space** | Jump |
| **Mouse drag** | Orbit camera |
| **Mouse wheel** | Zoom (4–18 m) |
| **F** | Enter the nearest vehicle when close enough |
| **E** | Fire a shot into the air (raises wanted heat) |
| **P** | Continue after a mission-complete screen |
| **Play button / UI start** | Start gameplay from title state |

### In a vehicle
| Input | Action |
|---|---|
| **W / ↑** | Accelerate |
| **S / ↓** | Brake / reverse |
| **A / D** (or ← / →) | Steer |
| **Space** | Handbrake |
| **F** | Exit vehicle |
| **Mouse drag / wheel** | Orbit / zoom chase camera |

The HUD shows an enter prompt when a drivable car is within range, and switches speed/vitals context when driving.

---

## Missions

Four missions run in order (one active at a time). Completing a mission pays out, shows a completion screen, and arms the next one when you press **P** to continue.

### 1. HOT WIRE — $1,500
- **Objective:** Steal any parked car and deliver it to the drop zone.
- **How it plays:** Find a parked vehicle, press **F** to take it, drive to the marked drop. Leaving the car at the wrong place does not complete it.
- **Trigger/flow:** Starts armed at boot; completes when the stolen car reaches the delivery condition.

### 2. DOCKS RUN — $3,000
- **Objective:** Reach the harbour gate at the far end with three wanted stars on you.
- **How it plays:** You must be carrying at least three wanted stars when you reach the harbour gate objective. Build heat first (fire **E**, bump/ram traffic or police, sustain pursuit pressure), then make the run while surviving the chase.
- **Trigger/flow:** Armed after HOT WIRE completion; completion checks both destination and wanted level.

### 3. GETAWAY — $4,500
- **Objective:** Break line of sight and stay clean until the heat dies.
- **How it plays:** Escape pursuit by putting distance/buildings between you and the cruisers. Heat only cools after a sustained line-of-sight break.
- **Trigger/flow:** Armed after DOCKS RUN completion.

### 4. THE VAULT — $7,500
- **Objective:** Get to the tower with the cash.
- **How it plays:** A final delivery/run objective to the tower marker.
- **Trigger/flow:** Armed after GETAWAY completion; final payout in the chain.

> Exact objective text and live target markers are driven by `game/src/missions.js` and surfaced in the HUD. If behaviour differs, trust the in-game objective line.

---

## Wanted system

Implemented in `game/src/police.js`.

- **Heat scale:** `0.0` to `5.0` (displayed as 0–5 stars). Two stars or more bring active units.
- **Heat sources:**
  - Firing a shot (`E`) adds heat (`reportShot()` / `addHeat`).
  - Traffic collisions / bumps can add heat via gameplay hooks (e.g. bump callback in `main.js`).
  - Rams/contact during pursuit escalate pressure (handled in pursuit logic).
- **Cooling:** Heat decays only after the player has broken line of sight for a sustained period (design target: ~20 seconds clean). Simply driving fast is not enough if cruisers retain sight.
- **Unit spawning:** Pursuit waves are capped (`callWave` respects live-unit caps and spawns in controlled batches near valid road points). Star level influences target wave size/speed pressure.
- **Pursuit behaviour:** Units steer on the road grid toward the player/target point, accelerate with star level, and attempt rams when close.
- **Reset/despawn:** When wanted pressure is lost/cleared, units are retired and their resources are disposed.

---

## Architecture

### Runtime modules (`game/src/`)
- **`main.js`** — entry point and orchestration: renderer/scene/camera/lights setup, world construction, fixed-step simulation loop, input wiring, HUD refresh, start/title flow, and `window.game` debug API.
- **`city.js`** — procedural Harbour City generation: road grid, sidewalks, crosswalks, buildings/facades, lamps/palms/props, colliders/bounds, and city-side data used by traffic/peds/missions.
- **`player.js`** — on-foot character controller: movement, sprint/jump/gravity, walk cycle/animation state, capsule-vs-building collision resolution, and player transform state.
- **`vehicles.js`** — traffic and drivable vehicle system: parked/driving cars, car meshes/lights, traffic-light integration, player enter/exit, vehicle driving physics/steering, smoke/effects, and collision responses (including building/vehicle interactions).
- **`police.js`** — wanted state machine and police units: heat/stars, spawn/wave management, pursuit steering/speed, LOS/cooldown logic, siren visuals/state, and cleanup/disposal.
- **`peds.js`** — pedestrian simulation: sidewalk corridor walkers, crossing/wait behaviour, simple flee/threat reactions, and lightweight per-ped updates.
- **`missions.js`** — mission definitions/state/progression: objective text, triggers/completion checks, payouts, and sequencing across the four-story chain.
- **`camera.js`** — third-person orbit/chase camera: pointer orbit, zoom limits, damped follow/look-ahead, and mode-aware framing for foot/vehicle.
- **`hud.js`** — 2D canvas HUD overlay: vitals/status, wanted stars, objective/clock/balance, speed readout, minimap/markers, prompts and mission-complete messaging.

### Other important paths
- **`game/index.html`** — app shell/canvas/overlay entry for the playable build.
- **`game/vendor/three.module.min.js`** — vendored Three.js module (no network dependency at runtime).
- **`out/`** — built/static mirror of runtime files for packaging/publish flows in this repo (keep in sync with `game/` as needed).
- **`screenshots/`** — captured images referenced by README/docs.

### Simulation model
- Fixed-timestep stepping (`1/60 s`) driven from `main.js` with frame-time clamping/accumulation so physics/gameplay stay stable across variable render rates.

---

## Debug API

`main.js` exposes a browser-console API on `window.game` (exact methods as implemented):

- **`window.game.start()`** — begin gameplay (leave title/idle flow and hand control to the player).
- **`window.game.fire()`** — fire a shot into the air (same heat effect as pressing **E**).
- **`window.game.toggleCar()`** — enter the nearest car if on foot, or exit if driving.
- **`window.game.teleport(x, z)`** — move the player to the nearest road-lattice point near `(x, z)`, clear of kerbs/buildings (snaps to a safe road position).
- **`window.game.snapToRoad()`** — snap the player onto the nearest road point from current position.
- **`window.game.setWanted(level)`** — set wanted stars/heat level directly (clamped to valid range) for testing pursuit states.
- **`window.game.step(seconds = 1/60)`** — advance the simulation by a given amount of time in fixed steps and render; useful for deterministic/manual ticking in DevTools.
- **`window.game.stats()`** — return a structured snapshot of runtime state and counters (time, fps/frame timing, player position/money/health-driving context, vehicles, police/wanted, missions, peds, etc.).

> This is the live debug surface; if you need a new helper, add it in `game/src/main.js` rather than assuming it exists.

---

## Known issues / limitations

- **Procedural simplicity:** pedestrians and traffic use lightweight corridor/lane logic (not full navmesh/pathfinding), so edge-case pathing can look simplistic.
- **Collision model is pragmatic:** vehicle/building/police interactions are game-feel approximations, not a rigid-body physics simulation; extreme speeds/overlaps may still produce odd resolves.
- **Wanted/LOS tuning:** heat gain/cooldown and spawn pressure are balance-tuned heuristics and may feel abrupt depending on situation.
- **Performance varies by GPU/browser:** fixed-step sim helps stability, but draw load/post-like effects and pixel ratio can affect frame time on low-end devices.
- **Mirror drift risk:** `out/` can diverge from `game/` if edits are not copied/built consistently.
- **No automated test suite in-repo:** verification relies on manual/browser runs and debug hooks.

---

## Verification workflow

1. **Static/syntax sanity (fast):**
   - `node --check game/src/*.js` (or check changed modules individually) to catch syntax errors.
   - Optional: `git diff --stat` and skim diffs for accidental edits in `out/`/vendor files.

2. **Run locally:**
   - Start server: `python3 -m http.server 8765 --directory .`
   - Open: `http://localhost:8765/game/`
   - Confirm load: no console errors, city renders, player can move.

3. **Core smoke checks:**
   - **Movement/camera:** walk, sprint, jump, orbit/zoom.
   - **Vehicles:** approach parked car, **F** to enter, drive/steer/handbrake, **F** to exit.
   - **Wanted loop:** press **E** or cause bump to gain heat; verify stars/HUD update and police spawn/chase at >=2 stars; break LOS and confirm cooldown/despawn behaviour.
   - **Missions:** verify objective text/marker updates and at least one mission can be progressed/completed (or use `window.game.completeMission()` to validate flow/UI).

4. **Debug-assisted checks (DevTools console):**
   - `window.game.start()` to force-start.
   - `window.game.stats()` before/after stress moments (chase, lots of entities) to inspect runtime state/cost.
   - `window.game.teleport(x, z)` / `window.game.snapToRoad()` to reposition quickly.
   - `window.game.setWanted(n)` to exercise police/wanted states without manual setup.
   - `window.game.toggleCar()` and `window.game.step(seconds)` for controlled interaction/simulation checks.

5. **Before commit/push:**
   - Re-test the changed behaviour path(s) in-browser.
   - Ensure screenshots/docs updated if user-facing flow changed.
   - Keep changes scoped; verify no generated/vendor churn unless intended.

---

## File map (quick)

- `game/index.html` — playable entry point
- `game/src/main.js` — bootstrap, loop, input, debug API
- `game/src/city.js` — world generation/colliders
- `game/src/player.js` — on-foot controller
- `game/src/vehicles.js` — traffic + drivable cars
- `game/src/police.js` — wanted/chase system
- `game/src/peds.js` — pedestrians
- `game/src/missions.js` — mission logic/content
- `game/src/camera.js` — camera controls
- `game/src/hud.js` — HUD rendering
- `docs/PLAYBOOK.md` — this document
