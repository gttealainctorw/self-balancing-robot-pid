// =====================================================================
//  web_page.h — Web app served by the Nano ESP32 at http://192.168.4.1
//  Single file (no internet, no external libraries):
//  joystick, live PID tuning, calibration, tests and a live plot.
// =====================================================================
#pragma once

const char WEB_PAGE[] PROGMEM = R"rawhtml(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>BalanceBot</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--line:#2a2f3a;--tx:#e8eaf0;--mu:#9aa3b2;--ac:#4f8cff;--ok:#2fbf71;--wa:#f0a020;--er:#e5484d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.4 system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
h1{font-size:17px;margin:0 auto 0 0}.pill{padding:3px 10px;border-radius:99px;background:var(--line);font-size:13px}
.ok{background:#1d4d33}.wa{background:#5a4210}.er{background:#5c1f22}
main{max-width:760px;margin:auto;padding:12px;display:grid;gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.card h2{font-size:15px;margin:0 0 8px;color:var(--mu);font-weight:600}
.row{display:flex;gap:8px;flex-wrap:wrap}button{flex:1 1 auto;min-width:96px;padding:10px;border:1px solid var(--line);border-radius:9px;background:#222734;color:var(--tx);font-size:14px}
button:active{background:#2c3446}button.pri{background:var(--ac);border-color:var(--ac)}button.dan{background:#3a1d20;border-color:#6b2a2f}
#joy{width:230px;height:230px;margin:6px auto;border-radius:50%;background:#11141a;border:2px solid var(--line);position:relative;touch-action:none}
#knob{width:76px;height:76px;border-radius:50%;background:var(--ac);position:absolute;left:77px;top:77px;opacity:.9}
.big{display:flex;justify-content:space-around;text-align:center}.big b{display:block;font-size:24px}.big span{color:var(--mu);font-size:12px}
canvas{width:100%;height:170px;display:block}
.prm{display:grid;grid-template-columns:62px 1fr 74px;gap:8px;align-items:center;margin:7px 0}
.prm label{font-weight:600}.prm small{grid-column:1/-1;color:var(--mu);margin-top:-6px;font-size:12px}
input[type=range]{width:100%}input[type=number]{width:100%;padding:6px;background:#11141a;color:var(--tx);border:1px solid var(--line);border-radius:7px}
#log{height:110px;overflow:auto;font:12px ui-monospace,monospace;color:var(--mu);white-space:pre-wrap}
.leg{font-size:12px;color:var(--mu)}.leg i{display:inline-block;width:10px;height:3px;margin:0 4px 2px 8px;vertical-align:middle}
</style></head><body>
<header><h1>BalanceBot</h1><span id="st" class="pill">connecting…</span><span id="en" class="pill">—</span></header>
<main>
<section class="card"><div class="big">
<div><b id="ang">—</b><span>angle °</span></div><div><b id="tg">—</b><span>target °</span></div>
<div><b id="pw">—</b><span>PWM</span></div><div><b id="lu">—</b><span>loop µs</span></div></div></section>

<section class="card"><h2>Drive</h2>
<div id="joy"><div id="knob"></div></div>
<div class="row"><button id="bon" class="pri">Balance ON</button><button id="boff" class="dan">OFF</button></div>
<p class="leg">Drag the circle: up = forward, sides = turn. On a PC: arrow keys or WASD.</p></section>

<section class="card"><h2>Plot (last 20 s)</h2><canvas id="cv"></canvas>
<div class="leg"><i style="background:#4f8cff"></i>angle<i style="background:#f0a020"></i>target<i style="background:#2fbf71"></i>PWM/10</div></section>

<section class="card"><h2>Live tuning</h2><div id="prms"></div>
<div class="row"><button id="bsave" class="pri">Save</button><button id="bload">Reload</button><button id="bdef">Default PID</button></div></section>

<section class="card"><h2>Calibration (in this order the first time)</h2>
<div class="row"><button data-c="calg">1 · Gyro<br><small>keep still</small></button>
<button data-c="calup">2 · Upright<br><small>at balance point</small></button>
<button data-c="calfwd">3 · Forward<br><small>tilted ~20°</small></button></div></section>

<section class="card"><h2>Tests</h2>
<div class="row"><button data-c="mt">Motor test</button><button data-c="invl">Reverse left</button><button data-c="invr">Reverse right</button></div>
<div class="row" style="margin-top:8px"><button data-c="ramp">Min PWM ramp</button><button data-c="ok" class="pri">They turn!</button><button data-c="stop">Stop</button></div></section>

<section class="card"><h2>Messages</h2><div id="log"></div></section>
</main>
<script>
const P=[
["kp","Proportional: push per degree of tilt",0,150,0.5],
["kd","Derivative: damping (uses the gyro)",0,5,0.05],
["ki","Angle integral (usually 0)",0,300,1],
["trim","Fine correction of the balance point (°)",-8,8,0.05],
["ks","Speed loop: stops the drift",0,60,0.5],
["kis","Auto-trim: removes slow drift",0,20,0.1],
["vmax","Speed at full joystick",0,0.8,0.01],
["tauv","Speed estimator filter (s)",0.05,1.5,0.01],
["lean","Max lean requested by the speed loop (°)",0,15,0.5],
["minpwm","Lowest PWM that turns the wheels",0,120,1],
["db","Output dead band",0,20,0.5],
["turn","Turning strength",0,150,1],
["dlpf","D-term smoothing",0,0.95,0.05],
["alpha","Complementary filter (gyro weight)",0.95,0.999,0.001]];
const $=id=>document.getElementById(id);
const log=t=>{const l=$('log');l.textContent=(new Date().toLocaleTimeString()+'  '+t+'\n'+l.textContent).slice(0,4000)};
async function cmd(q){try{const r=await fetch('/c?q='+encodeURIComponent(q));const t=(await r.text()).trim();if(t)log(t);return t}catch(e){log('no connection')}}
// parameters
const box=$('prms'),inputs={};let tmr={};
for(const[k,d,lo,hi,st]of P){const w=document.createElement('div');w.className='prm';
w.innerHTML=`<label>${k}</label><input type=range min=${lo} max=${hi} step=${st}><input type=number step=${st}><small>${d}</small>`;
const[r,n]=w.querySelectorAll('input');inputs[k]=[r,n];
const send=v=>{clearTimeout(tmr[k]);tmr[k]=setTimeout(()=>cmd(k+' '+v),150)};
r.oninput=()=>{n.value=r.value;send(r.value)};n.onchange=()=>{r.value=n.value;send(n.value)};box.appendChild(w)}
async function loadState(){try{const s=await(await fetch('/s')).json();for(const k in inputs)if(k in s.p){inputs[k][0].value=s.p[k];inputs[k][1].value=+s.p[k].toFixed(4)}
document.title=s.ssid;log('Connected to '+s.ssid+' · firmware '+s.fw)}catch(e){setTimeout(loadState,1000)}}
$('bsave').onclick=()=>cmd('save');$('bload').onclick=async()=>{await cmd('load');loadState()};$('bdef').onclick=async()=>{await cmd('reset');loadState()};
$('bon').onclick=()=>cmd('on');$('boff').onclick=()=>cmd('off');
document.querySelectorAll('[data-c]').forEach(b=>b.onclick=async()=>{await cmd(b.dataset.c);if(b.dataset.c=='ok')setTimeout(loadState,300)});
// joystick
let jx=0,jy=0;const joy=$('joy'),kn=$('knob');
function setK(x,y){jx=x;jy=y;kn.style.left=(77+x*77)+'px';kn.style.top=(77-y*77)+'px'}
function mv(e){const r=joy.getBoundingClientRect();let x=(e.clientX-r.left-r.width/2)/(r.width/2-38),y=-(e.clientY-r.top-r.height/2)/(r.height/2-38);
const m=Math.hypot(x,y);if(m>1){x/=m;y/=m}setK(x,y)}
joy.onpointerdown=e=>{joy.setPointerCapture(e.pointerId);mv(e)};joy.onpointermove=e=>{if(e.buttons||e.pointerType=='touch')mv(e)};
joy.onpointerup=joy.onpointercancel=()=>setK(0,0);
const keys={};onkeydown=e=>{keys[e.key.toLowerCase()]=1;kb()};onkeyup=e=>{keys[e.key.toLowerCase()]=0;kb()};
function kb(){if(document.activeElement.tagName=='INPUT')return;const y=(keys.arrowup||keys.w?1:0)-(keys.arrowdown||keys.s?1:0),x=(keys.arrowright||keys.d?1:0)-(keys.arrowleft||keys.a?1:0);setK(x*0.8,y*0.8)}
const dz=v=>Math.abs(v)<0.08?0:v;
// plot
const cv=$('cv'),cx=cv.getContext('2d'),N=200,H={a:[],t:[],u:[]};
function draw(){const w=cv.width=cv.clientWidth*devicePixelRatio,h=cv.height=cv.clientHeight*devicePixelRatio;cx.clearRect(0,0,w,h);
let mx=5;for(const v of H.a.concat(H.t,H.u))mx=Math.max(mx,Math.abs(v));mx=Math.ceil(mx);
cx.strokeStyle='#2a2f3a';cx.lineWidth=1;cx.beginPath();cx.moveTo(0,h/2);cx.lineTo(w,h/2);cx.stroke();
cx.fillStyle='#9aa3b2';cx.font=11*devicePixelRatio+'px sans-serif';cx.fillText('±'+mx,4,12*devicePixelRatio);
for(const[k,c]of[['u','#2fbf71'],['t','#f0a020'],['a','#4f8cff']]){const s=H[k];cx.strokeStyle=c;cx.lineWidth=2*devicePixelRatio;cx.beginPath();
s.forEach((v,i)=>{const X=w*(i+N-s.length)/(N-1),Y=h/2-v/mx*(h/2-4);i?cx.lineTo(X,Y):cx.moveTo(X,Y)});cx.stroke()}}
// polling: sends the joystick and receives telemetry every 100 ms
let lastSq=-1,fails=0;
async function poll(){try{const r=await fetch(`/j?v=${dz(jy).toFixed(2)}&t=${dz(jx).toFixed(2)}`);const d=await r.json();fails=0;
$('ang').textContent=d.a.toFixed(1);$('tg').textContent=d.t.toFixed(1);$('pw').textContent=d.u.toFixed(0);$('lu').textContent=d.lu;
const st=$('st');st.textContent=d.imu?d.m:'MPU error!';st.className='pill '+(!d.imu?'er':d.m=='balancing'?'ok':d.m=='fallen'?'er':'wa');
const en=$('en');en.textContent=d.e?'balance ON':'balance OFF';en.className='pill '+(d.e?'ok':'');
if(d.sq!=lastSq){if(lastSq>=0&&d.msg)log(d.msg);lastSq=d.sq}
H.a.push(d.a);H.t.push(d.t);H.u.push(d.u/10);for(const k in H)if(H[k].length>N)H[k].shift();draw()}
catch(e){if(++fails==3){$('st').textContent='no connection';$('st').className='pill er'}}
setTimeout(poll,100)}
loadState();poll();
</script></body></html>)rawhtml";
