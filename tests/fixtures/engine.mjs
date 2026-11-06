import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BTN, InputState, normalizeMask } from '../../shared/input.js';
import { configFingerprint } from '../../shared/integrity.js';
import * as Skills from '../../shared/skills.js';

const read = file => readFileSync(new URL('../../'+file,import.meta.url),'utf8');
const html = read('index.html');
const config = JSON.parse(read('data/fighter.neon.json'));
const rules = JSON.parse(read('data/rules.json'));
const stage = JSON.parse(read('data/stage.synthwave.json'));
const between = (start,end) => {
  const first=html.indexOf(start), last=html.indexOf(end,first);
  if(first<0 || last<0) throw new Error('Missing runtime fixture boundary '+start+' / '+end);
  return html.slice(first,last);
};

export function engine({roster=[null,null],flow=false,view=false}={}) {
  const context = vm.createContext({
    BTN,normalizeMask,configFingerprint,Skills,Math,
    PHYS:config.physics,MOVES:structuredClone(config.moves),MOTIONS:config.motions,
    SCALING:config.scaling,HURT:config.hurtboxes,
    FLOOR:stage.world.floorY,WALL_L:stage.world.wallLeft,WALL_R:stage.world.wallRight,
    VW:stage.world.width,
    Audio5:{play(){},duck(){}},UI:{sync(){},show(){},hide(){}},
    FX:{dust(){},spark(){},cancelFlash(){},wallSpark(){}},Cam:{shake(){},flash(){}},
    Game:{frame:0,hitstop:0,phase:'fight',timer:99,timerSub:0,phaseT:0,roster:[...roster],
      slowmo:0,paused:false,cpu:false,round:1,winsNeeded:2,maxRounds:3},
    updateFlow(){},Net:{epoch:1,state:'idle'},
    performance:{now:()=>0},requestAnimationFrame(){},
    document:{hidden:false,getElementById:()=>null},
    DEBUG:{fps:0,stepMs:0},LiveInput:[new InputState(),new InputState()],
    lastStepFrozen:false,presentationCalls:0,
    updatePresentation(){ context.presentationCalls++; },render(){},updateDiag(){},
  });
  vm.runInContext([
    between('const BIT_OF =','const KEYMAP ='),
    html.match(/^const scaleAt = .*$/m)[0],
    between('function aabb(','const Rng ='),
    between('const Rng =','const vrand ='),
    between('const ANIM =','const PAL ='),
    between('let BUFFER_LEN =','/* ====================== PHASE 8'),
    between('const Juice =','const DEBUG ='),
    `BUFFER_LEN=${rules.inputBufferFrames};
     for(const [key,move] of Object.entries(MOVES)){ move.key=key; move.frameMap=FRAME_MAPS[key]; }
     const P1=new Fighter(0,330,{},'P1'), P2=new Fighter(1,820,{},'P2');
     const FIGHTERS=[P1,P2];
     FIGHTERS.forEach((f,i)=>{f.character=Game.roster[i]; f.setState('idle');});
     globalThis.api={P1,P2,MOVES,Projectiles,InputBuffer,Fighter,Rng};`,
    between('function endRound(','/* ------------------------- 6.2 CPU'),
    flow?between('function updateFlow(){','function endRound('):'',
    between('function cpuMask(','/* --------------------- 3.2 collision'),
    between('function resolveCombat(','function snapshot('),
    'Object.assign(api,{simulate,resolveCombat,updateTraps,worldEffects,cpuMask,endRound,hash:deterministicHash});',
    view?between('const STEP =','/* ============================== BOOT'):  '',
    view?'Object.assign(api,{renderFrame:frame,getRenderAlpha:()=>renderAlpha});':'',
  ].join('\n'),context);
  const api=context.api;
  api.starts=[];
  const original=api.P1.startMove;
  api.P1.startMove=function(...args){
    const started=original.apply(this,args);
    if(started) api.starts.push(args);
    return started;
  };
  api.context=context;
  api.update=(mask=0) => api.P1.update(mask,api.P2);
  api.frames=(count,mask=0) => {for(let i=0;i<count;i++) api.update(mask);};
  api.sim=(a=0,b=0) => api.simulate(a,b);
  api.game=context.Game;
  return api;
}
