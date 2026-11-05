/**
 * Phase 11 — data-driven config loading + validation.
 *
 * The engine no longer contains a single hardcoded frame value. It asks this
 * module for a validated config. Validation matters more than it looks:
 * a typo'd `startup` silently becomes NaN, which makes every comparison in
 * the frame-data path false, and the move's hitbox never turns on. Failing
 * loudly at load beats debugging a ghost move at 60fps.
 */

const REQUIRED_MOVE_FIELDS = [
  'startup', 'active', 'recovery', 'damage', 'chip',
  'hitstun', 'blockstun', 'pushHit', 'pushBlock', 'height',
];
const VALID_HEIGHTS = ['low', 'mid', 'overhead'];

export class ConfigError extends Error {
  constructor(msg, path) {
    super(path ? `${path}: ${msg}` : msg);
    this.name = 'ConfigError';
    this.path = path;
  }
}

function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isBox(b) {
  return b && isFiniteNum(b.x) && isFiniteNum(b.y) &&
         isFiniteNum(b.w) && isFiniteNum(b.h) && b.w > 0 && b.h > 0;
}

export function validateFighter(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') throw new ConfigError('config is not an object');
  if (!cfg.id) errs.push('missing id');
  if (!cfg.moves || typeof cfg.moves !== 'object') errs.push('missing moves');

  // physics
  const P = cfg.physics || {};
  for (const k of ['gravity', 'jumpVel', 'walkSpeed', 'backSpeed', 'friction', 'maxPush']) {
    if (!isFiniteNum(P[k])) errs.push(`physics.${k} must be a finite number`);
  }
  if (isFiniteNum(P.gravity) && P.gravity <= 0) errs.push('physics.gravity must be > 0');
  if (isFiniteNum(P.jumpVel) && P.jumpVel >= 0) errs.push('physics.jumpVel must be negative (up is -y)');
  if (isFiniteNum(P.friction) && (P.friction <= 0 || P.friction > 1)) {
    errs.push('physics.friction must be in (0,1]');
  }

  // hurtboxes
  for (const key of ['stand', 'crouch', 'air', 'hit', 'ko']) {
    const list = cfg.hurtboxes?.[key];
    if (!Array.isArray(list) || list.length === 0) { errs.push(`hurtboxes.${key} missing`); continue; }
    list.forEach((b, i) => { if (!isBox(b)) errs.push(`hurtboxes.${key}[${i}] is not a valid box`); });
  }

  // moves
  for (const [name, m] of Object.entries(cfg.moves || {})) {
    for (const f of REQUIRED_MOVE_FIELDS) {
      if (!isFiniteNum(m[f]) && f !== 'height') errs.push(`moves.${name}.${f} must be a number`);
    }
    if (!VALID_HEIGHTS.includes(m.height)) {
      errs.push(`moves.${name}.height must be one of ${VALID_HEIGHTS.join('|')}`);
    }
    if (m.startup < 1) errs.push(`moves.${name}.startup must be >= 1`);
    if (m.active < 1) errs.push(`moves.${name}.active must be >= 1`);
    if (m.recovery < 0) errs.push(`moves.${name}.recovery must be >= 0`);
    if (m.damage < 0) errs.push(`moves.${name}.damage must be >= 0`);
    // a non-projectile move that deals damage needs a hitbox to deal it with
    if (!m.projectile && m.damage > 0 && !isBox(m.box)) {
      errs.push(`moves.${name}.box is required for a damaging move`);
    }
    // cancel targets must exist
    for (const t of m.cancelInto || []) {
      if (!cfg.moves[t]) errs.push(`moves.${name}.cancelInto references unknown move "${t}"`);
    }
    if (m.invuln && (!Array.isArray(m.invuln) || m.invuln.length !== 2)) {
      errs.push(`moves.${name}.invuln must be [startFrame, endFrame]`);
    }
  }

  // motions
  const NUMPAD = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  (cfg.motions || []).forEach((mo, i) => {
    if (!cfg.moves[mo.move]) errs.push(`motions[${i}] references unknown move "${mo.move}"`);
    if (!['punch', 'kick'].includes(mo.btn)) errs.push(`motions[${i}].btn must be punch|kick`);
    if (!Array.isArray(mo.seq) || mo.seq.length < 2) errs.push(`motions[${i}].seq too short`);
    for (const d of mo.seq || []) {
      if (!NUMPAD.includes(d)) errs.push(`motions[${i}].seq has invalid direction ${d}`);
    }
    if (!isFiniteNum(mo.window) || mo.window < mo.seq?.length) {
      errs.push(`motions[${i}].window must be >= seq length`);
    }
  });

  // scaling tables
  const S = cfg.scaling || {};
  for (const k of ['damage', 'hitstun', 'gravity']) {
    if (!Array.isArray(S[k]) || S[k].length === 0) { errs.push(`scaling.${k} must be a non-empty array`); continue; }
    if (S[k].some(v => !isFiniteNum(v) || v < 0)) errs.push(`scaling.${k} has invalid entries`);
  }
  // damage scaling must never increase — that would *create* infinites
  if (Array.isArray(S.damage)) {
    for (let i = 1; i < S.damage.length; i++) {
      if (S.damage[i] > S.damage[i - 1]) {
        errs.push(`scaling.damage must be non-increasing (index ${i})`); break;
      }
    }
  }
  // gravity scaling must never decrease
  if (Array.isArray(S.gravity)) {
    for (let i = 1; i < S.gravity.length; i++) {
      if (S.gravity[i] < S.gravity[i - 1]) {
        errs.push(`scaling.gravity must be non-decreasing (index ${i})`); break;
      }
    }
  }

  if (errs.length) throw new ConfigError(`invalid fighter config:\n  - ${errs.join('\n  - ')}`, cfg.id);
  return cfg;
}

export function validateRules(r) {
  const errs = [];
  for (const k of ['roundTime', 'maxRounds', 'winsNeeded', 'maxHp',
                   'inputBufferFrames', 'inputDelayFrames', 'rollbackMaxFrames']) {
    if (!isFiniteNum(r?.[k])) errs.push(`rules.${k} must be a number`);
  }
  if (r?.winsNeeded > r?.maxRounds) errs.push('rules.winsNeeded cannot exceed maxRounds');
  if (r?.inputDelayFrames > r?.rollbackMaxFrames) {
    errs.push('rules.inputDelayFrames should not exceed rollbackMaxFrames');
  }
  if (errs.length) throw new ConfigError(`invalid rules:\n  - ${errs.join('\n  - ')}`);
  return r;
}

/* ------------------------------------------------------------------ */
/* Phase 11.2 — weighted asset preloader                               */
/* ------------------------------------------------------------------ */
/**
 * Loads every manifest entry and reports weighted progress, so the bar
 * reflects real work rather than "3 of 4 files". Generated work (atlas
 * building, audio rendering) is registered as weighted steps too, because
 * on a mid-range phone building the atlas costs more than the download.
 */
export class AssetLoader {
  constructor({ base = '', fetchImpl = null } = {}) {
    this.base = base;
    this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.assets = {};
    this.totalWeight = 0;
    this.doneWeight = 0;
    this.listeners = [];
    this.errors = [];
  }
  onProgress(fn) { this.listeners.push(fn); return this; }
  _emit(label) {
    const pct = this.totalWeight ? this.doneWeight / this.totalWeight : 0;
    for (const fn of this.listeners) fn(Math.min(1, pct), label);
  }

  async loadManifest(url = 'data/manifest.json') {
    const res = await this.fetch(this.base + url);
    if (!res.ok) throw new ConfigError(`manifest fetch failed: HTTP ${res.status}`, url);
    this.manifest = await res.json();
    this.totalWeight =
      (this.manifest.data || []).reduce((s, a) => s + (a.weight || 1), 0) +
      (this.manifest.generated || []).reduce((s, a) => s + (a.weight || 1), 0);
    return this.manifest;
  }

  async loadData() {
    for (const entry of this.manifest.data || []) {
      this._emit(`loading ${entry.id}`);
      try {
        const res = await this.fetch(this.base + entry.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.assets[entry.id] = await res.json();
      } catch (e) {
        this.errors.push(`${entry.id}: ${e.message}`);
        throw new ConfigError(`failed to load "${entry.id}" (${entry.url}): ${e.message}`);
      }
      this.doneWeight += entry.weight || 1;
      this._emit(`loaded ${entry.id}`);
    }
    if (this.assets.fighter) validateFighter(this.assets.fighter);
    if (this.assets.rules) validateRules(this.assets.rules);
    return this.assets;
  }

  /** Run a generated step (atlas build, audio render) with progress. */
  async runStep(id, fn) {
    const entry = (this.manifest?.generated || []).find(g => g.id === id);
    const w = entry?.weight || 1;
    this._emit(`building ${id}`);
    // yield to the event loop so the progress bar can actually paint
    await new Promise(r => setTimeout(r, 0));
    const out = await fn();
    this.doneWeight += w;
    this._emit(`built ${id}`);
    return out;
  }
}
