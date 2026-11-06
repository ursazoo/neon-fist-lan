import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {tab,until} from './cdp.mjs';
const url=process.env.SITE_URL||'http://127.0.0.1:4174/';
const port=Number(process.env.CDP_PORT||19334);
const directory=new URL('../artifacts/input/',import.meta.url);await mkdir(directory,{recursive:true});
const pages=[],checks=[];
const pass=(name,details)=>{checks.push({name,result:'pass',details});console.log('PASS',name,JSON.stringify(details||''));};
async function page(){const p=await tab(port,url);pages.push(p);await until(()=>p.eval('!!window.NEON'),Boolean,30000);if(process.env.EXPECTED_BUILD)assert.equal(await p.eval('NEON.build'),process.env.EXPECTED_BUILD);return p;}
async function click(p,id){await p.eval(`document.getElementById(${JSON.stringify(id)}).click()`);}
async function frames(p,n){const first=await p.eval('NEON.Game.frame');return until(()=>p.eval('NEON.Game.frame'),f=>f>=first+n,15000);}
async function events(p,entries){await p.eval(`(()=>{for(const[code,down]of ${JSON.stringify(entries)})window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code,key:code.startsWith('Key')?code.slice(3).toLowerCase():code,bubbles:true,cancelable:true}));})()`);}
const tap=(p,...codes)=>events(p,[...codes.map(c=>[c,true]),...codes.map(c=>[c,false])]);
async function reset(p){await p.eval(`window.dispatchEvent(new Event('blur'));NEON.Game.paused=false;NEON.Game.cpu=false;NEON.Game.phase='fight';NEON.Game.phaseT=0;NEON.Game.hitstop=0;NEON.P1.reset(true);NEON.P2.reset(true);NEON.P1.setState('idle');NEON.P2.setState('idle');NEON.P1.x=330;NEON.P2.x=820;window.__moves=[];`);}
async function trace(p){await p.eval(`window.__moves=[];for(const f of[NEON.P1,NEON.P2]){const original=f.startMove;f.startMove=function(key,cancel){const result=original.call(this,key,cancel);if(result)__moves.push({side:this.side,key,frame:NEON.Game.frame,cancel:!!cancel});return result;};}`);}
async function move(p,key,side='p1'){return until(()=>p.eval(`__moves.filter(x=>x.side===${JSON.stringify(side)})`),rows=>rows.some(x=>x.key===key));}
try{
 const p=await page();await click(p,'start');await until(()=>p.eval('NEON.Game.phase'),x=>x==='fight');await trace(p);
 for(const[button,expected]of[['KeyJ','jumpPunch'],['KeyK','jumpKick']])for(const direction of [null,'KeyA','KeyD']){
  await reset(p);await tap(p,...[direction,'KeyW',button].filter(Boolean));await move(p,expected);assert(await p.eval('!NEON.P1.onGround'));await frames(p,45);assert.equal((await p.eval('__moves.filter(x=>x.side==="p1")')).length,1);pass('short same-frame jump attack', {button,direction,expected});
 }
 for(const[buttons,expected]of[[['KeyS','KeyJ'],'lowPunch'],[['KeyS','KeyK'],'lowKick'],[['KeyJ','KeyK'],'kick']]){
  await reset(p);await tap(p,...buttons);await move(p,expected);await frames(p,35);assert.equal((await p.eval('__moves.filter(x=>x.side==="p1")')).length,1);pass('explicit chord resolves once',{buttons,expected});
 }
 for(const[button,expected]of[['KeyU','deepseekSweep'],['KeyI','deepseekCounter'],['KeyO','deepseekSlide']]){await reset(p);await tap(p,button);await move(p,expected);pass('single-key special',{button,expected});}
 await reset(p);await events(p,[['KeyS',true],['KeyS',false],['KeyW',true],['KeyJ',true]]);await move(p,'jumpPunch');assert(await p.eval('!NEON.P1.onGround'));pass('released down cannot suppress the following jump attack');
 await reset(p);await events(p,[['KeyJ',true]]);await frames(p,80);assert.equal((await p.eval('__moves.filter(x=>x.side==="p1")')).length,1);await events(p,[['KeyJ',false]]);await frames(p,2);await tap(p,'KeyJ');await until(()=>p.eval('__moves.filter(x=>x.side==="p1").length'),n=>n===2);pass('hold does not repeat; release and press works');
 await reset(p);await events(p,[['KeyW',true],['Space',true],['KeyW',false]]);await frames(p,3);assert((await p.eval('NEON.P1.buf.cur()'))&4);await events(p,[['Space',false]]);await frames(p,3);assert.equal((await p.eval('NEON.P1.buf.cur()'))&4,0);pass('jump aliases retain other held source');
 await reset(p);await events(p,[['KeyA',true],['KeyD',true]]);await frames(p,3);assert.equal(await p.eval('NEON.P1.buf.dirAgo(0)'),5);assert.equal(await p.eval('NEON.P1.x'),330);await events(p,[['KeyA',false],['KeyD',false]]);pass('opposite horizontal directions are neutral');
 await reset(p);await tap(p,'KeyW','KeyS');await frames(p,4);assert(await p.eval('NEON.P1.onGround'));assert.equal(await p.eval('NEON.P1.state'),'idle');pass('opposite vertical directions do not create latent jump');
 await reset(p);await events(p,[['KeyL',true]]);await frames(p,2);
 const guard=await p.eval(`(()=>{const hp=NEON.P1.hp;const results=[NEON.P1.takeHit(NEON.MOVES.punch,NEON.P2),NEON.P1.takeHit(NEON.MOVES.punch,NEON.P2)];return {results,damage:hp-NEON.P1.hp};})()`);
 assert.deepEqual(guard.results,['block','block']);assert.equal(guard.damage,2*await p.eval('NEON.MOVES.punch.chip'));await frames(p,14);assert.equal(await p.eval('NEON.P1.state'),'block');pass('continuous block survives blockstun and release boundary',guard);
 await reset(p);await events(p,[['KeyS',true],['KeyL',true]]);await frames(p,3);assert.equal(await p.eval('NEON.P1.takeHit(NEON.MOVES.lowKick,NEON.P2)'),'block');assert.equal(await p.eval('NEON.P1.takeHit(NEON.MOVES.jumpKick,NEON.P2)'),'hit');pass('guard height still distinguishes low and overhead');
 await reset(p);await tap(p,'KeyJ');await move(p,'punch');await p.eval('NEON.P1.takeHit(NEON.MOVES.kick,NEON.P2)');assert.equal(await p.eval('NEON.P1.hitbox()'),null);assert.equal(await p.eval('NEON.P1.move'),null);await frames(p,30);assert.equal((await p.eval('__moves.filter(x=>x.side==="p1")')).length,1);pass('hit interrupts old move without resurrection');
 await reset(p);await tap(p,'KeyW','KeyK');await move(p,'jumpKick');await p.eval('NEON.P1.y=NEON.world.FLOOR-1;NEON.P1.vy=3');await frames(p,2);assert(await p.eval('NEON.P1.onGround'));assert.equal(await p.eval('!!NEON.P1.move?.air'),false);pass('landing stops aerial attack');
 await reset(p);await tap(p,'KeyP');assert(await p.eval('NEON.Game.paused'));await tap(p,'KeyJ');await tap(p,'KeyP');assert(!(await p.eval('NEON.Game.paused')));await frames(p,15);assert.equal((await p.eval('__moves')).length,0);pass('paused presses do not replay on resume');
 await reset(p);await click(p,'tNet');await tap(p,'KeyU');await click(p,'nClose');await frames(p,15);assert.equal((await p.eval('__moves')).length,0);pass('dialog presses do not leak into play');
 await reset(p);await events(p,[['KeyJ',true]]);await p.eval(`window.dispatchEvent(new Event('blur'))`);await frames(p,4);assert.equal(await p.eval('NEON.P1.buf.cur()'),0);pass('blur clears held and latched input');
 for(const surface of ['blur','visibility','dialog','focus','pause']){
  await reset(p);await p.eval(`(()=>{NEON.Game.paused=true;NEON.P1.setState('hitstun');NEON.P1.stun=3;NEON.P1.update(128,NEON.P2);})()`);
  if(surface==='blur')await p.eval(`window.dispatchEvent(new Event('blur'))`);
  if(surface==='visibility')await p.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
  if(surface==='dialog')await click(p,'tNet');
  if(surface==='focus')await p.eval(`document.getElementById('tNet').focus()`);
  if(surface==='pause')await tap(p,'KeyP');
  await p.eval('NEON.Game.paused=false');await frames(p,15);
  assert.equal((await p.eval('__moves')).length,0);assert.equal(await p.eval('NEON.P1.buf.detectSpecial()'),null);
  if(surface==='dialog')await click(p,'nClose');
  await p.eval('document.activeElement?.blur()');pass('sampled request is cancelled on '+surface);
 }
 const a=await page(),b=await page();for(const q of[a,b]){await trace(q);await click(q,'openNet');await q.eval('document.getElementById("manualConnect").open=true');}
 await click(a,'nHost');const offer=await until(()=>a.eval('document.getElementById("netout").value'),Boolean,15000);await click(b,'nJoin');await b.eval(`document.getElementById('netin').value=${JSON.stringify(offer)}`);await click(b,'nAccept');const answer=await until(()=>b.eval('document.getElementById("netout").value'),Boolean,15000);await a.eval(`document.getElementById('netin').value=${JSON.stringify(answer)}`);await click(a,'nAccept');
 for(const q of[a,b])await until(()=>q.eval('NEON.Game.phase'),x=>x==='fight',15000);
 await tap(a,'KeyW','KeyJ');await move(a,'jumpPunch');await move(b,'jumpPunch');pass('network preserves short jump chord');await frames(a,55);
 await tap(b,'KeyI');await move(a,'deepseekCounter','p2');await move(b,'deepseekCounter','p2');pass('network accepts expanded special input bits');await frames(a,60);
 const blocking=b.send('Runtime.evaluate',{expression:'(()=>{const end=performance.now()+1000;while(performance.now()<end){};})()'});
 await until(()=>a.eval('NEON.Net.state'),x=>x==='waiting',2000);await tap(a,'KeyU');await blocking;await move(a,'deepseekSweep');await move(b,'deepseekSweep');await frames(a,10);pass('short special pressed during network wait is retained');
 await frames(a,60);
 const target=await a.eval('NEON.Game.frame+45');
 for(const q of[a,b])await q.eval(`(()=>{const original=NEON.P1.update;NEON.P1.update=function(mask,opp){if(NEON.Game.frame===${target}){this.setState('hitstun');this.stun=30;this.update=original;}return original.call(this,mask,opp);};window.__moves=[];})()`);
 await until(()=>a.eval('NEON.P1.stun'),x=>x>20);await tap(a,'KeyU');
 for(const q of[a,b])await until(()=>q.eval('NEON.P1.buf.detectSpecial()?.move'),x=>x==='deepseekSweep');
 await a.eval(`window.dispatchEvent(new Event('blur'))`);
 for(const q of[a,b])await until(()=>q.eval('NEON.P1.buf.detectSpecial()'),x=>x===null);
 await frames(a,40);
 for(const q of[a,b])assert.equal((await q.eval('__moves.filter(x=>x.side==="p1")')).length,0);
 pass('sampled network request is cancelled identically on both peers');
 const left=await a.eval('NEON.Net.checkpoints'),right=await b.eval('NEON.Net.checkpoints');const common=left.filter(x=>right.some(y=>x.epoch===y.epoch&&x.frame===y.frame));assert(common.length>20);for(const row of common)assert.equal(row.hash,right.find(y=>row.epoch===y.epoch&&row.frame===y.frame).hash);pass('network state and request consumption agree',{checkpoints:common.length,throughFrame:Math.max(...common.map(x=>x.frame))});
 const identity=await p.eval('({build:NEON.build,config:NEON.fingerprint})');
 const report={result:'pass',site:url,...identity,environment:'Chrome windows on one computer; physical keyboards and two-PC Wi-Fi acceptance pending.',checks};await writeFile(new URL('report.json',directory),JSON.stringify(report,null,2)+'\n');
}catch(error){await writeFile(new URL('report.json',directory),JSON.stringify({result:'fail',checks,error:error.stack},null,2)+'\n');throw error;}finally{await Promise.all(pages.map(p=>p.destroy().catch(()=>p.close())));}
