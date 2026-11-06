import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BTN, InputState, MAX_INPUT_MASK } from '../shared/input.js';
import { SKILLS, TRAP, moveFor } from '../shared/skills.js';
import { Lockstep } from '../shared/lockstep.js';
import { engine } from './fixtures/engine.mjs';

const make = (character,opponent='claude') => engine({roster:[character,opponent]});
const ticks = (e,count,a=0,b=0) => { for(let i=0;i<count;i++) e.sim(a,b); };
const close = e => { e.P1.x=330; e.P2.x=400; e.P1.face=1; e.P2.face=-1; };
const active = (fighter,key) => {
  assert(fighter.startMove(key)); fighter.moveFrame=fighter.move.startup;
};
const place = e => {
  e.update(BTN.SPIN); e.frames(SKILLS.claude.spinKick.startup);
  assert(e.P1.skill.trap); e.frames(SKILLS.claude.spinKick.active+SKILLS.claude.spinKick.recovery);
  assert.equal(e.P1.move,null);
  return e.P1.skill.trap;
};

test('SUPER uses the new network bit and CLEAR keeps its existing bit',()=>{
  assert.equal(BTN.SUPER,2048); assert.equal(BTN.CLEAR,1024); assert.equal(MAX_INPUT_MASK,4095);
  const input=new InputState(); input.set('n',BTN.SUPER); input.remove('n');
  assert.equal(input.take(),BTN.SUPER); assert.equal(input.take(),0);
  input.cancel(); assert.equal(input.take(),BTN.CLEAR);
  const queue=new Lockstep(0); queue.receive(2,BTN.SUPER|BTN.CLEAR|BTN.PUNCH);
  assert.equal(queue.inputs[1].get(2),3088); assert.throws(()=>queue.receive(3,4096));
});

for(const character of Object.keys(SKILLS)){
  for(const [input,bit] of [['fireball',BTN.FIREBALL],['uppercut',BTN.UPPERCUT],['spinKick',BTN.SPIN],['super',BTN.SUPER]]){
    test(`${character} ${input} chooses its registered move and a held edge never repeats`,()=>{
      const e=make(character); e.P1.meter=100;
      e.update(bit); assert.equal(e.P1.move.key,SKILLS[character][input].key);
      assert.equal(e.P1.move.input,input); assert.equal(e.P1.move.skillArt.row,['fireball','uppercut','spinKick','super'].indexOf(input));
      e.frames(130,bit); assert.equal(e.starts.length,1);
    });
  }
  test(`${character} classic motions select the same registered specials`,()=>{
    for(const [input,masks] of Object.entries({fireball:[8,10,18],uppercut:[2,8,26],spinKick:[8,9,33]})){
      const e=make(character); for(const mask of masks)e.update(mask);
      assert.equal(e.P1.move.key,SKILLS[character][input].key);
    }
  });
  test(`${character} legacy normal contracts remain available and grounded skills do not replace air attacks`,()=>{
    const e=make(character); e.update(BTN.UP|BTN.PUNCH|BTN.FIREBALL);
    assert.equal(e.P1.move.key,SKILLS[character].fireball.key,'ground special keeps existing priority');
    e.P1.reset(false);e.P1.setState('idle'); e.update(BTN.UP);
    e.update(BTN.PUNCH|BTN.FIREBALL); assert.equal(e.P1.move.key,'jumpPunch');
    assert.equal(e.P1.move.skillArt,undefined);
  });
  test(`${character} N requires meter at the edge, preserves simultaneous normal input, and spends once`,()=>{
    for(const normal of [BTN.PUNCH,BTN.KICK,BTN.UP,BTN.FIREBALL]){
      const e=make(character); e.P1.meter=99; e.update(BTN.SUPER|normal);
      assert.notEqual(e.P1.move?.input,'super');
      assert(normal===BTN.UP?!e.P1.onGround:!!e.P1.move);
      e.P1.addMeter(100); e.frames(100,BTN.SUPER);
      assert.equal(e.starts.some(([key])=>key===SKILLS[character].super.key),false);
    }
    const e=make(character);e.P1.meter=100;e.update(BTN.SUPER);assert.equal(e.P1.meter,0);
    e.frames(80,BTN.SUPER);assert.equal(e.starts.length,1);
    e.update(0);e.P1.meter=100;e.update(BTN.SUPER);assert.equal(e.starts.length,2);
  });
}

test('connected normals cancel to role skills and full-meter supers while whiffs cannot',()=>{
  for(const character of Object.keys(SKILLS))for(const bit of [BTN.FIREBALL,BTN.SUPER]){
    const e=make(character);close(e);e.P1.meter=100;
    active(e.P1,'punch');e.resolveCombat(e.P1,e.P2);e.update(bit);
    assert.equal(e.P1.move.key,SKILLS[character][bit===BTN.SUPER?'super':'fireball'].key);
    const miss=make(character);active(miss.P1,'punch');miss.P1.meter=100;miss.update(bit);
    assert.equal(miss.P1.move.key,'punch');
  }
});

test('DeepSeek sweep is a low melee attack, beaten by crouch guard and jumping',()=>{
  for(const [guard,damage] of [['block',10],['crouchBlock',1]]){
    const e=make('deepseek');close(e);e.P2.setState(guard);active(e.P1,'deepseekSweep');
    e.resolveCombat(e.P1,e.P2);assert.equal(e.P2.hp,100-damage);
  }
  const e=make('deepseek');close(e);e.P2.y-=100;e.P2.onGround=false;e.P2.setState('jump');
  active(e.P1,'deepseekSweep');e.resolveCombat(e.P1,e.P2);assert.equal(e.P2.hp,100);
});

for(const [frame,success] of [[1,false],[2,true],[13,true],[14,false]]){
  test(`DeepSeek counter frame ${frame} has the exact short window`,()=>{
    const e=make('deepseek');close(e);e.P1.startMove('deepseekCounter');e.P1.moveFrame=frame;
    active(e.P2,'punch');e.resolveCombat(e.P2,e.P1);
    assert.equal(e.P1.hp,success?100:93);assert.equal(e.P2.hp,success?86:100);
    assert.equal(e.P1.move?.key,success?'deepseekCounterHit':undefined);
  });
}

test('DeepSeek counter catches frontal overhead melee but not low, projectiles, rear attacks or traps',()=>{
  for(const attack of ['lowKick','projectile','rear','trap','overhead']){
    const e=make('deepseek');close(e);active(e.P1,'deepseekCounter');
    if(attack==='projectile'){
      const p=e.Projectiles.spawn(e.P2);p.x=e.P1.x+10;p.vx=-2;e.Projectiles.update([e.P1,e.P2]);
    }else if(attack==='trap')e.P1.takeHit(TRAP.attack,e.P2);
    else{
      if(attack==='rear'){e.P2.x=e.P1.x-60;e.P2.face=1;}
      active(e.P2,attack==='lowKick'?'lowKick':attack==='overhead'?'jumpPunch':'punch');
      e.resolveCombat(e.P2,e.P1);
    }
    assert.equal(e.P1.hp,attack==='overhead'?100:attack==='lowKick'?91:attack==='projectile'?90:attack==='trap'?88:93);
    assert.equal(e.P2.hp,attack==='overhead'?86:100);
  }
  const miss=make('deepseek');miss.update(BTN.UPPERCUT);miss.frames(20);
  assert.equal(miss.P1.move.key,'deepseekCounter');assert(miss.P1.moveFrame>=14);
});

test('DeepSeek slide lowers hurtboxes, stops at contact, exposes recovery, and remains vulnerable to low sweeps',()=>{
  const e=make('deepseek');e.P2.x=e.P1.x+85;e.update(BTN.SPIN);
  assert(e.P1.hurtboxes().every(b=>b.y>=e.P1.y-54));
  for(let i=0;i<20 && !e.P1.skill.slideStopped;i++)e.update(0);
  assert(e.P1.skill.slideStopped);assert(Math.abs(e.P2.x-e.P1.x-52)<0.01);
  const x=e.P1.x;e.update(0);assert.equal(e.P1.x,x);
  e.P1.moveFrame=e.P1.move.startup+e.P1.move.active;
  assert(e.P1.hurtboxes().some(b=>b.y<e.P1.y-100));
  const low=make('deepseek','deepseek');close(low);active(low.P1,'deepseekSlide');
  active(low.P2,'deepseekSweep');low.resolveCombat(low.P2,low.P1);
  assert.equal(low.P1.hp,90);assert.equal(low.P1.move,null);
});

test('DeepSeek slide waits for physical contact before the six-damage splash and does not push through a close foe',()=>{
  const e=make('deepseek');e.P2.x=e.P1.x+95;
  e.update(BTN.SPIN);e.P1.moveFrame=6;assert.equal(e.P1.hitbox(),null);
  e.resolveCombat(e.P1,e.P2);assert.equal(e.P2.hp,100);
  for(let i=0;i<30 && e.P2.hp===100;i++)e.sim();
  assert.equal(e.P2.hp,94);assert(e.P1.skill.slideStopped);
  assert(e.P2.x>=e.P1.x+52);
  const touching=make('deepseek');touching.P2.x=touching.P1.x+52;
  const foeX=touching.P2.x;touching.sim(BTN.SPIN);touching.sim();
  assert.equal(touching.P2.x,foeX);assert.equal(touching.P1.vx,0);
});

test('Claude page and GPT breath retain their speed/damage and one active projectile per owner',()=>{
  for(const character of ['claude','chatgpt']){
    const e=make(character);e.update(BTN.FIREBALL);e.frames(e.P1.move.startup);
    const shots=e.Projectiles.list.filter(p=>p.active);assert.equal(shots.length,1);
    const p=shots[0];assert.equal(p.attack.damage,character==='claude'?8:10);
    assert.equal(p.vx,character==='claude'?7.2:4.4);assert.equal(p.character,character);
    assert.equal(e.Projectiles.spawn(e.P1),null);
    e.P2.x=p.x+50;e.P2.face=-1;e.P2.setState('idle');
    for(let i=0;i<15 && p.active;i++)e.Projectiles.update([e.P1,e.P2]);
    assert.equal(e.P2.hp,character==='claude'?92:90);
  }
});

for(const character of ['claude','chatgpt'])test(`${character} defensive skill hits airborne targets and leaves grounded approach open`,()=>{
  for(const airborne of [false,true]){
    const e=make(character);e.P2.x=e.P1.x+75;e.P2.onGround=!airborne;
    if(airborne){e.P2.y-=95;e.P2.setState('jump');}
    active(e.P1,SKILLS[character].uppercut.key);e.resolveCombat(e.P1,e.P2);
    assert.equal(e.P2.hp,airborne?100-SKILLS[character].uppercut.damage:100);
  }
});

test('Claude bookmark remains at its placed position, is unique, expires at 180 live frames and freezes in hitstop',()=>{
  const e=make('claude');const trap=place(e),x=trap.x;
  e.P1.x+=60;e.update(0);assert.equal(trap.x,x);assert.equal(e.P1.startMove('claudeBookmark'),false);
  ticks(e,179);assert(e.P1.skill.trap);assert.equal(trap.life,1);
  const hash=e.hash();e.game.hitstop=8;ticks(e,8);assert.equal(trap.life,1);assert.notEqual(e.hash(),hash);
  e.sim();assert.equal(e.P1.skill.trap,null);
});

test('Claude second O warns for 18 frames, hits once for 12 and holding O never replays',()=>{
  const e=make('claude');const trap=place(e);e.P2.x=trap.x;e.P2.setState('idle');
  e.update(BTN.SPIN);assert.equal(e.P1.move.key,'claudeDetonate');
  e.frames(e.P1.move.startup);assert.equal(trap.phase,'warning');assert.equal(trap.age,0);
  ticks(e,17,BTN.SPIN);assert.equal(trap.phase,'warning');assert.equal(e.P2.hp,100);
  e.sim(BTN.SPIN);assert.equal(trap.phase,'burst');assert.equal(e.P2.hp,88);
  ticks(e,40,BTN.SPIN);assert.equal(e.P2.hp,88);assert.equal(e.P1.skill.trap,null);
  assert.deepEqual(e.starts.map(([key])=>key),['claudeBookmark','claudeDetonate']);
});

test('Claude warning permits defense and escape, and actual hits clear a bookmark while blocks keep it',()=>{
  for(const defense of ['block','escape','hit','blockedOwner']){
    const e=make('claude');const trap=place(e);e.P2.x=trap.x;
    if(defense==='hit'||defense==='blockedOwner'){
      if(defense==='blockedOwner')e.P1.setState('block');
      e.P1.takeHit(e.MOVES.punch,e.P2);
      assert.equal(!!e.P1.skill.trap,defense==='blockedOwner');continue;
    }
    e.update(BTN.SPIN);e.frames(e.P1.move.startup);
    if(defense==='escape')e.P2.x=trap.x+150;
    ticks(e,18,0,defense==='block'?BTN.BLOCK:0);
    assert.equal(e.P2.hp,defense==='block'?98:100);
  }
});

test('bookmarks cannot trigger during stun and a bound detonate never becomes a fresh placement',()=>{
  for(const clear of ['expired','hit','inputClear']){
    const e=make('claude');const trap=place(e);e.P1.setState('blockstun');e.P1.stun=5;
    e.update(BTN.SPIN);assert.equal(e.P1.move,null);assert.equal(e.P1.buf.completed[0].move,'claudeDetonate');
    if(clear==='expired')e.P1.skill.trap=null;
    if(clear==='hit')e.P1.takeHit({...e.MOVES.punch,hitstun:2},e.P2);
    if(clear==='inputClear')e.update(BTN.CLEAR);
    e.frames(15);assert.equal(e.P1.move,null);assert.equal(e.starts.length,1);
    if(clear==='inputClear')assert.equal(e.P1.skill.trap.id,trap.id);
  }
  const e=make('claude');place(e);e.P1.setState('blockstun');e.P1.stun=4;
  e.update(BTN.SPIN);e.frames(3);assert.equal(e.P1.move.key,'claudeDetonate');
  assert.equal(e.P1.moveFrame,0,'the first legal recovery frame consumes the bound request');
});

test('GPT wing reflects one ordinary projectile once, swaps ownership, caps damage and preserves actual owner combo state',()=>{
  const e=make('chatgpt','chatgpt');close(e);active(e.P1,'chatgptReflect');
  const p=e.Projectiles.spawn(e.P2);p.attack.damage=50;p.x=e.P1.x+50;p.vx=-8;
  e.Projectiles.update([e.P1,e.P2]);assert.equal(p.owner,0);assert.equal(p.reflections,1);
  assert.equal(p.attack.damage,12);assert.equal(p.vx,8);assert.equal(e.P1.hp,100);
  const extra=e.Projectiles.spawn(e.P2);extra.x=e.P1.x+12;extra.vx=-2;
  e.Projectiles.update([e.P1,e.P2]);assert.equal(extra.reflections,0);assert.equal(e.P1.hp,90);
  active(e.P2,'chatgptReflect');p.x=e.P2.x-40;p.vx=8;
  for(let i=0;i<5&&p.active;i++)e.Projectiles.update([e.P1,e.P2]);
  assert.equal(p.owner,0);assert.equal(p.reflections,1);assert.equal(e.P2.hp,88);
  assert.equal(e.P1.combo,1);assert.equal(e.P1.comboDamage,12);
});

test('GPT reflection rejects startup, recovery, rear shots, unreflectable shots, melee, traps and supers',()=>{
  for(const kind of ['startup','recovery','rear','unreflectable','melee','trap','super']){
    const e=make('chatgpt');close(e);active(e.P1,'chatgptReflect');
    if(kind==='melee'){active(e.P2,'punch');e.resolveCombat(e.P2,e.P1);}
    else if(kind==='trap')e.P1.takeHit(TRAP.attack,e.P2);
    else if(kind==='super'){e.P2.character='claude';e.P2.meter=100;active(e.P2,'claudeSuper');e.resolveCombat(e.P2,e.P1);}
    else{
      if(kind==='startup')e.P1.moveFrame=2;
      if(kind==='recovery')e.P1.moveFrame=11;
      const p=e.Projectiles.spawn(e.P2);p.x=e.P1.x+10;p.vx=-2;
      if(kind==='rear'){p.x=e.P1.x-10;p.vx=2;}
      if(kind==='unreflectable')p.attack.reflectable=false;
      e.Projectiles.update([e.P1,e.P2]);assert.equal(p.reflections,0);
    }
    assert(e.P1.hp<100,kind);
  }
});

test('GPT claw follow requires real contact, a fresh O edge and its specific first action',()=>{
  for(const contact of ['hit','block','whiff']){
    const e=make('chatgpt');if(contact!=='whiff')close(e);
    if(contact==='block')e.P2.setState('block');
    e.update(BTN.SPIN);e.P1.moveFrame=7;e.resolveCombat(e.P1,e.P2);
    assert.equal(e.P1.skill.contact,contact==='whiff'?null:contact);
    e.update(0);e.update(BTN.SPIN);e.frames(8);
    assert.equal(e.P1.move.key,contact==='whiff'?'chatgptClaw':'chatgptClawFollow');
    e.frames(60,BTN.SPIN);assert.equal(e.starts.length,contact==='whiff'?1:2);
  }
  const held=make('chatgpt');close(held);held.update(BTN.SPIN);held.P1.moveFrame=7;
  held.resolveCombat(held.P1,held.P2);held.frames(80,BTN.SPIN);assert.equal(held.starts.length,1);
  const interrupted=make('chatgpt');close(interrupted);interrupted.update(BTN.SPIN);interrupted.P1.moveFrame=7;
  interrupted.resolveCombat(interrupted.P1,interrupted.P2);interrupted.update(0);interrupted.update(BTN.SPIN);
  assert.equal(interrupted.P1.buf.completed[0].move,'chatgptClawFollow');
  interrupted.P1.setState('blockstun');interrupted.P1.stun=1;interrupted.update(0);
  assert.equal(interrupted.P1.move,null);assert.equal(interrupted.starts.length,1);
});

test('GPT follow is overhead and the blocked-first-strike gap allows a real jab punish',()=>{
  for(const guard of ['block','crouchBlock']){
    const e=make('chatgpt');close(e);e.P2.setState(guard);active(e.P1,'chatgptClawFollow');
    e.resolveCombat(e.P1,e.P2);assert.equal(e.P2.hp,guard==='block'?99:94);
  }
  const e=make('chatgpt');close(e);e.update(BTN.SPIN);e.P1.moveFrame=7;e.P2.setState('block');
  e.resolveCombat(e.P1,e.P2);e.update(0);e.update(BTN.SPIN);
  for(let i=0;i<26 && e.P1.hp===100;i++){
    e.P2.x=e.P1.x+65;e.P2.vx=0;e.sim(0,BTN.PUNCH);
  }
  assert(e.P1.hp<100);assert.equal(e.P1.move,null);
});

for(const character of Object.keys(SKILLS))for(const result of ['hit','block','whiff','jump']){
  test(`${character} super ${result} only confirms hit into its promised total damage`,()=>{
    const e=make(character);close(e);if(result==='whiff')e.P2.x=820;
    if(result==='jump'){e.P2.onGround=false;e.P2.y-=250;e.P2.setState('jump');}
    if(result==='block')e.P2.setState('block');
    e.P1.meter=100;active(e.P1,SKILLS[character].super.key);
    assert.equal(e.P1.meter,0);assert.equal(e.worldEffects().some(effect=>effect.row===3),false);
    e.resolveCombat(e.P1,e.P2);
    assert.equal(!!e.P1.skill.superConfirm,result==='hit');
    assert.equal(e.worldEffects().some(effect=>effect.row===3),result==='hit');
    if(result==='jump')e.P2.x=820;
    ticks(e,85,0,result==='block'?BTN.BLOCK:0);
    const total=character==='claude'?28:30;
    assert.equal(e.P2.hp,result==='hit'?100-total:result==='block'?98:100);
  });
}

test('super confirmation freezes in hitstop and is cancelled if its owner is interrupted',()=>{
  const e=make('deepseek');close(e);e.P1.meter=100;active(e.P1,'deepseekSuper');e.resolveCombat(e.P1,e.P2);
  const age=e.P1.skill.superConfirm.age;ticks(e,e.game.hitstop);
  assert.equal(e.P1.skill.superConfirm.age,age);
  e.P1.takeHit(e.MOVES.punch,e.P2);assert.equal(e.P1.skill.superConfirm,null);
  ticks(e,70);assert.equal(e.P2.hp,90);
});

test('all new combat state and projectile ownership participate in save/hash and reset',()=>{
  const e=make('claude');place(e);const saved=e.P1.save({});
  assert.equal(saved.character,'claude');assert.equal(saved.skill.trap.x,e.P1.skill.trap.x);
  const mutate=fn=>{const before=e.hash();fn();assert.notEqual(e.hash(),before);};
  for(const key of ['serial','slideStopped','reflectionUsed'])mutate(()=>e.P1.skill[key]=key==='serial'?99:true);
  mutate(()=>e.P1.skill.contact='hit');mutate(()=>e.P1.skill.trap.life--);
  mutate(()=>e.P1.skill.superConfirm={target:1,age:0,finished:false});
  mutate(()=>e.P1.skill.superConfirm.age++);assert.notEqual(saved.skill.trap.life,e.P1.skill.trap.life);
  const p=e.Projectiles.spawn(e.P2);mutate(()=>p.reflections++);mutate(()=>p.owner=0);
  mutate(()=>p.attack.damage++);e.P1.reset(false);
  assert.equal(e.P1.skill.trap,null);assert.equal(e.P1.skill.superConfirm,null);
  assert.equal(e.P1.skill.serial,0);assert.equal(e.P1.buf.completed.length,0);
});

test('real simulators consume delayed lockstep skill inputs with identical hashes each frame',()=>{
  for(const roster of [['deepseek','chatgpt'],['claude','chatgpt'],['chatgpt','claude']]){
    const peers=[engine({roster}),engine({roster})], queues=[new Lockstep(0),new Lockstep(1)];
    for(const peer of peers){close(peer);peer.P1.meter=100;peer.P2.meter=100;}
    for(let frame=0;frame<400;frame++){
      const a=frame===0?BTN.SUPER:[0,BTN.FIREBALL,0,BTN.UPPERCUT,0,BTN.SPIN,0,BTN.PUNCH][Math.floor(frame/7)%8];
      const b=[0,BTN.BLOCK,0,BTN.UPPERCUT,0,BTN.SPIN,0,BTN.FIREBALL][Math.floor(frame/11)%8];
      const packets=[queues[0].capture(a),queues[1].capture(b)];
      queues[0].receive(packets[1].frame,packets[1].mask);queues[1].receive(packets[0].frame,packets[0].mask);
      for(let i=0;i<2;i++)queues[i].advance(peers[i].sim);
      assert.equal(peers[0].hash(),peers[1].hash(),`${roster} frame ${frame}`);
    }
  }
});

test('CPU chooses new skill inputs through the same pipeline including an affordable super',()=>{
  for(const character of Object.keys(SKILLS)){
    const e=make(character);close(e);e.P1.meter=100;
    const seen=new Set();for(let i=0;i<2500;i++){
      const mask=e.cpuMask(e.P1,e.P2);e.sim(mask,0);
      if(e.P1.move?.skillArt)seen.add(e.P1.move.input);
      if(i%180===0){e.P1.meter=100;e.P2.hp=100;e.P2.setState('idle');close(e);}
    }
    for(const input of ['fireball','uppercut','spinKick','super'])assert(seen.has(input),character+' '+input);
  }
});

test('world effects are derived without mutating combat state and never show a whiffed super finale',()=>{
  const e=make('claude');place(e);const before=e.hash();
  const first=JSON.stringify(e.worldEffects());for(let i=0;i<20;i++)assert.equal(JSON.stringify(e.worldEffects()),first);
  assert.equal(e.hash(),before);assert.equal(e.worldEffects()[0].row,2);
  assert.equal(moveFor('chatgpt','chatgptClawFollow').height,'overhead');
});

test('the real KO/time-up flow immediately clears both bookmarks including the round winner',()=>{
  for(const winner of ['p1','p2','draw'])for(const byKo of [true,false]){
    const e=engine({roster:['claude','claude'],flow:true});
    for(const f of [e.P1,e.P2]){
      f.startMove('claudeBookmark');f.moveFrame=f.move.startup-1;f.update(0);
      assert(f.skill.trap);
    }
    if(byKo){e.P1.hp=winner==='p1'?100:0;e.P2.hp=winner==='p2'?100:0;}
    else{e.game.timer=0;e.P1.hp=winner==='p1'?90:80;e.P2.hp=winner==='p2'?90:80;}
    e.sim();assert.equal(e.game.phase,'ko');assert.equal(e.game.winner,winner);
    assert.equal(e.P1.skill.trap,null);assert.equal(e.P2.skill.trap,null);
    ticks(e,118);assert.equal(e.game.phaseT,118);
    assert.equal(e.worldEffects().length,0);
  }
});

test('armed bookmarks never draw burst columns as they age and warning/burst/fade use their actual phases',()=>{
  const e=make('claude');const trap=place(e);e.P2.x=820;
  ticks(e,90);assert.equal(trap.age,90);
  assert.deepEqual(Array.from(e.worldEffects()[0].columns),[0]);
  e.update(BTN.SPIN);e.frames(e.P1.move.startup);
  assert.deepEqual(Array.from(e.worldEffects()[0].columns),[1]);
  ticks(e,18);assert.equal(trap.phase,'burst');
  assert.deepEqual(Array.from(e.worldEffects()[0].columns),[2]);
  ticks(e,6);assert.equal(trap.phase,'fade');
  assert.deepEqual(Array.from(e.worldEffects()[0].columns),[3]);
  e.P2.x=trap.x;ticks(e,7);assert.equal(e.P2.hp,100);assert(e.P1.skill.trap);
  e.sim();assert.equal(e.P1.skill.trap,null);
});

test('distant flying pages keep flight art and only real hit/block contact creates an eight-frame impact',()=>{
  for(const defense of ['hit','block','ignored','expiry']){
    const e=make('claude');e.update(BTN.FIREBALL);e.frames(e.P1.move.startup);
    const p=e.Projectiles.list.find(p=>p.active);p.x=100;p.vx=0;
    ticks(e,75);assert.equal(p.active,true);
    assert.deepEqual(Array.from(e.worldEffects().find(effect=>effect.row===0).columns),[1]);
    e.P2.x=500;p.x=e.P2.x;p.y=e.P2.y-98;
    if(defense==='block')e.P2.setState('block');
    if(defense==='ignored')e.P2.setState('frozen');
    if(defense==='expiry')p.life=1;
    e.Projectiles.update([e.P1,e.P2]);
    assert.equal(p.active,false);
    if(defense==='hit'||defense==='block'){
      assert.equal(p.impactAge,0);
      assert.deepEqual(Array.from(e.worldEffects()[0].columns),[2,3]);
      const hp=e.P2.hp;const follow=e.Projectiles.spawn(e.P1);
      assert(follow);assert.notEqual(follow,p,'an afterimage is not an active shot');
      follow.active=false;
      const before=e.hash();p.impactAge++;assert.notEqual(e.hash(),before);p.impactAge--;
      e.game.hitstop=8;ticks(e,8);assert.equal(p.impactAge,0);
      ticks(e,7);assert.equal(p.impactAge,7);assert.equal(e.P2.hp,hp);
      e.sim();assert.equal(p.impactAge,-1);assert.equal(e.worldEffects().length,0);
    }else assert.equal(p.impactAge,-1);
    e.Projectiles.clear();assert(e.Projectiles.list.every(p=>p.impactAge===-1&&!p.active));
  }
});

test('real melee activity selects strike art while a confirmed super uses charge then actual-impact art',()=>{
  const e=make('deepseek');close(e);active(e.P1,'deepseekSweep');
  assert.deepEqual(Array.from(e.worldEffects()[0].columns),[2]);
  e.P1.meter=100;active(e.P1,'deepseekSuper');assert.equal(e.worldEffects().length,0);
  e.resolveCombat(e.P1,e.P2);
  assert.deepEqual(Array.from(e.worldEffects()[0].columns),[1]);
  ticks(e,e.game.hitstop+SKILLS.deepseek.super.confirm.delay);
  assert.deepEqual(Array.from(e.worldEffects()[0].columns),[2,3]);
});

test('the actual paused local RAF loop freezes simulation and presentation and resumes without accumulated backlog',()=>{
  const e=engine({roster:['deepseek','claude'],view:true});
  e.game.paused=true;e.renderFrame(100);e.renderFrame(200);
  assert.equal(e.game.frame,0);assert.equal(e.context.presentationCalls,0);
  assert.equal(e.getRenderAlpha(),0);
  e.game.paused=false;e.renderFrame(217);
  assert.equal(e.game.frame,1);assert.equal(e.context.presentationCalls,1);
});
