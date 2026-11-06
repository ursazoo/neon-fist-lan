import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tab, until } from './cdp.mjs';

const port = Number(process.env.CDP_PORT || 19334);
const site = process.env.SITE_URL || 'http://127.0.0.1:4174/';
const destination = new URL('../artifacts/skills/', import.meta.url);
await mkdir(destination, { recursive:true });
const pages = [], checks = [], traces = [];
const pass = (name, details) => { checks.push({name,result:'pass',details}); console.log('PASS',name,JSON.stringify(details || '')); };
async function page() {
  const p=await tab(port,site); pages.push(p);
  await until(()=>p.eval('!!window.NEON?.SKILLS'),Boolean,45000);
  if(process.env.EXPECTED_BUILD) assert.equal(await p.eval('NEON.build'),process.env.EXPECTED_BUILD);
  await p.eval(`window.__moves=[];window.__poses=[];for(const f of [NEON.P1,NEON.P2]){
    const start=f.startMove;f.startMove=function(...args){const ok=start.apply(this,args);if(ok)__moves.push({side:this.side,key:this.move.key,frame:NEON.Game.frame});return ok;};
    const update=f.update;f.update=function(...args){const result=update.apply(this,args);if(this.idx===0&&this.move?.skillArt){const sprite=NEON.skillSprites.frame('p1');__poses.push({frame:NEON.Game.frame,key:this.move.key,moveFrame:this.moveFrame,sprite});}return result;};
  }`);
  return p;
}
const click=(p,id)=>p.eval(`document.getElementById(${JSON.stringify(id)}).click()`);
async function key(p,code,down){await p.send('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',code,key:code.startsWith('Key')?code.slice(3).toLowerCase():code});}
async function tap(p,code){await key(p,code,true);await key(p,code,false);}
async function frames(p,count){const first=await p.eval('NEON.Game.frame');return until(()=>p.eval('NEON.Game.frame'),n=>n>=first+count,15000);}
async function prepare(p,character,{near=false,paused=false,opponent='claude',meter=0}={}){
  await p.eval(`(()=>{window.dispatchEvent(new Event('blur'));NEON.startMatch(12345,[${JSON.stringify(character)},${JSON.stringify(opponent)}]);NEON.Game.phase='fight';NEON.Game.phaseT=0;NEON.Game.cpu=false;NEON.Game.hitstop=0;NEON.Game.paused=${paused};NEON.P1.setState('idle');NEON.P2.setState('idle');NEON.P1.x=330;NEON.P2.x=${near?410:850};NEON.P1.meter=${meter};window.__moves=[];window.__poses=[];})()`);
  await p.eval(`document.getElementById('center').style.opacity=0;document.getElementById('sub').style.opacity=0`);
  if(paused)await p.eval('new Promise(resolve=>requestAnimationFrame(()=>resolve()))');
}
async function screenshot(p,name){const{data}=await p.send('Page.captureScreenshot',{format:'png'});await writeFile(new URL(name+'.png',destination),Buffer.from(data,'base64'));}
async function compare(a,b,label){
  const left=await a.eval('NEON.Net.checkpoints'),right=await b.eval('NEON.Net.checkpoints');
  const common=left.filter(x=>right.some(y=>x.epoch===y.epoch&&x.frame===y.frame));assert(common.length>15,label);
  for(const row of common)assert.equal(row.hash,right.find(y=>row.epoch===y.epoch&&row.frame===y.frame).hash,label+' frame '+row.frame);
  pass(label,{checkpoints:common.length,throughFrame:Math.max(...common.map(x=>x.frame))});
}
async function exchange(a,b,roster){
  for(const [p,id]of[[a,roster[0]],[b,roster[1]]]){await p.eval(`document.querySelector('#boot [data-picker="local"] [data-character="${id}"]').click()`);await click(p,'openNet');await p.eval('document.getElementById("manualConnect").open=true');}
  await click(a,'nHost');const offer=await until(()=>a.eval('document.getElementById("netout").value'),Boolean,15000);
  await click(b,'nJoin');await b.eval(`document.getElementById('netin').value=${JSON.stringify(offer)}`);await click(b,'nAccept');
  const answer=await until(()=>b.eval('document.getElementById("netout").value'),Boolean,15000);
  await a.eval(`document.getElementById('netin').value=${JSON.stringify(answer)}`);await click(a,'nAccept');
  for(const p of[a,b])await until(()=>p.eval('NEON.Game.phase'),x=>x==='fight',20000);
}

try{
  const p=await page();await click(p,'start');
  for(const character of['deepseek','claude','chatgpt']){
    const definitions=await p.eval(`NEON.SKILLS.${character}`);
    for(const[input,code,row]of[['fireball','KeyU',0],['uppercut','KeyI',1],['spinKick','KeyO',2],['super','KeyN',3]]){
      await prepare(p,character,{meter:100});await tap(p,code);
      await until(()=>p.eval('__moves'),rows=>rows.some(x=>x.key===definitions[input].key));
      await frames(p,definitions[input].startup+definitions[input].active+definitions[input].recovery+5);
      const poses=await p.eval('__poses');const selected=poses.filter(x=>x.key===definitions[input].key);
      assert(selected.length>0);assert(selected.every(x=>x.sprite?.row===row));
      assert(selected.some(x=>x.sprite.phase==='active'));assert(selected.some(x=>x.sprite.phase==='recovery'));
      if(definitions[input].startup>2)assert(selected.some(x=>x.sprite.phase==='startup'));
      assert(selected.filter(x=>x.sprite.phase==='active').every(x=>x.sprite.column===(definitions[input].skillArt.activeColumn??(definitions[input].skillArt.columns.length===4?2:definitions[input].skillArt.columns[1]))));
      assert.equal((await p.eval('__moves')).filter(x=>x.key===definitions[input].key).length,1);
      traces.push({character,input,poses:selected});pass('native key plays phase-aligned skill',{character,input,drawings:[...new Set(selected.map(x=>x.sprite.column))]});
    }
    await prepare(p,character,{paused:true});
    const smooth=await p.eval(`(()=>{const f=NEON.P1;f.startMove(NEON.SKILLS.${character}.fireball.key);f.moveFrame=2;const before=NEON.deterministicHash();const samples=[0,.25,.5,.75].map(a=>NEON.skillSprites.frame('p1',a));return {samples,pure:before===NEON.deterministicHash(),alpha:NEON.renderAlpha};})()`);
    assert(smooth.pure);assert.equal(smooth.alpha,0);assert.equal(new Set(smooth.samples.map(x=>JSON.stringify(x.transform))).size,4);
    assert.equal(new Set(smooth.samples.map(x=>x.frameName)).size,1);pass('subframe easing preserves one drawing and gameplay state',{character});
    await screenshot(p,character+'-skill');
    for(const blocked of[false,true]){
      await prepare(p,character,{near:true,paused:true,meter:100});
      const result=await p.eval(`(()=>{const{P1,P2,Game}=NEON;const bit=NEON.BTN.SUPER;const guard=${blocked}?NEON.BTN.BLOCK:0;const rows=[];for(let i=0;i<120;i++){NEON.simulate(i===0?bit:0,guard);rows.push({hp:P2.hp,confirmed:!!P1.skill.superConfirm,effects:NEON.worldEffects().filter(x=>x.row===3).length});}return {hp:P2.hp,meter:P1.meter,confirmed:rows.some(x=>x.confirmed),vfx:rows.some(x=>x.effects),rows};})()`);
      assert.equal(result.meter,0);assert.equal(result.confirmed,!blocked);assert.equal(result.vfx,!blocked);
      assert(blocked?result.hp===98:result.hp>=68&&result.hp<=76);pass('super spends meter and follows hit confirmation',{character,blocked,hp:result.hp});
    }
    await prepare(p,character,{paused:true,meter:0});
    const noMeter=await p.eval(`(()=>{NEON.simulate(NEON.BTN.SUPER|NEON.BTN.PUNCH,0);return {key:NEON.P1.move?.key,meter:NEON.P1.meter};})()`);
    assert.equal(noMeter.key,'punch');assert.equal(noMeter.meter,0);pass('empty super preserves simultaneous normal',{character});
  }
  await prepare(p,'claude',{paused:true});
  const trap=await p.eval(`(()=>{const{P1,BTN}=NEON;for(let i=0;i<40;i++)NEON.simulate(i===0?BTN.SPIN:0,0);const placed=structuredClone(P1.skill.trap);NEON.simulate(BTN.SPIN,0);for(let i=0;i<5;i++)NEON.simulate(0,0);const warning=structuredClone(P1.skill.trap);return{placed,warning};})()`);
  assert.equal(trap.placed.phase,'armed');assert.equal(trap.warning.phase,'warning');pass('second O triggers the same placed bookmark',{x:trap.placed.x});await screenshot(p,'claude-bookmark');
  await prepare(p,'deepseek',{near:true,paused:true});
  const counter=await p.eval(`(()=>{const{P1,P2}=NEON;P1.startMove('deepseekCounter');P1.moveFrame=3;const result=P1.takeHit(NEON.MOVES.punch,P2);return{result,hp:P1.hp,foe:P2.hp,key:P1.move.key};})()`);
  assert.equal(counter.result,'counter');assert.equal(counter.hp,100);assert.equal(counter.foe,86);pass('whale counter animates actual retaliation',counter);await screenshot(p,'deepseek-counter');
  await prepare(p,'chatgpt',{near:true,paused:true,opponent:'claude'});
  const reflection=await p.eval(`(()=>{const{P1,P2,Projectiles}=NEON;P2.startMove('claudePage');const shot=Projectiles.spawn(P2);shot.x=P1.x+50;shot.y=P1.y-98;P1.startMove('chatgptReflect');P1.moveFrame=4;Projectiles.update([P1,P2]);return{owner:shot.owner,reflections:shot.reflections,vx:shot.vx};})()`);
  assert.equal(reflection.owner,0);assert.equal(reflection.reflections,1);assert(reflection.vx>0);pass('wing return reflects a real page projectile',reflection);await screenshot(p,'chatgpt-reflect');
  const pixelCheck=await p.eval(`(async()=>{
    const {loadSkillSprites}=await import('./shared/skillSprites.js');const atlas=await loadSkillSprites(new URL('./',location.href));
    const out=[];for(const [character,sheets]of Object.entries(atlas.characters))for(const[kind,sheet]of Object.entries(sheets)){
      const canvas=document.createElement('canvas');canvas.width=sheet.meta.width;canvas.height=sheet.meta.height;const ctx=canvas.getContext('2d');ctx.drawImage(sheet.image,0,0);const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;let lost=0,contaminated=0;
      for(const f of sheet.meta.frames){const [x,y,w,h]=f.rect;const band=sheet.meta.bands[f.row];const left=band.x[f.column],right=band.x[f.column+1],top=band.y[0],bottom=band.y[1];
        for(let py=top;py<bottom;py++)for(let px=left;px<right;px++)if(rgba[(py*canvas.width+px)*4+3]>24&&!(px>=x&&px<x+w&&py>=y&&py<y+h))lost++;
        for(let py=y;py<y+h;py++)for(let px=x;px<x+w;px++)if(rgba[(py*canvas.width+px)*4+3]>24&&!(px>=left&&px<right&&py>=top&&py<bottom))contaminated++;
      }out.push({character,kind,frames:sheet.meta.frames.length,lost,contaminated});
    }return out;
  })()`);
  assert.equal(pixelCheck.reduce((n,x)=>n+x.frames,0),96);assert(pixelCheck.every(x=>x.lost===0&&x.contaminated===0));pass('96 real Canvas source frames preserve contours without neighboring pixels',pixelCheck);
  for(const roster of[['deepseek','claude'],['claude','chatgpt']]){
    const a=await page(),b=await page();await exchange(a,b,roster);
    for(const[peer,side,character]of[[a,'p1',roster[0]],[b,'p2',roster[1]]])for(const[input,code]of[['fireball','KeyU'],['uppercut','KeyI'],['spinKick','KeyO']]){
      const expected=await peer.eval(`NEON.SKILLS.${character}.${input}.key`);await tap(peer,code);
      for(const q of[a,b])await until(()=>q.eval('__moves'),rows=>rows.some(x=>x.side===side&&x.key===expected));
      await frames(a,65);
    }
    await compare(a,b,'different-character skills agree on both peers '+roster.join('/'));
    const chargedFrame=await a.eval('NEON.Game.frame+45');
    for(const q of[a,b])await q.eval(`(()=>{const original=NEON.P1.update;NEON.P1.update=function(...args){if(NEON.Game.frame===${chargedFrame}){NEON.P1.meter=100;NEON.P2.meter=100;this.update=original;}return original.apply(this,args);};})()`);
    await frames(a,50);
    for(const[peer,side,character]of[[a,'p1',roster[0]],[b,'p2',roster[1]]]){
      const expected=await peer.eval(`NEON.SKILLS.${character}.super.key`);await tap(peer,'KeyN');
      for(const q of[a,b])await until(()=>q.eval('__moves'),rows=>rows.some(x=>x.side===side&&x.key===expected));
      await frames(a,90);
      for(const q of[a,b])assert.equal(await q.eval(`NEON.${side==='p1'?'P1':'P2'}.meter`),0);
    }
    await compare(a,b,'expanded super input and meter spend agree '+roster.join('/'));
    await a.send('Emulation.setCPUThrottlingRate',{rate:4});await frames(b,45);await a.send('Emulation.setCPUThrottlingRate',{rate:1});
    await compare(a,b,'render load does not alter skill simulation '+roster.join('/'));
  }
  assert(pages.every(p=>p.events.every(e=>e.method!=='Runtime.exceptionThrown')),'no unhandled browser exceptions');
  const report={result:'pass',site,build:await p.eval('NEON.build'),environment:'Chrome CDP, same-computer windows; physical two-PC Wi-Fi acceptance pending',checks};
  await writeFile(new URL('report.json',destination),JSON.stringify(report,null,2)+'\n');await writeFile(new URL('traces.json',destination),JSON.stringify(traces,null,2)+'\n');
}catch(error){await writeFile(new URL('report.json',destination),JSON.stringify({result:'fail',checks,error:error.stack},null,2)+'\n');throw error;}
finally{await Promise.all(pages.map(p=>p.destroy().catch(()=>p.close())));}
