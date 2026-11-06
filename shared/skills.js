const freeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};

const move = (key, name, input, row, spec) => ({
  key, name, input, anim:input === 'super' ? 'fireball' : input,
  special:true, kind:'melee', startup:7, active:4, recovery:20,
  damage:10, chip:1, hitstun:22, blockstun:10,
  pushHit:6, pushBlock:4, selfPush:0, height:'mid', weight:'light',
  sfx:'kick', meter:6, cancelInto:[],
  skillArt:{row,columns:[0,1,2,3]}, ...spec,
});
const superMove = (key, name, spec) => move(key,name,'super',3,{
  kind:'super', cost:100, startup:16, active:3, recovery:43,
  damage:10, chip:2, hitstun:42, blockstun:12, pushHit:0.5,
  meter:0, weight:'heavy', confirm:{delay:18,duration:32,damage:20}, ...spec,
});

export const SKILLS = freeze({
  deepseek:{
    fireball:move('deepseekSweep','鲸尾扫潮','fireball',0,{
      startup:8,active:5,recovery:18,height:'low',
      box:{x:22,y:-38,w:126,h:30},
    }),
    uppercut:move('deepseekCounter','摸鱼反拍','uppercut',1,{
      startup:2,active:12,recovery:22,damage:0,box:null,counter:[2,14],
      skillArt:{row:1,columns:[0,1,2,3],activeColumn:1},
    }),
    counterHit:move('deepseekCounterHit','摸鱼反拍','uppercut',1,{
      startup:0,active:3,recovery:18,damage:14,hitstun:26,pushHit:12,
      kind:'counter',box:{x:12,y:-132,w:136,h:112},
    }),
    spinKick:move('deepseekSlide','潜游贴贴','spinKick',2,{
      startup:6,active:16,recovery:22,damage:6,blockstun:8,
      driveVel:5.8,slide:true,lowProfile:{x:-25,y:-54,w:50,h:54},
      box:{x:22,y:-60,w:44,h:54},
    }),
    super:superMove('deepseekSuper','深海·大鲸落',{
      box:{x:18,y:-128,w:150,h:128},
    }),
  },
  claude:{
    fireball:move('claudePage','批注飞页','fireball',0,{
      startup:12,active:2,recovery:23,box:null,projectile:true,
      projectileData:{damage:8,speed:7.2,life:150,size:18},
    }),
    uppercut:move('claudeBarrier','请勿越界','uppercut',1,{
      startup:6,active:8,recovery:24,damage:10,pushHit:10,airOnly:true,
      box:{x:38,y:-210,w:84,h:112},
    }),
    spinKick:move('claudeBookmark','伏笔书签','spinKick',2,{
      startup:14,active:1,recovery:20,damage:0,box:null,trap:'place',
      skillArt:{row:2,columns:[0,1]},
    }),
    detonate:move('claudeDetonate','书签引爆','spinKick',2,{
      startup:4,active:1,recovery:15,damage:0,box:null,trap:'trigger',
      skillArt:{row:2,columns:[2,3]},
    }),
    super:superMove('claudeSuper','终章·论证完毕',{
      box:{x:30,y:-132,w:215,h:48},
      confirm:{delay:18,duration:32,damage:18},
    }),
  },
  chatgpt:{
    fireball:move('chatgptBreath','星环吐息','fireball',0,{
      startup:14,active:2,recovery:24,box:null,projectile:true,
      projectileData:{damage:10,speed:4.4,life:180,size:22},
    }),
    uppercut:move('chatgptReflect','改写·翼返','uppercut',1,{
      startup:3,active:8,recovery:26,damage:4,pushHit:11,airOnly:true,
      reflect:[3,11],box:{x:12,y:-205,w:95,h:112},
    }),
    spinKick:move('chatgptClaw','追问·龙爪','spinKick',2,{
      startup:7,active:3,recovery:22,damage:9,blockstun:8,driveVel:2.6,
      followWindow:[16,32],box:{x:22,y:-122,w:90,h:58},
      skillArt:{row:2,columns:[0,1]},
    }),
    follow:move('chatgptClawFollow','龙爪追击','spinKick',2,{
      startup:12,active:4,recovery:26,damage:6,height:'overhead',
      box:{x:20,y:-150,w:112,h:104},skillArt:{row:2,columns:[2,3]},
    }),
    super:superMove('chatgptSuper','万象·星环龙息',{
      startup:18,box:{x:26,y:-120,w:260,h:34},
    }),
  },
});

export const TRAP = freeze({life:180,warning:18,active:6,offset:96,width:76,height:190,
  attack:{key:'claudeTrapBurst',kind:'trap',damage:12,chip:2,hitstun:25,blockstun:11,
    pushHit:6,pushBlock:4,selfPush:0,height:'mid',weight:'heavy',sfx:'boom',meter:6,cancelInto:[]}});

export function moveFor(character, key) {
  const roster = SKILLS[character];
  return roster?.[key] || Object.values(roster || {}).find(move => move.key === key) || null;
}

export function freshState() {
  return {serial:0,contact:null,slideStopped:false,reflectionUsed:false,trap:null,superConfirm:null};
}

export function inWindow(fighter, mechanic) {
  const window = fighter.move?.[mechanic];
  return !!window && fighter.moveFrame >= window[0] && fighter.moveFrame < window[1];
}

export function bindRequest(fighter, input) {
  const move = moveFor(fighter.character,input);
  if (!move) return input === 'super' ? null : {move:input,input};
  if (input === 'super' && fighter.meter < move.cost) return null;
  if (input === 'spinKick') {
    const {skill} = fighter;
    if (fighter.character === 'claude') {
      if (skill.trap) return skill.trap.phase === 'armed'
        ? {move:'claudeDetonate',input,token:skill.trap.id} : null;
      if (fighter.move?.trap) return null;
    }
    if (fighter.character === 'chatgpt' && fighter.move?.input === 'spinKick') {
      return fighter.move.key === 'chatgptClaw' && skill.contact
        ? {move:'chatgptClawFollow',input,token:skill.serial} : null;
    }
  }
  return {move:move.key,input};
}

export function validRequest(fighter, command) {
  if (command.move === 'claudeDetonate') {
    return fighter.skill.trap?.id === command.token && fighter.skill.trap.phase === 'armed';
  }
  if (command.move === 'chatgptClawFollow') {
    return fighter.move?.key === 'chatgptClaw' && fighter.skill.serial === command.token && !!fighter.skill.contact;
  }
  const move = moveFor(fighter.character,command.move);
  return !move?.cost || fighter.meter >= move.cost;
}
