import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { loadSprites, sampleSprite } from '../shared/sprites.js';

const read = name => readFileSync(new URL('../' + name, import.meta.url));
const meta = JSON.parse(read('assets/fighters/keyzip.json'));
const config = JSON.parse(read('data/fighter.neon.json'));
const moves = config.moves;
const png = read('assets/fighters/keyzip.png');
const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
const freeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};
freeze(meta); freeze(moves);
const fighter = patch => ({ side:'p1',state:'idle',stateFrame:0,move:null,moveFrame:0,
  anim:'idle',vy:0,onGround:true,...patch });
const sample = patch => sampleSprite(fighter(patch), meta);

test('all seven moves show extended limbs only in the active phase at exact boundaries', () => {
  const anchors = {
    punch: ['punch0','punch1','punch3','punch2','idle0'],
    kick: ['kick1','kick2','kick3','kick1','idle0'],
    lowKick: ['low2','low3','low3','low2','low0'],
    jumpKick: ['air2','air3','air3','air2','jump2'],
    fireball: ['fire2','fire1','fire3','fire2','idle0'],
    uppercut: ['jump0','punch3','jump1','jump2','idle0'],
    spinKick: ['kick1','kick2','kick2','kick1','idle0'],
  };
  for (const [key, expected] of Object.entries(anchors)) {
    const move = moves[key], endActive = move.startup + move.active;
    const ticks = [move.startup - 1,move.startup,endActive - 1,endActive,endActive + move.recovery - 1];
    const phases = ['startup','active','active','recovery','recovery'];
    for (let i = 0; i < ticks.length; i++) {
      const frame = sample({ state:move.special?'special':move.air?'airAtk':key==='lowKick'?'crouchAtk':'attack',move,moveFrame:ticks[i] });
      assert.equal(frame.clip, key);
      assert.equal(frame.frameName, expected[i], key + ' at ' + ticks[i]);
      assert.equal(frame.phase, phases[i], key + ' phase at ' + ticks[i]);
    }
  }
});

test('move timing comes from live definitions and spin active repeats every three ticks', () => {
  const move = { ...moves.punch,startup:8,active:6,recovery:12 };
  assert.equal(sample({ state:'attack',move,moveFrame:7 }).phase, 'startup');
  assert.equal(sample({ state:'attack',move,moveFrame:8 }).frameName, 'punch1');
  assert.equal(sample({ state:'attack',move,moveFrame:13 }).frameName, 'punch3');
  assert.equal(sample({ state:'attack',move,moveFrame:14 }).frameName, 'punch2');
  assert.equal(sample({ state:'attack',move,moveFrame:25 }).frameName, 'idle0');
  for (const [tick, name] of [[0,'kick2'],[2,'kick2'],[3,'kick3'],[5,'kick3'],[6,'kick2']]) {
    assert.equal(sample({ state:'special',move:moves.spinKick,moveFrame:moves.spinKick.startup + tick }).frameName, name);
  }
  assert.equal(sample({ state:'special',move:moves.fireball,moveFrame:11 }).frameName, 'fire1');
});

test('walk, back and idle use every source frame and loop on simulation ticks', () => {
  for (const [state, count, duration] of [['idle',4,8],['walk',6,6],['back',6,6]]) {
    for (let i = 0; i < count; i++) {
      assert.equal(sample({ state,stateFrame:i*duration }).frameName, state + i);
      assert.equal(sample({ state,stateFrame:(i+1)*duration-1 }).frameName, state + i);
    }
    assert.equal(sample({ state,stateFrame:count*duration }).frameName, state + '0');
  }
  assert.equal(sample({ state:'frozen',stateFrame:999 }).frameName, 'idle0');
  assert.equal(sample({ state:'jump',vy:-3 }).frameName, 'jump0');
  assert.equal(sample({ state:'jump',vy:-2 }).frameName, 'jump1');
  assert.equal(sample({ state:'jump',vy:2 }).frameName, 'jump1');
  assert.equal(sample({ state:'jump',vy:3 }).frameName, 'jump2');
  assert.equal(sample({ state:'unknown' }).frameName, 'idle0');
});

test('grounded KO visibly falls before holding down; airborne KO waits for landing', () => {
  for (const onGround of [true,false]) {
    for (const [stateFrame, frameName] of [[0,'ko0'],[6,'ko0'],[7,'ko1'],[13,'ko1'],[14,'ko2'],[20,'ko2']]) {
      assert.equal(sample({ state:'ko',stateFrame,onGround,move:moves.kick }).frameName, frameName);
    }
    assert.equal(sample({ state:'ko',stateFrame:21,onGround }).frameName, onGround?'ko3':'ko2');
    assert.equal(sample({ state:'ko',stateFrame:100,onGround }).frameName, onGround?'ko3':'ko2');
  }
});

function actualFighters() {
  const html = read('index.html').toString();
  const source = html.slice(html.indexOf('let BUFFER_LEN ='), html.indexOf('/* ====================== PHASE 8'));
  const context = vm.createContext({ FLOOR:452,MOVES:moves,SCALING:config.scaling,
    scaleAt:(table,index)=>table[Math.min(index,table.length-1)],
    clamp:(value,min,max)=>Math.max(min,Math.min(value,max)),
    Audio5:{ play(){} },FX:{ spark(){},cancelFlash(){} },Juice:{ impact(){} },Rng:{ range:()=>0 },
  });
  vm.runInContext(source + '\nglobalThis.fighters=[new Fighter(0,330,{},"P1"),new Fighter(1,390,{},"P2")];', context);
  return context.fighters;
}

test('actual repeated hits restart immediately over residual moves; block and KO take priority', () => {
  const [attacker, victim] = actualFighters();
  victim.startMove('kick'); victim.moveFrame = 10;
  victim.takeHit(moves.punch, attacker);
  assert.equal(victim.stateFrame, 0);
  assert.equal(victim.move.key, 'kick');
  assert.equal(sampleSprite(victim, meta).frameName, 'hit1');
  victim.stateFrame = 6;
  assert.equal(sampleSprite(victim, meta).frameName, 'hit3');
  victim.takeHit(moves.punch, attacker);
  assert.equal(victim.stateFrame, 0);
  assert.equal(sampleSprite(victim, meta).frameName, 'hit1');
  victim.onGround = false;
  victim.takeHit(moves.punch, attacker);
  assert.equal(victim.state, 'airstun');
  assert.equal(sampleSprite(victim, meta).clip, 'hit');
  for (const [state, anim, expected] of [['block','block','block0'],['crouchBlock','crouchBlock','low0']]) {
    victim.setState(state,anim); victim.invuln = 0;
    victim.takeHit(moves.punch, attacker);
    assert.equal(victim.state, 'blockstun');
    assert.equal(sampleSprite(victim, meta).frameName, expected);
  }
  victim.startMove('punch'); victim.moveFrame = 5; victim.startMove('kick',true);
  assert.equal(sampleSprite(victim, meta).frameName, 'kick0');
  victim.startMove('kick');
  assert.equal(sampleSprite(victim, meta).frameName, 'kick0');
  victim.reset(false);
  assert.equal(sampleSprite(victim, meta).frameName, 'idle0');
});

function mockLoader(t, metadata = meta, decoding = Promise.resolve()) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url.href);
    return { ok:true,json:async()=>structuredClone(metadata) };
  });
  const originalImage = Object.getOwnPropertyDescriptor(globalThis,'Image');
  globalThis.Image = class {
    naturalWidth = width;
    naturalHeight = height;
    decode() { urls.push(this.src); return decoding; }
  };
  t.after(() => {
    if (originalImage) Object.defineProperty(globalThis,'Image',originalImage);
    else delete globalThis.Image;
  });
  return urls;
}

test('load waits for decode and resolves assets below a GitHub Pages project path', async t => {
  let finish;
  const decoding = new Promise(resolve => { finish = resolve; });
  const urls = mockLoader(t,meta,decoding);
  let ready = false;
  const loading = loadSprites('https://example.test/neon-fist/').then(value => { ready = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready,false);
  finish();
  const sprites = await loading;
  assert.deepEqual(urls,['https://example.test/neon-fist/assets/fighters/keyzip.json','https://example.test/neon-fist/assets/fighters/keyzip.png']);
  assert.equal(sprites.image.naturalWidth,width);
  for (const [name, { rect:[x,y,w,h],origin }] of Object.entries(sprites.meta.frames)) {
    assert(x >= 0 && y >= 0 && w > 0 && h > 0 && x+w <= width && y+h <= height,name);
    assert(origin.every(Number.isFinite),name);
  }
});

test('bad image, HTTP error, missing frame and out-of-bounds metadata reject loading', async t => {
  const urls = mockLoader(t);
  t.mock.method(globalThis,'fetch',async()=>({ ok:false }));
  await assert.rejects(loadSprites('https://example.test/'),/Unable to load/);
  const bad = structuredClone(meta);
  bad.frames.idle0.rect[0] = width;
  t.mock.method(globalThis,'fetch',async()=>({ ok:true,json:async()=>bad }));
  await assert.rejects(loadSprites('https://example.test/'),/Invalid fighter sprite frame idle0/);
  const missing = structuredClone(meta); delete missing.frames.punch3;
  t.mock.method(globalThis,'fetch',async()=>({ ok:true,json:async()=>missing }));
  await assert.rejects(loadSprites('https://example.test/'),/Missing fighter sprite frame punch3/);
  t.mock.method(globalThis,'fetch',async()=>({ ok:true,json:async()=>structuredClone(meta) }));
  globalThis.Image.prototype.decode = async()=>{ throw new Error('bad PNG'); };
  await assert.rejects(loadSprites('https://example.test/'),/Unable to decode/);
  assert(urls.length > 0);
});

test('repeated sampling and draws freeze unchanged fields, preserve fighters, anchors and effect filters', async t => {
  mockLoader(t);
  const sprites = await loadSprites('https://example.test/');
  const [actual] = actualFighters();
  actual.startMove('punch'); actual.moveFrame = 4;
  const before = JSON.stringify(actual.save({})), metadataBefore = JSON.stringify(meta);
  const frame = sprites.frame(actual);
  const calls = [], stack = [];
  const ctx = { filter:'brightness(2.4) saturate(0.4)',imageSmoothingEnabled:true,
    save() { stack.push([this.filter,this.imageSmoothingEnabled]); },
    restore() { [this.filter,this.imageSmoothingEnabled] = stack.pop(); },
    drawImage(...args) { calls.push({ args,filter:this.filter,smoothing:this.imageSmoothingEnabled }); },
  };
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(sprites.frame(actual),frame);
    assert.deepEqual(sprites.draw(ctx,actual),frame);
    sample({ state:'walk',stateFrame:i*6 });
  }
  assert.equal(JSON.stringify(actual.save({})),before);
  assert.equal(JSON.stringify(meta),metadataBefore);
  assert.throws(()=>{ frame.rect[0] = 999; },TypeError);
  assert.throws(()=>{ frame.origin[0] = 999; },TypeError);
  assert.throws(()=>{ frame.scale = 999; },TypeError);
  assert.equal(ctx.filter,'brightness(2.4) saturate(0.4)');
  assert.equal(ctx.imageSmoothingEnabled,true);
  const [x,y,w,h] = frame.rect, [ox,oy] = frame.origin, scale = frame.scale;
  assert.deepEqual(calls[0].args,[sprites.image,x,y,w,h,-ox*scale,-oy*scale,w*scale,h*scale]);
  assert.equal(calls[0].smoothing,false);
  assert.match(calls[0].filter,/hue-rotate\(135deg\).*brightness\(2.4\)/);
  ctx.filter = 'brightness(1.6) hue-rotate(70deg)';
  sprites.draw(ctx,freeze(fighter({ side:'p2',state:'hitstun',stateFrame:0,move:moves.kick,moveFrame:10 })));
  assert.match(calls.at(-1).filter,/hue-rotate\(280deg\).*brightness\(1.6\) hue-rotate\(70deg\)/);
  const frozen = freeze(fighter({ state:'attack',move:moves.kick,moveFrame:3,stateFrame:3 }));
  const held = sprites.frame(frozen);
  for (const remaining of [3,2,1,0]) {
    assert.deepEqual(sprites.draw(ctx,frozen),held,'skipped update with remaining hitstop ' + remaining);
  }
  assert.equal(sample({ state:'attack',move:moves.kick,moveFrame:4,stateFrame:4 }).frameName,'kick1');
});
