import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadSkillSprites, SKILL_ASSETS } from '../shared/skillSprites.js';
import { SKILLS } from '../shared/skills.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const registry = JSON.parse(read(SKILL_ASSETS[0]));
const base = JSON.parse(read('assets/fighters/ai.json'));
const ids = ['deepseek', 'claude', 'chatgpt'];
const fighter = (row = 0, tick = 0, columns = [0, 1, 2, 3]) => ({
  state: 'special', moveFrame: tick, stateFrame: tick, side: 'p1', face: 1,
  move: { key: 'testSkill', startup: 8, active: 6, recovery: 12, skillArt: { row, columns } },
});
const freeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};

function loader(t, data = registry, decoding = Promise.resolve()) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url.href);
    return { ok: true, json: async () => structuredClone(data) };
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  globalThis.Image = class {
    get naturalWidth() { return read(new URL(this.src).pathname.split('/').slice(-4).join('/')).readUInt32BE(16); }
    get naturalHeight() { return read(new URL(this.src).pathname.split('/').slice(-4).join('/')).readUInt32BE(20); }
    decode() { urls.push(this.src); return decoding; }
  };
  t.after(() => original ? Object.defineProperty(globalThis, 'Image', original) : delete globalThis.Image);
  return urls;
}

function canvas() {
  const calls = [], stack = [];
  return { calls, filter: 'brightness(2)', globalAlpha: .7, imageSmoothingEnabled: false,
    save() { stack.push([this.filter, this.globalAlpha, this.imageSmoothingEnabled]); },
    restore() { [this.filter, this.globalAlpha, this.imageSmoothingEnabled] = stack.pop(); },
    translate(...args) { calls.push(['translate', ...args]); },
    rotate(...args) { calls.push(['rotate', ...args]); },
    scale(...args) { calls.push(['scale', ...args]); },
    drawImage(...args) { calls.push(['draw', ...args]); },
  };
}

test('all seven fingerprint assets exist, six PNG hashes match metadata, geometry check uses repository files', () => {
  assert(Object.isFrozen(SKILL_ASSETS));
  assert.equal(SKILL_ASSETS[0], 'assets/fighters/skills.json');
  assert.equal(SKILL_ASSETS.length, 7);
  for (const id of ids) for (const kind of ['actions', 'effects']) {
    const meta = registry.characters[id][kind];
    assert(SKILL_ASSETS.includes(meta.image));
    assert.equal(createHash('sha256').update(read(meta.image)).digest('hex'), meta.sha256);
  }
  const report = JSON.parse(execFileSync('python3', ['tools/build-skill-frames.py', '--check'], { cwd: root }));
  assert.equal(report.tiles, 96);
  assert.equal(report.pngBytesUnchanged, true);
  assert.deepEqual(report.weakHaloSeams, [{ image: 'claude-effects.png', row: 3, x: 617, maxAlpha: 15 }]);
});

test('clean isolated checkout checks without sibling artwork and rejects modified PNG bytes', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'neon-skill-check-'));
  const checkout = path.join(temporary, 'neon-fist');
  try {
    for (const filename of ['tools/build-skill-frames.py', 'assets/fighters/ai.json', ...SKILL_ASSETS]) {
      const destination = path.join(checkout, filename);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(root, filename), destination);
    }
    const command = ['tools/build-skill-frames.py', '--check'];
    const check = (...extra) => JSON.parse(execFileSync('python3', [...command, ...extra],
      { cwd: checkout, stdio: ['pipe', 'pipe', 'pipe'] }));
    assert.equal(check().tiles, 96);
    assert.equal(check('--source', path.join(checkout, 'assets/fighters/skills')).tiles, 96);
    const image = path.join(checkout, SKILL_ASSETS[1]);
    writeFileSync(image, Buffer.concat([readFileSync(image), Buffer.from('changed-bytes')]));
    assert.throws(() => check(), error => /PNG hash mismatch/.test(error.stderr.toString()));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('independent Pillow scan retains every visible pixel once, including book, wing and finger tips', () => {
  const report = JSON.parse(execFileSync('python3', ['-'], { cwd: root, input: `
import json
from PIL import Image
m=json.load(open('assets/fighters/skills.json'))
tiles=0; core=0
for character,sheets in m['characters'].items():
 for kind,meta in sheets.items():
  im=Image.open(meta['image']); a=im.getchannel('A'); w,h=im.size
  coverage=bytearray(w*h)
  for f in meta['frames']:
   x,y,rw,rh=f['rect']; row=f['row']; col=f['column']; b=meta['bands'][row]
   left,right=b['x'][col:col+2]; top,bottom=b['y']
   assert left<=x<x+rw<=right and top<=y<y+rh<=bottom
   bounds=a.crop((left,top,right,bottom)).point(lambda q:255 if q>8 else 0).getbbox()
   assert x<=left+bounds[0] and y<=top+bounds[1]
   assert x+rw>=left+bounds[2] and y+rh>=top+bounds[3]
   for yy in range(y,y+rh):
    for xx in range(x,x+rw): coverage[yy*w+xx]+=1
   if kind=='actions':
    opaque=a.crop((left,top,right,bottom)).point(lambda q:255 if q>=200 else 0).getbbox()
    assert f['origin'][1]+y == top+opaque[3]
   tiles+=1
  for p,alpha in enumerate(a.tobytes()):
   if alpha>24:
    assert coverage[p]==1,(character,kind,p%w,p//w,coverage[p])
    core+=1
g=m['characters']['chatgpt']['actions']
assert g['frames'][10]['rect'][1]<=626
assert g['bands'][1]['x'][3]==942
assert g['bands'][2]['y'][0]==624
print(json.dumps({'tiles':tiles,'visiblePixels':core}))
` }));
  assert.equal(report.tiles, 96);
  assert(report.visiblePixels > 1_000_000);
});

test('loader awaits all six decodes under a GitHub project prefix and freezes all metadata', async t => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const urls = loader(t, registry, waiting);
  let complete = false;
  const pending = loadSkillSprites('https://example.test/neon-fist/').then(value => { complete = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete, false);
  assert.deepEqual(urls, SKILL_ASSETS.map(path => 'https://example.test/neon-fist/' + path));
  finish();
  const sprites = await pending;
  assert(Object.isFrozen(sprites));
  assert(Object.isFrozen(sprites.characters));
  assert(Object.isFrozen(sprites.characters.claude.actions.meta.frames[0].rect));
  assert(Object.isFrozen(sprites.characters.chatgpt.effects.meta.frames[15].origin));
});

test('all 96 tiles are reachable with precise phases and the two independent O pairs', async t => {
  loader(t);
  const sprites = await loadSkillSprites('https://example.test/'), reached = new Set();
  for (const id of ids) for (let row = 0; row < 4; row++) {
    for (const [tick, column, phase] of [[0, 0, 'startup'], [4, 1, 'startup'], [7, 1, 'startup'],
      [8, 2, 'active'], [13, 2, 'active'], [14, 3, 'recovery'], [25, 3, 'recovery']]) {
      const f = sprites.frame(fighter(row, tick), id, .999);
      assert.equal(f.row, row); assert.equal(f.column, column); assert.equal(f.phase, phase);
      assert.equal(f.name, `${id}-actions-${row}-${column}`);
      reached.add(f.name);
    }
    for (const [age, column] of [[0, 0], [4, 1], [8, 2], [12, 3]]) {
      const f = sprites.drawEffect(canvas(), { character: id, row, age, duration: 16, x: 10, y: 20 });
      assert.equal(f.column, column); reached.add(f.name);
    }
  }
  assert.equal(reached.size, 96);
  for (const id of ['claude', 'chatgpt']) for (const pair of [[0, 1], [2, 3]]) {
    for (const [tick, column] of [[0, pair[0]], [7, pair[0]], [8, pair[1]], [14, pair[1]]]) {
      assert.equal(sprites.frame(fighter(2, tick, pair), id).column, column);
    }
  }
  const counterHit = fighter(1, 0);
  counterHit.move.startup = 0;
  assert.equal(sprites.frame(counterHit, 'deepseek').column, 2);
  assert.equal(sprites.frame(counterHit, 'deepseek').phase, 'active');
});

test('registered defensive counter holds its stance; only the confirmed counter uses the attack pose', async t => {
  loader(t);
  const sprites = await loadSkillSprites('https://example.test/');
  const stance = SKILLS.deepseek.uppercut, hit = SKILLS.deepseek.counterHit;
  assert.equal(stance.skillArt.activeColumn, 1);
  for (let tick = 0; tick < stance.startup + stance.active + stance.recovery; tick++) {
    const state = freeze({ ...fighter(1, tick), move: stance });
    for (const alpha of [0, .5, .999]) {
      const f = sprites.frame(state, 'deepseek', alpha);
      assert.notEqual(f.column, 2, 'an unconfirmed counter never shows the tail slap');
      if (tick >= stance.startup && tick < stance.startup + stance.active) {
        assert.equal(f.phase, 'active'); assert.equal(f.column, 1);
      }
    }
  }
  for (let tick = 0; tick < hit.active; tick++) {
    const f = sprites.frame(freeze({ ...fighter(1, tick), move: hit }), 'deepseek');
    assert.equal(f.phase, 'active'); assert.equal(f.column, 2);
  }
  // The mapping belongs to data, so renaming the move cannot alter its pose.
  const renamed = fighter(1, 8);
  renamed.move.skillArt.activeColumn = 0;
  assert.equal(sprites.frame(renamed, 'deepseek').column, 0);
});

test('one stable scale per character matches old idle height without stretching crouch/slide', async t => {
  loader(t);
  const sprites = await loadSkillSprites('https://example.test/');
  for (const id of ids) {
    const actions = registry.characters[id].actions;
    const expected = base[id].frames.idle0.origin[1] * base[id].scale;
    assert(Math.abs(actions.standingHeight * actions.scale - expected) < .001);
    for (let row = 0; row < 4; row++) for (const tick of [0, 4, 8, 14]) {
      const f = sprites.frame(fighter(row, tick), id);
      assert.equal(f.scale, actions.scale);
      const tile = actions.frames[f.row * 4 + f.column];
      assert.equal(f.rect[1] + f.origin[1], tile.anchor[1]);
      assert.equal(f.transform.y, 0);
    }
  }
  assert(registry.characters.deepseek.actions.scale > .7, 'DeepSeek whitespace does not shrink her to 82%');
});

test('render fraction smooths only local curves; sampling/draws remain pure and stalls stable', async t => {
  loader(t);
  const sprites = await loadSkillSprites('https://example.test/');
  const state = freeze(fighter(0, 1)), before = JSON.stringify(state), metaBefore = JSON.stringify(registry);
  const a = sprites.frame(state, 'deepseek', 0), b = sprites.frame(state, 'deepseek', .5);
  assert.notDeepEqual(a.transform, b.transform);
  assert.deepEqual(a.rect, b.rect); assert.equal(a.phase, b.phase); assert.equal(a.column, b.column);
  for (const alpha of [0, .1, .25, .5, .99]) {
    const f = sprites.frame(state, 'deepseek', alpha);
    assert.deepEqual(sprites.frame(state, 'deepseek', alpha), f);
    assert(Object.isFrozen(f)); assert(Object.isFrozen(f.transform));
    assert(Math.abs(f.transform.x) <= 1.5 && Math.abs(f.transform.rotation) <= .01);
  }
  for (const reason of ['paused', 'hitstop', 'waiting', 'hidden']) {
    for (let i = 0; i < 12; i++) {
      assert.deepEqual(sprites.draw(canvas(), state, 'deepseek', 0), a, reason);
    }
  }
  assert.deepEqual(sprites.frame(state, 'deepseek', NaN), a);
  assert.deepEqual(sprites.frame(state, 'deepseek', -100), a);
  assert.equal(JSON.stringify(state), before); assert.equal(JSON.stringify(registry), metaBefore);
  assert.throws(() => { b.origin[1] = 2; }, TypeError);
  assert.throws(() => { b.transform.x = 2; }, TypeError);
});

test('action draws a single pose through existing face transform; preserves filters and foot origin', async t => {
  loader(t);
  const sprites = await loadSkillSprites('https://example.test/');
  for (const face of [1, -1]) {
    const state = freeze({ ...fighter(2, 9), face }), ctx = canvas();
    const f = sprites.draw(ctx, state, 'chatgpt', .5);
    const [x, y, w, h] = f.rect, [ox, oy] = f.origin, s = f.scale;
    assert.deepEqual(ctx.calls.filter(c => c[0] === 'draw'), [
      ['draw', sprites.characters.chatgpt.actions.image, x, y, w, h, -ox*s, -oy*s, w*s, h*s],
    ]);
    assert.equal(ctx.calls.filter(c => c[0] === 'scale').length, 0, 'parent owns mirroring');
    assert.equal(ctx.filter, 'brightness(2)'); assert.equal(ctx.globalAlpha, .7);
    assert.equal(ctx.imageSmoothingEnabled, false);
  }
  for (const state of ['idle', 'hitstun', 'airstun', 'blockstun', 'ko', 'frozen']) {
    const ctx = canvas();
    assert.equal(sprites.draw(ctx, { ...fighter(), state }, 'claude'), null);
    assert.equal(ctx.calls.length, 0);
  }
  assert.equal(sprites.frame({ state: 'special', move: {} }), null);
  assert.equal(sprites.frame(null), null);
});

test('effects own world translation/mirroring and retain common cell geometry across phases', async t => {
  loader(t);
  const sprites = await loadSkillSprites('https://example.test/');
  const args = { character: 'claude', row: 3, age: 0, duration: 16, x: 320, y: 360, width: 180, height: 120 };
  for (const face of [1, -1]) for (const age of [0, 4, 8, 12]) {
    const ctx = canvas(), f = sprites.drawEffect(ctx, { ...args, age, face });
    assert.deepEqual(ctx.calls[0], ['translate', args.x, args.y]);
    assert.deepEqual(ctx.calls[1], ['scale', face, 1]);
    const [x, y, w, h] = f.rect, [ox, oy] = f.origin;
    const [sx, sy] = f.scale;
    assert.equal(sx, args.width / 313.5); assert.equal(sy, args.height / 313.5);
    assert.deepEqual(ctx.calls[2], ['draw', sprites.characters.claude.effects.image,
      x, y, w, h, -ox*sx, -oy*sy, w*sx, h*sy]);
    assert.equal(ctx.filter, 'brightness(2)'); assert.equal(ctx.globalAlpha, .7);
    assert.deepEqual(sprites.drawEffect(canvas(), { ...args, age, face }), f);
  }
  for (const age of [-1, 16, 100]) {
    const ctx = canvas(); assert.equal(sprites.drawEffect(ctx, { ...args, age }), null);
    assert.equal(ctx.calls.length, 0);
  }
});

test('effect subsets keep trap and projectile phases isolated, ordered, immutable and pure', async t => {
  loader(t);
  const sprites = await loadSkillSprites('https://example.test/');
  const descriptor = { character: 'claude', row: 2, age: 0, duration: 20, x: 100, y: 200 };
  for (const columns of [[0], [1], [2], [3], [2, 3], [3, 1, 0]]) {
    const input = freeze({ ...descriptor, columns });
    const before = JSON.stringify(input);
    for (let age = 0; age < input.duration; age++) {
      const ctx = canvas();
      const f = sprites.drawEffect(ctx, { ...input, age });
      assert.equal(f.column, columns[Math.floor(age * columns.length / input.duration)]);
      assert(columns.includes(f.column));
      assert.deepEqual(f.columns, columns);
      assert(Object.isFrozen(f)); assert(Object.isFrozen(f.columns));
      assert(Object.isFrozen(f.rect)); assert(Object.isFrozen(f.origin)); assert(Object.isFrozen(f.scale));
      assert.equal(ctx.calls.filter(call => call[0] === 'draw').length, 1);
      assert.deepEqual(sprites.drawEffect(canvas(), { ...input, age }), f);
      assert.throws(() => { f.columns[0] = 9; }, TypeError);
    }
    assert.equal(JSON.stringify(input), before);
  }
  const mutable = [2, 3];
  const sampled = sprites.drawEffect(canvas(), { ...descriptor, columns: mutable });
  mutable[0] = 0;
  assert.deepEqual(sampled.columns, [2, 3], 'returned metadata owns an immutable snapshot');
  for (const columns of [null, [], [0, 0], [-1], [4], [1.5], ['1'], [undefined], Array(1), [0, , 2, 3], '1']) {
    const ctx = canvas();
    assert.throws(() => sprites.drawEffect(ctx, { ...descriptor, columns }), /Invalid/);
    assert.equal(ctx.calls.length, 0, 'invalid columns never draw');
  }
});

test('HTTP, any decode, missing sheet, invalid crop/anchor/timing fail explicitly', async t => {
  loader(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false }));
  await assert.rejects(loadSkillSprites('https://example.test/'), /Unable to load/);
  for (const mutate of [
    m => { delete m.characters.claude.effects; },
    m => { m.characters.chatgpt.actions.frames[0].rect[0] = 1254; },
    m => { m.characters.deepseek.actions.frames[0].origin = [0]; },
    m => { m.characters.deepseek.actions.frames.reverse(); },
  ]) {
    const data = structuredClone(registry); mutate(data);
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => data }));
    await assert.rejects(loadSkillSprites('https://example.test/'), /Invalid|Missing/);
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => structuredClone(registry) }));
  globalThis.Image.prototype.decode = async function () {
    if (this.src.endsWith('chatgpt-effects.png')) throw new Error('bad PNG');
  };
  await assert.rejects(loadSkillSprites('https://example.test/'), /Unable to decode/);
  globalThis.Image.prototype.decode = async function () { throw new Error('all bad'); };
  await assert.rejects(loadSkillSprites('https://example.test/'), /Unable to decode/);
  globalThis.Image.prototype.decode = async () => {};
  const sprites = await loadSkillSprites('https://example.test/');
  assert.throws(() => sprites.frame(fighter(), 'unknown'), /Unknown/);
  assert.throws(() => sprites.frame(fighter(4)), /Invalid/);
  assert.throws(() => sprites.frame(fighter(0, 0, [0, 0])), /Invalid/);
  for (const activeColumn of [-1, 4, 1.5, '1', null]) {
    const f = fighter(); f.move.skillArt.activeColumn = activeColumn;
    assert.throws(() => sprites.frame(f), /Invalid/);
  }
  const missing = fighter(0, 0, [0, 1]); missing.move.skillArt.activeColumn = 2;
  assert.throws(() => sprites.frame(missing), /Invalid/);
});
