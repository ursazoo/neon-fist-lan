import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {tab,until} from './cdp.mjs';
const directory=new URL('../artifacts/sprite-render/',import.meta.url);
await mkdir(directory,{recursive:true});
const registry=JSON.parse(await readFile(process.env.METADATA_PATH||new URL('../assets/fighters/ai.json',import.meta.url),'utf8'));
for(const meta of Object.values(registry))meta.scale=1;
const p=await tab(Number(process.env.CDP_PORT||19334),process.env.SITE_URL||'http://127.0.0.1:4174/');
try{
 await until(()=>p.eval('!!window.NEON'),Boolean,20000);
 const result=await p.eval(`(async()=>{
  NEON.Game.paused=true;
  const registry=${JSON.stringify(registry)};
  const originalFetch=window.fetch;
  window.fetch=async(url,options)=>new URL(url,location.href).pathname.endsWith('/assets/fighters/ai.json')?new Response(JSON.stringify(registry),{headers:{'Content-Type':'application/json'}}):originalFetch(url,options);
  let sprites;
  try{sprites=await(await import('./shared/sprites.js?pixel-audit=1')).loadSprites(new URL('.',location.href));}finally{window.fetch=originalFetch;}
  const failures=[],characters=[],sheets={};
  for(const [id,{meta,image}]of Object.entries(sprites.characters)){
   const source=document.createElement('canvas');source.width=image.naturalWidth;source.height=image.naturalHeight;
   const sg=source.getContext('2d',{willReadFrequently:true});sg.drawImage(image,0,0);
   const pixels=sg.getImageData(0,0,source.width,source.height).data,W=source.width,H=source.height;
   const labels=new Int32Array(W*H),components=[null];let serial=0;
   for(let start=0;start<labels.length;start++){
    if(labels[start]||pixels[start*4+3]<96)continue;
    const label=++serial,stack=[start],points=[];labels[start]=label;
    while(stack.length){const q=stack.pop(),x=q%W,y=(q/W)|0;points.push(q);
     for(const n of [x?q-1:-1,x<W-1?q+1:-1,y?q-W:-1,y<H-1?q+W:-1])if(n>=0&&!labels[n]&&pixels[n*4+3]>=96){labels[n]=label;stack.push(n);}
    }
    components[label]=points.length>700?points:null;
   }
   const cases=[],base={side:'p1',stateFrame:0,moveFrame:0,move:null,onGround:true,vy:0,anim:'idle'};
   for(const state of ['idle','walk','back','hitstun','blockstun','ko','win','crouch','block','crouchBlock'])for(let n=0;n<45;n++)cases.push({...base,state,stateFrame:n});
   for(const vy of [-4,0,4])cases.push({...base,state:'jump',vy});
   for(const move of Object.values(NEON.MOVES))for(let n=0;n<move.startup+move.active+move.recovery;n++)cases.push({...base,state:'attack',move,moveFrame:n});
   const seen=new Set(),rows=[];
   for(const fighter of cases){const frame=sprites.frame(fighter,id);if(seen.has(frame.frameName))continue;seen.add(frame.frameName);
    const [x,y,w,h]=frame.rect,counts=new Map();
    for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){const label=labels[yy*W+xx];if(components[label])counts.set(label,(counts.get(label)||0)+1);}
    const label=[...counts].sort((a,b)=>b[1]-a[1])[0]?.[0];if(!label){failures.push({id,frame:frame.frameName,error:'empty pose'});continue;}
    const padding=8,c=document.createElement('canvas');c.width=w+padding*2;c.height=h+padding*2;
    const g=c.getContext('2d',{willReadFrequently:true});g.translate(frame.origin[0]+padding,frame.origin[1]+padding);sprites.draw(g,fighter,id);
    const actual=g.getImageData(0,0,c.width,c.height).data;let missing=0,foreign=0;
    for(const q of components[label]){const xx=q%W-x+padding,yy=((q/W)|0)-y+padding;if(xx<0||xx>=c.width||yy<0||yy>=c.height||actual[(yy*c.width+xx)*4+3]<48)missing++;}
    for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){const owner=labels[(y+yy)*W+x+xx];if(owner!==label&&components[owner]&&actual[((yy+padding)*c.width+xx+padding)*4+3]>=48)foreign++;}
    rows.push({frame:frame.frameName,missing,foreign,rect:frame.rect});
    if(missing||foreign)failures.push({id,frame:frame.frameName,missing,foreign});
   }
   characters.push({id,sourcePoses:components.filter(Boolean).length,testedFrames:rows.length,frames:rows});
  }
  return {result:failures.length?'fail':'pass',failures,characters};
 })()`);
 await writeFile(new URL(process.env.REPORT_NAME||'report.json',directory),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({result:result.result,tested:result.characters.map(c=>({id:c.id,frames:c.testedFrames})),failures:result.failures}));
 assert.equal(result.failures.length,0,'every rendered frame preserves its complete pose and excludes other poses');
}finally{await p.destroy().catch(()=>p.close());}
