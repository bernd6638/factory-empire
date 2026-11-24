"""HTML-Seite für die OBS-Browserquelle (gleiches Aussehen wie das Overlay, transparenter Hintergrund)."""

PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>Input Overlay</title>
<style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{position:fixed;inset:0;width:100vw;height:100vh;display:block}
text{font-family:"Segoe UI",Arial,sans-serif;font-weight:700;text-anchor:middle;dominant-baseline:central;
     user-select:none}
</style></head><body>
<svg id="cv" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet"></svg>
<svg id="kb" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet"></svg>
<script>
const Q = new URLSearchParams(location.search);
const FORCE = (Q.get("mode") || "app").toLowerCase();   // app | controller | keyboard
const NS = "http://www.w3.org/2000/svg";

const C = {BODY:"#f7f7f6",BODY_EDGE:"#b4b5b3",BODY_SHADOW:"#c9cac8",PART:"#fbfbfa",WELL:"#e4e4e2",
  LABEL:"#55575a",DARK:"#1c1d1f",DPAD:"#3a3b3e",STICK:"#2a2b2e",STICK_EDGE:"#121314",STICK_TOP:"#38393c",
  GLOW:"#ffffff",ACCENT:"#24a0ff",ACCENT_EDGE:"#0b6fc2",
  KEY_FILL:"#202226",KEY_EDGE:"#4b4f57",KEY_TEXT:"#d8dbe0",KEY_ON_FILL:"#24a0ff",KEY_ON_EDGE:"#9fd4ff",KEY_ON_TEXT:"#ffffff"};
const ABXY = {A:"#5cc443",B:"#ef3b3b",X:"#2f8cf0",Y:"#ffc51a"};
const B = {DU:0x1,DD:0x2,DL:0x4,DR:0x8,MENU:0x10,VIEW:0x20,LS:0x40,RS:0x80,LB:0x100,RB:0x200,GUIDE:0x400,
  A:0x1000,B:0x2000,X:0x4000,Y:0x8000};

function el(parent, tag, attrs){const e=document.createElementNS(NS,tag);
  for(const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e;}
// gleiche Glättung wie tkinter (smooth=True): quadratische Kurven durch die Kantenmitten
function smooth(a){const n=a.length/2,P=i=>[a[(i%n)*2],a[(i%n)*2+1]];
  const M=i=>{const p=P(i),q=P(i+1);return[(p[0]+q[0])/2,(p[1]+q[1])/2]};
  let m=M(n-1),d=`M${m[0]} ${m[1]}`;
  for(let i=0;i<n;i++){const v=P(i),e=M(i);d+=`Q${v[0]} ${v[1]} ${e[0]} ${e[1]}`}return d+"Z";}
function rr(x1,y1,x2,y2,r){r=Math.min(r,(x2-x1)/2,(y2-y1)/2);
  return smooth([x1+r,y1,x2-r,y1,x2,y1,x2,y1+r,x2,y2-r,x2,y2,x2-r,y2,x1+r,y2,x1,y2,x1,y2-r,x1,y1+r,x1,y1]);}
const path=(g,d,f,s,w)=>el(g,"path",{d,fill:f,stroke:s||"none","stroke-width":w||0});
const circ=(g,x,y,r,f,s,w)=>el(g,"circle",{cx:x,cy:y,r,fill:f,stroke:s||"none","stroke-width":w||0});
const txt=(g,x,y,t,size,f)=>{const e=el(g,"text",{x,y,"font-size":size,fill:f});e.textContent=t;return e;};
const set=(e,a)=>{for(const k in a)e.setAttribute(k,a[k]);};

/* ---------------- Controller ---------------- */
const cv=document.getElementById("cv"); cv.setAttribute("viewBox","0 0 370 310");
const cg=el(cv,"g",{transform:"translate(3,0)"}); const I={};
for(const [n,x1,x2] of [["lt",62,126],["rt",238,302]]){
  path(cg,rr(x1,8,x2,46,12),C.PART,C.BODY_EDGE,1.3);
  I[n]=[el(cg,"rect",{x:x1+4,y:31,width:x2-x1-8,height:0,fill:C.ACCENT})];
  txt(cg,(x1+x2)/2,19,n.toUpperCase(),9,C.LABEL);}
for(const [n,x1,x2] of [["lb",38,138],["rb",226,326]]){
  I[n]=[path(cg,rr(x1,34,x2,62,13),C.PART,C.BODY_EDGE,1.3), txt(cg,(x1+x2)/2,38,n.toUpperCase(),9,C.LABEL)];}
const body=[104,50,182,48,260,50,302,53,329,63,348,100,358,158,364,214,361,258,352,286,338,300,320,302,304,290,
  270,244,238,214,182,206,126,214,94,244,60,290,44,302,26,300,12,286,3,258,0,214,6,158,16,100,35,63,62,53];
path(cg,smooth(body.map((v,i)=>v+(i%2?2.5:1))),C.BODY_SHADOW);
path(cg,smooth(body),C.BODY,C.BODY_EDGE,1.4);
I.guide=[circ(cg,182,82,15,C.BODY,C.BODY,2), circ(cg,182,82,11.5,C.DARK)];
for(const a of [45,135]){const r=a*Math.PI/180,dx=Math.cos(r)*8.5,dy=Math.sin(r)*8.5;
  el(cg,"line",{x1:182-dx,y1:82-dy,x2:182+dx,y2:82+dy,stroke:C.BODY,"stroke-width":2.6});}
I.view=[circ(cg,155,116,8,C.PART,C.BODY_EDGE,1.2)]; I.menu=[circ(cg,209,116,8,C.PART,C.BODY_EDGE,1.2)];
el(cg,"rect",{x:151.5,y:112.5,width:4.5,height:4.5,fill:"none",stroke:C.LABEL,"stroke-width":0.9});
el(cg,"rect",{x:154,y:115,width:4.5,height:4.5,fill:C.PART,stroke:C.LABEL,"stroke-width":0.9});
for(const dy of [-2.4,0,2.4]) el(cg,"line",{x1:205.5,y1:116+dy,x2:212.5,y2:116+dy,stroke:C.LABEL,"stroke-width":0.9});
path(cg,rr(174,131,190,141,5),C.PART,C.BODY_EDGE,1.2);
el(cg,"line",{x1:178.5,y1:137.5,x2:185.5,y2:137.5,stroke:C.LABEL,"stroke-width":0.9});
for(const [n,x,y] of [["ls",89,115],["rs",228,172]]){
  circ(cg,x,y,26,C.BODY,C.BODY_EDGE,1.3); circ(cg,x,y,23,C.WELL);
  I[n]=[circ(cg,x,y,19,C.STICK,C.STICK_EDGE,1.5), circ(cg,x,y,13,C.STICK_TOP), x, y];}
{const x=134,y=173; circ(cg,x,y,27,C.DARK,C.STICK_EDGE,1.3);
  el(cg,"rect",{x:x-7.5,y:y-7.5,width:15,height:15,fill:C.DPAD});
  const arms={dup:[x-7.5,y-22,x+7.5,y-7],ddown:[x-7.5,y+7,x+7.5,y+22],dleft:[x-22,y-7.5,x-7,y+7.5],dright:[x+7,y-7.5,x+22,y+7.5]};
  for(const n in arms) I[n]=[path(cg,rr(...arms[n],3),C.DPAD)];
  circ(cg,x,y,3.5,C.STICK_TOP);}
for(const [n,ox,oy] of [["Y",0,-23],["X",-23,0],["B",23,0],["A",0,23]])
  I[n]=[circ(cg,262+ox,116+oy,11.5,C.DARK,C.STICK_EDGE,1.2), txt(cg,262+ox,116+oy,n,12,ABXY[n])];

function drawPad(s){
  const b=s.b||0;
  for(const [n,v] of [["lt",s.lt||0],["rt",s.rt||0]]) set(I[n][0],{y:31-19*v,height:19*v});
  for(const [n,bit] of [["lb",B.LB],["rb",B.RB]]){const on=b&bit;
    set(I[n][0],{fill:on?C.ACCENT:C.PART,stroke:on?C.ACCENT_EDGE:C.BODY_EDGE}); set(I[n][1],{fill:on?C.GLOW:C.LABEL});}
  {const on=b&B.GUIDE; set(I.guide[0],{stroke:on?C.ACCENT:C.BODY,"stroke-width":on?3:2}); set(I.guide[1],{fill:on?C.ACCENT:C.DARK});}
  for(const [n,bit] of [["view",B.VIEW],["menu",B.MENU]]){const on=b&bit;
    set(I[n][0],{fill:on?C.ACCENT:C.PART,stroke:on?C.ACCENT_EDGE:C.BODY_EDGE});}
  for(const [n,bit] of [["dup",B.DU],["ddown",B.DD],["dleft",B.DL],["dright",B.DR]]) set(I[n][0],{fill:b&bit?C.ACCENT:C.DPAD});
  for(const n of ["A","B","X","Y"]){const on=b&B[n]; set(I[n][0],{fill:on?ABXY[n]:C.DARK}); set(I[n][1],{fill:on?C.GLOW:ABXY[n]});}
  for(const [n,x,y,bit] of [["ls",s.lx||0,s.ly||0,B.LS],["rs",s.rx||0,s.ry||0,B.RS]]){
    const [th,cap,cx,cy]=I[n],tx=cx+x*7,ty=cy-y*7,on=b&bit;
    set(th,{cx:tx,cy:ty,stroke:on?C.ACCENT:C.STICK_EDGE,"stroke-width":on?3:1.5}); set(cap,{cx:tx,cy:ty,fill:on?C.ACCENT:C.STICK_TOP});}
}

/* ---------------- Tastatur & Maus ---------------- */
const kb=document.getElementById("kb"); let KEYS=[], MOUSE={};
const MB={lmb:1,rmb:2,mmb:4,x1:5,x2:6};
function buildKeyboard(rows){
  kb.innerHTML=""; KEYS=[]; MOUSE={};
  const U=36,G=4,pad=4; let y=pad,maxx=0;
  for(const row of rows){let x=pad;
    for(const k of row){const w=k.w*U-G;
      const r=path(kb,rr(x,y,x+w,y+U-G,7),C.KEY_FILL,C.KEY_EDGE,1.2);
      const t=txt(kb,x+w/2,y+(U-G)/2,k.label,k.label.length<=2?13:10,C.KEY_TEXT);
      KEYS.push([k.vk,r,t]); x+=k.w*U;}
    maxx=Math.max(maxx,x); y+=U;}
  const mx1=maxx+14,mx2=mx1+2.4*U,my1=pad+U*0.5,my2=y-G,mid=(mx1+mx2)/2,split=my1+(my2-my1)*0.42,wh=split-my1,sy=split+10;
  path(kb,rr(mx1,my1,mx2,my2,30),C.KEY_FILL,C.KEY_EDGE,1.2);
  MOUSE.lmb=path(kb,rr(mx1+3,my1+3,mid-7,split,22),C.KEY_FILL,C.KEY_EDGE,1.2);
  MOUSE.rmb=path(kb,rr(mid+7,my1+3,mx2-3,split,22),C.KEY_FILL,C.KEY_EDGE,1.2);
  MOUSE.mmb=path(kb,rr(mid-4,my1+wh*0.22,mid+4,my1+wh*0.72,5),"#3a3d44",C.KEY_EDGE,1);
  MOUSE.x2=path(kb,rr(mx1-6,sy,mx1+4,sy+18,3),C.KEY_FILL,C.KEY_EDGE,1);
  MOUSE.x1=path(kb,rr(mx1-6,sy+22,mx1+4,sy+40,3),C.KEY_FILL,C.KEY_EDGE,1);
  kb.setAttribute("viewBox",`-8 0 ${mx2+pad+10} ${y+pad-G}`);
}
function drawKeys(down){
  const d=new Set(down||[]);
  for(const [vk,r,t] of KEYS){const on=d.has(vk);
    set(r,{fill:on?C.KEY_ON_FILL:C.KEY_FILL,stroke:on?C.KEY_ON_EDGE:C.KEY_EDGE}); set(t,{fill:on?C.KEY_ON_TEXT:C.KEY_TEXT});}
  for(const n in MOUSE){const on=d.has(MB[n]);
    set(MOUSE[n],{fill:on?C.KEY_ON_FILL:(n==="mmb"?"#3a3d44":C.KEY_FILL),stroke:on?C.KEY_ON_EDGE:C.KEY_EDGE});}
}

/* ---------------- Daten vom Programm ---------------- */
function show(mode){cv.style.display=mode==="controller"?"block":"none"; kb.style.display=mode==="keyboard"?"block":"none";}
function apply(s){
  const mode=FORCE==="controller"||FORCE==="keyboard"?FORCE:s.m;
  show(mode); drawPad(s); drawKeys(s.k);
}
show(FORCE==="keyboard"?"keyboard":"controller");
fetch("/layout").then(r=>r.json()).then(l=>{buildKeyboard(l.rows);
  const es=new EventSource("/events");
  es.onmessage=e=>apply(JSON.parse(e.data));
  es.onerror=()=>{drawPad({}); drawKeys([]);};
}).catch(()=>setTimeout(()=>location.reload(),3000));
</script></body></html>
"""
