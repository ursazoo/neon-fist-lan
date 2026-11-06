import { CHARACTERS, isCharacter } from './characters.js';

const CLIPS = {
  idle: { frames:['idle0','idle1','idle2','idle3'], duration:8, loop:true },
  walk: { frames:['walk0','walk1','walk2','walk3','walk4','walk5'], duration:6, loop:true },
  back: { frames:['back0','back1','back2','back3','back4','back5'], duration:6, loop:true },
  hit: { frames:['hit1','hit2','hit3'], duration:3, loop:false },
  block: { frames:['block0','block1'], duration:3, loop:false },
  ko: { frames:['ko0','ko1','ko2'], duration:7, loop:false },
  win: { frames:['victory0'], duration:8, loop:false },
};

const MOVES = {
  punch: { startup:['punch0'], active:['punch1','punch3'], recovery:['punch2','punch0','idle0'] },
  kick: { startup:['kick0','kick1'], active:['kick2','kick3'], recovery:['kick1','kick0','idle0'] },
  lowKick: { startup:['low0','low1','low2'], active:['low3'], recovery:['low2','low1','low0'] },
  jumpKick: { startup:['air0','air1','air2'], active:['air3'], recovery:['air2','air1','jump2'] },
  fireball: { startup:['fire0','fire2'], active:['fire1','fire3'], recovery:['fire2','fire0','idle0'] },
  // The base sheet has no dedicated uppercut, spin or victory artwork.
  uppercut: { startup:['punch0','jump0'], active:['punch3','jump1'], recovery:['jump2','jump3','idle0'] },
  spinKick: { startup:['kick0','kick1'], active:['kick2','kick3'], recovery:['kick1','kick0','idle0'], activeDuration:3 },
};

const ATTACK_STATES = new Set(['attack','crouchAtk','airAtk','special']);

function clipFrame(clip, age) {
  const index = Math.floor(age / clip.duration);
  return clip.frames[clip.loop ? index % clip.frames.length : Math.min(index, clip.frames.length - 1)];
}

export function sampleSprite(fighter, meta) {
  const f = fighter || {};
  const age = Math.max(0, Math.floor(f.stateFrame || 0));
  let clip = 'idle', phase = 'hold', frameName = 'idle0';
  const play = name => {
    clip = name;
    const sequence = meta.clips?.[name] || CLIPS[name];
    phase = sequence.loop ? 'loop' : 'once';
    frameName = clipFrame(sequence, age);
  };
  if (f.state === 'ko') {
    play('ko');
    if (age >= 21 && f.onGround) { frameName = 'ko3'; phase = 'hold'; }
  } else if (f.state === 'win') {
    play('win');
  } else if (f.state === 'hitstun' || f.state === 'airstun') {
    play('hit');
  } else if (f.state === 'blockstun') {
    if (f.anim === 'crouchBlock') { clip = 'crouchBlock'; frameName = 'low0'; }
    else play('block');
  } else if (f.state === 'frozen') {
    clip = 'frozen';
  } else if (ATTACK_STATES.has(f.state) && MOVES[f.move?.key]) {
    const move = f.move, frames = MOVES[move.key];
    const time = Math.max(0, Math.floor(f.moveFrame || 0));
    clip = move.key;
    phase = time < move.startup ? 'startup' : time < move.startup + move.active ? 'active' : 'recovery';
    const local = time - (phase === 'startup' ? 0 : phase === 'active' ? move.startup : move.startup + move.active);
    const names = frames[phase];
    const index = phase === 'active' && frames.activeDuration
      ? Math.floor(local / frames.activeDuration) % names.length
      : Math.min(names.length - 1, Math.floor(local * names.length / Math.max(1, move[phase])));
    frameName = names[index];
  } else if (['idle','walk','back'].includes(f.state)) {
    play(f.state);
  } else if (f.state === 'crouch' || f.state === 'crouchBlock') {
    clip = f.state; frameName = 'low0';
  } else if (f.state === 'block') {
    clip = 'block'; frameName = 'block0';
  } else if (f.state === 'jump') {
    clip = 'jump'; frameName = f.vy < -2 ? 'jump0' : f.vy > 2 ? 'jump2' : 'jump1';
  }
  const frame = meta.frames[frameName] || meta.frames.idle0;
  if (!meta.frames[frameName]) { clip = 'idle'; frameName = 'idle0'; phase = 'hold'; }
  return Object.freeze({ clip, frameName, phase,
    rect:Object.freeze([...frame.rect]), origin:Object.freeze([...frame.origin]), scale:meta.scale,
    ...(frame.clip ? { sourceClip:Object.freeze(frame.clip.map(point => Object.freeze([...point]))) } : {}) });
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

function validate(meta, image) {
  if (!meta || typeof meta.image !== 'string' || !Number.isFinite(meta.scale) || meta.scale <= 0 || !meta.frames) {
    throw new Error('Invalid fighter sprite metadata');
  }
  const required = new Set(['low0','block0','ko3','jump0','jump1','jump2']);
  for (const clip of Object.values(CLIPS)) for (const name of clip.frames) required.add(name);
  for (const move of Object.values(MOVES)) {
    for (const phase of ['startup','active','recovery']) for (const name of move[phase]) required.add(name);
  }
  for (const name of required) if (!meta.frames[name]) throw new Error('Missing fighter sprite frame ' + name);
  for (const [name, frame] of Object.entries(meta.frames)) {
    const r = frame?.rect, o = frame?.origin;
    if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isInteger) ||
        r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 ||
        r[0] + r[2] > image.naturalWidth || r[1] + r[3] > image.naturalHeight ||
        !Array.isArray(o) || o.length !== 2 || !o.every(Number.isFinite)) {
      throw new Error('Invalid fighter sprite frame ' + name);
    }
    if (frame.clip !== undefined && (!Array.isArray(frame.clip) || frame.clip.length < 3 ||
        !frame.clip.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isInteger) &&
          p[0] >= r[0] && p[0] <= r[0]+r[2] && p[1] >= r[1] && p[1] <= r[1]+r[3]))) {
      throw new Error('Invalid fighter sprite clip ' + name);
    }
  }
}

export async function loadSprites(baseURL = new URL('../', import.meta.url)) {
  const url = new URL('assets/fighters/ai.json', baseURL);
  const response = await fetch(url, { cache:'no-store' });
  if (!response.ok) throw new Error('Unable to load fighter sprites ' + url.pathname);
  const registry = await response.json();
  const loaded = await Promise.all(CHARACTERS.map(async ({id,image:expectedImage}) => {
    const meta = registry[id];
    if (!meta || meta.image !== expectedImage) throw new Error('Missing fighter sprite image ' + id);
    const imageURL = new URL(meta.image, baseURL);
    const image = new Image();
    image.src = imageURL.href;
    try { await image.decode(); }
    catch (cause) { throw new Error('Unable to decode fighter sprites ' + imageURL.pathname, { cause }); }
    validate(meta, image);
    freeze(meta);
    return [id,Object.freeze({meta,image})];
  }));
  const characters = Object.freeze(Object.fromEntries(loaded));
  const frame = (fighter, character='deepseek') => {
    if (!isCharacter(character)) throw new RangeError('Unknown fighter character ' + character);
    return sampleSprite(fighter, characters[character].meta);
  };
  return Object.freeze({ meta:characters.deepseek.meta,image:characters.deepseek.image,characters,frame,
    draw(ctx, fighter, character='deepseek') {
      const sampled = frame(fighter, character);
      const [x,y,w,h] = sampled.rect, [ox,oy] = sampled.origin, scale = sampled.scale;
      ctx.save();
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (sampled.sourceClip) {
          ctx.beginPath();
          sampled.sourceClip.forEach(([px,py], i) => {
            ctx[i ? 'lineTo' : 'moveTo']((px-x-ox)*scale, (py-y-oy)*scale);
          });
          ctx.closePath();
          ctx.clip();
        }
        ctx.drawImage(characters[character].image, x,y,w,h, -ox*scale,-oy*scale,w*scale,h*scale);
      } finally { ctx.restore(); }
      return sampled;
    },
  });
}
