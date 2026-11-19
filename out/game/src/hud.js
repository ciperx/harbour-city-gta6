// The HUD: a 2D canvas laid over the 3D view. Vitals, the wanted stars, the mission objective and
// its clock, the balance, a speed readout that switches to km/h behind the wheel, a minimap with
// the job marker and the police on it, and the control hints.

import { BOUNDS, GRID, PITCH, ROAD_COORDS, ROAD_WIDTH, BLOCK } from './city.js';

const MAP_SIZE = 150; // css pixels
const MAP_MARGIN = 22;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const AMBER = '#ffb347';
const MINT = '#7ef0c4';
const INK = 'rgba(8, 12, 20, 0.72)';
const LINE = 'rgba(232, 238, 252, 0.16)';

function money(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function star(ctx, cx, cy, r, filled, glow = 'rgba(255, 179, 71, 0.9)', fill = '#ffd98a') {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.44;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = fill;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    ctx.strokeStyle = 'rgba(232, 238, 252, 0.22)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

export class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.state = {
      health: 100,
      money: 0,
      speed: 0,
      yaw: 0,
      x: 0,
      z: 0,
      wanted: 0,
      wantedHeat: 0,
      objective: '',
      message: '',
      inCar: false,
      prompt: '',
      marker: null,
      police: [],
      timeLeft: 0,
    };
    this.shownSpeed = 0;
    this.time = 0;
    this.resize(window.innerWidth, window.innerHeight);
  }

  resize(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  update(dt, state) {
    this.time += dt;
    Object.assign(this.state, state);
    const blend = 1 - Math.exp(-8 * Math.min(dt, 0.1));
    this.shownSpeed += (this.state.speed - this.shownSpeed) * blend;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);

    this.#drawVignette(ctx);
    this.#drawPursuit(ctx);
    this.#drawHealth(ctx);
    this.#drawMoney(ctx);
    this.#drawWanted(ctx);
    this.#drawObjective(ctx);
    this.#drawSpeed(ctx);
    this.#drawHints(ctx);
    this.#drawMinimap(ctx);
  }

  #roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  #drawVignette(ctx) {
    const g = ctx.createRadialGradient(
      this.width / 2,
      this.height * 0.55,
      Math.min(this.width, this.height) * 0.32,
      this.width / 2,
      this.height * 0.55,
      Math.max(this.width, this.height) * 0.78,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.34)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  #drawHealth(ctx) {
    const x = 24;
    const y = 24;
    const w = 186;
    const h = 9;
    const hp = Math.max(0, Math.min(100, this.state.health));

    ctx.save();
    ctx.fillStyle = 'rgba(232,238,252,0.55)';
    ctx.font = `600 10px ${MONO}`;
    ctx.fillText('VITALS', x, y - 8);

    this.#roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.fill();

    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, hp > 40 ? MINT : '#ff7a6b');
    grad.addColorStop(1, hp > 40 ? '#39c9a0' : '#ff3d2e');
    this.#roundRect(ctx, x, y, Math.max(h, (w * hp) / 100), h, h / 2);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(8,12,20,0.55)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const tx = x + (w * i) / 4;
      ctx.beginPath();
      ctx.moveTo(tx, y + 1);
      ctx.lineTo(tx, y + h - 1);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(232,238,252,0.86)';
    ctx.font = `700 12px ${MONO}`;
    ctx.fillText(`${Math.round(hp)}`, x + w + 10, y + 9);
    ctx.restore();
  }

  #drawMoney(ctx) {
    const right = this.width - 24;
    const y = 24;
    ctx.save();
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(232,238,252,0.5)';
    ctx.font = `600 10px ${MONO}`;
    ctx.fillText('BALANCE', right, y - 8);

    ctx.font = `700 26px ${MONO}`;
    ctx.fillStyle = AMBER;
    ctx.shadowColor = 'rgba(255,159,60,0.5)';
    ctx.shadowBlur = 16;
    ctx.fillText(money(this.state.money), right, y + 18);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /**
   * Five stars over the objective. Clean, they are five faint outlines nobody reads; wanted, they
   * grow, sit on a red panel that pulses with the heat, and carry the unit count underneath.
   */
  #drawWanted(ctx) {
    const stars = Math.max(0, Math.min(5, this.state.wanted || 0));
    const cx = this.width / 2;

    if (stars <= 0) {
      for (let i = 0; i < 5; i++) star(ctx, cx - 44 + i * 22, 30, 6.6, false);
      return;
    }

    const heat = Math.max(0, Math.min(5, this.state.wantedHeat || stars));
    const pulse = 0.65 + 0.35 * Math.sin(this.time * (4 + heat * 0.8));
    const w = 258;
    const h = 50;
    const px = cx - w / 2;
    const py = 12;

    ctx.save();
    this.#roundRect(ctx, px, py, w, h, 13);
    ctx.fillStyle = `rgba(34, 7, 11, ${0.52 + 0.2 * pulse})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 74, 60, ${0.34 + 0.42 * pulse})`;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = 'rgba(255, 52, 40, 0.8)';
    ctx.shadowBlur = 16 + 12 * pulse;
    this.#roundRect(ctx, px, py, w, h, 13);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.textAlign = 'left';
    ctx.font = `700 11px ${MONO}`;
    ctx.fillStyle = `rgba(255, 158, 140, ${0.78 + 0.22 * pulse})`;
    ctx.fillText('WANTED', px + 16, py + 21);

    const units = (this.state.police || []).length;
    ctx.font = `600 9px ${MONO}`;
    ctx.fillStyle = 'rgba(255, 214, 204, 0.52)';
    ctx.fillText(units ? `${units} UNIT${units === 1 ? '' : 'S'}` : 'NO UNITS', px + 16, py + 36);

    const starY = py + h / 2 + 2;
    const gap = 28;
    const startX = px + w - 24 - gap * 4;
    for (let i = 0; i < 5; i++) {
      const on = i < stars;
      star(
        ctx,
        startX + i * gap,
        starY,
        11 + (on ? 1.6 * pulse : 0),
        on,
        'rgba(255, 80, 60, 0.95)',
        '#ffe6a8',
      );
    }
    ctx.restore();
  }

  /** A red pulse round the frame once the chase is serious, so the state is felt, not just read. */
  #drawPursuit(ctx) {
    const stars = Math.max(0, Math.min(5, this.state.wanted || 0));
    if (stars < 3) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * (5 + stars));
    const strength = ((stars - 2) / 3) * (0.16 + 0.14 * pulse);
    const g = ctx.createRadialGradient(
      this.width / 2,
      this.height / 2,
      Math.min(this.width, this.height) * 0.3,
      this.width / 2,
      this.height / 2,
      Math.max(this.width, this.height) * 0.62,
    );
    g.addColorStop(0, 'rgba(255, 40, 30, 0)');
    g.addColorStop(1, `rgba(255, 36, 26, ${strength.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  #drawObjective(ctx) {
    const cx = this.width / 2;
    const objective = this.state.objective || '';
    const message = this.state.message || '';
    // The wanted panel owns the top of the screen while it is up, so the objective drops below it.
    let y = this.state.wanted > 0 ? 84 : 58;

    ctx.save();
    ctx.textAlign = 'center';
    if (objective) {
      ctx.font = `600 12px ${MONO}`;
      const w = Math.min(this.width - 120, ctx.measureText(objective).width + 26);
      this.#roundRect(ctx, cx - w / 2, y - 14, w, 22, 11);
      ctx.fillStyle = 'rgba(8, 12, 20, 0.58)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 179, 71, 0.28)';
      ctx.lineWidth = 1;
      this.#roundRect(ctx, cx - w / 2, y - 14, w, 22, 11);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 232, 198, 0.94)';
      ctx.fillText(objective, cx, y + 1);
      y += 28;
    }

    if (message) {
      ctx.font = `700 15px ${MONO}`;
      ctx.fillStyle = AMBER;
      ctx.shadowColor = 'rgba(255, 159, 60, 0.65)';
      ctx.shadowBlur = 16;
      ctx.fillText(message, cx, y + 4);
      ctx.shadowBlur = 0;
    }

    if (this.state.prompt) {
      ctx.font = `600 11px ${MONO}`;
      ctx.fillStyle = 'rgba(232, 238, 252, 0.55)';
      ctx.fillText(this.state.prompt, cx, this.height - 74);
    }
    ctx.restore();
  }

  #drawSpeed(ctx) {
    const x = 24;
    const y = this.height - 92;
    const speed = this.shownSpeed;
    const inCar = Boolean(this.state.inCar);
    const shown = inCar ? speed * 3.6 : speed;
    const unit = inCar ? 'KM/H' : 'M/S';
    const ceiling = inCar ? 110 : 9;

    ctx.save();
    ctx.fillStyle = 'rgba(232,238,252,0.5)';
    ctx.font = `600 10px ${MONO}`;
    ctx.fillText(inCar ? 'ROAD SPEED' : 'GROUND SPEED', x, y - 8);

    ctx.font = `700 30px ${MONO}`;
    ctx.fillStyle = speed > 6.2 ? AMBER : 'rgba(232,238,252,0.92)';
    ctx.fillText(shown.toFixed(0), x, y + 22);

    ctx.font = `600 12px ${MONO}`;
    ctx.fillStyle = 'rgba(232,238,252,0.45)';
    ctx.fillText(unit, x + ctx.measureText(shown.toFixed(0)).width + 8, y + 22);

    const bw = 132;
    const bh = 4;
    this.#roundRect(ctx, x, y + 34, bw, bh, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fill();
    this.#roundRect(ctx, x, y + 34, Math.max(2, (bw * Math.min(shown, ceiling)) / ceiling), bh, 2);
    ctx.fillStyle = speed > (inCar ? 18 : 6.2) ? AMBER : MINT;
    ctx.fill();
    ctx.restore();
  }

  #drawHints(ctx) {
    const inCar = Boolean(this.state.inCar);
    const hints = inCar
      ? [
          ['W/S', 'throttle'],
          ['A/D', 'steer'],
          ['SPACE', 'handbrake'],
          ['F', 'get out'],
        ]
      : [
          ['WASD', 'move'],
          ['SHIFT', 'sprint'],
          ['SPACE', 'jump'],
          ['F', 'take car'],
          ['CLICK', 'fire'],
          ['DRAG', 'orbit'],
        ];

    ctx.save();
    ctx.font = `600 10px ${MONO}`;
    const gap = 16;
    const parts = hints.map(([k, v]) => ({ k, v, kw: ctx.measureText(k).width, vw: ctx.measureText(v).width }));
    const total = parts.reduce((sum, p) => sum + p.kw + p.vw + 14 + gap, -gap);
    let x = this.width / 2 - total / 2;
    const y = this.height - 26;

    for (const p of parts) {
      ctx.fillStyle = 'rgba(232,238,252,0.2)';
      this.#roundRect(ctx, x, y - 13, p.kw + 12, 18, 5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(232,238,252,0.18)';
      ctx.lineWidth = 1;
      this.#roundRect(ctx, x, y - 13, p.kw + 12, 18, 5);
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(232,238,252,0.78)';
      ctx.fillText(p.k, x + 6, y);
      ctx.fillStyle = 'rgba(232,238,252,0.38)';
      ctx.fillText(p.v, x + p.kw + 14, y);
      x += p.kw + p.vw + 14 + gap;
    }
    ctx.restore();
  }

  #drawMinimap(ctx) {
    const size = MAP_SIZE;
    const x = this.width - size - MAP_MARGIN;
    const y = this.height - size - MAP_MARGIN;
    const unit = size / (BOUNDS * 2);
    const sx = (wx) => x + (wx + BOUNDS) * unit;
    const sy = (wz) => y + (wz + BOUNDS) * unit;

    ctx.save();
    this.#roundRect(ctx, x - 8, y - 8, size + 16, size + 16, 14);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    this.#roundRect(ctx, x - 8, y - 8, size + 16, size + 16, 14);
    ctx.stroke();

    this.#roundRect(ctx, x, y, size, size, 8);
    ctx.save();
    ctx.clip();

    ctx.fillStyle = 'rgba(18, 24, 34, 0.95)';
    ctx.fillRect(x, y, size, size);

    ctx.fillStyle = 'rgba(30, 68, 96, 0.85)';
    ctx.fillRect(x, sy(BOUNDS + 1), size, y + size - sy(BOUNDS + 1));

    ctx.fillStyle = 'rgba(190, 200, 220, 0.12)';
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const bx = ROAD_COORDS[i] + ROAD_WIDTH / 2;
        const bz = ROAD_COORDS[j] + ROAD_WIDTH / 2;
        ctx.fillRect(sx(bx), sy(bz), BLOCK * unit, BLOCK * unit);
      }
    }

    ctx.strokeStyle = 'rgba(233, 226, 206, 0.5)';
    ctx.lineWidth = Math.max(1, ROAD_WIDTH * unit);
    ctx.beginPath();
    for (const c of ROAD_COORDS) {
      ctx.moveTo(sx(c), y);
      ctx.lineTo(sx(c), y + size);
      ctx.moveTo(x, sy(c));
      ctx.lineTo(x + size, sy(c));
    }
    ctx.stroke();

    // the landmark block glows amber
    const lc = ROAD_COORDS[4] + PITCH / 2;
    ctx.fillStyle = 'rgba(255, 179, 71, 0.85)';
    ctx.fillRect(sx(lc) - 2.5, sy(lc) - 2.5, 5, 5);

    // the mission marker: filled core, breathing ring and four spokes, so it never gets lost
    // against the roads drawn under it
    const marker = this.state.marker;
    if (marker) {
      const mx = sx(marker.x);
      const mz = sy(marker.z);
      const pulse = 5 + Math.sin(this.time * 4) * 2;

      ctx.beginPath();
      ctx.arc(mx, mz, pulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 179, 71, 0.95)';
      ctx.lineWidth = 1.8;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(mx, mz, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd79a';
      ctx.shadowColor = 'rgba(255, 179, 71, 0.95)';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = 'rgba(255, 196, 110, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        ctx.moveTo(mx + dx * (pulse - 2), mz + dz * (pulse - 2));
        ctx.lineTo(mx + dx * (pulse + 2.5), mz + dz * (pulse + 2.5));
      }
      ctx.stroke();
    }

    // police units: red, blinking, ringed, and drawn last so they sit on top of the map
    const blink = 0.5 + 0.5 * Math.sin(this.time * 8.5);
    for (const unit of this.state.police || []) {
      const ux = sx(unit.x);
      const uz = sy(unit.z);
      ctx.beginPath();
      ctx.arc(ux, uz, 5.6, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 118, 100, ${0.2 + 0.4 * blink})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(ux, uz, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 58, 46, ${0.55 + 0.45 * blink})`;
      ctx.shadowColor = 'rgba(255, 54, 40, 0.95)';
      ctx.shadowBlur = 9;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // player arrow: forward is (sin yaw, cos yaw) in world XZ, which is (right, down) here
    ctx.save();
    ctx.translate(sx(this.state.x), sy(this.state.z));
    ctx.rotate(Math.PI - this.state.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -7.5);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fillStyle = this.state.inCar ? AMBER : MINT;
    ctx.shadowColor = this.state.inCar ? 'rgba(255,179,71,0.9)' : 'rgba(126,240,196,0.9)';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.restore();

    ctx.restore(); // clip

    ctx.fillStyle = 'rgba(232,238,252,0.72)';
    ctx.font = `700 10px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText('N', x + size / 2, y + 13);
    ctx.beginPath();
    ctx.moveTo(x + size / 2, y + 16);
    ctx.lineTo(x + size / 2, y + 21);
    ctx.strokeStyle = 'rgba(232,238,252,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    this.#roundRect(ctx, x, y, size, size, 8);
    ctx.strokeStyle = 'rgba(111,214,255,0.25)';
    ctx.stroke();
    ctx.restore();
  }
}

export default HUD;