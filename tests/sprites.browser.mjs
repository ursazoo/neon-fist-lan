import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {tab,until} from './cdp.mjs';
const destination=new URL('../artifacts/sprites/',import.meta.url);
await mkdir(destination,{recursive:true});
const p=await tab(Number(process.env.CDP_PORT||19334),process.env.SITE_URL||'http://127.0.0.1:4174/');
const checks=[];
async function key(code,down){await p.send('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',code,key:code.slice(3).toLowerCase()});}
async function record(n){return p.eval(`new Promise(resolve=>{const rows=[];function read(){rows.push({step:NEON.Game.frame,state:NEON.P1.state,move:NEON.P1.move?.key,moveFrame:NEON.P1.moveFrame,sprite:NEON.sprites.frame('p1')});if(rows.length<${n})requestAnimationFrame(read);else resolve(rows);}requestAnimationFrame(read);})`);}
async function recordSteps(n){return p.eval(`new Promise(resolve=>{const first=NEON.Game.frame,rows=[];function read(){rows.push({step:NEON.Game.frame,state:NEON.P1.state,sprite:NEON.sprites.frame('p1')});if(NEON.Game.frame-first<${n})requestAnimationFrame(read);else resolve(rows);}requestAnimationFrame(read);})`);}
async function action(code,n=42){
 await p.eval(`window.__spriteTrace=[];window.__spriteDone=new Promise(resolve=>{function read(){__spriteTrace.push({step:NEON.Game.frame,state:NEON.P1.state,move:NEON.P1.move?.key,moveFrame:NEON.P1.moveFrame,sprite:NEON.sprites.frame('p1')});if(__spriteTrace.length<${n})requestAnimationFrame(read);else resolve(__spriteTrace);}requestAnimationFrame(read);});void 0;`);
 await key(code,true);await record(3);await key(code,false);
 return p.eval('window.__spriteDone');
}
try{
 await until(()=>p.eval('!!window.NEON?.sprites'),Boolean,15000);
 await p.eval('document.getElementById("start").click()');
 await until(()=>p.eval('NEON.Game.phase'),x=>x==='fight');
 await p.eval('NEON.Game.cpu=false;NEON.Projectiles.clear();for(const f of [NEON.P1,NEON.P2]){f.reset(true);f.setState("idle");}NEON.P1.x=300;NEON.P2.x=850;');
 const idle=await record(40);
 assert(new Set(idle.map(x=>x.sprite.frameName)).size>=4,'idle plays all four sprite drawings');
 await key('KeyD',true);const walk=await recordSteps(36);await key('KeyD',false);
 await writeFile(new URL('walk-trace.json',destination),JSON.stringify(walk,null,2));
 assert(new Set(walk.filter(x=>x.state==='walk').map(x=>x.sprite.frameName)).size>=5,'walk plays at least five drawings');
 await record(4);
 const punch=await action('KeyJ');
 await writeFile(new URL('punch-trace.json',destination),JSON.stringify(punch,null,2));
 const attack=punch.filter(x=>x.move==='punch'&&x.state==='attack');
 assert(attack.some(x=>x.sprite.phase==='startup'));
 assert(attack.some(x=>x.sprite.phase==='active'));
 assert(attack.some(x=>x.sprite.phase==='recovery'));
 assert(new Set(attack.map(x=>x.sprite.frameName)).size>=4,'punch has anticipation, extension and retraction');
 const kick=await action('KeyK',48);
 assert(new Set(kick.filter(x=>x.move==='kick').map(x=>x.sprite.frameName)).size>=4,'kick cycles through distinct drawings');
 const jump=await action('KeyW',48);
 assert(new Set(jump.filter(x=>x.state==='jump').map(x=>x.sprite.frameName)).size>=2,'rising and falling jump poses differ');
 await p.eval('NEON.Game.paused=true');
 const paused=await record(12);
 assert(paused.every(x=>x.step===paused[0].step&&x.sprite.frameName===paused[0].sprite.frameName),'pause holds sprite and simulation');
 const purity=await p.eval(`(()=>{const before=JSON.stringify(NEON.P1.save({}));for(let i=0;i<100;i++)NEON.sprites.frame('p1');return before===JSON.stringify(NEON.P1.save({}));})()`);
 assert(purity,'sampling does not mutate gameplay');
 checks.push('actual keyboard idle/walk/punch/kick/jump sequences','pause freezes sprite','render sampling preserves fighter snapshot');
 await p.eval('NEON.Game.paused=false');
 const {data}=await p.send('Page.captureScreenshot',{format:'png'});
 await writeFile(new URL('game.png',destination),Buffer.from(data,'base64'));
 const errors=p.events.filter(e=>e.method==='Runtime.exceptionThrown');
 assert.equal(errors.length,0,JSON.stringify(errors));
 await writeFile(new URL('report.json',destination),JSON.stringify({result:'pass',checks,idle,walk,punch,kick,jump},null,2)+'\n');
 console.log('PASS sprite browser verification',checks);
}finally{await p.destroy().catch(()=>p.close());}
