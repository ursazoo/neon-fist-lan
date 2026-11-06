import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { BTN, MAX_INPUT_MASK, normalizeMask, InputState } from '../shared/input.js';
import { Lockstep, INPUT_DELAY } from '../shared/lockstep.js';
import { configFingerprint } from '../shared/integrity.js';
import { validateFighter, validateRules } from '../shared/configLoader.js';

const read = file => readFileSync(new URL('../'+file,import.meta.url),'utf8');
const html = read('index.html');
const config = JSON.parse(read('data/fighter.neon.json'));
const rules = JSON.parse(read('data/rules.json'));
const stage = JSON.parse(read('data/stage.synthwave.json'));
const between = (start,end) => html.slice(html.indexOf(start),html.indexOf(end));

function engine() {
  const context = vm.createContext({
    BTN,normalizeMask,configFingerprint,Math,
    PHYS:config.physics,MOVES:structuredClone(config.moves),MOTIONS:config.motions,
    SCALING:config.scaling,HURT:config.hurtboxes,
    FLOOR:stage.world.floorY,WALL_L:stage.world.wallLeft,WALL_R:stage.world.wallRight,
    VW:stage.world.width,
    Rng:{s:1,range:()=>0},Audio5:{play(){}},
    FX:{dust(){},spark(){},cancelFlash(){},wallSpark(){}},Cam:{shake(){},flash(){}},
    Game:{frame:0,hitstop:0,phase:'fight',timer:99,timerSub:0,phaseT:0},
    updateFlow(){},Net:{epoch:1},
  });
  vm.runInContext([
    between('const BIT_OF =','const KEYMAP ='),
    html.match(/^const scaleAt = .*$/m)[0],
    between('function aabb(','const Rng ='),
    between('const ANIM =','const PAL ='),
    between('let BUFFER_LEN =','/* ====================== PHASE 8'),
    between('const Juice =','const DEBUG ='),
    `BUFFER_LEN=${rules.inputBufferFrames};
     for(const [key,move] of Object.entries(MOVES)){ move.key=key; move.frameMap=FRAME_MAPS[key]; }
     const P1=new Fighter(0,330,{},'P1'), P2=new Fighter(1,820,{},'P2');
     const FIGHTERS=[P1,P2];
     P1.setState('idle'); P2.setState('idle');
     globalThis.api={P1,P2,MOVES,Projectiles,InputBuffer};`,
    between('function resolveCombat(','function snapshot('),
    'Object.assign(api,{simulate,resolveCombat,hash:deterministicHash});',
  ].join('\n'),context);
  const api=context.api;
  api.starts=[];
  const original=api.P1.startMove;
  api.P1.startMove=function(...args){ api.starts.push(args); return original.apply(this,args); };
  api.context=context;
  api.update=(mask=0) => api.P1.update(mask,api.P2);
  api.frames=(count,mask=0) => {for(let i=0;i<count;i++) api.update(mask);};
  api.sim=(a=0,b=0) => api.simulate(a,b);
  api.game=context.Game;
  return api;
}

test('input config validates with distinct fists and unchanged 10 frame buffer',()=>{
  validateFighter(config); validateRules(rules);
  assert.equal(rules.inputBufferFrames,10);
  assert.equal(INPUT_DELAY,2);
  for(const key of ['lowPunch','lowKick']) assert.equal(config.moves[key].crouch,true);
  for(const key of ['jumpPunch','jumpKick']) assert.equal(config.moves[key].air,true);
  assert(config.moves.lowPunch.damage < config.moves.lowKick.damage);
  assert(config.moves.jumpPunch.startup < config.moves.jumpKick.startup);
});

test('physical sources preserve aliases and taps until exactly one capture',()=>{
  const input=new InputState();
  input.set('KeyW',BTN.UP); input.set('Space',BTN.UP); input.remove('KeyW');
  assert.equal(input.take(),BTN.UP);
  input.remove('Space'); assert.equal(input.take(),0);
  input.set('KeyJ',BTN.PUNCH); input.remove('KeyJ');
  assert.equal(input.peek(),BTN.PUNCH); assert.equal(input.peek(),BTN.PUNCH);
  assert.equal(input.take(),BTN.PUNCH); assert.equal(input.take(),0);
  input.set('KeyJ',BTN.PUNCH); input.take(); input.set('KeyJ',BTN.PUNCH);
  input.remove('KeyJ'); assert.equal(input.take(),0,'repeat set does not latch a second attack');
  input.set('touch:1',BTN.KICK); input.set('KeyK',BTN.KICK); input.remove('touch:1');
  assert.equal(input.take(),BTN.KICK); input.remove('KeyK'); assert.equal(input.take(),0);
  input.set('touch:2',BTN.PUNCH); input.remove('touch:2'); input.clear();
  assert.equal(input.take(),0); assert.equal(input.sources.size,0);
});

test('SOCD is neutral for both axes at capture and at the engine boundary',()=>{
  for(const face of [1,-1]){
    const e=engine(); e.P1.face=face; e.P2.x=face===1?820:100;
    e.update(BTN.LEFT|BTN.RIGHT|BTN.UP|BTN.DOWN);
    assert.equal(e.P1.buf.cur(),0); assert.equal(e.P1.buf.dirAgo(0),5);
    assert.equal(e.P1.state,'idle'); assert.equal(e.P1.buf.avail('up'),false);
    e.update(0); assert.equal(e.P1.onGround,true);
  }
  const input=new InputState(); input.set('a',BTN.LEFT|BTN.UP); input.set('b',BTN.RIGHT|BTN.DOWN);
  assert.equal(input.take(),0); input.remove('b'); assert.equal(input.take(),BTN.LEFT|BTN.UP);
  assert.equal(normalizeMask(MAX_INPUT_MASK),2032);
});

test('released opposite directions cannot suppress the newer direction or resurrect a conflict',()=>{
  for(const [old,next] of [[BTN.DOWN,BTN.UP],[BTN.UP,BTN.DOWN],[BTN.LEFT,BTN.RIGHT],[BTN.RIGHT,BTN.LEFT]]){
    const input=new InputState();input.set('old',old);input.remove('old');input.set('new',next);
    input.set('j',BTN.PUNCH);assert.equal(input.take(),next|BTN.PUNCH);
    input.clear();input.set('old',old);input.remove('old');input.set('new',next);input.remove('new');
    assert.equal(input.take(),next,'last released direction wins over an earlier tap');
    input.clear();input.set('old',old);input.set('new',next);input.remove('old');input.remove('new');
    assert.equal(input.take(),0,'a genuinely simultaneous conflict leaves no latent direction');
  }
  const input=new InputState(),e=engine(),queue=new Lockstep(0);
  input.set('s',BTN.DOWN);input.remove('s');input.set('w',BTN.UP);input.set('j',BTN.PUNCH);
  queue.capture(()=>input.take());queue.advance(()=>{});queue.advance(()=>{});queue.receive(2,0);
  queue.advance(a=>e.update(a));assert.equal(e.P1.move.key,'jumpPunch');assert.equal(e.P1.onGround,false);
});

test('cancelled input clears sampled requests on the shared simulation path and accepts fresh input',()=>{
  for(const pending of [BTN.PUNCH,BTN.UP,BTN.FIREBALL]){
    const e=engine();e.P1.setState('hitstun');e.P1.stun=4;e.update(pending);
    const input=new InputState();input.cancel();
    assert.equal(input.peek(),BTN.CLEAR);e.update(input.take());e.frames(3);
    assert.equal(e.P1.move,null);assert.equal(e.P1.onGround,true);assert.equal(e.starts.length,0);
    assert.equal(input.take(),0);assert.equal(e.P1.buf.cur()&BTN.CLEAR,0);
  }
  const e=engine(),input=new InputState();input.cancel();input.set('j',BTN.PUNCH);
  e.update(input.take());assert.equal(e.P1.move.key,'punch');
});

test('network cancellation stays latched until a new immutable frame can capture it',()=>{
  const input=new InputState(),queue=new Lockstep(0);
  queue.capture(0);input.cancel();
  assert.equal(queue.capture(()=>input.take()),null);assert.equal(input.peek(),BTN.CLEAR);
  queue.advance(()=>{});assert.deepEqual(queue.capture(()=>input.take()),{frame:3,mask:BTN.CLEAR});
  assert.equal(queue.inputs[0].get(2),0);assert.equal(input.take(),0);
  const peers=[engine(),engine()];
  for(const e of peers){e.P1.setState('hitstun');e.P1.stun=5;e.update(BTN.FIREBALL);}
  for(const mask of [0,BTN.CLEAR,0,0,0]){
    for(const e of peers)e.sim(mask);
    assert.equal(peers[0].hash(),peers[1].hash());
  }
  for(const e of peers)assert.equal(e.starts.length,0);
});

for(const face of [1,-1]) for(const dir of [0,BTN.LEFT,BTN.RIGHT]) for(const [bit,move] of [[BTN.PUNCH,'jumpPunch'],[BTN.KICK,'jumpKick']]){
  for(const order of ['same','jump-first']) test(`${move} ${order} facing ${face} direction ${dir}`,()=>{
    const e=engine(); e.P1.face=face; e.P2.x=face===1?820:100;
    if(order==='jump-first') e.update(BTN.UP|dir);
    e.update(BTN.UP|dir|bit);
    assert.equal(e.P1.move.key,move); assert.equal(e.P1.state,'airAtk');
    assert.equal(e.P1.onGround,false); assert(e.P1.y<stage.world.floorY);
    assert.equal(e.P1.buf.avail('up'),false);
    assert.equal(e.P1.buf.avail('punch'),false); assert.equal(e.P1.buf.avail('kick'),false);
    assert.equal(e.starts.length,1);
  });
}

for(const [mask,move,state] of [[16,'punch','attack'],[32,'kick','attack'],[24,'lowPunch','crouchAtk'],[40,'lowKick','crouchAtk'],[48,'kick','attack'],[56,'lowKick','crouchAtk'],[52,'jumpKick','airAtk']]){
  test(`normal chord ${mask} selects exactly ${move}`,()=>{
    const e=engine();e.update(mask);
    assert.equal(e.P1.move.key,move); assert.equal(e.P1.state,state);
    e.P1.canCancel=true; e.P1.moveFrame=e.P1.move.startup;
    e.update(0);
    assert.equal(e.starts.length,1,'losing simultaneous edge cannot cancel');
  });
}

test('committed punch is immediate and a later W cannot cancel it',()=>{
  const e=engine();e.update(BTN.PUNCH); assert.equal(e.P1.move.key,'punch');
  e.update(BTN.UP); assert.equal(e.P1.move.key,'punch'); assert.equal(e.P1.onGround,true);
  e.frames(30);assert.equal(e.starts.length,1);assert.equal(e.P1.onGround,true);
});

test('holding attacks and jump never repeats; release and repress starts a new action',()=>{
  for(const bit of [BTN.PUNCH,BTN.KICK]){
    const e=engine();e.frames(100,bit);assert.equal(e.starts.length,1);
    e.update(0);e.update(bit);assert.equal(e.starts.length,2);
  }
  const e=engine();e.frames(100,BTN.UP);assert.equal(e.P1.onGround,true);
  e.update(0);e.update(BTN.UP);assert.equal(e.P1.onGround,false);
});

const motions={ fireball:[8,10,18],uppercut:[2,8,26],spinKick:[8,9,33] };
const mirror = mask => (mask&~3)|((mask&1)<<1)|((mask&2)>>1);
for(const face of [1,-1]) for(const [move,masks] of Object.entries(motions)){
  test(`${move} motion is facing relative (${face})`,()=>{
    const e=engine();e.P1.face=face;e.P2.x=face===1?820:100;
    for(const mask of masks) e.update(face===1?mask:mirror(mask));
    assert.equal(e.P1.move.key,move); assert.equal(e.P1.buf.completed.length,0);
    assert.equal(e.starts.length,1);
  });
}
for(const [bit,move] of [[128,'fireball'],[256,'uppercut'],[512,'spinKick']]){
  test(`${move} shortcut uses the same move and one edge`,()=>{
    const e=engine();e.frames(100,bit);assert.equal(e.starts.length,1);assert.equal(e.starts[0][0],move);
  });
}

test('special priority beats jump and normals; one accepted gesture cannot replay',()=>{
  const e=engine();for(const mask of [2,8,10,18|4|32])e.update(mask);
  assert.equal(e.P1.move.key,'uppercut');assert.equal(e.starts.length,1);
  e.frames(70);assert.equal(e.starts.length,1);
  const other=engine();other.update(128|256|512|16|32|4);
  assert.equal(other.P1.move.key,'uppercut');assert.equal(other.P1.buf.completed.length,0);
});

test('facing flip removes incomplete history without deleting a completed command',()=>{
  const e=engine(),b=e.P1.buf;
  b.push(2,1);b.push(8,1);b.push(9,-1);b.push(25,-1);
  assert.equal(b.detectSpecial(),null,'crossup cannot synthesize an uppercut');
  b.reset();for(const mask of motions.fireball)b.push(mask,1);
  b.push(0,-1);assert.equal(b.detectSpecial().move,'fireball');
});

test('completed motion survives direction eviction through the first legal stun frame',()=>{
  const e=engine();e.P1.setState('hitstun');e.P1.stun=14;
  for(const mask of [8,10,10,10,10,18])e.update(mask);
  assert.equal(e.P1.buf.detectSpecial().move,'fireball');
  e.frames(8);
  assert.equal(e.P1.move.key,'fireball');assert.equal(e.P1.moveFrame,0);
  assert.equal(e.starts.length,1);
});

test('an old punch cannot become a motion after release; stale commands never degrade into normals',()=>{
  const e=engine();e.P1.setState('hitstun');e.P1.stun=4;
  for(const mask of [16,8,10,2])e.update(mask);
  assert.equal(e.P1.move.key,'punch');
  const stale=engine();stale.P1.setState('hitstun');stale.P1.stun=20;
  for(const mask of motions.fireball)stale.update(mask);
  stale.frames(20);assert.equal(stale.starts.length,0);
  const late=engine();for(const mask of [8,10,2])late.update(mask);
  late.frames(15);late.update(16);assert.equal(late.P1.move.key,'punch');
});

test('stun release dispatches age 10 inputs immediately; too early inputs expire',()=>{
  const e=engine();e.P1.setState('hitstun');e.P1.stun=11;
  e.update(16);e.frames(10);assert.equal(e.P1.move.key,'punch');
  const stale=engine();stale.P1.setState('hitstun');stale.P1.stun=12;
  stale.update(16);stale.frames(11);assert.equal(stale.P1.move,null);
  const recovery=engine();recovery.P1.startMove('kick');recovery.P1.moveFrame=17;
  recovery.update(16);recovery.frames(10);assert.equal(recovery.P1.move.key,'punch');
});

test('normal and completed-command expiry freeze during actual simulate hitstop',()=>{
  for(const command of [false,true]){
    const e=engine();e.P1.startMove('punch');e.P1.moveFrame=4;e.P1.canCancel=true;
    if(command) for(const mask of motions.fireball)e.P1.buf.push(mask,1);
    else e.P1.buf.push(BTN.KICK,1);
    for(let i=0;i<6;i++)e.P1.buf.push(0,1);
    const age=command?e.P1.buf.detectSpecial().age:e.P1.buf.pressAge.kick;
    const clock=e.P1.buf.clock;e.game.hitstop=6;
    for(let i=0;i<6;i++)e.sim();
    assert.equal(e.P1.moveFrame,4);assert.equal(e.P1.buf.clock,clock);
    assert.equal(command?e.P1.buf.detectSpecial().age:e.P1.buf.pressAge.kick,age);
    e.sim();assert.equal(e.P1.move.key,command?'fireball':'kick');
  }
  const fresh=engine();fresh.P1.startMove('punch');fresh.P1.moveFrame=4;fresh.P1.canCancel=true;
  fresh.game.hitstop=18;fresh.sim(32);for(let i=0;i<17;i++)fresh.sim();
  assert.equal(fresh.P1.buf.pressAge.kick,0);fresh.sim();assert.equal(fresh.P1.move.key,'kick');
});

test('natural heavy contact hitstop retains the previously completed special cancel',()=>{
  const e=engine();e.P1.x=860;e.P2.x=920;
  for(const mask of [32,8,10,18])e.sim(mask);
  for(let i=0;i<5;i++)e.sim();
  assert.equal(e.game.hitstop,6);
  for(let i=0;i<7;i++)e.sim();
  assert.equal(e.P1.move.key,'fireball');
});

test('only connected whitelisted cancels execute, including each move in a normal chain',()=>{
  const whiff=engine();whiff.update(16);whiff.frames(4);whiff.update(32);
  assert.equal(whiff.P1.move.key,'punch');
  for(const blocked of [false,true]){
    const e=engine();e.P1.startMove('punch');e.P1.moveFrame=4;
    e.P2.x=e.P1.x+60;
    if(blocked)e.P2.setState('block');
    e.resolveCombat(e.P1,e.P2);assert.equal(e.P1.canCancel,true);
    e.update(32);assert.equal(e.P1.move.key,'kick');
    e.P1.moveFrame=8;e.P1.canCancel=true;
    e.update(128);assert.equal(e.P1.move.key,'fireball');
  }
  const illegal=engine();illegal.P1.onGround=false;illegal.P1.y=300;illegal.P1.startMove('jumpKick');illegal.P1.moveFrame=5;illegal.P1.canCancel=true;
  illegal.update(128);assert.equal(illegal.P1.move.key,'jumpKick');
});

test('actual hit interrupts hitboxes, cancels, invulnerability and pre-hit pending actions',()=>{
  const e=engine();e.P2.x=390;e.P1.startMove('punch');e.P1.moveFrame=4;
  e.P1.canCancel=true;e.P1.buf.push(32,1);assert(e.P1.hitbox());
  e.P1.takeHit({...e.MOVES.kick,hitstun:3},e.P2);
  assert.equal(e.P1.move,null);assert.equal(e.P1.moveFrame,0);assert.equal(e.P1.hitbox(),null);
  assert.equal(e.P1.canCancel,false);assert.equal(e.P1.cancelUsed,false);assert.equal(e.P1.multiTick,0);
  const hp=e.P2.hp;e.resolveCombat(e.P1,e.P2);assert.equal(e.P2.hp,hp);
  e.frames(4);assert.equal(e.starts.length,1);
  const startup=engine();startup.P1.startMove('fireball');startup.P1.moveFrame=10;
  startup.P1.takeHit(startup.MOVES.punch,startup.P2);startup.frames(20);
  assert.equal(startup.Projectiles.list.some(p=>p.active),false);
  const fresh=engine();fresh.P1.takeHit(fresh.MOVES.kick,fresh.P2);
  fresh.frames(14);fresh.update(16);fresh.frames(7);assert.equal(fresh.P1.move.key,'punch');
});

test('air attacks end on landing; uppercut recovery and fresh landing input survive',()=>{
  for(const move of ['jumpPunch','jumpKick']){
    const e=engine();e.P1.onGround=false;e.P1.y=451;e.P1.vy=2;e.P1.startMove(move);
    e.P1.moveFrame=e.P1.move.startup-1;e.update(0);
    assert.equal(e.P1.onGround,true);assert.equal(e.P1.move,null);assert.equal(e.P1.hitbox(),null);
    assert.equal(e.P1.state,'idle');
  }
  const special=engine();special.P1.startMove('uppercut');special.P1.y=451;special.P1.vy=2;
  special.update(0);assert.equal(special.P1.move.key,'uppercut');
  const pending=engine();pending.P1.onGround=false;pending.P1.y=451;pending.P1.vy=2;
  pending.P1.startMove('jumpKick');pending.P1.moveFrame=17;
  pending.update(16);pending.update(0);assert.equal(pending.P1.move.key,'punch');
});

test('continuous high and low block survive repeated hits and retain height rules',()=>{
  for(const [state,mask,move] of [['block',64,'punch'],['crouchBlock',72,'lowKick']]){
    const e=engine();e.P1.setState(state);e.P1.buf.push(mask,1);
    assert.equal(e.P1.takeHit(e.MOVES[move],e.P2),'block');
    e.update(mask);assert.equal(e.P1.takeHit(e.MOVES[move],e.P2),'block');
    if(state==='crouchBlock') assert.equal(e.P1.hurtboxes().length,config.hurtboxes.crouch.length);
    assert.equal(e.P1.hp,100-2*e.MOVES[move].chip);
  }
  const high=engine();high.P1.setState('block');high.P1.takeHit(high.MOVES.punch,high.P2);
  high.update(64);assert.equal(high.P1.takeHit(high.MOVES.lowKick,high.P2),'hit');
  const low=engine();low.P1.setState('crouchBlock');low.P1.takeHit(low.MOVES.lowKick,low.P2);
  low.update(72);assert.equal(low.P1.takeHit(low.MOVES.jumpKick,low.P2),'hit');
  const release=engine();release.P1.setState('block');release.P1.takeHit(release.MOVES.punch,release.P2);
  release.update(0);assert.equal(release.P1.takeHit(release.MOVES.punch,release.P2),'hit');
  const switchLow=engine();switchLow.P1.setState('block');switchLow.P1.takeHit(switchLow.MOVES.punch,switchLow.P2);
  switchLow.update(72);assert.equal(switchLow.P1.takeHit(switchLow.MOVES.lowKick,switchLow.P2),'block');
});

test('stun exit evaluates held guard on the first legal frame and real multihits stay blocked',()=>{
  for(const state of ['hitstun','blockstun']){
    const e=engine();e.P1.setState(state);e.P1.stun=1;e.P2.x=390;e.P2.startMove('punch');e.P2.moveFrame=4;
    e.update(64);assert.equal(e.P1.state,'block');
    e.resolveCombat(e.P2,e.P1);assert.equal(e.P1.hp,99);
  }
  const e=engine();e.P1.x=860;e.P2.x=920;e.P2.setState('block');
  e.P1.startMove('spinKick');e.P1.moveFrame=6;
  const results=[],takeHit=e.P2.takeHit;
  e.P2.takeHit=function(...args){const result=takeHit.apply(this,args);results.push(result);return result;};
  for(let i=0;i<30;i++)e.sim(0,64);
  assert(results.length>1);assert(results.every(result=>result==='block'));
  assert.equal(e.P2.hp,100-results.length*e.MOVES.spinKick.chip);
  assert.equal(e.P2.state,'blockstun');
});

test('KO, win and frozen clear attacks and pending requests and ignore further hits',()=>{
  for(const state of ['ko','win','frozen']){
    const e=engine();e.P1.startMove('punch');e.P1.moveFrame=4;e.P1.buf.push(128|32,1);
    e.P1.setState(state);assert.equal(e.P1.move,null);assert.equal(e.P1.buf.completed.length,0);
    assert.equal(e.P1.takeHit(e.MOVES.punch,e.P2),'ignored');assert.equal(e.P1.hp,100);
    e.update(16);e.P1.setState('idle');e.update(0);assert.equal(e.starts.length,1);
  }
  const e=engine();e.game.phase='ko';const p=e.Projectiles.spawn(e.P2);p.x=e.P1.x;p.y=e.P1.y-98;
  e.sim();assert.equal(e.P1.hp,100);
});

test('save/hash include command, clock, facing history and guard; reset removes all requests',()=>{
  const e=engine();e.P1.setState('hitstun');e.P1.stun=20;
  for(const mask of motions.fireball)e.update(mask);
  const saved=e.P1.save({}),before=e.hash();
  assert.equal(saved.commands[0].move,'fireball');assert.equal(saved.bface,1);
  assert.equal(saved.bclock,e.P1.buf.clock);assert.equal(saved.bframe,e.P1.buf.frame);
  e.P1.buf.completed[0].age++;assert.notEqual(e.hash(),before);
  const after=e.hash();e.P1.buf.face=-1;assert.notEqual(e.hash(),after);
  assert.equal(saved.commands[0].age,0,'snapshot owns a copy');
  e.P1.reset(false);assert.equal(e.P1.buf.completed.length,0);assert.equal(e.P1.buf.clock,0);
  assert.equal(e.P1.buf.face,0);assert.equal(e.P1.guard,null);
});

test('lazy capture cannot consume a waiting frame tap or overwrite its immutable mask',()=>{
  const input=new InputState(),queue=new Lockstep(0);
  let calls=0;const sample=()=>{calls++;return input.take();};
  input.set('j',16);input.remove('j');assert.deepEqual(queue.capture(sample),{frame:2,mask:16});
  input.set('u',128);input.remove('u');
  for(let i=0;i<20;i++)assert.equal(queue.capture(sample),null);
  assert.equal(calls,1);assert.equal(input.peek(),128);
  queue.advance(()=>{});assert.deepEqual(queue.capture(sample),{frame:3,mask:128});
  assert.equal(calls,2);assert.equal(input.take(),0);
});
