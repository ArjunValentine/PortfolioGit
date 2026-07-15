'use strict';
/* ============================================================================
   Particles — a small falling-sand cellular automaton "cutaway" of the plant,
   driven entirely by the macro simulation's live state via window.SimBridge
   (defined in app.js). Not an editable sandbox: cells spawn, flow, react,
   and (rarely) detonate according to S.gt/S.hrsg/S.st/S.cond/S.health/S.wreck.
   Grid runs left→right through air→compression→combustion→hot gas→HRSG heat
   exchange→stack, and a parallel steam band through the steam turbine into
   the condenser, with a cooling-tower plume off to the side.
   ============================================================================ */

const Particles = (() => {
  const W = 200, H = 60;

  const EMPTY = 0, WALL = 1, AIR = 2, FUEL = 3, FLAME = 4, HOTGAS = 5,
        STEAM = 6, SMOKE = 7, WATER = 8, VAPOR = 9, SPARK = 10;

  const AGE_MAX = { [SPARK]: 16, [VAPOR]: 70, [SMOKE]: 100, [STEAM]: 170, [FLAME]: 3, [AIR]: 130, [FUEL]: 55 };

  // chamber geometry (grid cells) — a stylized cutaway, not to scale
  const ZONE = {
    gt:   { x0: 40,  x1: 86,  y0: 22, y1: 42 },
    hrsg: { x0: 88,  x1: 150, y0: 4,  y1: 58 },
    cond: { x0: 150, x1: 190, y0: 20, y1: 58 },
  };

  let canvas, ctx, img, buf;
  let type, temp, age, moved;
  let burst = [];
  let scorch;                 // Uint8Array flag: cell is part of a wrecked, scorched zone
  let enabled = true;
  let raf = null, lastStepAt = 0, flashUntil = 0;
  let curS = null;
  const STEP_MS = 48;

  const idx = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
  const jitter = () => { const r = Math.random(); return r < 0.34 ? -1 : (r < 0.67 ? 0 : 1); };
  const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const lerpRGB = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

  function drawWallRect(x0, x1, y0, y1) {
    for (let x = x0; x <= x1; x++) { if (inb(x, y0)) type[idx(x, y0)] = WALL; if (inb(x, y1)) type[idx(x, y1)] = WALL; }
  }
  function drawWallVLine(x, y0, y1) {
    for (let y = y0; y <= y1; y++) if (inb(x, y)) type[idx(x, y)] = WALL;
  }

  function initWalls() {
    type.fill(EMPTY);
    scorch.fill(0);
    drawWallRect(2, 150, 23, 41);     // main hot-gas duct rails
    drawWallRect(88, 176, 5, 21);     // steam duct rails
    drawWallVLine(149, 21, 58);       // condenser left wall
    drawWallVLine(191, 21, 58);       // condenser right wall (borders cooling tower)
    drawWallRect(150, 190, 58, 58);   // condenser floor (drawWallRect draws both y0/y1 — harmless dup)
  }

  function init(canvasEl) {
    canvas = canvasEl;
    canvas.width = W; canvas.height = H;
    ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    img = ctx.createImageData(W, H);
    buf = img.data;
    type = new Uint8Array(W * H);
    temp = new Int16Array(W * H);
    age = new Uint16Array(W * H);
    moved = new Uint8Array(W * H);
    scorch = new Uint8Array(W * H);
    initWalls();
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function setEnabled(v) { enabled = v; }

  function operateVisible() {
    const el = document.getElementById('tab-operate');
    return !!el && el.classList.contains('active');
  }

  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (!enabled || document.hidden || !operateVisible()) return;
    const B = window.SimBridge;
    if (!B) return;
    const S = B.state();
    if (!S || S.speed === 0) return;
    if (ts - lastStepAt < STEP_MS) return;
    lastStepAt = ts;
    curS = S;
    step(S, B);
    render(S);
  }

  function step(S, B) {
    spawn(S, B);
    advect();
    react(S);
    ageOut();
    stepBurst();
  }

  /* ---------------- spawning ---------------- */

  function spawnAt(x, y, ty, t0) {
    if (!inb(x, y) || type[idx(x, y)] !== EMPTY) return false;
    const i = idx(x, y);
    type[i] = ty; temp[i] = t0 || 0; age[i] = 0;
    return true;
  }

  function spawnBand(x0, x1, y0, y1, ty, t0, rate) {
    const n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
    for (let k = 0; k < n; k++) spawnAt(randInt(x0, x1), randInt(y0, y1), ty, t0);
  }

  function spawnPoint(cx, cy, ty, rate, t0) {
    const n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
    for (let k = 0; k < n; k++) spawnAt(cx + randInt(-2, 2), cy + randInt(-2, 2), ty, t0);
  }

  function maybeSpark(zone, x0, x1, y0, y1, S) {
    if (S.wreck[zone]) {
      if (Math.random() < 0.025) spawnPoint(randInt(x0, x1), randInt(y0, y1), SPARK, 1, 0);
      return;
    }
    const h = S.health[zone];
    if (h >= 50) return;
    if (Math.random() < ((50 - h) / 50) * 0.06) spawnPoint(randInt(x0, x1), randInt(y0, y1), SPARK, 1, 0);
  }

  // A real turbine is flow-through — mass in becomes mass out almost
  // instantly. Any cellular automaton with random-walk movement hits a
  // traffic-jam phase transition well before it's actually "full" (cars
  // don't need bumper-to-bumper density to gridlock a road), so the
  // combustor+turbine section — where combustion products are actively
  // created — is watched specifically and throttled hard before it can
  // saturate and visually block the turbine icon.
  function ductOccupancy() {
    let filled = 0;
    const x0 = 40, x1 = 86, y0 = 24, y1 = 40;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = type[idx(x, y)];
        if (t === AIR || t === FUEL || t === FLAME || t === HOTGAS) filled++;
      }
    }
    return filled / ((x1 - x0 + 1) * (y1 - y0 + 1));
  }

  function spawn(S, B) {
    const gtRunning = ['purge', 'ignition', 'accel', 'fsnl', 'online'].includes(S.gt.state);
    const firing = S.gt.state === 'online';
    const avail = B.gtAvailable();
    const loadFrac = firing ? clamp(S.gt.mw / Math.max(1, avail), 0, 1)
      : (S.gt.state === 'ignition' || S.gt.state === 'accel' || S.gt.state === 'fsnl' ? 0.16 : 0);

    const occ = ductOccupancy();
    const throttle = clamp(1 - (occ - 0.12) / 0.16, 0.04, 1);

    if (gtRunning && !S.wreck.gt) {
      const foulPenalty = Math.max(0.15, 1 - 0.6 * S.filterDp - 0.3 * S.foul);
      spawnBand(3, 13, 25, 39, AIR, 20, (1.1 + 2.2 * loadFrac) * foulPenalty * throttle);
    }
    if ((firing || S.gt.state === 'ignition' || S.gt.state === 'accel') && !S.wreck.gt) {
      spawnPoint(48, 32, FUEL, (S.gt.state === 'online' ? (0.5 + 1.2 * loadFrac) : 0.5) * throttle, 40);
    }

    const fansOn = S.fans.filter(Boolean).length;
    if (fansOn > 0) spawnBand(193, 198, 50, 56, VAPOR, 0, fansOn * (0.5 + 0.4 * S.health.ct / 100));

    maybeSpark('gt', 60, 84, 26, 40, S);
    maybeSpark('hrsg', 90, 148, 6, 40, S);
    maybeSpark('cond', 152, 188, 30, 56, S);
  }

  /* ---------------- movement ---------------- */

  function dirFor(x, y, t) {
    if (t === AIR || t === FUEL) {
      if (x < 150) return { dx: 1, dy: jitter() };
      return { dx: 0, dy: -1 }; // any air that never combusted still exits with the exhaust
    }
    if (t === HOTGAS || t === FLAME) {
      if (x < 150) return { dx: 1, dy: jitter() };
      return { dx: 0, dy: -1 };
    }
    if (t === SMOKE) return { dx: jitter(), dy: -1 };
    if (t === STEAM) {
      if (y < 22) return { dx: 1, dy: jitter() };
      return { dx: jitter(), dy: 1 };
    }
    if (t === WATER) return { dx: jitter(), dy: 1 };
    if (t === VAPOR) return { dx: jitter(), dy: -1 };
    if (t === SPARK) return { dx: jitter(), dy: -1 };
    return null;
  }

  // A real turbine is flow-through — mass in becomes mass out almost
  // instantly. This automaton can only move a cell one step per frame, which
  // (at a spawn rate tuned to look busy) makes gas visibly queue up and jam
  // solid against the turbine icon rather than flow past it. Rather than
  // starving the spawn rate to compensate, give the hot-gas-path species a
  // higher transit speed — several hops per frame — so they clear the duct
  // fast enough to never visually back up, independent of the throttle in
  // spawn(). Slower species (steam, water, vapor, sparks) keep one hop.
  const HOP_SPEED = { [AIR]: 2, [HOTGAS]: 3, [FLAME]: 2 };

  function tryMove(x, y) {
    const i0 = idx(x, y);
    const t = type[i0];
    if (t === EMPTY || t === WALL || moved[i0]) return;
    const d = dirFor(x, y, t);
    if (!d) return;
    let cx = x, cy = y;
    const hops = HOP_SPEED[t] || 1;
    for (let h = 0; h < hops; h++) {
      const i = idx(cx, cy);
      if (type[i] !== t) return; // something else touched this cell already this frame

      if ((t === HOTGAS || t === SMOKE || t === AIR || t === FUEL) && cy + d.dy < 2) { type[i] = EMPTY; return; }
      if (t === WATER && cy + d.dy > 57) { type[i] = EMPTY; return; }
      if ((t === VAPOR || t === SPARK) && cy + d.dy < 5) { type[i] = EMPTY; return; }

      const nx = cx + d.dx, ny = cy + d.dy;
      if (!inb(nx, ny)) return;
      const j = idx(nx, ny);
      if (type[j] === EMPTY) {
        type[j] = t; temp[j] = temp[i]; age[j] = age[i];
        type[i] = EMPTY;
        moved[j] = 1;
        cx = nx; cy = ny;
        continue; // try the next hop from the new position
      }
      // blocked — fall back to a pure horizontal or vertical nudge, then stop
      const alt1 = idx(clamp(nx, 0, W - 1), cy);
      if (d.dy !== 0 && inb(nx, cy) && type[alt1] === EMPTY) {
        type[alt1] = t; temp[alt1] = temp[i]; age[alt1] = age[i]; type[i] = EMPTY; moved[alt1] = 1; return;
      }
      const alt2 = idx(cx, clamp(ny, 0, H - 1));
      if (d.dx !== 0 && inb(cx, ny) && type[alt2] === EMPTY) {
        type[alt2] = t; temp[alt2] = temp[i]; age[alt2] = age[i]; type[i] = EMPTY; moved[alt2] = 1;
      }
      return;
    }
  }

  function advect() {
    moved.fill(0);
    const ltr = (Math.floor(lastStepAt / STEP_MS) % 2) === 0;
    for (let y = H - 1; y >= 0; y--) {
      if (ltr) { for (let x = 0; x < W; x++) tryMove(x, y); }
      else { for (let x = W - 1; x >= 0; x--) tryMove(x, y); }
    }
  }

  /* ---------------- reactions ---------------- */

  function react(S) {
    const firing = ['ignition', 'accel', 'online'].includes(S.gt.state);
    // combustion
    if (firing) {
      const z = ZONE.gt;
      for (let y = z.y0; y <= z.y1; y++) {
        for (let x = 40; x <= 58; x++) {
          const i = idx(x, y);
          if (type[i] !== FUEL) continue;
          const neigh = [idx(x + 1, y), idx(x - 1, y), idx(x, y + 1), idx(x, y - 1)];
          const airNeighbor = neigh.find((j) => type[j] === AIR);
          if (airNeighbor !== undefined && Math.random() < 0.35) {
            type[i] = FLAME; temp[i] = 1450; age[i] = 0;
            type[airNeighbor] = EMPTY; // the oxygen is consumed, not left sitting there
          }
        }
      }
      // dilution air — real turbines mix far more intake air than actually
      // burns; whatever didn't combust in the can still mixes into the hot
      // exhaust once it reaches the turbine section, rather than drifting
      // through as a separate, unreacted, ever-growing pocket of cool air
      for (let y = z.y0; y <= z.y1; y++) {
        for (let x = 58; x <= 86; x++) {
          const i = idx(x, y);
          if (type[i] === AIR && Math.random() < 0.12) { type[i] = HOTGAS; temp[i] = 420; age[i] = 0; }
        }
      }
    }
    // HRSG heat exchange: HOTGAS gives up heat, spawns STEAM above, cools to SMOKE.
    // Absorption rate responds to its own backlog — like a relief valve
    // opening wider under pressure — so a busy HRSG drains faster instead of
    // saturating solid and jamming the turbine section behind it.
    if (!S.wreck.hrsg) {
      const hrsgFactor = 0.4 + 0.6 * S.health.hrsg / 100;
      let hrsgCount = 0;
      const hrsgCells = (149 - 88 + 1) * (40 - 22 + 1);
      for (let y = 22; y <= 40; y++) for (let x = 88; x <= 149; x++) if (type[idx(x, y)] === HOTGAS) hrsgCount++;
      const backlog = hrsgCount / hrsgCells;
      const absorbProb = clamp((0.55 + backlog * 2.2) * hrsgFactor, 0, 0.97);
      for (let y = 22; y <= 40; y++) {
        for (let x = 88; x <= 149; x++) {
          const i = idx(x, y);
          if (type[i] !== HOTGAS) continue;
          if (Math.random() < absorbProb) {
            temp[i] -= 220;
            if (Math.random() < 0.5) spawnAt(x, 20, STEAM, 220);
          }
          if (temp[i] < 180) type[i] = SMOKE;
        }
      }
    }
    // condenser: STEAM -> WATER based on vacuum quality (S.cond.pk, lower = colder = better)
    if (!S.wreck.cond) {
      const coldness = clamp(1 - (S.cond.pk - 4) / 30, 0.05, 1);
      for (let y = 22; y <= 57; y++) {
        for (let x = 150; x <= 189; x++) {
          const i = idx(x, y);
          if (type[i] !== STEAM) continue;
          if (Math.random() < 0.03 + coldness * 0.16) { type[i] = WATER; temp[i] = 30; }
        }
      }
    }
  }

  function ageOut() {
    for (let i = 0; i < W * H; i++) {
      const t = type[i];
      const max = AGE_MAX[t];
      if (!max) continue;
      age[i]++;
      if (age[i] > max) type[i] = (t === FLAME) ? HOTGAS : EMPTY;
    }
  }

  /* ---------------- catastrophic burst overlay ---------------- */

  function punchWalls(z) {
    for (let n = 0; n < 10; n++) {
      const edge = Math.random() < 0.5 ? z.y0 : z.y1;
      const x = randInt(z.x0, z.x1);
      if (inb(x, edge)) type[idx(x, edge)] = EMPTY;
    }
  }

  function clearZone(z) {
    for (let y = z.y0; y <= z.y1; y++) {
      for (let x = z.x0; x <= z.x1; x++) {
        const i = idx(x, y);
        if (type[i] !== WALL) type[i] = EMPTY;
        scorch[i] = 1;
      }
    }
  }

  function explode(zone) {
    const z = ZONE[zone];
    if (!z || !canvas) return;
    punchWalls(z);
    clearZone(z);
    const cx = (z.x0 + z.x1) / 2, cy = (z.y0 + z.y1) / 2;
    for (let i = 0; i < 90; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 0.5 + Math.random() * 2.4;
      burst.push({
        x: cx + (Math.random() - 0.5) * 6,
        y: cy + (Math.random() - 0.5) * 6,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 0.7,
        life: 26 + Math.random() * 46,
        kind: Math.random() < 0.35 ? 'debris' : (Math.random() < 0.6 ? 'flame' : 'spark'),
      });
    }
    flashUntil = performance.now() + 260;
    render(curS);
  }

  function rebuild(zone) {
    const z = ZONE[zone];
    if (!z) return;
    for (let y = z.y0; y <= z.y1; y++) for (let x = z.x0; x <= z.x1; x++) scorch[idx(x, y)] = 0;
    initWalls(); // simplest correct repair — re-lay every duct wall, zero cost at this grid size
  }

  function stepBurst() {
    for (const p of burst) {
      p.x += p.vx; p.y += p.vy;
      if (p.kind === 'debris') p.vy += 0.12;
      p.vx *= 0.96; p.vy *= 0.96;
      p.life--;
    }
    burst = burst.filter((p) => p.life > 0 && p.x > -5 && p.x < W + 5 && p.y > -5 && p.y < H + 5);
  }

  /* ---------------- rendering ---------------- */

  const COL = {
    bg: [13, 17, 23], wall: [58, 64, 72], wallScorch: [26, 19, 16],
    air: [96, 140, 168], fuel: [237, 161, 0],
    flameLo: [255, 106, 0], flameHi: [255, 246, 200],
    hotLo: [120, 110, 100], hotHi: [232, 84, 44],
    steam: [222, 236, 243], smoke: [126, 126, 122], water: [42, 120, 214],
    vapor: [225, 231, 235], spark: [255, 226, 110],
  };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function colorFor(i, S) {
    const t = type[i];
    switch (t) {
      case EMPTY: return COL.bg;
      case WALL:  return scorch[i] ? COL.wallScorch : COL.wall;
      case AIR:   return COL.air;
      case FUEL:  return COL.fuel;
      case FLAME: return lerpRGB(COL.flameLo, COL.flameHi, clamp(temp[i] / 1600, 0, 1));
      case HOTGAS: return lerpRGB(COL.hotLo, COL.hotHi, clamp((temp[i] - 120) / 1250, 0, 1));
      case STEAM: return COL.steam;
      case SMOKE: return COL.smoke;
      case WATER: return COL.water;
      case VAPOR: return COL.vapor;
      case SPARK: return COL.spark;
      default: return COL.bg;
    }
  }

  function drawRotor(cx, cy, r, rpm) {
    const ang = (performance.now() / 1000) * (rpm / 60) * 2 * Math.PI;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = ang + (k * 2 * Math.PI) / 3;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.stroke();
  }

  function render(S) {
    for (let i = 0; i < W * H; i++) {
      const c = colorFor(i, S);
      const o = i * 4;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    if (S) {
      if (S.gt.rpm > 50) drawRotor(63, 32, 9, S.gt.rpm);
      if (S.st.rpm > 50) drawRotor(163, 13, 8, S.st.rpm);
    }

    for (const p of burst) {
      ctx.globalAlpha = clamp(p.life / 40, 0, 1);
      ctx.fillStyle = p.kind === 'debris' ? '#241c17' : p.kind === 'flame' ? '#ff8a3d' : '#ffe66b';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.kind === 'debris' ? 1.3 : 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (performance.now() < flashUntil) {
      ctx.fillStyle = 'rgba(255,244,214,0.5)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  return { init, setEnabled, explode, rebuild };
})();

window.Particles = Particles;
