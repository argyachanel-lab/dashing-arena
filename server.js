const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  transports: ['websocket', 'polling'],
  pingTimeout: 8000,
  pingInterval: 3000,
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;

const ARENA_R=258,CHAR_R=17,FRICTION=.87,LAUNCH_FRICTION=.93,MOVE_ACC=.62,MAX_SPEED=4.3;
const DASH_SPD=20,DASH_DUR=155,DASH_CD=1500,FALL_R=ARENA_R+CHAR_R*2.4,START_LIVES=3;
const KNOCKBACK_BASE=16,DANGER_R=ARENA_R*.75,TICK_MS=16,BROADCAST_EVERY=3;

const PLAYER_COLORS=[
  {main:'#ff4d6d',name:'BLAZE'},{main:'#00d4ff',name:'BOLT'},
  {main:'#a8ff3e',name:'VIPER'},{main:'#ffaa00',name:'FLAME'},
];
const PERSONALITIES=['aggressive','tactical','defensive'];

let chars=[],round=1,gameActive=false,roundEnding=false;
let tickCount=0,lastTick=Date.now(),humanCount=0;
const slotSocket={0:null,1:null,2:null,3:null},socketSlot={},inputs={};

function createChar(i){
  const a=(i/4)*Math.PI*2-Math.PI/2;
  return{idx:i,x:Math.cos(a)*ARENA_R*.52,y:Math.sin(a)*ARENA_R*.52,vx:0,vy:0,
    lives:START_LIVES,eliminated:false,falling:false,fallScale:1,
    dashCooldown:0,dashActive:false,dashTimer:0,dashVx:0,dashVy:0,
    hitFlash:0,invincible:0,launched:false,lastHitBy:-1,
    personality:PERSONALITIES[i%PERSONALITIES.length],
    botDecisionTimer:Math.random()*300,botReactTimer:200+Math.random()*300,
    botEdgeTimer:0,botMoveX:0,botMoveY:0,botDashIntent:false,botDashDx:0,botDashDy:0};
}
function initRound(){chars=[0,1,2,3].map(createChar);gameActive=true;roundEnding=false;io.emit('roundStart',{round,colors:PLAYER_COLORS});console.log('Round',round);}

function executeDash(c,dx,dy){const l=Math.hypot(dx,dy)||1;c.dashVx=(dx/l)*DASH_SPD;c.dashVy=(dy/l)*DASH_SPD;c.dashActive=true;c.dashTimer=DASH_DUR;c.dashCooldown=DASH_CD;}
function predictPos(c,t){let vx=c.vx,vy=c.vy,x=c.x,y=c.y;for(let i=0;i<t;i++){vx*=FRICTION;vy*=FRICTION;x+=vx;y+=vy;}return{x,y};}
function edgeDanger(c){const d=Math.hypot(c.x,c.y),nx=c.x/(d||1),ny=c.y/(d||1),fp=predictPos(c,12);return{dist:d,vel:c.vx*nx+c.vy*ny,inDanger:Math.hypot(fp.x,fp.y)>DANGER_R||d>ARENA_R*.78};}
function bestPush(me,t){const td=Math.hypot(t.x,t.y)||1,tl=Math.hypot(t.x-me.x,t.y-me.y)||1;let dx=(t.x-me.x)/tl*.6+t.x/td*.4,dy=(t.y-me.y)/tl*.6+t.y/td*.4;const dl=Math.hypot(dx,dy)||1;return{dx:dx/dl,dy:dy/dl};}

function applyPlayer(c,dt){
  if(c.falling||c.eliminated)return;
  const inp=inputs[slotSocket[c.idx]]||{};
  let ax=0,ay=0;
  if(inp.up)ay-=1;if(inp.dn)ay+=1;if(inp.lt)ax-=1;if(inp.rt)ax+=1;
  const l=Math.hypot(ax,ay);if(l>0){ax/=l;ay/=l;}
  c.vx+=ax*MOVE_ACC;c.vy+=ay*MOVE_ACC;
  if(inp.dash&&c.dashCooldown<=0&&!c.dashActive){let dx=ax,dy=ay;if(!dx&&!dy){dx=c.vx;dy=c.vy;}const dl=Math.hypot(dx,dy)||1;executeDash(c,dx/dl,dy/dl);}
}

function applyBot(c,dt){
  if(c.falling||c.eliminated)return;
  const alive=chars.filter(o=>!o.eliminated&&!o.falling&&o!==c);if(!alive.length)return;
  if(c.botReactTimer>0)c.botReactTimer-=dt;
  const danger=edgeDanger(c),rate=c.personality==='aggressive'?220:c.personality==='tactical'?300:380;
  c.botDecisionTimer-=dt;if(c.botEdgeTimer>0)c.botEdgeTimer-=dt;
  if(danger.inDanger&&c.botEdgeTimer<=0){
    const d=danger.dist||1;let ex=-c.x/d,ey=-c.y/d;
    const n=(Math.random()-.5)*.5;ex+=n*ey;ey-=n*ex;
    const el=Math.hypot(ex,ey)||1;c.botMoveX=ex/el;c.botMoveY=ey/el;
    if(c.dashCooldown<=0&&!c.dashActive&&danger.dist>ARENA_R*.88)executeDash(c,c.botMoveX,c.botMoveY);
  }
  if(c.botDecisionTimer<=0){
    c.botDecisionTimer=rate+Math.random()*180;c.botEdgeTimer=150+Math.random()*100;
    let tgt;
    if(c.personality==='aggressive')tgt=alive.reduce((b,o)=>Math.hypot(o.x-c.x,o.y-c.y)<Math.hypot(b.x-c.x,b.y-c.y)?o:b);
    else if(c.personality==='tactical')tgt=alive.reduce((b,o)=>Math.hypot(o.x,o.y)>Math.hypot(b.x,b.y)?o:b);
    else tgt=alive[Math.floor(Math.random()*alive.length)];
    const td=Math.hypot(tgt.x-c.x,tgt.y-c.y),nm=18+Math.random()*24,na=Math.random()*Math.PI*2;
    const gx=tgt.x+Math.cos(na)*nm,gy=tgt.y+Math.sin(na)*nm;
    const gdx=gx-c.x,gdy=gy-c.y,gl=Math.hypot(gdx,gdy)||1;
    if(td>90){c.botMoveX=gdx/gl;c.botMoveY=gdy/gl;}
    else if(td>40){
      const p=bestPush(c,{x:gx,y:gy});c.botMoveX=p.dx;c.botMoveY=p.dy;
      const human=!!slotSocket[tgt.idx];
      if(c.dashCooldown<=0&&!c.dashActive&&!human&&(Math.hypot(tgt.x,tgt.y)>ARENA_R*.3||c.personality==='aggressive')&&Math.random()>.25){const p2=bestPush(c,{x:gx,y:gy});c.botDashDx=p2.dx;c.botDashDy=p2.dy;c.botDashIntent=true;}
    }else{
      c.botMoveX=gdx/gl;c.botMoveY=gdy/gl;
      if(c.dashCooldown<=0&&!c.dashActive&&Math.random()>.2){const aa=Math.atan2(gdy,gdx)+(Math.random()-.5)*.9;c.botDashDx=Math.cos(aa);c.botDashDy=Math.sin(aa);c.botDashIntent=true;}
    }
    if(c.botDashIntent&&Math.hypot(c.x+c.botDashDx*DASH_SPD*.5,c.y+c.botDashDy*DASH_SPD*.5)>ARENA_R*.92)c.botDashIntent=false;
  }
  c.vx+=c.botMoveX*MOVE_ACC*(.6+Math.random()*.35);c.vy+=c.botMoveY*MOVE_ACC*(.6+Math.random()*.35);
  if(c.botDashIntent&&c.dashCooldown<=0&&!c.dashActive&&c.botReactTimer<=0){executeDash(c,c.botDashDx,c.botDashDy);c.botDashIntent=false;}
}

function updateChar(c,dt){
  if(c.eliminated)return;
  if(c.falling){c.x+=c.vx*dt/16;c.y+=c.vy*dt/16;c.fallScale-=.028;if(c.fallScale<=0){c.fallScale=0;c.eliminated=true;loseLife(c);}return;}
  if(c.hitFlash>0)c.hitFlash-=dt;if(c.invincible>0)c.invincible-=dt;if(c.dashCooldown>0)c.dashCooldown-=dt;
  if(c.dashActive){c.dashTimer-=dt;c.vx=c.dashVx;c.vy=c.dashVy;if(c.dashTimer<=0){c.dashActive=false;c.vx*=.35;c.vy*=.35;}}
  const fr=c.launched?LAUNCH_FRICTION:FRICTION;c.vx*=fr;c.vy*=fr;
  const spd=Math.hypot(c.vx,c.vy);
  if(!c.dashActive&&!c.launched&&spd>MAX_SPEED){c.vx=c.vx/spd*MAX_SPEED;c.vy=c.vy/spd*MAX_SPEED;}
  if(c.launched&&spd<MAX_SPEED*1.2)c.launched=false;
  c.x+=c.vx*dt/16;c.y+=c.vy*dt/16;
  const dist=Math.hypot(c.x,c.y);
  if(!c.dashActive&&!c.launched&&dist+CHAR_R>ARENA_R){const nx=c.x/dist,ny=c.y/dist,ov=dist+CHAR_R-ARENA_R;c.x-=nx*ov*.6;c.y-=ny*ov*.6;const dot=c.vx*nx+c.vy*ny;if(dot>0){c.vx-=nx*dot*1.4;c.vy-=ny*dot*1.4;}}
  if(Math.hypot(c.x,c.y)+CHAR_R>FALL_R)c.falling=true;
}

function resolveCollisions(){
  for(let i=0;i<chars.length;i++)for(let j=i+1;j<chars.length;j++){
    const a=chars[i],b=chars[j];if(a.eliminated||b.eliminated||a.falling||b.falling)continue;
    const dx=b.x-a.x,dy=b.y-a.y,dist=Math.hypot(dx,dy),min=CHAR_R*2;
    if(dist<min&&dist>.01){
      const nx=dx/dist,ny=dy/dist,ov=min-dist;
      a.x-=nx*ov*.5;a.y-=ny*ov*.5;b.x+=nx*ov*.5;b.y+=ny*ov*.5;
      const aDash=a.dashActive&&a.invincible<=0,bDash=b.dashActive&&b.invincible<=0;
      if(aDash){const kb=KNOCKBACK_BASE*(Math.hypot(a.dashVx,a.dashVy)/DASH_SPD);b.vx=nx*kb;b.vy=ny*kb;b.launched=true;b.hitFlash=300;b.lastHitBy=a.idx;a.dashActive=false;a.vx*=.3;a.vy*=.3;io.emit('hit',{x:b.x,y:b.y,col:PLAYER_COLORS[b.idx].main});}
      else if(bDash){const kb=KNOCKBACK_BASE*(Math.hypot(b.dashVx,b.dashVy)/DASH_SPD);a.vx=-nx*kb;a.vy=-ny*kb;a.launched=true;a.hitFlash=300;a.lastHitBy=b.idx;b.dashActive=false;b.vx*=.3;b.vy*=.3;io.emit('hit',{x:a.x,y:a.y,col:PLAYER_COLORS[a.idx].main});}
      else{const rv=a.vx-b.vx,rvy=a.vy-b.vy,rd=rv*nx+rvy*ny;if(rd>0){a.vx-=nx*rd;a.vy-=ny*rd;b.vx+=nx*rd;b.vy+=ny*rd;}}
    }
  }
}

function loseLife(c){
  const ki=c.lastHitBy;c.lastHitBy=-1;c.lives=Math.max(0,c.lives-1);
  io.emit('kill',{victim:{idx:c.idx,name:PLAYER_COLORS[c.idx].name,col:PLAYER_COLORS[c.idx].main,isBot:!slotSocket[c.idx]},killer:ki>=0?{idx:ki,name:PLAYER_COLORS[ki].name,col:PLAYER_COLORS[ki].main,isBot:!slotSocket[ki]}:null});
  checkRoundEnd();if(c.lives>0)setTimeout(()=>respawn(c),1300);
}
function respawn(c){if(!gameActive)return;const a=Math.random()*Math.PI*2;c.x=Math.cos(a)*ARENA_R*.38;c.y=Math.sin(a)*ARENA_R*.38;c.vx=0;c.vy=0;c.falling=false;c.eliminated=false;c.fallScale=1;c.dashCooldown=0;c.dashActive=false;c.hitFlash=0;c.launched=false;c.invincible=1500;}
function checkRoundEnd(){
  if(roundEnding)return;const alive=chars.filter(c=>c.lives>0);
  if(alive.length<=1){roundEnding=true;gameActive=false;const w=alive[0]||null;
    setTimeout(()=>{io.emit('roundEnd',{winner:w?{idx:w.idx,name:PLAYER_COLORS[w.idx].name,col:PLAYER_COLORS[w.idx].main}:null,round});round++;setTimeout(initRound,3500);},900);}
}
function snapshot(){return chars.map(c=>({idx:c.idx,x:Math.round(c.x*10)/10,y:Math.round(c.y*10)/10,vx:Math.round(c.vx*100)/100,vy:Math.round(c.vy*100)/100,lives:c.lives,eliminated:c.eliminated,falling:c.falling,fallScale:Math.round(c.fallScale*100)/100,dashActive:c.dashActive,dashVx:Math.round(c.dashVx*10)/10,dashVy:Math.round(c.dashVy*10)/10,dashCooldown:Math.max(0,Math.round(c.dashCooldown)),hit:c.hitFlash>0,invinc:c.invincible>0,launched:c.launched,isBot:!slotSocket[c.idx]}));}

setInterval(()=>{const now=Date.now(),dt=Math.min(now-lastTick,32);lastTick=now;if(gameActive){chars.forEach(c=>{slotSocket[c.idx]?applyPlayer(c,dt):applyBot(c,dt);updateChar(c,dt);});resolveCollisions();}if(++tickCount%BROADCAST_EVERY===0)io.emit('state',snapshot());},TICK_MS);

io.on('connection',socket=>{
  console.log('+',socket.id);
  const free=[0,1,2,3].find(i=>slotSocket[i]===null);
  if(free!==undefined){slotSocket[free]=socket.id;socketSlot[socket.id]=free;inputs[socket.id]={up:false,dn:false,lt:false,rt:false,dash:false};humanCount++;socket.emit('init',{yourSlot:free,colors:PLAYER_COLORS,round,state:snapshot()});io.emit('players',[0,1,2,3].map(i=>({slot:i,isBot:!slotSocket[i],name:PLAYER_COLORS[i].name,col:PLAYER_COLORS[i].main})));console.log('Slot',free,'->',socket.id,'('+humanCount+'h)');}
  else socket.emit('init',{yourSlot:-1,colors:PLAYER_COLORS,round,state:snapshot()});
  socket.on('input',d=>{if(inputs[socket.id])inputs[socket.id]=d;});
  socket.on('pingCheck',ts=>socket.emit('pongCheck',ts));
  socket.on('disconnect',()=>{const slot=socketSlot[socket.id];if(slot!==undefined){slotSocket[slot]=null;delete socketSlot[socket.id];delete inputs[socket.id];humanCount=Math.max(0,humanCount-1);io.emit('players',[0,1,2,3].map(i=>({slot:i,isBot:!slotSocket[i],name:PLAYER_COLORS[i].name,col:PLAYER_COLORS[i].main})));console.log('Slot',slot,'freed ('+humanCount+'h)');}});
});

// Serve HTML inline — no public/ folder needed
app.get('*',(_,res)=>res.send(HTML));

const HTML=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DASHING ARENA</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Rajdhani:wght@400;600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050508;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;overflow:hidden;font-family:'Rajdhani',sans-serif;user-select:none}
#ui-top{display:flex;gap:16px;margin-bottom:8px;align-items:center;flex-wrap:wrap;justify-content:center}
.pc{display:flex;align-items:center;gap:6px;padding:5px 11px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);font-size:12px;font-weight:700;letter-spacing:1px;transition:opacity .3s}
.pc.dead{opacity:.2}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.tag{font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(255,255,255,.12);color:rgba(255,255,255,.5)}
.tag.you{background:rgba(255,255,255,.25);color:#fff}
#rb{font-family:'Bebas Neue',sans-serif;font-size:20px;color:#fff;letter-spacing:3px;opacity:.45}
canvas{border-radius:12px;display:block}
#hint{margin-top:7px;font-size:11px;color:rgba(255,255,255,.22);letter-spacing:1px;text-align:center}
#dw{display:flex;align-items:center;gap:7px;margin-top:4px}
#dl{font-size:10px;color:rgba(255,255,255,.3);letter-spacing:1px}
#db{width:130px;height:7px;background:rgba(255,255,255,.07);border-radius:4px;overflow:hidden}
#df{height:100%;width:100%;background:linear-gradient(90deg,#00d4ff,#a8ff3e);border-radius:4px}
#kf{position:fixed;bottom:16px;right:16px;display:flex;flex-direction:column;gap:5px;align-items:flex-end;pointer-events:none;z-index:50}
.kfe{display:flex;align-items:center;gap:6px;background:rgba(8,8,18,.88);border:1px solid rgba(255,255,255,.07);border-radius:6px;padding:5px 10px;font-size:12px;font-weight:700;backdrop-filter:blur(6px);animation:kfIn .18s ease;transition:opacity .4s}
@keyframes kfIn{from{transform:translateX(14px);opacity:0}to{transform:translateX(0);opacity:1}}
.kfd{width:8px;height:8px;border-radius:50%;flex-shrink:0}
#sb{position:fixed;top:6px;right:8px;display:flex;gap:6px;z-index:150;font-family:monospace;font-size:11px}
.sb{background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:2px 7px;letter-spacing:1px}
#dbg{position:fixed;bottom:0;left:0;right:0;height:130px;background:rgba(0,0,0,.9);border-top:1px solid rgba(255,255,255,.08);font-family:monospace;font-size:11px;color:#a8ff3e;overflow-y:scroll;padding:6px 10px;z-index:200;display:none}
#dbg.show{display:block}
#dbt{position:fixed;bottom:134px;left:8px;font-family:'Rajdhani',sans-serif;font-size:11px;background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.4);padding:3px 8px;border-radius:4px;cursor:pointer;z-index:201;letter-spacing:1px}
#dbt.open{color:#a8ff3e;border-color:#a8ff3e44}
#ov{position:fixed;inset:0;background:rgba(5,5,8,.93);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:100}
#ov h1{font-family:'Bebas Neue',sans-serif;font-size:68px;letter-spacing:10px;background:linear-gradient(135deg,#00d4ff,#a8ff3e);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;filter:drop-shadow(0 0 28px #00d4ff55);margin-bottom:6px}
#ov p{font-size:14px;color:rgba(255,255,255,.35);letter-spacing:3px;margin-bottom:10px}
#cm{font-size:15px;color:rgba(255,255,255,.5);letter-spacing:2px}
#rr{font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:5px;margin-bottom:8px;display:none}
#rc{font-size:13px;color:rgba(255,255,255,.35);letter-spacing:2px;display:none}
</style>
</head>
<body>
<div id="ui-top">
  <div style="display:flex;flex-direction:column;gap:5px">
    <div id="pc" style="display:flex;gap:8px"></div>
    <div id="dw"><span id="dl">DASH</span><div id="db"><div id="df"></div></div></div>
  </div>
  <div id="rb">ROUND 1</div>
</div>
<canvas id="c"></canvas>
<div id="hint">WASD / ARROWS — MOVE &nbsp;|&nbsp; SPACE / SHIFT — DASH</div>
<div id="sb">
  <span class="sb" id="fps" style="color:#a8ff3e">-- FPS</span>
  <span class="sb" id="ping" style="color:#00d4ff">-- ms</span>
  <span class="sb" id="cst" style="color:#ffaa00">CONNECTING</span>
</div>
<button id="dbt" onclick="toggleDbg()">DEBUG ▲</button>
<div id="dbg"></div>
<div id="kf"></div>
<div id="ov">
  <h1>DASHING ARENA</h1>
  <p>REAL-TIME MULTIPLAYER</p>
  <div id="cm">Connecting...</div>
  <div id="rr"></div>
  <div id="rc"></div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
const canvas=document.getElementById('c'),ctx=canvas.getContext('2d');
const W=canvas.width=640,H=canvas.height=640,CX=W/2,CY=H/2;
const ARENA_R=258,CHAR_R=17,DASH_CD=1500,START_LIVES=3;
let mySlot=-1,playerColors=[],prev=null,curr=null,lerpT=1;
let trails=[[],[],[],[]],shake=0,parts=[],round=1;
let fpsF=0,fpsLast=performance.now();

const dbgEl=document.getElementById('dbg');
let dbgOpen=false;
function toggleDbg(){dbgOpen=!dbgOpen;dbgEl.classList.toggle('show',dbgOpen);const b=document.getElementById('dbt');b.textContent=dbgOpen?'DEBUG \u25BC':'DEBUG \u25B2';b.classList.toggle('open',dbgOpen);}
function log(msg,col){const t=new Date().toISOString().substr(11,12),d=document.createElement('div');d.style.color=col||'#a8ff3e';d.textContent='['+t+'] '+msg;dbgEl.appendChild(d);dbgEl.scrollTop=dbgEl.scrollHeight;while(dbgEl.children.length>200)dbgEl.removeChild(dbgEl.firstChild);console.log('[DA]',msg);}
function setCst(t,c){const e=document.getElementById('cst');e.textContent=t;e.style.color=c;}

function tickFps(){fpsF++;const n=performance.now();if(n-fpsLast>=1000){const e=document.getElementById('fps');e.textContent=fpsF+' FPS';e.style.color=fpsF>=55?'#a8ff3e':fpsF>=30?'#ffaa00':'#ff4d6d';fpsF=0;fpsLast=n;}}

const keys={};let lastInp='';
window.addEventListener('keydown',e=>{if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();keys[e.code]=true;sendInp();});
window.addEventListener('keyup',e=>{keys[e.code]=false;sendInp();});
function sendInp(){if(mySlot<0)return;const i={up:!!(keys['KeyW']||keys['ArrowUp']),dn:!!(keys['KeyS']||keys['ArrowDown']),lt:!!(keys['KeyA']||keys['ArrowLeft']),rt:!!(keys['KeyD']||keys['ArrowRight']),dash:!!(keys['Space']||keys['ShiftLeft']||keys['ShiftRight'])};const s=JSON.stringify(i);if(s!==lastInp){socket.emit('input',i);lastInp=s;}}

log('Connecting...','#ffaa00');
const socket=io({transports:['websocket','polling']});
socket.on('connect',()=>{log('Connected! id='+socket.id+' via '+socket.io.engine.transport.name,'#a8ff3e');setCst('ONLINE','#a8ff3e');document.getElementById('cm').textContent='Connected! Waiting for game...';pingLoop();});
socket.on('connect_error',e=>{log('connect_error: '+e.message,'#ff4d6d');setCst('ERR','#ff4d6d');});
socket.on('disconnect',r=>{log('Disconnected: '+r,'#ff4d6d');setCst('OFFLINE','#ff4d6d');document.getElementById('ov').style.display='flex';document.getElementById('cm').textContent='Disconnected. Refresh!';document.getElementById('cm').style.display='block';document.getElementById('rr').style.display='none';document.getElementById('rc').style.display='none';});
socket.on('reconnect_attempt',n=>{log('Retry #'+n,'#ffaa00');setCst('RETRY '+n,'#ffaa00');});
socket.on('init',d=>{log('init slot='+d.yourSlot+' round='+d.round,'#00d4ff');mySlot=d.yourSlot;playerColors=d.colors;round=d.round;curr=d.state;prev=d.state;lerpT=1;trails=[[],[],[],[]];document.getElementById('rb').textContent='ROUND '+round;updateCards(d.state);document.getElementById('ov').style.display='none';});
socket.on('state',s=>{prev=curr;curr=s;lerpT=0;updateCards(s);updateDashBar(s);});
socket.on('kill',d=>addKf(d.victim,d.killer));
socket.on('hit',d=>{spawnParts(d.x,d.y,d.col,20);shake=Math.min(shake+8,14);});
socket.on('roundEnd',d=>{const rr=document.getElementById('rr'),rc=document.getElementById('rc');document.getElementById('cm').style.display='none';rr.style.display='block';rc.style.display='block';if(d.winner){rr.textContent=d.winner.name+' WINS!';rr.style.color=d.winner.col;rr.style.filter='drop-shadow(0 0 20px '+d.winner.col+'88)';}else{rr.textContent='DRAW!';rr.style.color='#fff';}rc.textContent='ROUND '+d.round+' \u2014 NEXT IN 3...';document.getElementById('ov').style.display='flex';let t=3;const cd=setInterval(()=>{t--;if(t<=0)clearInterval(cd);else rc.textContent='ROUND '+d.round+' \u2014 NEXT IN '+t+'...';},1000);});
socket.on('roundStart',d=>{round=d.round;document.getElementById('rb').textContent='ROUND '+round;document.getElementById('kf').innerHTML='';trails=[[],[],[],[]];document.getElementById('ov').style.display='none';});
socket.on('pongCheck',ts=>{const ms=Date.now()-ts,e=document.getElementById('ping');e.textContent=ms+' ms';e.style.color=ms<50?'#a8ff3e':ms<120?'#ffaa00':'#ff4d6d';});
function pingLoop(){socket.emit('pingCheck',Date.now());setTimeout(pingLoop,2000);}

function updateCards(snap){const c=document.getElementById('pc');if(!playerColors.length)return;c.innerHTML='';snap.forEach(s=>{const col=playerColors[s.idx],el=document.createElement('div');el.className='pc'+(s.lives<=0?' dead':'');const h='\u2665'.repeat(Math.max(0,s.lives))+'\u2661'.repeat(Math.max(0,START_LIVES-s.lives));el.innerHTML='<div class="dot" style="background:'+col.main+';box-shadow:0 0 6px '+col.main+'66"></div><span style="color:'+col.main+'">'+col.name+'</span>'+(s.idx===mySlot?'<span class="tag you">YOU</span>':'')+(s.isBot?'<span class="tag">BOT</span>':'')+'<span style="color:rgba(255,255,255,.4);font-size:11px">'+h+'</span>';c.appendChild(el);});}
function updateDashBar(snap){if(mySlot<0)return;const me=snap.find(s=>s.idx===mySlot);if(!me)return;const f=document.getElementById('df'),pct=me.dashCooldown<=0?100:Math.max(0,100-(me.dashCooldown/DASH_CD)*100);f.style.width=pct+'%';f.style.background=pct>=100?'linear-gradient(90deg,#00d4ff,#a8ff3e)':'linear-gradient(90deg,#00d4ff '+pct+'%,rgba(255,255,255,.05) '+pct+'%)';f.style.boxShadow=pct>=100?'0 0 8px #00d4ff88':'none';}
function addKf(v,k){const feed=document.getElementById('kf'),e=document.createElement('div');e.className='kfe';if(k)e.innerHTML='<div class="kfd" style="background:'+k.col+'"></div><span style="color:'+k.col+'">'+k.name+(k.isBot?'':' \uD83D\uDC64')+'</span><span style="opacity:.5">\uD83D\uDC80</span><span style="color:'+v.col+'">'+v.name+'</span><div class="kfd" style="background:'+v.col+'"></div>';else e.innerHTML='<span style="opacity:.5">\uD83D\uDC80</span><span style="color:'+v.col+'">'+v.name+'</span><span style="color:rgba(255,255,255,.3);font-size:11px">fell off</span>';feed.appendChild(e);while(feed.children.length>5)feed.removeChild(feed.firstChild);setTimeout(()=>{e.style.opacity='0';setTimeout(()=>e.remove(),400);},3500);}
function spawnParts(x,y,col,n){for(let i=0;i<n;i++){const a=Math.random()*Math.PI*2,s=2+Math.random()*6;parts.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:1,col});}}
function lerp(a,b,t){return a+(b-a)*t;}

function drawArena(){
  const g=ctx.createRadialGradient(CX,CY,0,CX,CY,ARENA_R);g.addColorStop(0,'rgba(30,32,45,1)');g.addColorStop(.75,'rgba(18,20,30,1)');g.addColorStop(1,'rgba(10,12,18,1)');
  ctx.beginPath();ctx.arc(CX,CY,ARENA_R,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
  ctx.save();ctx.beginPath();ctx.arc(CX,CY,ARENA_R,0,Math.PI*2);ctx.clip();ctx.strokeStyle='rgba(255,255,255,.033)';ctx.lineWidth=1;
  for(let x=-ARENA_R;x<ARENA_R;x+=40){ctx.beginPath();ctx.moveTo(CX+x,CY-ARENA_R);ctx.lineTo(CX+x,CY+ARENA_R);ctx.stroke();}
  for(let y=-ARENA_R;y<ARENA_R;y+=40){ctx.beginPath();ctx.moveTo(CX-ARENA_R,CY+y);ctx.lineTo(CX+ARENA_R,CY+y);ctx.stroke();}
  ctx.restore();
  const p=.06+.04*Math.sin(Date.now()*.004);ctx.beginPath();ctx.arc(CX,CY,ARENA_R-18,0,Math.PI*2);ctx.strokeStyle='rgba(255,60,60,'+p+')';ctx.setLineDash([10,14]);ctx.lineWidth=2;ctx.stroke();ctx.setLineDash([]);
  ctx.shadowColor='rgba(0,212,255,.25)';ctx.shadowBlur=12;ctx.beginPath();ctx.arc(CX,CY,ARENA_R,0,Math.PI*2);ctx.strokeStyle='rgba(255,255,255,.17)';ctx.lineWidth=2.5;ctx.stroke();ctx.shadowBlur=0;
  const vg=ctx.createRadialGradient(CX,CY,ARENA_R,CX,CY,ARENA_R+42);vg.addColorStop(0,'rgba(5,5,8,0)');vg.addColorStop(1,'rgba(5,5,8,1)');ctx.beginPath();ctx.arc(CX,CY,ARENA_R+42,0,Math.PI*2);ctx.fillStyle=vg;ctx.fill();
}
function drawChar(c){
  if(!playerColors.length||c.eliminated&&c.fallScale<=0)return;
  const col=playerColors[c.idx].main,nm=playerColors[c.idx].name,sc=c.falling?Math.max(0,c.fallScale):1;
  ctx.save();ctx.translate(CX+c.x,CY+c.y);ctx.scale(sc,sc);
  if(c.invinc&&Math.floor(Date.now()/80)%2===0){ctx.restore();return;}
  ctx.shadowColor=c.hit?'#fff':col;ctx.shadowBlur=c.dashActive?32:c.hit?26:16;
  const bg=ctx.createRadialGradient(-5,-5,2,0,0,CHAR_R);bg.addColorStop(0,c.hit?'#fff':col);bg.addColorStop(1,col+'66');
  ctx.beginPath();ctx.arc(0,0,CHAR_R,0,Math.PI*2);ctx.fillStyle=bg;ctx.fill();
  ctx.shadowBlur=0;ctx.strokeStyle='rgba(255,255,255,.28)';ctx.lineWidth=1.5;ctx.stroke();
  const spd=Math.hypot(c.vx,c.vy);if(spd>.6){const ang=Math.atan2(c.vy,c.vx),tip=CHAR_R+9;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(ang)*tip,Math.sin(ang)*tip);ctx.strokeStyle='rgba(255,255,255,.6)';ctx.lineWidth=2;ctx.stroke();ctx.beginPath();ctx.arc(Math.cos(ang)*tip,Math.sin(ang)*tip,2.5,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();}
  if(c.launched){ctx.beginPath();ctx.arc(0,0,CHAR_R+9,0,Math.PI*2);ctx.strokeStyle='rgba(255,255,255,.75)';ctx.lineWidth=2.5;ctx.shadowColor='#fff';ctx.shadowBlur=12;ctx.stroke();ctx.beginPath();ctx.arc(0,0,CHAR_R+15,0,Math.PI*2);ctx.strokeStyle='rgba(255,80,80,.45)';ctx.lineWidth=1.5;ctx.shadowBlur=8;ctx.stroke();}
  if(c.dashActive){ctx.beginPath();ctx.arc(0,0,CHAR_R+7,0,Math.PI*2);ctx.strokeStyle=col;ctx.lineWidth=3;ctx.shadowColor=col;ctx.shadowBlur=20;ctx.stroke();const da=Math.atan2(c.dashVy,c.dashVx);for(let k=-1;k<=1;k++){const a2=da+k*.3+Math.PI;ctx.beginPath();ctx.moveTo(Math.cos(a2)*(CHAR_R+4),Math.sin(a2)*(CHAR_R+4));ctx.lineTo(Math.cos(a2)*(CHAR_R+14),Math.sin(a2)*(CHAR_R+14));ctx.strokeStyle=col+'88';ctx.lineWidth=2;ctx.shadowBlur=4;ctx.stroke();}}
  ctx.shadowBlur=0;ctx.fillStyle='#fff';ctx.font='bold '+(c.idx===mySlot?9:8)+'px Rajdhani';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(c.idx===mySlot?'YOU':nm.slice(0,3),0,0);
  ctx.restore();
}

let lastRender=0;
function loop(ts){
  requestAnimationFrame(loop);tickFps();
  const dt=Math.min(ts-lastRender,32);lastRender=ts;shake*=.75;
  parts=parts.filter(p=>{p.x+=p.vx*dt/16;p.y+=p.vy*dt/16;p.vx*=.9;p.vy*=.9;p.life-=.055;return p.life>0;});
  ctx.clearRect(0,0,W,H);ctx.save();
  if(shake>.5)ctx.translate((Math.random()-.5)*shake,(Math.random()-.5)*shake);
  ctx.fillStyle='#050508';ctx.fillRect(0,0,W,H);
  if(!curr){ctx.restore();return;}
  lerpT=Math.min(lerpT+dt/50,1);
  const state=curr.map((c,i)=>{const p=(prev&&prev[i])?prev[i]:c;if(c.falling!==p.falling||c.eliminated!==p.eliminated)return c;return{...c,x:lerp(p.x,c.x,lerpT),y:lerp(p.y,c.y,lerpT)};});
  state.forEach((c,i)=>{
    if(!c.eliminated&&!c.falling){const spd=Math.hypot(c.vx,c.vy);if(c.dashActive||c.launched||spd>2)trails[i].push({x:c.x,y:c.y,life:c.launched?1.3:1,col:c.launched?'#fff':playerColors[i]?playerColors[i].main:'#fff'});}
    trails[i]=trails[i].filter(p=>{p.life-=.065;return p.life>0;});
  });
  drawArena();
  trails.forEach(tr=>tr.forEach(p=>{ctx.save();ctx.globalAlpha=Math.min(p.life*.55,.55);ctx.shadowColor=p.col;ctx.shadowBlur=8;ctx.fillStyle=p.col;ctx.beginPath();ctx.arc(CX+p.x,CY+p.y,CHAR_R*.45*p.life,0,Math.PI*2);ctx.fill();ctx.restore();}));
  state.forEach(drawChar);
  parts.forEach(p=>{ctx.save();ctx.globalAlpha=p.life*.85;ctx.shadowColor=p.col;ctx.shadowBlur=6;ctx.fillStyle=p.col;ctx.beginPath();ctx.arc(CX+p.x,CY+p.y,3*p.life,0,Math.PI*2);ctx.fill();ctx.restore();});
  ctx.restore();
}
requestAnimationFrame(loop);
</script>
</body>
</html>`;

initRound();
server.listen(PORT,()=>console.log('\n🎮  DASHING ARENA — port',PORT,'\n'));

