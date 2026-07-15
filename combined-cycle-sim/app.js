'use strict';
/* ============================================================================
   Voltage Falls Power Station — combined-cycle plant simulator
   One tick = one simulated minute. All energy flows in MW (thermal or
   electric); fuel is displayed in MMBtu/h (1 MWh = 3.412 MMBtu).
   ============================================================================ */

/* ---------------- helpers ---------------- */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, f) => a + (b - a) * f;
const r0 = (n) => Math.round(n).toLocaleString('en-US');
const r1 = (n) => (Math.round(n * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1 });

function fmtMoney(n) {
  const sign = n < 0 ? '−$' : '$';
  const a = Math.abs(n);
  if (a >= 1e6) return sign + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return sign + Math.round(a / 1e3) + 'k';
  return sign + Math.round(a).toLocaleString('en-US');
}

function fmtClock(t) {
  const day = Math.floor(t / 1440) + 1;
  const h = Math.floor((t % 1440) / 60);
  const m = t % 60;
  return `Day ${day} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ---------------- configuration ---------------- */

const CFG = {
  gtRating: 180,          // MW at ISO conditions
  gtMin: 45,              // MW minimum stable load
  gtEffFL: 0.37,          // full-load LHV efficiency
  stRating: 92,           // MW
  steamCycleEff: 0.335,   // steam-cycle conversion of recovered heat
  hrsgEffect: 0.86,       // fraction of exhaust heat recovered when clean
  purgeMin: 6,
  ignitionMin: 2,
  rampNormal: 8,          // MW/min
  rampFast: 16,
  safeWarmRate: 3.5,      // °C/min drum warm-up before stress accrues
  fanCapMWth: 90,         // heat rejection per fan cell
  startBudget: 2000000,
  omPerHour: 900,
  gasPrice0: 3.50,        // $/MMBtu
  oilPriceMult: 1.4,
  co2PerMMBtu: 0.05306,   // tonnes CO2 per MMBtu of gas
  waterMax: 800,          // m³ demin storage
  histLen: 190,
};

const SEV = {
  info:     { glyph: '·', cls: 'sev-info' },
  good:     { glyph: '✓', cls: 'sev-info' },
  warning:  { glyph: '!', cls: 'sev-warning' },
  serious:  { glyph: '▲', cls: 'sev-serious' },
  critical: { glyph: '✕', cls: 'sev-critical' },
};

const EVENTS = [
  { id: 'heat',   name: 'Heat wave', dur: 360, tempOff: 9,
    msg: 'Heat wave: +9 °C for 6 h. Thin air and warm cooling water will cost output — right as air-conditioning demand peaks.' },
  { id: 'cold',   name: 'Cold snap', dur: 480, tempOff: -10,
    msg: 'Cold snap: −10 °C for 8 h. Dense intake air boosts GT output; heating demand rises.' },
  { id: 'spike',  name: 'Price spike', dur: 120, priceMult: 2.6,
    msg: 'A unit tripped elsewhere on the grid — power prices spike ×2.6 for ~2 h. Being on line right now is very profitable.' },
  { id: 'gasup',  name: 'Gas supply pinch', dur: 600, gasMult: 1.5,
    msg: 'Pipeline congestion: natural-gas price +50 % for ~10 h. Watch your break-even price.' },
  { id: 'dust',   name: 'Dust storm', dur: 180, dustMult: 8,
    msg: 'Dust storm for ~3 h: inlet filters are loading up 8× faster than normal.' },
  { id: 'gridmax', name: 'Max-output request', dur: 90, priceMult: 1.8,
    msg: 'The grid operator requests maximum output for 90 min — prices up ×1.8. Consider duct firing.' },
];

const TASKS = [
  { id: 'filters',   name: 'Replace inlet filters',           hours: 4,   cost: 40000,
    needs: 'gtOff', blockedBy: 'gt', desc: 'Restores airflow — recovers GT capacity lost to filter ΔP.' },
  { id: 'washOff',   name: 'Offline compressor wash',         hours: 6,   cost: 15000,
    needs: 'gtOff', blockedBy: 'gt', desc: 'Full crank-soak wash; recovers all fouling losses.' },
  { id: 'gtInspect', name: 'GT combustion inspection',        hours: 48,  cost: 400000,
    needs: 'gtOff', blockedBy: 'gt', desc: 'Borescope + combustor liner and fuel-nozzle replacement. GT health +45.' },
  { id: 'gtMajor',   name: 'GT hot-gas-path overhaul',        hours: 120, cost: 1500000,
    needs: 'gtOff', blockedBy: 'gt', desc: 'Blades, vanes, and rotor inspection. GT health restored to 100.' },
  { id: 'hrsgClean', name: 'HRSG chemical clean & inspection', hours: 36, cost: 250000,
    needs: 'gtOff', blockedBy: 'hrsg', desc: 'Removes tube-side deposits, inspects headers. HRSG health +50.' },
  { id: 'condClean', name: 'Condenser tube cleaning',         hours: 24,  cost: 120000,
    needs: 'stOff', blockedBy: 'cond', desc: 'Brushes fouling out of condenser tubes. Condenser health restored to 100.' },
  { id: 'ctService', name: 'Cooling-tower service',           hours: 12,  cost: 60000,
    needs: 'stOff', desc: 'Fill cleaning, fan gearbox service. Tower health restored to 100.' },
  { id: 'stMinor',   name: 'ST minor overhaul',               hours: 96,  cost: 900000,
    needs: 'stOff', desc: 'Steam-path inspection, seal replacement. ST health +60.' },
  { id: 'gtRebuild', name: '☠ Full GT rebuild (catastrophic failure)', hours: 300, cost: 2200000,
    needs: 'gtOff', requiresWreck: 'gt',
    desc: 'Replace the destroyed rotor, casing, and hot-gas-path — the only way back after an uncontained failure. GT health restored to 100; the failure is cleared.' },
  { id: 'hrsgRebuild', name: '☠ Full HRSG rebuild (catastrophic failure)', hours: 240, cost: 1800000,
    needs: 'gtOff', requiresWreck: 'hrsg',
    desc: 'Replace the ruptured tube bank, drum, and casing. HRSG health restored to 100; the failure is cleared.' },
  { id: 'condRebuild', name: '☠ Full condenser rebuild (catastrophic failure)', hours: 160, cost: 900000,
    needs: 'stOff', requiresWreck: 'cond',
    desc: 'Replace the imploded shell and tube bundle. Condenser health restored to 100; the failure is cleared.' },
];

/* the daily rhythm of Voltage Falls — one value per hour, 0..1 */
const DAY_SHAPE = [0.26, 0.22, 0.20, 0.19, 0.21, 0.30, 0.48, 0.72, 0.84, 0.80,
                  0.75, 0.72, 0.70, 0.71, 0.74, 0.79, 0.85, 0.94, 1.00, 0.96,
                  0.82, 0.62, 0.46, 0.33];

function dayShape(t) {
  const h = (t % 1440) / 60;
  const i = Math.floor(h), f = h - i;
  return lerp(DAY_SHAPE[i], DAY_SHAPE[(i + 1) % 24], f);
}

/* ---------------- state ---------------- */

let S = null;

function newState() {
  return {
    v: 1,
    t: 6 * 60,               // Day 1, 06:00
    speed: 1,
    budget: CFG.startBudget,
    profit: 0, mwh: 0, co2: 0, trips: 0, starts: 0,
    servedSum: 0, servedN: 0,
    demandNoise: 0, priceNoise: 0,
    event: null,             // {idx, remain}
    gt: { state: 'off', prog: 0, rpm: 0, mw: 0, set: 0, offlineAt: -6000,
          fuel: 'gas', mode: 'normal', autoStop: false },
    st: { state: 'off', rpm: 0, mw: 0, admission: 0, autoStop: false },
    sync: { df: 0.06, phase: 120, hold: 0 },
    hrsg: { drumT: 20, rate: 0 },
    cond: { pk: 4.5, vacTimer: 0 },
    fans: [false, false, false, false],
    health: { gt: 100, hrsg: 100, st: 100, cond: 100, ct: 100 },
    wreck: { gt: false, hrsg: false, cond: false },  // catastrophic, permanent until rebuilt
    meltdowns: 0,
    filterDp: 0.05,          // 0..1 fouled
    foul: 0.05,              // compressor fouling 0..1
    duct: { on: false, level: 0 },
    scr: true, evap: false, dispatch: 'manual', autosync: false,
    water: CFG.waterMax, ammonia: 100,
    waterTimer: 0, purityTimer: 0,
    orders: [],              // {what, remain}
    maint: null,             // {id, remain}
    lockout: false,
    banner: null,            // {sev, msg}
    lastMargin: 0,
    log: [], events: [],
    hist: { net: [], demand: [], eff: [] },
    done: {},                // checklist flags
  };
}

/* ---------------- logging ---------------- */

let lastSfxAt = {};
function sfxForLog(sev, msg) {
  if (!window.SFX) return;
  const now = performance.now();
  const cooldown = { warning: 1400, serious: 1400, critical: 300, good: 700 }[sev] || 1000;
  if (lastSfxAt[sev] && now - lastSfxAt[sev] < cooldown) return;
  lastSfxAt[sev] = now;
  if (sev === 'critical') window.SFX.play(msg.indexOf('☠') === 0 ? 'wreck' : 'trip');
  else if (sev === 'serious') window.SFX.play('serious');
  else if (sev === 'warning') window.SFX.play('warning');
  else if (sev === 'good') window.SFX.play('good');
}

function log(sev, msg, learnId) {
  S.log.unshift({ t: S.t, sev, msg, learnId: learnId || null });
  if (S.log.length > 250) S.log.pop();
  if (sev === 'warning' || sev === 'serious' || sev === 'critical') {
    S.banner = { sev, msg, t: S.t };
  }
  sfxForLog(sev, msg);
}

function logEvent(msg) {
  S.events.unshift({ t: S.t, msg });
  if (S.events.length > 60) S.events.pop();
}

/* ---------------- environment, market ---------------- */

function ambientT() {
  const h = (S.t % 1440) / 60;
  let T = 16 + 7 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
  if (S.event && EVENTS[S.event.idx].tempOff) T += EVENTS[S.event.idx].tempOff;
  return T;
}

function cityDemand() {
  const T = ambientT();
  const ac = T > 24 ? (T - 24) * 4.5 : (T < 2 ? (2 - T) * 2.5 : 0);
  return Math.max(60, 88 + 190 * dayShape(S.t) + ac + S.demandNoise);
}

function powerPrice() {
  let p = 22 + 58 * Math.pow(dayShape(S.t), 1.6) + S.priceNoise;
  if (S.event && EVENTS[S.event.idx].priceMult) p *= EVENTS[S.event.idx].priceMult;
  return Math.max(12, p);
}

function gasPrice() {
  let p = CFG.gasPrice0;
  if (S.event && EVENTS[S.event.idx].gasMult) p *= EVENTS[S.event.idx].gasMult;
  return p;
}

function tickEnvironment() {
  S.demandNoise = clamp(S.demandNoise + (Math.random() - 0.5) * 1.6, -12, 12);
  S.priceNoise = clamp(S.priceNoise + (Math.random() - 0.5) * 1.2, -6, 8);
  if (S.event) {
    S.event.remain--;
    if (S.event.remain <= 0) {
      logEvent(`${EVENTS[S.event.idx].name} has ended.`);
      log('info', `${EVENTS[S.event.idx].name} has ended.`);
      S.event = null;
    }
  } else if (Math.random() < 1 / 300) {
    const idx = Math.floor(Math.random() * EVENTS.length);
    S.event = { idx, remain: EVENTS[idx].dur };
    logEvent(EVENTS[idx].msg);
    log('warning', EVENTS[idx].msg);
  }
}

/* ---------------- gas turbine ---------------- */

function startClass() {
  const hOff = (S.t - S.gt.offlineAt) / 60;
  if (hOff < 8) return 'hot';
  if (hOff < 48) return 'warm';
  return 'cold';
}

function gtAvailable() {
  const T = ambientT();
  const Teff = S.evap && T > 18 ? T - 6 : T;
  const tempF = 1 - 0.0035 * (Teff - 15);
  const filterF = 1 - 0.10 * S.filterDp;
  const foulF = 1 - 0.06 * S.foul;
  const healthF = 0.92 + 0.08 * (S.health.gt / 100);
  return CFG.gtRating * tempF * filterF * foulF * healthF;
}

function gtEfficiency(loadFrac) {
  const partLoad = 0.55 + 0.45 * clamp(loadFrac, 0, 1);
  const foulF = 1 - 0.05 * S.foul;
  const filterF = 1 - 0.03 * S.filterDp;
  const healthF = 0.96 + 0.04 * (S.health.gt / 100);
  return CFG.gtEffFL * partLoad * foulF * filterF * healthF;
}

function tripGT(msg, learnId) {
  const wasOnline = S.gt.state === 'online';
  S.gt.state = 'off';
  S.gt.mw = 0; S.gt.set = 0; S.gt.prog = 0;
  S.gt.offlineAt = S.t;
  S.gt.autoStop = false;
  S.lockout = true;
  S.trips++;
  S.health.gt = Math.max(0, S.health.gt - (wasOnline ? 3 : 1.5));
  log('critical', `GT TRIP — ${msg}`, learnId || 'learn-states');
  if (S.st.state !== 'off') tripST('loss of steam supply (GT trip)');
}

function tripST(msg, learnId) {
  S.st.state = 'off'; S.st.mw = 0; S.st.admission = 0; S.st.rpm = 0;
  S.st.autoStop = false;
  S.lockout = true;
  S.trips++;
  S.health.st = Math.max(0, S.health.st - 2);
  log('critical', `ST TRIP — ${msg}`, learnId || 'learn-states');
}

/* ---------------- catastrophic failure (permanent until rebuilt) ---------------- */

function wreckComponent(zone, msg) {
  S.wreck[zone] = true;
  S.health[zone] = 0;
  S.meltdowns++;
  S.trips++;
  S.lockout = true;
  // a breach anywhere in the hot-gas or steam path takes the whole cycle down
  S.gt.state = 'off'; S.gt.mw = 0; S.gt.set = 0; S.gt.prog = 0; S.gt.rpm = 0;
  S.gt.offlineAt = S.t; S.gt.autoStop = false;
  S.st.state = 'off'; S.st.mw = 0; S.st.admission = 0; S.st.rpm = 0; S.st.autoStop = false;
  S.duct.on = false; S.duct.level = 0;
  log('critical', `☠ CATASTROPHIC FAILURE — ${msg}`, 'learn-catastrophic');
  if (window.Particles) { try { window.Particles.explode(zone); } catch (e) { /* cosmetic only */ } }
}

function tickGT() {
  const g = S.gt;
  switch (g.state) {
    case 'off':
      g.rpm = Math.max(0, g.rpm - 300);
      break;
    case 'purge':
      g.rpm = 600;
      g.prog += 1 / CFG.purgeMin;
      if (g.prog >= 1) {
        g.state = 'purged'; g.prog = 0;
        log('good', 'Purge complete — gas path swept with fresh air. Ignition is now permitted.', 'learn-purge');
      }
      break;
    case 'purged':
      g.rpm = 600;
      break;
    case 'ignition': {
      g.rpm = 900;
      g.prog += 1 / CFG.ignitionMin;
      const foulRisk = S.filterDp > 0.85 || S.foul > 0.85;
      const flameoutChance = (g.fuel === 'oil' ? 0.02 : 0.006) * (foulRisk ? 3.5 : 1);
      if (Math.random() < flameoutChance) {
        if (foulRisk && Math.random() < 0.25) {
          wreckComponent('gt', 'compressor surge deflagration — badly fouled inlet air stalled the compressor mid-light-off, and the fuel already committed to the combustor flashed back through the casing.');
        } else {
          g.state = 'off'; g.prog = 0; g.offlineAt = S.t;
          log('serious', 'Flameout during ignition — fuel flow was unstable. The gas path must be re-purged before another attempt.', 'learn-purge');
        }
        break;
      }
      if (g.prog >= 1) {
        g.state = 'accel'; g.prog = 0;
        log('info', 'Flame established. Accelerating to 3,600 rpm under the machine’s own power.');
        if (window.SFX) window.SFX.play('spoolup');
      }
      break;
    }
    case 'accel': {
      const accelMin = startClass() === 'hot' ? 4 : (startClass() === 'warm' ? 6 : 8);
      g.rpm = Math.min(3600, g.rpm + (3600 - 900) / accelMin);
      g.prog = (g.rpm - 900) / 2700;
      if (g.rpm >= 3600) {
        g.state = 'fsnl'; g.prog = 0;
        S.sync = { df: 0.05 + Math.random() * 0.06, phase: Math.random() * 300 - 150, hold: 0 };
        log('info', 'Full speed, no load (FSNL) — 3,600 rpm, breaker open. Match the synchroscope to close.', 'learn-sync');
      }
      break;
    }
    case 'fsnl':
      g.rpm = 3600;
      break;
    case 'online': {
      g.rpm = 3600;
      const avail = gtAvailable();
      if (S.dispatch === 'follow') {
        const aux = 4 + 0.4 * S.fans.filter(Boolean).length;
        g.set = clamp(cityDemand() - S.st.mw + aux, CFG.gtMin, avail);
      }
      if (g.autoStop) g.set = CFG.gtMin;
      const target = clamp(g.set, CFG.gtMin, avail);
      const ramp = g.mode === 'fast' ? CFG.rampFast : CFG.rampNormal;
      g.mw += clamp(target - g.mw, -ramp * 1.5, ramp);
      if (g.autoStop && g.mw <= CFG.gtMin + 0.5) {
        g.state = 'off'; g.mw = 0; g.set = 0; g.autoStop = false; g.offlineAt = S.t;
        log('good', 'GT breaker opened at minimum load — normal shutdown. The machine coasts down and begins its cooldown.');
        if (S.st.state !== 'off') tripST('loss of steam supply (GT shutdown)');
      }
      // fast ramping while HRSG is cold is punished in tickHRSG via warm rate
      if (S.health.gt < 25 && Math.random() < (25 - S.health.gt) * 0.0004) {
        if (S.health.gt < 10 && Math.random() < 0.35) {
          wreckComponent('gt', `uncontained turbine failure at ${r0(S.gt.mw)} MW — a rotor already weakened by neglected hot-gas-path damage let go, and debris breached the casing.`);
        } else {
          tripGT('high vibration — hot-gas-path distress. Health was allowed to run too low.', 'learn-degrade');
        }
      }
      break;
    }
  }
}

/* fuel + exhaust bookkeeping — returns thermal flows in MW */
function gtFlows() {
  const g = S.gt;
  const avail = gtAvailable();
  if (g.state === 'ignition') return { fuel: 28, exhaust: 26, gen: 0 };
  if (g.state === 'accel')    return { fuel: 55, exhaust: 50, gen: 0 };
  if (g.state === 'fsnl')     return { fuel: 70, exhaust: 64, gen: 0 };
  if (g.state === 'online') {
    const eff = gtEfficiency(g.mw / avail);
    const fuel = g.mw / eff;
    return { fuel, exhaust: (fuel - g.mw) * 0.985, gen: g.mw, eff };
  }
  return { fuel: 0, exhaust: 0, gen: 0 };
}

/* ---------------- HRSG & steam ---------------- */

function steamPressure() {
  return Math.max(0, (S.hrsg.drumT - 100) * 0.55);
}

function tickHRSG(exhaustMW, ductMW) {
  const h = S.hrsg;
  const heatIn = exhaustMW + ductMW;
  let rate;
  if (heatIn > 1) {
    const targetT = clamp(140 + 180 * (heatIn / 300), 0, 330);
    rate = Math.min((targetT - h.drumT) * 0.10, heatIn * 0.021);
    rate = Math.max(rate, (targetT - h.drumT) * 0.02); // cooling toward lower target
  } else {
    rate = (20 - h.drumT) / 840; // cools with ~14 h time constant
  }
  h.drumT = clamp(h.drumT + rate, 20, 335);
  h.rate = rate;
  if (rate > CFG.safeWarmRate) {
    const over = rate - CFG.safeWarmRate;
    S.health.hrsg = Math.max(0, S.health.hrsg - over * 0.05);
    if (S.t % 5 === 0) {
      log('warning', `HRSG warming at ${r1(rate)} °C/min — over the ${CFG.safeWarmRate} °C/min limit. Thermal stress is consuming drum fatigue life. Reduce GT load until the drum is warm.`, 'learn-stress');
    }
    if (rate > 6.5 && Math.random() < 0.06) {
      if (S.health.hrsg < 15 && Math.random() < 0.3) {
        wreckComponent('hrsg', `tube rupture — a drum already fatigued by repeated over-rate thermal cycling let go under ${r1(rate)} °C/min heating, flashing feedwater to steam inside the casing.`);
      } else {
        tripGT('drum level excursion — swell from too-fast steam formation.', 'learn-stress');
      }
    }
  }
  // steam available to the cycle (cold metal soaks up heat first)
  const readiness = clamp((h.drumT - 120) / 160, 0, 1);
  const effect = CFG.hrsgEffect * (0.90 + 0.10 * S.health.hrsg / 100);
  return heatIn * effect * readiness;
}

/* ---------------- steam turbine & condenser ---------------- */

function tickST(steamMW) {
  const st = S.st;
  switch (st.state) {
    case 'off':
      st.rpm = Math.max(0, st.rpm - 250);
      break;
    case 'rolling':
      if (steamPressure() < 22) {
        log('warning', 'Steam pressure fell below 22 bar — steam-turbine roll stalled. Raise GT load to keep the HRSG making steam.');
        st.state = 'off'; st.rpm = 0;
        break;
      }
      st.rpm = Math.min(3600, st.rpm + 450);
      if (st.rpm >= 3600) {
        st.state = 'fsnl';
        S.sync = { df: 0.05 + Math.random() * 0.06, phase: Math.random() * 300 - 150, hold: 0 };
        log('info', 'Steam turbine at 3,600 rpm, breaker open. Synchronize G2 to enter combined-cycle operation.', 'learn-sync');
      }
      break;
    case 'fsnl':
      st.rpm = 3600;
      break;
    case 'online': {
      st.rpm = 3600;
      st.admission = clamp(st.admission + (st.autoStop ? -0.10 : 0.05), 0, 1);
      const vacF = clamp(1 - (S.cond.pk - 6) * 0.02, 0.72, 1.02);
      const healthF = 0.94 + 0.06 * S.health.st / 100;
      st.mw = Math.min(CFG.stRating, steamMW * CFG.steamCycleEff * vacF * healthF * st.admission);
      if (st.autoStop && st.mw < 2) {
        st.state = 'off'; st.mw = 0; st.admission = 0; st.autoStop = false;
        S.duct.on = false; S.duct.level = 0;
        log('good', 'ST breaker opened at low load — normal steam-turbine shutdown. Steam bypasses to the condenser.');
      }
      break;
    }
  }
}

function tickCondenser(steamMW) {
  const stOn = S.st.state === 'online';
  const bypass = steamMW > 1 && !stOn;
  let duty = 0;
  if (stOn) duty = Math.max(0, steamMW * S.st.admission - S.st.mw) + steamMW * (1 - S.st.admission) * 0.95;
  else if (bypass) duty = steamMW * 0.95;

  const fansOn = S.fans.filter(Boolean).length;
  const T = ambientT();
  const wbF = clamp(1 - 0.012 * (T - 15), 0.7, 1.15);
  const cap = fansOn * CFG.fanCapMWth * wbF
            * (0.85 + 0.15 * S.health.ct / 100)
            * (0.80 + 0.20 * S.health.cond / 100);

  let pk = 4.0 + Math.max(0, (T - 15)) * 0.09 + (1 - S.health.cond / 100) * 2.5;
  if (duty > 0.01) {
    const ratio = cap > 0 ? duty / cap : 99;
    if (ratio > 0.9) pk += (ratio - 0.9) * 42;
  }
  S.cond.pk = clamp(pk, 3, 40);

  if (stOn && S.cond.pk > 16) {
    S.cond.vacTimer++;
    if (S.cond.vacTimer === 2) {
      log('serious', `Condenser pressure ${r1(S.cond.pk)} kPa and rising — cooling can’t keep up. Start more fan cells or reduce load, or the ST will trip on low vacuum.`, 'learn-vacuum');
    }
    if (S.cond.pk > 26 || S.cond.vacTimer > 10) {
      if (S.health.cond < 15 && S.cond.pk > 34 && Math.random() < 0.35) {
        wreckComponent('cond', 'vacuum collapse — a shell already thinned by fouling and cavitation gave way under the pressure differential and imploded.');
      } else {
        tripST('low condenser vacuum — heat rejection was insufficient for the steam flow.', 'learn-vacuum');
      }
      S.cond.vacTimer = 0;
    }
  } else {
    S.cond.vacTimer = 0;
  }
  return { duty, cap, fansOn };
}

/* ---------------- consumables, wear, work orders ---------------- */

function tickConsumables(fired, steamMW) {
  // demin water
  let use = 0;
  if (steamMW > 1) use += 0.35;
  if (S.evap && fired && ambientT() > 18) use += 0.5;
  S.water = Math.max(0, S.water - use);
  if (S.water === 0 && steamMW > 1) {
    S.purityTimer++;
    if (S.purityTimer === 1) log('serious', 'Demin water storage empty — feedwater purity degrading. Order water now; the ST will trip on steam purity if this continues.', 'learn-degrade');
    if (S.purityTimer > 20 && S.st.state === 'online') { tripST('steam purity — demin water exhausted.'); S.purityTimer = 0; }
  } else if (S.water > 0) S.purityTimer = 0;
  if (S.water === 0 && S.evap) { S.evap = false; log('warning', 'Evaporative cooler stopped — no demin water.'); }

  // ammonia for the SCR (~1.5 days at full-load firing)
  if (S.scr && fired) {
    S.ammonia = Math.max(0, S.ammonia - gtFlows().fuel * 0.0001);
    if (S.ammonia === 0 && S.t % 60 === 0) {
      log('warning', 'Ammonia tank empty — the SCR is passing NOₓ untreated. Emissions penalties apply while firing.', 'learn-emissions');
    }
  }

  // deliveries
  for (const o of S.orders) o.remain--;
  S.orders = S.orders.filter((o) => {
    if (o.remain > 0) return true;
    if (o.what === 'water') { S.water = Math.min(CFG.waterMax, S.water + 400); log('good', 'Demin water delivery: +400 m³.'); }
    if (o.what === 'ammonia') { S.ammonia = 100; log('good', 'Ammonia delivery: SCR reagent tank refilled.'); }
    return false;
  });
}

function tickWear(fired, loadFrac) {
  const dustM = S.event && EVENTS[S.event.idx].dustMult ? EVENTS[S.event.idx].dustMult : 1;
  if (fired) {
    const sev = (loadFrac > 0.95 ? 1.6 : 1) * (S.gt.fuel === 'oil' ? 2 : 1);
    S.health.gt = Math.max(0, S.health.gt - 0.0022 * sev);
    S.health.hrsg = Math.max(0, S.health.hrsg - 0.0012 - (S.duct.on ? 0.0012 * S.duct.level / 100 : 0));
    S.filterDp = Math.min(1, S.filterDp + 0.00008 * dustM);
    S.foul = Math.min(1, S.foul + 0.00006);
  }
  if (S.st.state === 'online') S.health.st = Math.max(0, S.health.st - 0.0010);
  const fansOn = S.fans.filter(Boolean).length;
  if (fansOn > 0) {
    S.health.ct = Math.max(0, S.health.ct - 0.0008 * fansOn / 4);
    S.health.cond = Math.max(0, S.health.cond - (S.st.state === 'online' || steamFlowing() ? 0.0009 : 0.0002));
  }
}

function steamFlowing() {
  return S.gt.state === 'online' && S.hrsg.drumT > 130;
}

function tickMaintenance() {
  if (!S.maint) return;
  const task = TASKS.find((x) => x.id === S.maint.id);
  S.maint.remain--;
  if (S.maint.remain <= 0) {
    switch (task.id) {
      case 'filters':   S.filterDp = 0; break;
      case 'washOff':   S.foul = 0; break;
      case 'gtInspect': S.health.gt = Math.min(100, S.health.gt + 45); break;
      case 'gtMajor':   S.health.gt = 100; break;
      case 'hrsgClean': S.health.hrsg = Math.min(100, S.health.hrsg + 50); break;
      case 'condClean': S.health.cond = 100; break;
      case 'ctService': S.health.ct = 100; break;
      case 'stMinor':   S.health.st = Math.min(100, S.health.st + 60); break;
      case 'gtRebuild':   S.health.gt = 100;   S.wreck.gt = false;   break;
      case 'hrsgRebuild': S.health.hrsg = 100; S.wreck.hrsg = false; break;
      case 'condRebuild': S.health.cond = 100; S.wreck.cond = false; break;
    }
    if (task.requiresWreck && window.Particles) { try { window.Particles.rebuild(task.requiresWreck); } catch (e) { /* cosmetic only */ } }
    log('good', `Maintenance complete: ${task.name}.`);
    S.maint = null;
  }
}

/* ---------------- economy ---------------- */

function tickEconomy(flows, ductMW, fansOn) {
  const gross = S.gt.mw + S.st.mw;
  const aux = 0.4 + 0.02 * gross + 0.4 * fansOn
            + (S.gt.state === 'online' ? 1.2 : 0)
            + (S.st.state === 'online' ? 1.6 : (steamFlowing() ? 0.9 : 0));
  const net = gross - aux;
  const price = powerPrice();

  const fuelMWth = flows.fuel + ductMW;
  const fuelMMBtuH = fuelMWth * 3.412;
  const isOil = S.gt.fuel === 'oil';
  const fuelCostH = fuelMMBtuH * gasPrice() * (isOil ? CFG.oilPriceMult : 1);
  const revenueH = net * price;                      // negative when net < 0 (buying aux power)
  let penaltyH = 0;
  if (fuelMWth > 1 && (!S.scr || S.ammonia <= 0)) penaltyH += 1100;  // NOx penalty
  const marginMin = (revenueH - fuelCostH - CFG.omPerHour - penaltyH) / 60;

  S.budget += marginMin;
  S.profit += marginMin;
  S.lastMargin = revenueH - fuelCostH - CFG.omPerHour - penaltyH;
  if (net > 0) S.mwh += net / 60;
  S.co2 += fuelMMBtuH * CFG.co2PerMMBtu * (isOil ? 1.35 : 1) / 60;

  const demand = cityDemand();
  if (net > 1) { S.servedSum += Math.min(net / demand, 1); S.servedN++; }

  return { net, aux, fuelMWth, fuelMMBtuH, price, demand };
}

/* ---------------- the master tick (1 sim minute) ---------------- */

let lastTickInfo = { net: 0, aux: 0, fuelMWth: 0, fuelMMBtuH: 0, price: 30, demand: 200, steamMW: 0, duty: 0, cap: 0, effNet: 0 };

function tick() {
  S.t++;
  tickEnvironment();
  tickMaintenance();
  tickGT();

  const flows = gtFlows();
  let ductMW = 0;
  if (S.duct.on && S.st.state === 'online') ductMW = 40 * (S.duct.level / 100);
  else { S.duct.on = false; S.duct.level = 0; }

  const steamMW = tickHRSG(flows.exhaust, ductMW);
  tickST(steamMW);
  const cond = tickCondenser(steamMW);
  tickConsumables(flows.fuel > 0, steamMW);
  tickWear(flows.fuel > 0, S.gt.state === 'online' ? S.gt.mw / gtAvailable() : 0);

  const eco = tickEconomy(flows, ductMW, cond.fansOn);
  const effNet = eco.fuelMWth > 1 && eco.net > 0 ? eco.net / eco.fuelMWth : 0;

  S.hist.net.push(Math.max(0, eco.net));
  S.hist.demand.push(eco.demand);
  S.hist.eff.push(effNet * 100);
  for (const k of Object.keys(S.hist)) if (S.hist[k].length > CFG.histLen) S.hist[k].shift();

  lastTickInfo = { ...eco, steamMW, duty: cond.duty, cap: cond.cap, effNet };

  if (S.banner && S.t - S.banner.t > 90) S.banner = null;

  if (S.budget < 0 && S.t % 240 === 0) {
    log('warning', 'Budget is negative — the city council is asking questions. Run profitably during peaks or cut costs.');
  }
  if (S.t % 300 === 0) save(true);
}

/* ============================================================================
   UI
   ============================================================================ */

const el = {};
function cacheEls() {
  ['tb-clock', 'tb-weather', 'tb-net', 'tb-demand', 'tb-price', 'tb-budget',
   'alarm-banner', 'alarm-glyph', 'alarm-text',
   'ring-pct', 'ring-desc', 'ring-arc',
   'h-filter', 'h-gt', 'h-hrsg', 'h-st', 'h-cond', 'h-ct',
   't-gt-rpm', 't-gt-mw', 't-drum', 't-st-rpm', 't-st-mw', 't-vac', 't-fans',
   'tile-net', 'tile-eff', 'tile-hr', 'tile-fuel', 'tile-co2', 'tile-margin', 'tile-margin-note',
   'trend', 'chart-tip', 'log',
   'st-gt-state', 'prog-gt', 'st-st-state', 'prog-st',
   'btn-purge', 'btn-ignite', 'btn-sync-gt', 'btn-roll-st', 'btn-sync-st',
   'btn-shutdown-st', 'btn-shutdown-gt', 'btn-open-gt', 'btn-reset-alarms',
   'syncscope', 'sync-needle', 'sync-unit', 'sync-freq', 'sync-phase', 'sync-ok', 'chk-autosync',
   'seq-msg', 'gt-set-val', 'gt-out', 'gt-eff', 'chk-evap', 'btn-wash-online',
   'ro-drum', 'ro-press', 'ro-rate', 'ro-steampath', 'chk-duct', 'row-duct', 'duct-val',
   'ro-vac', 'ro-cool', 'chk-scr',
   'health-meters', 'consumables', 'task-list', 'maint-msg',
   'sc-profit', 'sc-mwh', 'sc-served', 'sc-trips', 'sc-starts', 'sc-co2', 'sc-melt',
   'mk-demand', 'mk-price', 'mk-gas', 'mk-breakeven', 'events-log', 'save-note',
  ].forEach((id) => { el[id] = $(id); });
}

/* ----- status helpers (color always paired with glyph + text) ----- */

function healthStatus(h) {
  if (h >= 75) return { key: 'good', glyph: '✓', word: 'good' };
  if (h >= 50) return { key: 'warning', glyph: '!', word: 'fair' };
  if (h >= 25) return { key: 'serious', glyph: '▲', word: 'poor' };
  return { key: 'critical', glyph: '✕', word: 'critical' };
}

function setCompStatus(groupId, healthVal, running, wrecked) {
  const st = wrecked ? 'wreck' : (running === false && healthVal >= 75 ? 'off' : healthStatus(healthVal).key);
  document.querySelectorAll(`#${groupId} .comp`).forEach((n) => {
    n.setAttribute('class', `comp st-${st}`);
  });
}

/* ----- sequence messages ----- */

function showSeqMsg(text, learnId) {
  const box = el['seq-msg'];
  box.innerHTML = '';
  box.appendChild(document.createTextNode(text + ' '));
  if (learnId) {
    const a = document.createElement('span');
    a.className = 'why'; a.textContent = 'Learn why →';
    a.onclick = () => gotoLearn(learnId);
    box.appendChild(a);
  }
  box.classList.add('show');
}

function gotoLearn(learnId) {
  switchTab('learn');
  const d = $(learnId);
  if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}

/* ----- sequence actions (buttons stay clickable; refusals explain) ----- */

function maintBlocks(unit) {
  if (!S.maint) return null;
  const task = TASKS.find((x) => x.id === S.maint.id);
  if (unit === 'gt' && task.needs === 'gtOff') return task.name;
  if (unit === 'st' && (task.needs === 'stOff' || task.needs === 'gtOff')) return task.name;
  return null;
}

function actPurge() {
  if (S.wreck.gt) return showSeqMsg('The gas turbine suffered a catastrophic failure and cannot be restarted. Schedule a full rebuild in Maintenance.', 'learn-catastrophic');
  if (S.gt.state === 'purge') return showSeqMsg('Purge already in progress — several full volume changes of air take a few minutes.', 'learn-purge');
  if (S.gt.state !== 'off') return showSeqMsg('The gas turbine is already past the purge step.');
  if (S.lockout) return showSeqMsg('Alarms are locked out after the trip. Investigate the cause in the log, then press "Reset alarms" before restarting.', 'learn-states');
  const mb = maintBlocks('gt');
  if (mb) return showSeqMsg(`The GT is tagged out for maintenance (${mb}). Wait for the work order to finish.`);
  S.gt.state = 'purge'; S.gt.prog = 0;
  S.done.fuel = true; S.done.purgeStart = true;
  log('info', `Starter motor cranking — purging the gas path (${startClass()} start, ${CFG.purgeMin} min).`, 'learn-purge');
  showSeqMsg('Purging: the starter spins the unfired machine so fresh air flushes any leaked fuel out of the turbine and HRSG before ignition is allowed.', 'learn-purge');
  if (window.SFX) window.SFX.play('purge');
}

function actIgnite() {
  if (S.wreck.gt) return showSeqMsg('The gas turbine suffered a catastrophic failure and cannot be restarted. Schedule a full rebuild in Maintenance.', 'learn-catastrophic');
  if (S.gt.state === 'off') return showSeqMsg('Ignition is interlocked: the gas path must be purged first. A spark into pooled fuel vapor would be an explosion, not a start.', 'learn-purge');
  if (S.gt.state === 'purge') return showSeqMsg('Purge still in progress — the interlock releases when enough air volumes have swept through.', 'learn-purge');
  if (S.gt.state !== 'purged') return showSeqMsg('The unit is already ignited.');
  S.gt.state = 'ignition'; S.gt.prog = 0;
  log('info', 'Fuel admitted at ignition flow; igniters firing.');
  if (window.SFX) window.SFX.play('ignite');
}

function syncInWindow() {
  return Math.abs(S.sync.phase) < 15 && Math.abs(S.sync.df) < 0.08;
}

function actSyncGT() {
  if (S.gt.state !== 'fsnl') {
    if (S.gt.state === 'online') return showSeqMsg('G1 is already synchronized.');
    return showSeqMsg('The machine must be at full speed, no load (3,600 rpm) before its breaker may close — synchronous speed is what makes 60 Hz.', 'learn-sync');
  }
  if (!syncInWindow()) {
    return showSeqMsg(`Sync-check relay blocked the closure: phase error ${r0(Math.abs(S.sync.phase))}°. Closing out of phase would slam the rotor into step with brutal torque. Wait for the needle near 12 o’clock.`, 'learn-sync');
  }
  S.gt.state = 'online'; S.gt.mw = 8; S.gt.set = Math.max(S.gt.set, CFG.gtMin);
  S.starts++;
  const wear = startClass() === 'cold' ? 1.2 : startClass() === 'warm' ? 0.8 : 0.5;
  S.health.gt = Math.max(0, S.health.gt - wear);
  S.done.sync = true;
  if (window.SFX) window.SFX.play('sync');
  log('good', `G1 synchronized to the grid (${startClass()} start). Loading — hold near minimum load until the HRSG drum is warm.`, 'learn-sync');
  showSeqMsg('On line. Watch the HRSG warm-up rate: keep it under 3.5 °C/min by holding GT load down until the drum passes ~250 °C.', 'learn-stress');
}

function actRollST() {
  if (S.wreck.hrsg) return showSeqMsg('The HRSG suffered a catastrophic failure — no steam can be raised until it is rebuilt.', 'learn-catastrophic');
  if (S.wreck.cond) return showSeqMsg('The condenser was destroyed — the steam turbine has nowhere to exhaust to until it is rebuilt.', 'learn-catastrophic');
  if (S.st.state !== 'off') return showSeqMsg('The steam turbine is already rolling or on line.');
  if (S.lockout) return showSeqMsg('Alarms are locked out — reset alarms first.');
  if (S.gt.state !== 'online') return showSeqMsg('No steam without the gas turbine: the HRSG is heated only by GT exhaust.', 'learn-cc');
  const mb = maintBlocks('st');
  if (mb) return showSeqMsg(`Steam side tagged out for maintenance (${mb}).`);
  if (steamPressure() < 30) return showSeqMsg(`Steam pressure is ${r0(steamPressure())} bar — below the 30 bar needed to roll. Let the HRSG keep warming (drum is at ${r0(S.hrsg.drumT)} °C).`, 'learn-stress');
  if (S.fans.filter(Boolean).length < 2) return showSeqMsg('Start at least two cooling-tower fan cells first — rolling steam into a condenser with no cooling will lose vacuum immediately.', 'learn-vacuum');
  S.st.state = 'rolling'; S.st.rpm = 0;
  S.done.roll = true;
  log('info', 'Steam admitted to the steam turbine — rolling up to 3,600 rpm.');
}

function actSyncST() {
  if (S.st.state === 'online') return showSeqMsg('G2 is already synchronized.');
  if (S.st.state !== 'fsnl') return showSeqMsg('The steam turbine must reach 3,600 rpm before its breaker may close.', 'learn-sync');
  if (!syncInWindow()) {
    return showSeqMsg(`Sync-check relay blocked the closure: phase error ${r0(Math.abs(S.sync.phase))}°. Wait for the needle near 12 o’clock.`, 'learn-sync');
  }
  S.st.state = 'online'; S.st.admission = 0.08;
  S.done.sync2 = true;
  if (window.SFX) window.SFX.play('sync');
  log('good', 'G2 synchronized — combined-cycle operation. Steam admission increases over the next ~20 minutes.', 'learn-cc');
}

function actShutdownST() {
  if (S.st.state !== 'online') return showSeqMsg('The steam turbine is not on line.');
  S.st.autoStop = true;
  log('info', 'ST normal shutdown: unloading steam admission, breaker opens at low load.');
}

function actShutdownGT() {
  if (S.gt.state !== 'online') return showSeqMsg('The gas turbine is not on line.');
  if (S.st.state !== 'off') return showSeqMsg('Shut down the steam turbine first. Killing the GT now would slam the steam supply shut and trip the ST — always unload the bottoming cycle before the topping cycle.', 'learn-cc');
  S.gt.autoStop = true;
  log('info', 'GT normal shutdown: ramping to minimum load, then the breaker opens.');
}

function actOpenGT() {
  if (S.gt.state !== 'online') return showSeqMsg('The GT breaker is already open.');
  if (S.gt.mw > 15) {
    S.health.gt = Math.max(0, S.health.gt - 2.5);
    if (S.health.gt < 15 && Math.random() < 0.4) {
      wreckComponent('gt', `overspeed disc burst — opening the breaker at ${r0(S.gt.mw)} MW freed the turbine to accelerate with nothing holding it back, and a rotor already near end-of-life didn't survive.`);
    } else {
      tripGT(`load rejection at ${r0(S.gt.mw)} MW — the freed machine surged toward overspeed and the protection tripped it. Opening a loaded breaker dumps all that torque into pure acceleration; use a normal shutdown instead.`, 'learn-sync');
    }
  } else {
    S.gt.state = 'off'; S.gt.mw = 0; S.gt.set = 0; S.gt.offlineAt = S.t;
    log('info', 'GT breaker opened at low load.');
    if (S.st.state !== 'off') tripST('loss of steam supply (GT off line)');
  }
}

function actResetAlarms() {
  if (!S.lockout) return showSeqMsg('No lockout is active.');
  if (S.gt.state !== 'off' || S.st.state !== 'off') return showSeqMsg('Units must be fully off line to reset.');
  S.lockout = false;
  S.banner = null;
  log('info', 'Alarms reset. Master lockout cleared — the unit may be restarted.');
  showSeqMsg('Lockout cleared. In a real plant you would only reset after the trip cause is understood and corrected.');
}

/* ----- synchroscope (runs on a fast UI timer; cosmetic dynamics) ----- */

function syncActive() {
  return S && (S.gt.state === 'fsnl' || S.st.state === 'fsnl');
}

setInterval(() => {
  if (!S) return;
  const scope = el['syncscope'];
  if (!syncActive()) { if (scope) scope.classList.remove('show'); return; }
  scope.classList.add('show');
  const sy = S.sync;
  if (S.speed > 0) {
    sy.df = clamp(sy.df + (Math.random() - 0.5) * 0.004, -0.12, 0.12);
    if (S.autosync) sy.df = lerp(sy.df, 0.012, 0.06); // auto-sync trims the governor itself
    sy.phase += sy.df * 360 * 0.12;
    if (sy.phase > 180) sy.phase -= 360;
    if (sy.phase < -180) sy.phase += 360;
    if (S.autosync && syncInWindow()) {
      sy.hold++;
      if (sy.hold > 4) { sy.hold = 0; (S.gt.state === 'fsnl' ? actSyncGT : actSyncST)(); renderAll(); }
    } else sy.hold = 0;
  }
  el['sync-unit'].textContent = S.gt.state === 'fsnl' ? 'GT / G1' : 'ST / G2';
  el['sync-freq'].textContent = (60 + sy.df).toFixed(2);
  el['sync-phase'].textContent = (sy.phase >= 0 ? '+' : '−') + Math.abs(sy.phase).toFixed(0);
  el['sync-needle'].setAttribute('transform', `rotate(${sy.phase.toFixed(1)} 45 45)`);
  el['sync-ok'].style.visibility = syncInWindow() ? 'visible' : 'hidden';
}, 120);

/* ----- render: top bar, schematic, tiles ----- */

function renderTop(info) {
  el['tb-clock'].textContent = fmtClock(S.t);
  el['tb-weather'].textContent = `${r0(ambientT())} °C` + (S.event ? ` · ${EVENTS[S.event.idx].name}` : '');
  el['tb-net'].textContent = `${r0(Math.max(0, info.net))} MW`;
  el['tb-demand'].textContent = `${r0(info.demand)} MW`;
  el['tb-price'].textContent = `$${r0(info.price)} /MWh`;
  el['tb-budget'].textContent = fmtMoney(S.budget);

  const b = el['alarm-banner'];
  if (S.banner) {
    b.className = `alarm-banner show ${SEV[S.banner.sev].cls}`;
    el['alarm-glyph'].textContent = SEV[S.banner.sev].glyph;
    el['alarm-text'].textContent = S.banner.msg;
  } else b.className = 'alarm-banner';
}

function plantHealth() {
  const h = S.health;
  return Math.round(h.gt * 0.30 + h.hrsg * 0.22 + h.st * 0.22 + h.cond * 0.13 + h.ct * 0.13);
}

function renderSchematic(info) {
  const fired = gtFlows().fuel > 0;
  const stOn = S.st.state === 'online';
  const steamMoving = info.steamMW > 2;

  setCompStatus('c-gt', S.health.gt, fired, S.wreck.gt);
  setCompStatus('c-hrsg', S.health.hrsg, steamMoving, S.wreck.hrsg);
  setCompStatus('c-st', S.health.st, stOn);
  setCompStatus('c-cond', S.health.cond, steamMoving, S.wreck.cond);
  setCompStatus('c-ct', S.health.ct, S.fans.some(Boolean));
  setCompStatus('c-gen1', S.gt.state === 'online' ? 100 : 90, S.gt.state === 'online');
  setCompStatus('c-gen2', stOn ? 100 : 90, stOn);
  setCompStatus('c-filter', 100 - S.filterDp * 100, fired);

  const flow = (id, on) => { $(id).classList.toggle('flowing', !!on); };
  flow('p-air', fired || S.gt.state === 'purge');
  flow('p-fuel', fired);
  flow('p-exhaust', fired || S.gt.state === 'purge');
  flow('p-stack', fired);
  flow('p-steam', stOn && steamMoving);
  flow('p-stcond', steamMoving);
  flow('p-cw-out', S.fans.some(Boolean) && steamMoving);
  flow('p-cw-ret', S.fans.some(Boolean) && steamMoving);
  flow('p-feed', steamMoving);

  el['h-gt'].textContent = S.wreck.gt ? 'WRECKED — rebuild needed' : `health ${r0(S.health.gt)}%`;
  el['h-hrsg'].textContent = S.wreck.hrsg ? 'WRECKED — rebuild needed' : `health ${r0(S.health.hrsg)}%`;
  el['h-st'].textContent = `health ${r0(S.health.st)}%`;
  el['h-cond'].textContent = S.wreck.cond ? 'WRECKED — rebuild needed' : `health ${r0(S.health.cond)}%`;
  el['h-ct'].textContent = `health ${r0(S.health.ct)}%`;
  el['h-filter'].textContent = S.filterDp > 0.6 ? `ΔP high (${r0(S.filterDp * 100)}%)` : `ΔP ${r0(S.filterDp * 100)}%`;
  el['t-gt-rpm'].textContent = `${r0(S.gt.rpm)} rpm`;
  el['t-st-rpm'].textContent = `${r0(S.st.rpm)} rpm`;
  el['t-gt-mw'].textContent = `${r0(S.gt.mw)} MW`;
  el['t-st-mw'].textContent = `${r0(S.st.mw)} MW`;
  el['t-drum'].textContent = `drum ${r0(S.hrsg.drumT)} °C`;
  el['t-vac'].textContent = `vacuum ${r1(S.cond.pk)} kPa`;
  el['t-fans'].textContent = `fans ${S.fans.filter(Boolean).length}/4`;

  const ph = plantHealth();
  const hs = healthStatus(ph);
  const anyWreck = S.wreck.gt || S.wreck.hrsg || S.wreck.cond;
  el['ring-pct'].textContent = `${ph}%`;
  el['ring-desc'].textContent = anyWreck ? '☠ Catastrophic failure — rebuild required' : `${hs.glyph} Plant health — ${hs.word}`;
  const C = 2 * Math.PI * 26;
  el['ring-arc'].setAttribute('stroke-dasharray', `${(ph / 100) * C} ${C}`);
  const ringColor = anyWreck ? '#d03b3b' : { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' }[hs.key];
  el['ring-arc'].setAttribute('stroke', ringColor);
}

function renderTiles(info) {
  el['tile-net'].textContent = r0(Math.max(0, info.net));
  el['tile-eff'].textContent = info.effNet > 0 ? r1(info.effNet * 100) : '—';
  el['tile-hr'].textContent = info.effNet > 0 ? r0(3412 / info.effNet) : '—';
  el['tile-fuel'].textContent = r0(info.fuelMMBtuH);
  el['tile-co2'].textContent = r1(info.fuelMMBtuH * CFG.co2PerMMBtu * (S.gt.fuel === 'oil' ? 1.35 : 1));
  el['tile-margin'].textContent = fmtMoney(S.lastMargin) + '/h';
  el['tile-margin'].parentElement.parentElement.querySelector('.delta').className =
    'delta ' + (S.lastMargin > 0 ? 'up' : S.lastMargin < -100 ? 'down' : '');
  drawSpark('spark-net', S.hist.net);
  drawSpark('spark-eff', S.hist.eff);
}

/* ----- sequence panel ----- */

const GT_LABELS = {
  off: () => S.lockout ? 'Tripped — lockout' : `Offline — ${startClass()} (${r0((S.t - S.gt.offlineAt) / 60)} h)`,
  purge: () => 'Purging gas path…',
  purged: () => 'Purge complete — ready to ignite',
  ignition: () => 'Igniting…',
  accel: () => 'Accelerating to 3,600 rpm',
  fsnl: () => 'FSNL — ready to synchronize',
  online: () => S.gt.autoStop ? 'Unloading for shutdown' : `On line — ${r0(S.gt.mw)} MW`,
};

const ST_LABELS = {
  off: () => S.lockout ? 'Tripped — lockout' : (steamPressure() >= 30 && S.gt.state === 'online' ? 'Ready to roll' : 'Offline'),
  rolling: () => 'Rolling on steam',
  fsnl: () => 'FSNL — ready to synchronize',
  online: () => S.st.autoStop ? 'Unloading for shutdown'
    : (S.st.admission < 1 ? `Loading — admission ${r0(S.st.admission * 100)}%` : `On line — ${r0(S.st.mw)} MW`),
};

function renderSequence() {
  el['st-gt-state'].textContent = GT_LABELS[S.gt.state]();
  el['st-st-state'].textContent = ST_LABELS[S.st.state]();

  let gp = 0;
  if (S.gt.state === 'purge' || S.gt.state === 'ignition') gp = S.gt.prog;
  else if (S.gt.state === 'accel') gp = S.gt.rpm / 3600;
  else if (S.gt.state === 'online') gp = S.gt.mw / gtAvailable();
  else if (S.gt.state === 'fsnl' || S.gt.state === 'purged') gp = 1;
  el['prog-gt'].style.width = `${clamp(gp, 0, 1) * 100}%`;

  let sp = 0;
  if (S.st.state === 'rolling') sp = S.st.rpm / 3600;
  else if (S.st.state === 'fsnl') sp = 1;
  else if (S.st.state === 'online') sp = S.st.mw / CFG.stRating;
  el['prog-st'].style.width = `${clamp(sp, 0, 1) * 100}%`;

  // highlight the next expected action
  const next =
    S.lockout ? 'btn-reset-alarms' :
    S.gt.state === 'off' ? 'btn-purge' :
    S.gt.state === 'purged' ? 'btn-ignite' :
    S.gt.state === 'fsnl' ? 'btn-sync-gt' :
    (S.gt.state === 'online' && S.st.state === 'off' && steamPressure() >= 30) ? 'btn-roll-st' :
    S.st.state === 'fsnl' ? 'btn-sync-st' : null;
  ['btn-purge', 'btn-ignite', 'btn-sync-gt', 'btn-roll-st', 'btn-sync-st', 'btn-reset-alarms']
    .forEach((id) => el[id].classList.toggle('primary', id === next));

  // checklist
  if (S.fans.filter(Boolean).length >= 2) S.done.fans = true;
  if (S.gt.state !== 'off') S.done.purgeStart = true;
  if (['accel', 'fsnl', 'online'].includes(S.gt.state)) S.done.ignite = true;
  if (S.hrsg.drumT >= 250 && steamPressure() >= 30) S.done.warm = true;
  const map = { 'fs-fans': 'fans', 'fs-fuel': 'fuel', 'fs-purge': 'purgeStart', 'fs-ignite': 'ignite',
                'fs-sync': 'sync', 'fs-warm': 'warm', 'fs-roll': 'roll', 'fs-sync2': 'sync2' };
  for (const [li, key] of Object.entries(map)) $(li).classList.toggle('done', !!S.done[key]);
}

/* ----- control panels ----- */

function renderControls(info) {
  el['gt-set-val'].textContent = `${r0(S.gt.set)} MW`;
  const avail = gtAvailable();
  el['gt-out'].textContent = `${r0(S.gt.mw)} / ${r0(avail)} MW`;
  const f = gtFlows();
  el['gt-eff'].textContent = f.eff ? `${r1(f.eff * 100)} % (GT alone)` : '—';
  el['btn-wash-online'].disabled = !(S.gt.state === 'online' && S.gt.mw / avail < 0.8 && S.water >= 20);

  el['ro-drum'].textContent = `${r0(S.hrsg.drumT)} °C`;
  el['ro-press'].textContent = `${r0(steamPressure())} bar`;
  const rate = S.hrsg.rate;
  el['ro-rate'].textContent = `${r1(Math.max(0, rate))} °C/min` + (rate > CFG.safeWarmRate ? ' — TOO FAST' : '');
  el['ro-rate'].style.color = rate > CFG.safeWarmRate ? '#d03b3b' : '';
  el['ro-steampath'].textContent =
    info.steamMW < 2 ? '—' :
    S.st.state === 'online' ? 'to steam turbine' : 'bypass to condenser';

  el['chk-duct'].checked = S.duct.on;
  el['chk-duct'].disabled = false;
  el['row-duct'].style.display = S.duct.on ? 'flex' : 'none';
  el['duct-val'].textContent = `${S.duct.level} %`;

  el['ro-vac'].textContent = `${r1(S.cond.pk)} kPa abs` + (S.cond.pk > 16 ? ' — HIGH' : '');
  el['ro-vac'].style.color = S.cond.pk > 16 ? '#d03b3b' : '';
  el['ro-cool'].textContent = `${r0(info.duty)} / ${r0(info.cap)} MWth`;
  document.querySelectorAll('.chk-fan').forEach((c) => { c.checked = S.fans[+c.dataset.fan]; });
  el['chk-scr'].checked = S.scr;
  el['chk-evap'].checked = S.evap;
  el['chk-autosync'].checked = S.autosync;
}

/* ----- maintenance tab ----- */

const METERS = [
  { key: 'gt', name: 'Gas turbine' },
  { key: 'hrsg', name: 'HRSG' },
  { key: 'st', name: 'Steam turbine' },
  { key: 'cond', name: 'Condenser' },
  { key: 'ct', name: 'Cooling tower' },
];

let maintSig = '';
function renderMaintenance(force) {
  // Rebuild only when displayed values change, so buttons aren't replaced mid-click.
  const sig = JSON.stringify([
    METERS.map((m) => r0(S.health[m.key])), r0(S.filterDp * 100), r0(S.foul * 100),
    r0(S.water), r0(S.ammonia), S.orders.map((o) => o.what),
    S.maint && [S.maint.id, Math.ceil(S.maint.remain / 60)],
    S.wreck.gt, S.wreck.hrsg, S.wreck.cond,
  ]);
  if (!force && sig === maintSig) return;
  maintSig = sig;

  const box = el['health-meters'];
  box.innerHTML = '';
  for (const m of METERS) {
    const h = S.health[m.key];
    const wrecked = S.wreck && S.wreck[m.key];
    const st = healthStatus(h);
    const cls = wrecked ? 'critical' : st.key;
    const label = wrecked
      ? '<span class="glyph">☠</span>WRECKED — rebuild required'
      : `<span class="glyph">${st.glyph}</span>${r0(h)}% · ${st.word}`;
    box.insertAdjacentHTML('beforeend',
      `<div class="meter-row"><span class="name">${m.name}</span>
        <div class="meter m-${cls}"><div class="fill" style="width:${h}%"></div></div>
        <span class="stat g-${cls}">${label}</span></div>`);
  }
  const extra = [
    { name: 'Inlet filter loading', v: S.filterDp * 100, inv: true },
    { name: 'Compressor fouling', v: S.foul * 100, inv: true },
  ];
  for (const x of extra) {
    const st = healthStatus(100 - x.v);
    box.insertAdjacentHTML('beforeend',
      `<div class="meter-row"><span class="name">${x.name}</span>
        <div class="meter m-${st.key}"><div class="fill" style="width:${x.v}%"></div></div>
        <span class="stat g-${st.key}"><span class="glyph">${st.glyph}</span>${r0(x.v)}% fouled</span></div>`);
  }

  // consumables
  const c = el['consumables'];
  c.innerHTML = '';
  const waterPct = S.water / CFG.waterMax * 100;
  const wSt = healthStatus(waterPct);
  const aSt = healthStatus(S.ammonia);
  const pending = (what) => S.orders.some((o) => o.what === what);
  c.insertAdjacentHTML('beforeend',
    `<div class="consumable-row"><span class="cname">Demin water</span>
      <div class="meter m-${wSt.key}"><div class="fill" style="width:${waterPct}%"></div></div>
      <span class="stat">${r0(S.water)} m³</span>
      <button class="btn" data-order="water" ${pending('water') ? 'disabled' : ''}>${pending('water') ? 'Truck en route…' : 'Order 400 m³ — $12k (1 h)'}</button></div>
     <div class="consumable-row"><span class="cname">SCR ammonia</span>
      <div class="meter m-${aSt.key}"><div class="fill" style="width:${S.ammonia}%"></div></div>
      <span class="stat">${r0(S.ammonia)} %</span>
      <button class="btn" data-order="ammonia" ${pending('ammonia') ? 'disabled' : ''}>${pending('ammonia') ? 'Truck en route…' : 'Refill — $8k (2 h)'}</button></div>`);
  c.querySelectorAll('[data-order]').forEach((b) => {
    b.onclick = () => orderConsumable(b.dataset.order);
  });

  // work orders — normal jobs hide once their unit is wrecked; rebuild jobs
  // only appear once there's something to rebuild
  const t = el['task-list'];
  t.innerHTML = '';
  const visible = TASKS.filter((task) => {
    if (task.requiresWreck) return S.wreck[task.requiresWreck];
    if (task.blockedBy) return !S.wreck[task.blockedBy];
    return true;
  });
  for (const task of visible) {
    const active = S.maint && S.maint.id === task.id;
    const label = active ? `${Math.ceil(S.maint.remain / 60)} h left` : 'Schedule';
    t.insertAdjacentHTML('beforeend',
      `<div class="task${task.requiresWreck ? ' task-wreck' : ''}"><span class="t-name">${task.name}</span>
        <span class="t-desc">${task.desc}</span>
        <span class="t-meta">${task.hours} h · ${fmtMoney(task.cost)} · requires ${task.needs === 'gtOff' ? 'GT off line' : 'ST off line'}</span>
        <button class="btn ${active ? '' : 'primary'}" data-task="${task.id}" ${active ? 'disabled' : ''}>${label}</button></div>`);
  }
  t.querySelectorAll('[data-task]').forEach((b) => { b.onclick = () => scheduleTask(b.dataset.task); });
}

function showMaintMsg(text) {
  const box = el['maint-msg'];
  box.textContent = text;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 6000);
}

function orderConsumable(what) {
  const cost = what === 'water' ? 12000 : 8000;
  const delay = what === 'water' ? 60 : 120;
  S.budget -= cost;
  S.orders.push({ what, remain: delay });
  log('info', `${what === 'water' ? 'Demin water' : 'Ammonia'} ordered — delivery in ${delay / 60} h.`);
  renderMaintenance();
}

function scheduleTask(id) {
  const task = TASKS.find((x) => x.id === id);
  if (task.requiresWreck && !S.wreck[task.requiresWreck]) return showMaintMsg('Nothing to rebuild — this component has not suffered a catastrophic failure.');
  if (task.blockedBy && S.wreck[task.blockedBy]) return showMaintMsg('This component was destroyed — only a full rebuild is possible now.');
  if (S.maint) return showMaintMsg(`One crew at a time: "${TASKS.find((x) => x.id === S.maint.id).name}" is still in progress.`);
  if (task.needs === 'gtOff' && S.gt.state !== 'off') return showMaintMsg('This job needs the gas turbine off line and cool. Shut the unit down first (ST, then GT).');
  if (task.needs === 'stOff' && S.st.state !== 'off') return showMaintMsg('This job needs the steam side off line. Shut down the steam turbine first.');
  if (S.budget < task.cost) return showMaintMsg(`Not enough budget: this job costs ${fmtMoney(task.cost)}.`);
  S.budget -= task.cost;
  S.maint = { id, remain: task.hours * 60 };
  log('info', `Maintenance started: ${task.name} (${task.hours} h). The unit is tagged out until work completes.`);
  renderMaintenance();
}

/* ----- market tab ----- */

function renderMarket(info) {
  el['sc-profit'].textContent = fmtMoney(S.profit);
  el['sc-mwh'].textContent = r0(S.mwh);
  el['sc-served'].textContent = S.servedN ? r0(S.servedSum / S.servedN * 100) : '—';
  el['sc-trips'].textContent = S.trips;
  el['sc-starts'].textContent = S.starts;
  el['sc-co2'].textContent = r0(S.co2);
  el['sc-melt'].textContent = S.meltdowns;
  el['mk-demand'].textContent = `${r0(info.demand)} MW`;
  el['mk-price'].textContent = `$${r1(info.price)} /MWh`;
  el['mk-gas'].textContent = `$${gasPrice().toFixed(2)} /MMBtu` + (S.gt.fuel === 'oil' ? ' (burning oil at 1.4×)' : '');
  const hr = info.effNet > 0 ? 3412 / info.effNet : 6100;
  el['mk-breakeven'].textContent = `$${r1(hr * gasPrice() / 1000 + CFG.omPerHour / 250)} /MWh`;

  const ev = el['events-log'];
  ev.innerHTML = S.events.length ? '' : '<div style="color:#898781;font-size:13px">No events yet — the grid is quiet.</div>';
  for (const e of S.events) {
    ev.insertAdjacentHTML('beforeend',
      `<div class="log-entry"><span class="t">${fmtClock(e.t)}</span><span class="m">${e.msg}</span></div>`);
  }
}

/* ----- alarm log ----- */

let lastLogLen = -1;
function renderLog() {
  if (S.log.length === lastLogLen) return;
  lastLogLen = S.log.length;
  const box = el['log'];
  box.innerHTML = '';
  for (const e of S.log.slice(0, 120)) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `<span class="t">${fmtClock(e.t)}</span><span class="glyph g-${e.sev === 'critical' ? 'critical' : e.sev === 'serious' ? 'serious' : e.sev === 'warning' ? 'warning' : 'good'}">${SEV[e.sev].glyph}</span><span class="m"></span>`;
    div.querySelector('.m').textContent = e.msg;
    if (e.learnId) {
      const a = document.createElement('span');
      a.className = 'why'; a.textContent = 'why?';
      a.onclick = () => gotoLearn(e.learnId);
      div.querySelector('.m').append(' ', a);
    }
    box.appendChild(div);
  }
}

/* ----- sparklines & trend chart ----- */

function drawSpark(id, data) {
  const svg = $(id);
  const W = +svg.viewBox.baseVal.width, H = +svg.viewBox.baseVal.height;
  const d = data.slice(-60);
  if (d.length < 2) { svg.innerHTML = ''; return; }
  const max = Math.max(...d, 1), min = Math.min(...d, 0);
  const x = (i) => (i / (d.length - 1)) * (W - 8) + 2;
  const y = (v) => H - 4 - ((v - min) / (max - min || 1)) * (H - 8);
  const pts = d.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lx = x(d.length - 1), ly = y(d[d.length - 1]);
  svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="#c3c2b7" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="4" fill="#2a78d6" stroke="#fcfcfb" stroke-width="2"/>`;
}

const TREND = { W: 760, H: 220, L: 44, R: 74, T: 12, B: 26 };

function niceMax(v) {
  const steps = [50, 100, 150, 200, 250, 300, 350, 400, 500];
  for (const s of steps) if (v <= s) return s;
  return Math.ceil(v / 100) * 100;
}

function drawTrend() {
  const svg = el['trend'];
  const net = S.hist.net.slice(-180), dem = S.hist.demand.slice(-180);
  const n = net.length;
  if (n < 2) { svg.innerHTML = ''; return; }
  const { W, H, L, R, T, B } = TREND;
  const pw = W - L - R, ph = H - T - B;
  const yMax = niceMax(Math.max(...net, ...dem) * 1.08);
  const xi = (i) => L + ((i + (180 - n)) / 179) * pw; // right-aligned window
  const Y = (v) => T + ph - (v / yMax) * ph;

  let out = '';
  for (let g = 0; g <= 4; g++) {
    const v = (yMax / 4) * g, yy = Y(v);
    out += `<line class="gridline" x1="${L}" y1="${yy}" x2="${L + pw}" y2="${yy}"/>`;
    out += `<text x="${L - 6}" y="${yy + 4}" text-anchor="end">${r0(v)}</text>`;
  }
  out += `<line class="axisline" x1="${L}" y1="${T + ph}" x2="${L + pw}" y2="${T + ph}"/>`;
  for (let hAgo = 3; hAgo >= 0; hAgo--) {
    const idx = 179 - hAgo * 60;
    if (idx >= 180 - n) {
      out += `<text x="${L + (idx / 179) * pw}" y="${H - 8}" text-anchor="middle">${hAgo === 0 ? 'now' : `−${hAgo}h`}</text>`;
    }
  }
  const path = (d) => d.map((v, i) => `${i === 0 ? 'M' : 'L'}${xi(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  out += `<path class="series" d="${path(dem)}" stroke="#eda100"/>`;
  out += `<path class="series" d="${path(net)}" stroke="#2a78d6"/>`;

  // direct end labels (relief rule for sub-3:1 hues); nudge apart if colliding.
  // The colored dot carries identity; the words stay in ink.
  let yN = Y(net[n - 1]), yD = Y(dem[n - 1]);
  if (Math.abs(yN - yD) < 14) { if (yN < yD) { yN -= (14 - (yD - yN)) / 2; yD += 7; } else { yD -= 7; yN += 7; } }
  out += `<text class="end-label" x="${L + pw + 6}" y="${yD + 4}"><tspan fill="#eda100">●</tspan> Demand</text>`;
  out += `<text class="end-label" x="${L + pw + 6}" y="${yN + 4}"><tspan fill="#2a78d6">●</tspan> Net</text>`;
  svg.innerHTML = out;
}

/* trend hover tooltip */
function bindTrendHover() {
  const svg = el['trend'], tip = el['chart-tip'];
  const move = (ev) => {
    const net = S.hist.net.slice(-180), dem = S.hist.demand.slice(-180);
    const n = net.length;
    if (n < 2) return;
    const rect = svg.getBoundingClientRect();
    const { W, L, R } = TREND;
    const px = (ev.clientX - rect.left) / rect.width * W;
    const pw = W - L - R;
    let slot = Math.round(((px - L) / pw) * 179);
    slot = clamp(slot, 180 - n, 179);
    const i = slot - (180 - n);
    const minsAgo = n - 1 - i;
    tip.style.display = 'block';
    tip.innerHTML = `<div class="tip-t">${minsAgo === 0 ? 'now' : minsAgo + ' min ago'}</div>
      <div class="tip-row"><span class="key" style="background:#2a78d6;width:10px;height:3px;display:inline-block;border-radius:2px"></span> Net ${r0(net[i])} MW</div>
      <div class="tip-row"><span class="key" style="background:#eda100;width:10px;height:3px;display:inline-block;border-radius:2px"></span> Demand ${r0(dem[i])} MW</div>`;
    const tx = clamp(ev.clientX - rect.left + 14, 0, rect.width - 150);
    tip.style.left = tx + 'px';
    tip.style.top = '10px';
  };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

/* ----- tabs ----- */

function switchTab(name) {
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => {
    b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-page').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${name}`);
  });
}

/* ----- master render ----- */

function renderAll() {
  const info = lastTickInfo;
  renderTop(info);
  renderSchematic(info);
  renderTiles(info);
  renderSequence();
  renderControls(info);
  renderLog();
  drawTrend();
  if ($('tab-maintain').classList.contains('active')) renderMaintenance();
  if ($('tab-market').classList.contains('active')) renderMarket(info);
}

/* ---------------- persistence ---------------- */

const SAVE_KEY = 'ccgs-save-v1';

function save(auto) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(S));
    if (!auto) {
      $('save-note').textContent = 'Saved.';
      setTimeout(() => { $('save-note').textContent = ''; }, 2500);
    }
  } catch (e) { /* storage unavailable — play on */ }
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === 1) {
      S = parsed;
      if (!S.wreck) S.wreck = { gt: false, hrsg: false, cond: false };
      if (S.meltdowns == null) S.meltdowns = 0;
      return true;
    }
  } catch (e) { /* corrupt save — start fresh */ }
  return false;
}

/* ---------------- wiring ---------------- */

function bind() {
  document.querySelectorAll('.speed-btn').forEach((b) => {
    b.onclick = () => {
      S.speed = +b.dataset.speed;
      document.querySelectorAll('.speed-btn').forEach((x) =>
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    };
  });

  document.querySelectorAll('.tabs [role=tab]').forEach((b) => {
    b.onclick = () => { if (window.SFX) window.SFX.play('tab'); switchTab(b.dataset.tab); renderAll(); };
  });

  // soft UI-click feedback on every button/checkbox/radio, layered under the
  // richer mechanical cues played at specific action sites
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, input[type=checkbox], input[type=radio]');
    if (t && !t.disabled && window.SFX) window.SFX.play('click');
  }, true);

  el['btn-purge'].onclick = () => { actPurge(); renderAll(); };
  el['btn-ignite'].onclick = () => { actIgnite(); renderAll(); };
  el['btn-sync-gt'].onclick = () => { actSyncGT(); renderAll(); };
  el['btn-roll-st'].onclick = () => { actRollST(); renderAll(); };
  el['btn-sync-st'].onclick = () => { actSyncST(); renderAll(); };
  el['btn-shutdown-st'].onclick = () => { actShutdownST(); renderAll(); };
  el['btn-shutdown-gt'].onclick = () => { actShutdownGT(); renderAll(); };
  el['btn-open-gt'].onclick = () => { actOpenGT(); renderAll(); };
  el['btn-reset-alarms'].onclick = () => { actResetAlarms(); renderAll(); };
  el['chk-autosync'].onchange = (e) => { S.autosync = e.target.checked; };
  $('btn-gov-up').onclick = () => { S.sync.df = clamp(S.sync.df + 0.008, -0.12, 0.12); };
  $('btn-gov-dn').onclick = () => { S.sync.df = clamp(S.sync.df - 0.008, -0.12, 0.12); };

  // remove initial disabled state — refusals explain instead
  ['btn-purge', 'btn-ignite', 'btn-sync-gt', 'btn-roll-st', 'btn-sync-st',
   'btn-shutdown-st', 'btn-shutdown-gt', 'btn-open-gt', 'btn-reset-alarms']
    .forEach((id) => { el[id].disabled = false; });

  document.querySelectorAll('input[name=fuel]').forEach((rb) => {
    rb.onchange = () => {
      if (S.gt.state !== 'off') {
        showSeqMsg('Fuel transfer while running is a specialized procedure — in this simulator, change fuel only while the GT is off line.');
        document.querySelector(`input[name=fuel][value=${S.gt.fuel}]`).checked = true;
        return;
      }
      S.gt.fuel = rb.value; S.done.fuel = true;
      log('info', `Fuel selected: ${rb.value === 'gas' ? 'natural gas' : 'distillate oil'}.`);
    };
  });

  document.querySelectorAll('input[name=ramp]').forEach((rb) => {
    rb.onchange = () => { S.gt.mode = rb.value; };
  });

  document.querySelectorAll('input[name=dispatch]').forEach((rb) => {
    rb.onchange = () => { S.dispatch = rb.value; };
  });

  const stepGT = (d) => {
    if (S.gt.state !== 'online') { showSeqMsg('Load setpoint acts once G1 is synchronized — a breaker-open machine can’t take load.', 'learn-sync'); return; }
    if (S.dispatch === 'follow') { showSeqMsg('Dispatch is set to follow city demand. Switch to Manual to move the setpoint yourself.'); return; }
    S.gt.set = clamp(S.gt.set + d, CFG.gtMin, Math.ceil(gtAvailable()));
    renderAll();
  };
  $('btn-gt-up').onclick = () => stepGT(+10);
  $('btn-gt-dn').onclick = () => stepGT(-10);

  el['chk-evap'].onchange = (e) => {
    if (e.target.checked && S.water < 50) {
      showSeqMsg('Not enough demin water for the evaporative cooler — order a delivery first.');
      e.target.checked = false; return;
    }
    S.evap = e.target.checked;
    if (S.evap) log('info', 'Evaporative inlet cooler in service — recovers hot-day capacity at the cost of demin water.');
  };

  el['chk-duct'].onchange = (e) => {
    if (e.target.checked && S.st.state !== 'online') {
      showSeqMsg('Duct burners fire inside the HRSG and need an established steam path — synchronize the steam turbine first.', 'learn-states');
      e.target.checked = false; return;
    }
    S.duct.on = e.target.checked;
    S.duct.level = S.duct.on ? 50 : 0;
    if (S.duct.on) log('info', 'Duct burners in service — more steam-side MW at a worse heat rate. Best used when prices are high.', 'learn-econ');
    renderAll();
  };
  $('btn-duct-up').onclick = () => { S.duct.level = clamp(S.duct.level + 10, 10, 100); renderAll(); };
  $('btn-duct-dn').onclick = () => { S.duct.level = clamp(S.duct.level - 10, 10, 100); renderAll(); };

  document.querySelectorAll('.chk-fan').forEach((c) => {
    c.onchange = () => { S.fans[+c.dataset.fan] = c.checked; renderAll(); };
  });

  el['chk-scr'].onchange = (e) => { S.scr = e.target.checked; };

  const cutawayChk = $('chk-cutaway');
  if (cutawayChk) {
    cutawayChk.onchange = (e) => { if (window.Particles) window.Particles.setEnabled(e.target.checked); };
  }

  el['btn-wash-online'].onclick = () => {
    S.budget -= 2000; S.water = Math.max(0, S.water - 20);
    S.foul = Math.max(0, S.foul - 0.15);
    log('good', 'Online compressor wash complete — some fouling recovered. Full recovery needs an offline crank wash.');
    renderAll();
  };

  document.querySelectorAll('[data-learn]').forEach((n) => {
    n.onclick = () => gotoLearn(n.dataset.learn);
  });

  $('btn-save').onclick = () => save(false);
  $('btn-reset').onclick = () => {
    if (confirm('Start over? Your plant, budget, and history will be reset.')) {
      localStorage.removeItem(SAVE_KEY);
      S = newState();
      seedIntro();
      lastLogLen = -1;
      syncControlsFromState();
      renderAll();
    }
  };

  bindTrendHover();
}

function syncControlsFromState() {
  document.querySelector(`input[name=fuel][value=${S.gt.fuel}]`).checked = true;
  document.querySelector(`input[name=ramp][value=${S.gt.mode}]`).checked = true;
  document.querySelector(`input[name=dispatch][value=${S.dispatch}]`).checked = true;
  document.querySelectorAll('.speed-btn').forEach((x) =>
    x.setAttribute('aria-pressed', +x.dataset.speed === S.speed ? 'true' : 'false'));
}

function seedIntro() {
  log('info', 'Welcome, operator. Voltage Falls is counting on you. Work through the first-start checklist on the right — and read the Learn tab whenever a step surprises you.');
  log('info', 'Tip: prices peak in the morning (07–09) and evening (18–21). A cold start takes about an hour — plan backward from the peak.');
}

/* ---------------- main loop ---------------- */

let tickAcc = 0;
setInterval(() => {
  if (!S || S.speed === 0) { if (S) renderAll(); return; }
  tickAcc += S.speed / 4;
  let n = Math.floor(tickAcc);
  tickAcc -= n;
  n = Math.min(n, 40);
  while (n-- > 0) tick();
  renderAll();
}, 250);

/* ---------------- boot splash (brief box-art flash before the title card) ---------------- */

function bindBootSplash() {
  const boot = $('boot-splash');
  if (!boot) return;
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    boot.classList.add('hide');
    setTimeout(() => { boot.style.display = 'none'; }, 420);
  };
  const AUTO_MS = 2800;
  const timer = setTimeout(dismiss, AUTO_MS);
  const skip = () => { clearTimeout(timer); dismiss(); };
  boot.addEventListener('click', skip);
  boot.addEventListener('keydown', skip);
  document.addEventListener('keydown', skip, { once: true });
}

/* ---------------- title splash ---------------- */

function peekSavedSummary() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || p.v !== 1) return null;
    return { t: p.t, budget: Math.round(p.budget) };
  } catch (e) { return null; }
}

function dismissSplash() {
  $('splash').classList.add('dismissed');
}

function bindSplash() {
  const saved = peekSavedSummary();
  const continueBtn = $('splash-continue');
  const newBtn = $('splash-new');
  const meta = $('splash-meta');

  if (saved) {
    continueBtn.hidden = false;
    newBtn.textContent = '▶ New simulation';
    newBtn.classList.remove('primary');
    meta.textContent = `Saved game found — ${fmtClock(saved.t)}, budget ${fmtMoney(saved.budget)}.`;
  } else {
    meta.textContent = 'No saved game yet — starting fresh builds you a cold plant at 06:00.';
  }

  continueBtn.onclick = () => dismissSplash();

  newBtn.onclick = () => {
    if (saved && !confirm('Start a brand-new simulation? Your saved plant, budget, and history will be reset.')) return;
    localStorage.removeItem(SAVE_KEY);
    S = newState();
    seedIntro();
    lastLogLen = -1;
    syncControlsFromState();
    renderAll();
    dismissSplash();
  };

  $('splash-learn').onclick = () => {
    dismissSplash();
    switchTab('learn');
    renderAll();
  };
}

/* ---------------- bridge for particles.js ---------------- */

window.SimBridge = {
  state: () => S,
  gtAvailable: () => gtAvailable(),
  steamPressure: () => steamPressure(),
  ambientT: () => ambientT(),
  lastTick: () => lastTickInfo,
};

/* ---------------- audio prefs & controls ---------------- */

const MUSIC_KEY = 'ccgs-music-on';
const SFX_KEY = 'ccgs-sfx-on';

function bindAudioControls() {
  if (window.Music) window.Music.init($('bg-music'));

  const musicBtn = $('btn-music'), sfxBtn = $('btn-sfx');
  let musicOn = localStorage.getItem(MUSIC_KEY) === '1';
  let sfxOn = localStorage.getItem(SFX_KEY) !== '0'; // default on

  const paintMusic = () => { musicBtn.setAttribute('aria-pressed', musicOn ? 'true' : 'false'); };
  const paintSfx = () => { sfxBtn.setAttribute('aria-pressed', sfxOn ? 'true' : 'false'); };
  if (window.SFX) window.SFX.setEnabled(sfxOn);
  paintMusic(); paintSfx();

  musicBtn.onclick = () => {
    musicOn = !musicOn;
    localStorage.setItem(MUSIC_KEY, musicOn ? '1' : '0');
    if (window.Music) window.Music.setEnabled(musicOn);
    paintMusic();
  };
  sfxBtn.onclick = () => {
    sfxOn = !sfxOn;
    localStorage.setItem(SFX_KEY, sfxOn ? '1' : '0');
    if (window.SFX) window.SFX.setEnabled(sfxOn);
    paintSfx();
  };

  // the splash buttons are the guaranteed first user gesture — use it to
  // (re)start music if the saved preference says it should be playing
  ['splash-continue', 'splash-new', 'splash-learn'].forEach((id) => {
    const b = $(id);
    if (b) b.addEventListener('click', () => { if (musicOn && window.Music) window.Music.setEnabled(true); });
  });
}

/* ---------------- boot ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  cacheEls();
  if (!load()) { S = newState(); seedIntro(); }
  bind();
  bindSplash();
  bindBootSplash();
  bindAudioControls();
  syncControlsFromState();
  renderAll();

  const cutawayCanvas = $('cutaway-canvas');
  if (cutawayCanvas && window.Particles) window.Particles.init(cutawayCanvas);
});
