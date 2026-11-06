import { CHARACTERS, isCharacter } from './characters.js';

export const SKILL_ASSETS = Object.freeze([
  'assets/fighters/skills.json',
  ...CHARACTERS.flatMap(({ id }) => ['actions', 'effects'].map(kind =>
    `assets/fighters/skills/${id}-${kind}.png`)),
]);

const ATTACK_STATES = new Set(['attack', 'crouchAtk', 'airAtk', 'special']);
const DEFAULT_COLUMNS = Object.freeze([0, 1, 2, 3]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smooth = value => value * value * (3 - 2 * value);

const validColumns = columns => Array.isArray(columns) && columns.length > 0 && columns.length <= 4 &&
  new Set(columns).size === columns.length &&
  Array.from(columns).every(c => Number.isInteger(c) && c >= 0 && c < 4);

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

function validate(meta, image, character, kind) {
  const expected = `assets/fighters/skills/${character}-${kind}.png`;
  if (!meta || meta.image !== expected || meta.width !== image.naturalWidth ||
      meta.height !== image.naturalHeight || !Number.isFinite(meta.scale) || meta.scale <= 0 ||
      !Array.isArray(meta.cellSize) || meta.cellSize.length !== 2 ||
      !meta.cellSize.every(n => Number.isFinite(n) && n > 0) ||
      !Array.isArray(meta.frames) || meta.frames.length !== 16) {
    throw new Error(`Invalid skill sprite metadata ${character}/${kind}`);
  }
  for (let i = 0; i < 16; i++) {
    const frame = meta.frames[i], r = frame?.rect, o = frame?.origin;
    if (frame?.row !== Math.floor(i / 4) || frame?.column !== i % 4 ||
        typeof frame?.name !== 'string' || !Array.isArray(r) || r.length !== 4 ||
        !r.every(Number.isInteger) || r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 ||
        r[0] + r[2] > meta.width || r[1] + r[3] > meta.height ||
        !Array.isArray(o) || o.length !== 2 || !o.every(Number.isFinite)) {
      throw new Error(`Invalid skill sprite frame ${character}/${kind}/${i}`);
    }
  }
}

function timing(fighter, alpha) {
  const move = fighter.move, art = move.skillArt;
  if (!Number.isInteger(art.row) || art.row < 0 || art.row > 3 ||
      !validColumns(art.columns) || ![2, 4].includes(art.columns.length) ||
      (art.activeColumn !== undefined && !art.columns.includes(art.activeColumn)) ||
      !['startup', 'active', 'recovery'].every(p => Number.isInteger(move[p]) && move[p] >= 0)) {
    throw new RangeError('Invalid skillArt or skill timing ' + move.key);
  }
  const time = Math.max(0, Math.floor(fighter.moveFrame || 0));
  const phase = time < move.startup ? 'startup' :
    time < move.startup + move.active ? 'active' : 'recovery';
  const local = time - (phase === 'startup' ? 0 : phase === 'active' ?
    move.startup : move.startup + move.active);
  const fraction = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 0;
  const progress = clamp((local + fraction) / Math.max(1, move[phase]), 0, 1);
  // Two-pose O variants have their own preparation/attack pair. In a
  // four-pose row the extended attack is reserved for the exact active tick.
  const index = art.columns.length === 2 ? (phase === 'startup' ? 0 : 1) :
    phase === 'startup' ? (local < move.startup / 2 ? 0 : 1) : phase === 'active' ? 2 : 3;
  // A defensive active window can hold a stance. The move registry owns that
  // choice; successful counters use the ordinary attack-column default.
  const column = phase === 'active' ? art.activeColumn ?? art.columns[index] : art.columns[index];
  return { row: art.row, column, phase, progress };
}

function transform(phase, progress) {
  // Simulation-tick easing plus the runtime's render fraction, no private clock.
  // Keep the foot origin
  // fixed vertically; rotation is around that origin and remains under 0.7deg.
  const envelope = Math.sin(Math.PI * smooth(progress));
  return Object.freeze({ x: envelope * (phase === 'startup' ? -1.5 : phase === 'active' ? 1 : .6),
    y: 0, rotation: envelope * (phase === 'startup' ? -.01 : phase === 'active' ? .008 : .004) });
}

export async function loadSkillSprites(baseURL = new URL('../', import.meta.url)) {
  const url = new URL(SKILL_ASSETS[0], baseURL);
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load skill sprites ' + url.pathname);
  const registry = await response.json();
  if (registry?.version !== 1) throw new Error('Invalid skill sprite registry');
  const loaded = await Promise.all(CHARACTERS.map(async ({ id }) => {
    const sheets = await Promise.all(['actions', 'effects'].map(async kind => {
      const meta = registry.characters?.[id]?.[kind];
      if (meta?.image !== `assets/fighters/skills/${id}-${kind}.png`) {
        throw new Error(`Missing skill sprite image ${id}/${kind}`);
      }
      const imageURL = new URL(meta.image, baseURL), image = new Image();
      image.src = imageURL.href;
      try { await image.decode(); }
      catch (cause) { throw new Error('Unable to decode skill sprites ' + imageURL.pathname, { cause }); }
      validate(meta, image, id, kind);
      freeze(meta);
      return [kind, Object.freeze({ meta, image })];
    }));
    return [id, Object.freeze(Object.fromEntries(sheets))];
  }));
  const characters = Object.freeze(Object.fromEntries(loaded));
  const frame = (fighter, character = 'deepseek', alpha = 0) => {
    if (!fighter?.move?.skillArt || !ATTACK_STATES.has(fighter.state)) return null;
    if (!isCharacter(character)) throw new RangeError('Unknown fighter character ' + character);
    // The runtime supplies alpha=0 during pause, hitstop, lockstep waiting and
    // hidden/boot states. Only the local curve interpolates; poses never lead
    // the simulation into an active frame.
    const { row, column, phase, progress } = timing(fighter, alpha);
    const meta = characters[character].actions.meta, tile = meta.frames[row * 4 + column];
    return Object.freeze({ clip: fighter.move.key, name: tile.name, frameName: tile.name,
      phase, rect: tile.rect, origin: tile.origin, scale: meta.scale, row, column,
      transform: transform(phase, progress) });
  };
  return Object.freeze({ characters, frame,
    draw(ctx, fighter, character = 'deepseek', alpha = 0) {
      const sampled = frame(fighter, character, alpha);
      if (!sampled) return null;
      const [x, y, w, h] = sampled.rect, [ox, oy] = sampled.origin, s = sampled.scale;
      ctx.save();
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const t = sampled.transform;
        if (t.x || t.y) ctx.translate(t.x, t.y);
        if (t.rotation) ctx.rotate(t.rotation);
        ctx.drawImage(characters[character].actions.image, x, y, w, h, -ox*s, -oy*s, w*s, h*s);
      } finally { ctx.restore(); }
      return sampled;
    },
    drawEffect(ctx, { character, row, age, duration, x, y, face = 1, width = 160, height = 160,
      columns = DEFAULT_COLUMNS }) {
      if (!isCharacter(character)) throw new RangeError('Unknown fighter character ' + character);
      if (!Number.isInteger(row) || row < 0 || row > 3 ||
          ![age, duration, x, y, width, height].every(Number.isFinite) ||
          width <= 0 || height <= 0 || ![-1, 1].includes(face) || !validColumns(columns)) {
        throw new RangeError('Invalid skill effect geometry');
      }
      if (age < 0 || duration <= 0 || age >= duration) return null;
      const meta = characters[character].effects.meta;
      const column = columns[Math.min(columns.length - 1, Math.floor(Math.floor(age) * columns.length / duration))];
      const tile = meta.frames[row * 4 + column];
      const [sx, sy, w, h] = tile.rect, [ox, oy] = tile.origin;
      const scaleX = width / meta.cellSize[0], scaleY = height / meta.cellSize[1];
      ctx.save();
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.translate(x, y);
        ctx.scale(face, 1);
        ctx.drawImage(characters[character].effects.image, sx, sy, w, h,
          -ox*scaleX, -oy*scaleY, w*scaleX, h*scaleY);
      } finally { ctx.restore(); }
      return Object.freeze({ clip: 'effect', name: tile.name, frameName: tile.name, phase: 'effect',
        row, column, columns: columns === DEFAULT_COLUMNS ? DEFAULT_COLUMNS : Object.freeze([...columns]),
        rect: tile.rect, origin: tile.origin, scale: Object.freeze([scaleX, scaleY]) });
    },
  });
}
