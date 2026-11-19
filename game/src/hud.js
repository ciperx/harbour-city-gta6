// The HUD: a 2D canvas laid over the 3D view. Health, money, speed, a minimap built from the
// same road grid the city was generated from, and the control hints.

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

export class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.state = { health: 100, money: 0, speed: 0, yaw: 0, x: 0, z: 0 };
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
    this.#drawHealth(ctx);
    this.#drawMoney(ctx);
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
    // A whisper of darkening at the edges makes the sunset pop.
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
    ctx.letterSpacing = '2px';
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

    // tick marks every 25 hp
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

    // a small trend chip under the balance
    ctx.font = `600 10px ${MONO}`;
    ctx.fillStyle = 'rgba(126,240,196,0.8)';
    ctx.fillText('+ 3.4% TODAY', right, y + 34);
    ctx.restore();
  }

  #drawSpeed(ctx) {
    const x = 24;
    const y = this.height - 92;
    const speed = this.shownSpeed;

    ctx.save();
    ctx.fillStyle = 'rgba(232,238,252,0.5)';
    ctx.font = `600 10px ${MONO}`;
    ctx.fillText('GROUND SPEED', x, y - 8);

    ctx.font = `700 30px ${MONO}`;
    ctx.fillStyle = speed > 6.2 ? AMBER : 'rgba(232,238,252,0.92)';
    ctx.fillText(speed.toFixed(1), x, y + 22);

    ctx.font = `600 12px ${MONO}`;
    ctx.fillStyle = 'rgba(232,238,252,0.45)';
    ctx.fillText('m/s', x + ctx.measureText(speed.toFixed(1)).width + 46, y + 22);

    // little bar showing the sprint ceiling
    const bw = 132;
    const bh = 4;
    this.#roundRect(ctx, x, y + 34, bw, bh, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fill();
    this.#roundRect(ctx, x, y + 34, Math.max(2, (bw * Math.min(speed, 9)) / 9), bh, 2);
    ctx.fillStyle = speed > 6.2 ? AMBER : MINT;
    ctx.fill();
    ctx.restore();
  }

  #drawHints(ctx) {
    const hints = [
      ['WASD', 'move'],
      ['SHIFT', 'sprint'],
      ['SPACE', 'jump'],
      ['DRAG', 'orbit'],
      ['WHEEL', 'zoom'],
    ];
    ctx.save();
    ctx.font = `600 10px ${MONO}`;
    ctx.textAlign = 'center';
    const gap = 20;
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
    const unit = size / (BOUNDS * 2); // pixels per metre
    const sx = (wx) => x + (wx + BOUNDS) * unit;
    const sy = (wz) => y + (wz + BOUNDS) * unit;

    ctx.save();
    // frame
    this.#roundRect(ctx, x - 8, y - 8, size + 16, size + 16, 14);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    this.#roundRect(ctx, x - 8, y - 8, size + 16, size + 16, 14);
    ctx.stroke();

    // clip the map to a rounded rect so the harbour water stays inside
    this.#roundRect(ctx, x, y, size, size, 8);
    ctx.save();
    ctx.clip();

    ctx.fillStyle = 'rgba(18, 24, 34, 0.95)';
    ctx.fillRect(x, y, size, size);

    // harbour beyond the promenade
    ctx.fillStyle = 'rgba(30, 68, 96, 0.85)';
    ctx.fillRect(x, sy(BOUNDS + 1), size, y + size - sy(BOUNDS + 1));

    // blocks as faint slabs
    ctx.fillStyle = 'rgba(190, 200, 220, 0.12)';
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const bx = ROAD_COORDS[i] + ROAD_WIDTH / 2;
        const bz = ROAD_COORDS[j] + ROAD_WIDTH / 2;
        ctx.fillRect(sx(bx), sy(bz), BLOCK * unit, BLOCK * unit);
      }
    }

    // roads
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
    ctx.fillStyle = MINT;
    ctx.shadowColor = 'rgba(126,240,196,0.9)';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.restore();

    ctx.restore(); // clip

    // N marker (north is -Z, the top of the map)
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