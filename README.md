# Harbour City

> Full guide: [docs/PLAYBOOK.md](docs/PLAYBOOK.md) (controls, missions, wanted system, architecture, debug API, verification).
A dusk city you can walk through, drive through and get chased through. Three.js, hand-built
procedural geometry, no assets to download: every facade, road, palm and lamp in `game/` is
generated from code at load time, and the whole thing is one HTML page plus nine ES modules.

The city is 170 procedural buildings plus a landmark tower, on a 9 x 9 block grid ringed by water
and a skyline, running under a low sun with shadows, windows that light up, lamp pools on the
asphalt and a bloom pass over the brightest pixels. Traffic drives itself, pedestrians wait at the
kerbs for the crossing light, and the police count your stars.

## Running it

`serve.ts` is a 60-line static server for the `game/` directory, standard library only, no
dependencies. Node runs the TypeScript directly by type stripping, so there is no build step.

```
node serve.ts            # game/ on http://localhost:8080
node serve.ts --port 3000
```

Then open <http://localhost:8080>. Node 22.18 or newer is required (type stripping is on by
default from that release); tested on Node 26.

It is a development server and says so: it serves `game/` on 127.0.0.1, sends the MIME types a
browser game needs, and refuses any path that resolves outside `game/`. For anything public, put a
real web server in front of the directory.

Three.js is vendored at `game/vendor/three.module.min.js`, so the page needs no CDN and works
offline.

### Syntax check

Every module is plain ESM with no transform step, so a parse check is the whole build:

```
for f in game/src/*.js; do node --check "$f"; done
```

## Controls

| Key | On foot | In a car |
| --- | --- | --- |
| `W` `A` `S` `D` | walk / run | throttle, steer, brake and reverse |
| `Shift` | sprint | — |
| `Space` | jump | handbrake |
| `F` | get into the nearest car | get out |
| `P` | pause / resume | pause / resume |
| Left click | fire a shot | fire a shot |
| Drag | orbit the camera | orbit the camera |
| Wheel | zoom (4 m to 18 m) | zoom |

`Enter` or `Space` on the title screen starts the game. `P` freezes the loop and puts a badge over
the last frame; the clock is reset on resume, so the pause does not arrive as one enormous step.

## Missions

Four jobs, taken one at a time from the amber beacon, with the objective line in the HUD.

| # | Job | Objective | Pays |
| --- | --- | --- | --- |
| 1 | Hot Wire | Lift any car with `F`, drive it to the harbour lock-up and stop inside the ring | $2,500 |
| 2 | Docks Run | Reach the harbour gate in 100 seconds, at three stars | $4,000 |
| 3 | Packages | Collect five drops across the district in 130 seconds | $3,500 |
| 4 | The Vault | Get the balance to $10,000, then walk into the tower | $6,000 |

The payout line is drawn from a short list that rotates per job, so a second run through the chain
does not read as a replay of the first.

## The street

- **Traffic.** Cars hold their lane, keep eight metres off the car in front and brake for it; tail
  lights come up when a car is slowing or holding at a standstill.
- **Pedestrians.** Thirty of them walk the corridors, stop at the kerb when the crossing light is
  against them, glance up and down the pavement, and turn to watch the player go past. From three
  stars up, the street clears and everyone runs.
- **Wanted level.** Shots and shunts add heat. From two stars the radio sends two to four cars that
  ram you; from three the crowd panics. Stay out of sight for twenty seconds and a star comes off;
  at zero the street is empty again.
- **Camera.** Damped third-person orbit with two separate wall guards, a lens that opens with
  speed, a small bank into corners, and a look-ahead that leans the frame the way you are moving.

## HUD

Money, health, wanted stars, speed, the current objective, the minimap (north-up, with red dots for
police units) and a compass chip above it: a needle, the cardinal letter and the bearing in degrees,
on the same north-up axis as the map.

## Debugging and automation

`window.game` exposes the live scene and a small scripted API — useful from the console and used by
the screenshot harness:

```js
game.stats()        // fps, draw calls, triangles, buildings, player, vehicles, police, missions…
game.start()        // leave the title screen
game.advance(2)     // run two seconds of simulation without waiting for frames
game.wanted(3)      // set the wanted level; the wave is on the street before this returns
game.mission(0)     // start HOT WIRE
game.enterCar()     // take the nearest car within 40 m
game.pause(); game.unpause()
game.player, game.city, game.vehicles, game.police, game.missions, game.peds
```

`game.stats()` reports `pixelRatio` and `pixelRatioCap` alongside the render counters, because the
render resolution is adaptive: the frame loop walks the pixel ratio between the display's own value
and two thirds of it, dropping a notch below 48 fps and taking one back above 58, at most once per
1.2 seconds so it settles instead of oscillating.

## Layout

```
game/index.html        title screen, HUD canvases, module entry
game/src/main.js       bootstrap, input, fixed-step loop, HUD wiring, window.game
game/src/city.js       blocks, roads, buildings, lamps, palms, waterfront, skyline, glow
game/src/player.js     capsule character, walk cycle, jump, collision, foot dust
game/src/camera.js     orbit rig, wall guards, speed FOV, corner bank
game/src/vehicles.js   parked fleet and traffic, player car physics, brake lights
game/src/police.js     wanted logic, spawned units, pursuit, siren lights
game/src/peds.js       crowd, kerb waiting, panic, head turns
game/src/missions.js   the four jobs, markers, pickups, payouts
game/src/hud.js        canvas HUD: money, stars, speed, minimap, compass, messages
game/vendor/           three.module.min.js, vendored so the page works offline
serve.ts               local static server for game/
main.ts                packaging entry: copies game/ into out/ and writes a dossier
screenshots/           cover, mission and wanted shots
```

## Notes on rendering

Walls are batched into six merged meshes by facade variant, rooftops into one, so the whole city
draws in a couple of dozen calls. Wall tints come from three district palettes — cool concrete and
glass to the west, warm limestone around the landmark, brick and ochre toward the docks — with a
small per-footprint shade taken from the footprint's position rather than from the PRNG, so the
layout stays deterministic run to run.

## Licence

MIT. See `LICENSE`.