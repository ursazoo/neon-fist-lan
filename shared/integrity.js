/**
 * Phase 12 — state hashing, desync detection and tamper checks.
 *
 * Threat model, stated honestly:
 *   A browser fighting game running P2P has NO trusted client. Anyone can
 *   open devtools and set hp = 999. Nothing in this file makes the client
 *   trustworthy. What it does is make cheating *detectable and unprofitable*:
 *
 *     1. Both peers hash their simulation state every N frames. Because the
 *        sim is deterministic (verified bit-identical under rollback), honest
 *        peers always agree. One tampered value diverges the hash immediately.
 *     2. On mismatch the match is voided — no Elo is awarded to anyone. A
 *        cheater cannot farm rating; the worst they achieve is a no-contest.
 *     3. Elo/win_count are written ONLY by the server, only via a
 *        SECURITY DEFINER RPC, and only when both peers' hashes agree.
 *     4. Config invariants are checked so a tampered fighter.json (giant
 *        hitboxes, 0-frame startup) is rejected before it reaches the sim.
 *
 *   A determined cheater who controls both peers can still lie. The real
 *   fix is a server-authoritative simulation; that is a deliberate,
 *   documented tradeoff, not an oversight.
 */

/* ---------------- FNV-1a 32-bit: fast, allocation-free ---------------- */
export function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function hashInts(ints, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < ints.length; i++) {
    let v = ints[i] | 0;
    h ^= v & 0xff;         h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 16) & 0xff;h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 24) & 0xff;h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Hash the authoritative slice of a fighter's state.
 * Positions are quantized to 1/64px so floating-point noise never causes a
 * false desync, while still catching any real teleport or damage edit.
 */
export function hashFighter(f) {
  return [
    Math.round(f.x * 64), Math.round(f.y * 64),
    Math.round(f.vx * 64), Math.round(f.vy * 64),
    f.face | 0, f.hp | 0, f.meter | 0,
    f.stun | 0, f.moveFrame | 0, f.combo | 0,
    f.onGround ? 1 : 0, f.invuln | 0,
    fnv1a(f.state || ''), fnv1a(f.move ? (f.move.key || f.move) : ''),
  ];
}

export function hashGameState(game, p1, p2) {
  const ints = [
    game.frame | 0, game.timer | 0, game.hitstop | 0,
    game.round | 0, fnv1a(game.phase || ''),
    p1.rounds | 0, p2.rounds | 0,
    ...hashFighter(p1), ...hashFighter(p2),
  ];
  return hashInts(ints);
}

/* ------------------------- desync detection ------------------------- */

export const DesyncState = {
  OK: 'ok',
  SUSPECT: 'suspect',       // one mismatch — could be a late rollback
  DESYNCED: 'desynced',     // confirmed, match must be voided
};

/**
 * Tracks hash agreement between peers.
 *
 * A single mismatch is NOT immediately fatal: with rollback, a peer can hash
 * a frame it later corrects. We therefore keep a small window of local hashes
 * per frame and only escalate when a frame that should be *confirmed*
 * (older than the rollback horizon, so it can no longer change) disagrees.
 */
export class DesyncDetector {
  constructor({ horizon = 8, tolerance = 2, checkInterval = 30 } = {}) {
    this.horizon = horizon;           // rollback window; below this, disagreement is normal
    this.tolerance = tolerance;       // confirmed mismatches before voiding
    this.checkInterval = checkInterval;
    this.local = new Map();           // frame -> hash
    this.remote = new Map();
    this.mismatches = [];
    this.state = DesyncState.OK;
    this.checked = 0;
    this.agreed = 0;
  }
  shouldCheck(frame) { return frame % this.checkInterval === 0; }

  recordLocal(frame, hash) {
    this.local.set(frame, hash >>> 0);
    this._prune(frame);
    return this._compare(frame);
  }
  recordRemote(frame, hash) {
    this.remote.set(frame, hash >>> 0);
    return this._compare(frame);
  }
  _prune(frame) {
    const cutoff = frame - 600;
    for (const k of this.local.keys()) if (k < cutoff) this.local.delete(k);
    for (const k of this.remote.keys()) if (k < cutoff) this.remote.delete(k);
  }
  /** Compare only frames old enough that rollback can no longer alter them. */
  _compare(currentFrame) {
    let verdict = this.state;
    for (const [frame, lh] of this.local) {
      if (!this.remote.has(frame)) continue;
      if (currentFrame - frame < this.horizon) continue; // not yet confirmed
      const rh = this.remote.get(frame);
      this.checked++;
      if (lh === rh) { this.agreed++; }
      else {
        this.mismatches.push({ frame, local: lh, remote: rh });
        verdict = this.mismatches.length >= this.tolerance
          ? DesyncState.DESYNCED : DesyncState.SUSPECT;
      }
      this.local.delete(frame);
      this.remote.delete(frame);
    }
    this.state = verdict;
    return verdict;
  }
  get report() {
    return {
      state: this.state, checked: this.checked, agreed: this.agreed,
      mismatches: this.mismatches.slice(0, 5),
      firstBadFrame: this.mismatches[0]?.frame ?? null,
    };
  }
}

/* ---------------------- config tamper detection --------------------- */

/**
 * Invariants a legitimate fighter config must satisfy. Catches the obvious
 * console edits: zero-frame startup, screen-wide hitboxes, 999 damage.
 */
export const CONFIG_LIMITS = {
  maxDamage: 40, maxBoxW: 160, maxBoxH: 220,
  minStartup: 1, maxHitstun: 60, maxPush: 20, maxHp: 100,
};

export function auditFighterConfig(cfg, limits = CONFIG_LIMITS) {
  const violations = [];
  for (const [name, m] of Object.entries(cfg.moves || {})) {
    if (m.damage > limits.maxDamage) violations.push(`${name}.damage=${m.damage} exceeds ${limits.maxDamage}`);
    if (m.startup < limits.minStartup) violations.push(`${name}.startup=${m.startup} below ${limits.minStartup}`);
    if (m.hitstun > limits.maxHitstun) violations.push(`${name}.hitstun=${m.hitstun} exceeds ${limits.maxHitstun}`);
    if (m.box) {
      if (m.box.w > limits.maxBoxW) violations.push(`${name}.box.w=${m.box.w} exceeds ${limits.maxBoxW}`);
      if (m.box.h > limits.maxBoxH) violations.push(`${name}.box.h=${m.box.h} exceeds ${limits.maxBoxH}`);
    }
    if (Math.abs(m.pushHit || 0) > limits.maxPush) violations.push(`${name}.pushHit out of range`);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Canonical JSON: keys sorted at EVERY depth, so two structurally identical
 * configs serialize identically regardless of key order.
 *
 * NB: the obvious one-liner `JSON.stringify(cfg, Object.keys(cfg).sort())`
 * is badly broken here — a replacer *array* is applied at every nesting
 * level, so it silently drops every nested key that isn't also a top-level
 * key. That made the fingerprint blind to edited damage/hitbox values,
 * i.e. blind to precisely the tampering it exists to catch.
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

/** Fingerprint the config both peers claim to be running. */
export function configFingerprint(cfg) {
  return fnv1a(canonicalJSON(cfg)).toString(16).padStart(8, '0');
}

/**
 * Runtime sanity check on live fighter state. Catches `p1.hp = 9999` typed
 * into the console between frames.
 */
export function auditRuntime(f, rules = { maxHp: 100, maxMeter: 100 }) {
  const bad = [];
  if (!Number.isFinite(f.hp) || f.hp < 0 || f.hp > rules.maxHp) bad.push(`hp=${f.hp}`);
  if (!Number.isFinite(f.meter) || f.meter < 0 || f.meter > rules.maxMeter) bad.push(`meter=${f.meter}`);
  if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) bad.push('position not finite');
  if (Math.abs(f.vx) > 100 || Math.abs(f.vy) > 100) bad.push('velocity out of range');
  return { ok: bad.length === 0, violations: bad };
}
