import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {tab,until} from './cdp.mjs';

const site=process.env.SITE_URL||'http://127.0.0.1:4174/';
const port=Number(process.env.CDP_PORT||19334);
const folder=new URL('../artifacts/rooms/',import.meta.url);
await mkdir(folder,{recursive:true});
const pages=[],checks=[];
const passed=(name,details)=>{checks.push({name,result:'pass',details});console.log('PASS',name,JSON.stringify(details||''));};
async function page(url=site){
  const p=await tab(port,url);pages.push(p);
  await until(()=>p.eval('!!window.NEON'),Boolean,40000);
  await until(()=>p.eval('Number(getComputedStyle(document.getElementById("loading")).opacity)'),v=>v<.01);
  if(process.env.EXPECTED_BUILD)assert.equal(await p.eval('NEON.build'),process.env.EXPECTED_BUILD);
  return p;
}
async function click(p,id){await p.eval(`(()=>{const b=document.getElementById(${JSON.stringify(id)});if(!b||b.disabled)throw Error('Disabled '+${JSON.stringify(id)});b.click();})()`);}
async function key(p,code,down){await p.send('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',code,key:code==='Enter'?'Enter':code.slice(3).toLowerCase()});}
async function advance(p,n){const first=await p.eval('NEON.Game.frame');return until(()=>p.eval('({frame:NEON.Game.frame,phase:NEON.Game.phase})'),s=>s.frame>=first+n||s.phase==='matchEnd',15000);}
async function compare(a,b,name){
  const rows=await a.eval('NEON.Net.checkpoints'),other=await b.eval('NEON.Net.checkpoints');
  const common=rows.filter(r=>other.some(q=>q.epoch===r.epoch&&q.frame===r.frame));
  assert(common.length>10);
  for(const row of common)assert.equal(row.hash,other.find(q=>q.epoch===row.epoch&&q.frame===row.frame).hash);
  passed(name,{checkpoints:common.length,throughFrame:Math.max(...common.map(r=>r.frame))});
}
async function shot(p,name){const capture=await p.send('Page.captureScreenshot',{format:'png'});await writeFile(new URL(name+'.png',folder),Buffer.from(capture.data,'base64'));}
async function join(p,code){await p.eval(`document.getElementById('rCode').value=${JSON.stringify(code)}`);await click(p,'rJoin');}

try{
  const a=await page();await click(a,'openNet');
  assert(await a.eval('!document.getElementById("manualConnect").open'));
  assert.equal(a.events.filter(e=>e.method==='Network.webSocketCreated').length,0);
  await shot(a,'entry-desktop');
  await a.send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:false});
  assert(await a.eval(`document.getElementById('netui').scrollWidth<=375`));
  await shot(a,'entry-mobile');
  await a.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  passed('room controls fit desktop and 375px; no signaling connection before use');
  await join(a,'123');
  await until(()=>a.eval('document.getElementById("netstat").textContent'),t=>/6|六|房间号/.test(t));
  assert.equal(await a.eval('NEON.Net.active'),false);
  assert.equal(a.events.filter(e=>e.method==='Network.webSocketCreated').length,0);
  passed('invalid short code does not open a signaling connection');
  await click(a,'rCreate');
  const code=await until(()=>a.eval('NEON.Rooms.state==="waiting"&&document.getElementById("rNumber").value'),v=>/^\d{6}$/.test(v),25000);
  assert(await a.eval('document.querySelector("#netui .character-card").disabled'));
  await shot(a,'waiting');passed('public signaling registers a six digit room',{codeLength:code.length});
  await a.send('Browser.grantPermissions',{origin:new URL(site).origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await click(a,'rCopy');assert.equal(await a.eval('navigator.clipboard.readText()'),code);
  await click(a,'rInvite');const invite=await a.eval('navigator.clipboard.readText()');
  assert.equal(new URL(invite).hash,'#room='+code);passed('copy code and invitation link use the actual clipboard');
  const b=await page(invite);
  assert.equal(await b.eval('document.getElementById("rCode").value'),code);
  assert.equal(await b.eval('document.getElementById("netui").style.display'),'flex');
  await b.eval('document.querySelector("#netui [data-character=claude]").click()');await click(b,'rJoin');
  for(const q of[a,b])await until(()=>q.eval('NEON.Net.state'),s=>['playing','waiting'].includes(s),25000);
  for(const q of[a,b]){
    assert.deepEqual(await q.eval('NEON.Game.roster'),['deepseek','claude']);
    assert.equal((await q.eval('NEON.Net.pc.getConfiguration()')).iceServers.length,0);
  }
  passed('invite opens with room prefilled; one join establishes LAN-only game with selected characters');
  await until(()=>a.eval('NEON.Game.phase'),s=>s==='fight',15000);
  const c=await page();await click(c,'openNet');await join(c,code);
  await until(()=>c.eval('document.getElementById("netstat").textContent'),s=>/已满|两人|占用/.test(s),25000);
  assert(['playing','waiting'].includes(await a.eval('NEON.Net.state')));
  passed('third player sees room full and cannot interrupt the match');
  await join(c,'000000');
  await until(()=>c.eval('document.getElementById("netstat").textContent'),s=>/不存在|找不到|未找到|无此|离开/.test(s),25000);
  passed('unknown room gives a retryable message');
  await click(c,'rCreate');await until(()=>c.eval('NEON.Rooms.state'),s=>s==='waiting',25000);
  const cancelled=await c.eval('NEON.Rooms.code');await click(c,'rCancel');
  assert.equal(await c.eval('NEON.Rooms.active'),false);
  assert.equal(await c.eval('document.getElementById("rCreate").disabled'),false);
  assert(await c.eval('!document.getElementById("manualConnect").hidden'));
  await click(c,'rCreate');const rebuilt=await until(()=>c.eval('NEON.Rooms.state==="waiting"&&NEON.Rooms.code'),Boolean,25000);assert.notEqual(rebuilt,cancelled);
  await c.eval('window.__writeClipboard=navigator.clipboard.writeText;navigator.clipboard.writeText=()=>Promise.reject(new Error("Clipboard unavailable"))');
  await click(c,'rCopy');assert.equal(await c.eval('document.getElementById("room-share-fallback").value'),rebuilt);assert.equal(await c.eval('document.getElementById("room-share-fallback").hidden'),false);
  await c.eval('navigator.clipboard.writeText=window.__writeClipboard');passed('clipboard denial exposes selected content for manual copy');
  await click(c,'rCancel');
  passed('cancel releases the room and allows a fresh room or manual fallback');
  await c.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await click(c,'rCreate');
  await until(()=>c.eval('NEON.Rooms.state'),s=>s==='error',25000);
  assert.equal(await c.eval('document.getElementById("manualConnect").hidden'),false);
  assert.equal(await c.eval('document.getElementById("rCreate").disabled'),false);
  await c.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await c.eval('document.getElementById("manualConnect").open=true');await click(c,'nHost');
  await until(()=>c.eval('document.getElementById("netout").value'),Boolean,15000);await click(c,'nDisconnect');
  passed('unavailable signaling permits retry and manual LAN fallback');
  const practice=await page();await click(practice,'start');await until(()=>practice.eval('NEON.Game.phase'),s=>s==='fight');
  await click(practice,'tNet');await click(practice,'rCreate');await until(()=>practice.eval('NEON.Rooms.state'),s=>s==='waiting',25000);
  await click(practice,'rCancel');await click(practice,'nClose');assert.equal(await practice.eval('NEON.Net.state'),'idle');await advance(practice,10);
  await click(practice,'tNet');await practice.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await click(practice,'rCreate');
  await until(()=>practice.eval('NEON.Rooms.state'),s=>s==='error',25000);
  assert.match(await practice.eval('document.getElementById("netstatus").textContent'),/信令|房间|服务/);
  assert.doesNotMatch(await practice.eval('document.getElementById("netstatus").textContent'),/已离开对局/);
  await practice.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await click(practice,'nClose');assert.equal(await practice.eval('NEON.Net.state'),'idle');await advance(practice,10);
  passed('cancel or failed connection returns to the original practice and preserves the real error');
  await Promise.all([key(a,'KeyD',true),key(b,'KeyA',true)]);await advance(a,59);
  await Promise.all([key(a,'KeyD',false),key(b,'KeyA',false)]);
  for(let i=0;i<5;i++){await key(a,'KeyJ',true);await advance(a,2);await key(a,'KeyJ',false);await advance(a,22);}
  for(let i=0;i<4;i++){await key(b,'KeyK',true);await advance(a,2);await key(b,'KeyK',false);await advance(a,25);}
  assert(await a.eval('NEON.P1.hp<100&&NEON.P2.hp<100'));await compare(a,b,'room transport carries both keyboards and combat deterministically');
  for(let i=0;i<65&&(await a.eval('NEON.Game.phase'))!=='matchEnd';i++){
    if((await a.eval('NEON.Game.phase'))==='fight'){
      await key(a,'KeyD',true);await advance(a,10);await key(a,'KeyD',false);
      await key(a,'KeyK',true);await advance(a,2);await key(a,'KeyK',false);await advance(a,25);
    }else await new Promise(r=>setTimeout(r,300));
  }
  for(const q of[a,b])await until(()=>q.eval('NEON.Game.phase'),s=>s==='matchEnd',20000);
  await compare(a,b,'room match ends with the same state');
  const epoch=await a.eval('NEON.Net.epoch');await key(a,'Enter',true);await key(a,'Enter',false);
  await new Promise(r=>setTimeout(r,250));assert.equal(await a.eval('NEON.Net.epoch'),epoch);
  await key(b,'Enter',true);await key(b,'Enter',false);
  for(const q of[a,b])await until(()=>q.eval('NEON.Net.epoch'),v=>v>epoch,12000);
  await advance(a,150);await compare(a,b,'both players agree to rematch without creating a new room');
  await click(a,'tNet');await click(a,'nDisconnect');
  assert.notEqual(await a.eval('NEON.Net.state'),'idle');
  await until(()=>b.eval('NEON.Net.state'),s=>['disconnected','error'].includes(s));
  const frozen=await b.eval('NEON.Game.frame');await new Promise(r=>setTimeout(r,400));assert.equal(await b.eval('NEON.Game.frame'),frozen);
  passed('room disconnect freezes the other player');
  const errors=pages.flatMap(p=>p.events.filter(e=>e.method==='Runtime.exceptionThrown'));assert.equal(errors.length,0,JSON.stringify(errors));
  const identity=await a.eval('({build:NEON.build,config:NEON.fingerprint})');
  const report={result:'pass',site,...identity,environment:'Chrome windows on one computer through public PeerServer Cloud; physical two-PC Wi-Fi acceptance pending.',checks};
  await writeFile(new URL(process.env.SITE_URL?'production-report.json':'local-report.json',folder),JSON.stringify(report,null,2)+'\n');
}catch(error){
  const snapshots=await Promise.all(pages.map(async(p,i)=>{await shot(p,'failure-'+i).catch(()=>{});return{state:await p.eval('({net:NEON?.Net.state,room:NEON?.Rooms.state,code:NEON?.Rooms.code,message:document.getElementById("netstat")?.textContent,build:NEON?.build})').catch(()=>null),events:p.events.filter(e=>['Runtime.exceptionThrown','Runtime.consoleAPICalled','Network.webSocketFrameReceived','Network.webSocketFrameSent','Network.webSocketFrameError'].includes(e.method)).slice(-20)};}));
  await writeFile(new URL('failure.json',folder),JSON.stringify({result:'fail',site,checks,snapshots,error:error.stack},null,2)+'\n');throw error;
}
finally{await Promise.all(pages.map(p=>p.destroy().catch(()=>p.close())));}
