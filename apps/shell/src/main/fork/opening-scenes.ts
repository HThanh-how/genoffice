import type { SplashApp } from './opening-window'

export interface SceneMeta {
  id: string
  /** shown in the gallery */
  name: string
  /** the app it was drawn for (decides the colour it is tinted with in the gallery) */
  app: SplashApp
  /** page background: top-left and middle */
  bg: [string, string]
}

/** Every scene there is. The gallery shows them all; each app plays the one in SCENE_FOR_APP. */
export const SCENES: SceneMeta[] = [
  { id: 'ocean', name: 'Đại dương: sứa, cá, tia nắng', app: 'docs', bg: ['#041427', '#0a3b66'] },
  { id: 'aurora', name: 'Đêm sao và cực quang', app: 'docs', bg: ['#060a1c', '#0f2250'] },
  { id: 'moonsea', name: 'Biển đêm trăng, thuyền buồm', app: 'docs', bg: ['#050b1a', '#0d2a4e'] },
  { id: 'lotus', name: 'Hồ sen và cá chép', app: 'docs', bg: ['#06222a', '#0c4a52'] },
  { id: 'mountains', name: 'Núi sương lúc bình minh', app: 'docs', bg: ['#1b2a4a', '#56739c'] },
  { id: 'pages', name: 'Trang giấy bay', app: 'docs', bg: ['#0a1630', '#16295a'] },
  { id: 'jungle', name: 'Rừng đêm, đom đóm', app: 'sheets', bg: ['#03130c', '#0b3a22'] },
  { id: 'rice', name: 'Ruộng lúa chiều, cò bay', app: 'sheets', bg: ['#33200e', '#8a6126'] },
  { id: 'bamboo', name: 'Rừng tre trong sương', app: 'sheets', bg: ['#06150f', '#1a4a36'] },
  { id: 'butterflies', name: 'Vườn bướm', app: 'sheets', bg: ['#0a2418', '#2a6a3a'] },
  { id: 'grid', name: 'Lưới ô sáng lan sóng', app: 'sheets', bg: ['#031510', '#0a3324'] },
  { id: 'sunrise', name: 'Bình minh, khinh khí cầu', app: 'slides', bg: ['#2b1233', '#7d3140'] },
  { id: 'leaves', name: 'Lá thu rơi', app: 'pdf', bg: ['#220c0c', '#5a1f1b'] },
  { id: 'snow', name: 'Tuyết rơi đêm, nhà gỗ', app: 'markdown', bg: ['#0a1226', '#1d3358'] },
  { id: 'ink', name: 'Mực loang trong nước', app: 'markdown', bg: ['#070b1a', '#13204a'] },
  { id: 'sakura', name: 'Hoa anh đào rơi', app: 'markdown', bg: ['#1a0f1f', '#4a2440'] },
  { id: 'galaxy', name: 'Thiên hà xoáy', app: 'html', bg: ['#05040d', '#150f2e'] },
  {
    id: 'synthwave',
    name: 'Synthwave: mặt trời và lưới đường',
    app: 'html',
    bg: ['#12062b', '#3a0f5c'],
  },
  { id: 'city', name: 'Thành phố đêm', app: 'html', bg: ['#070912', '#17203a'] },
  { id: 'bubbles', name: 'Bong bóng xà phòng', app: 'html', bg: ['#0c1424', '#223a5c'] },
]

/** The scene each app plays today (change it here to switch). */
export const SCENE_FOR_APP: Record<SplashApp, string> = {
  docs: 'aurora',
  sheets: 'jungle',
  slides: 'sunrise',
  pdf: 'leaves',
  markdown: 'ink',
  html: 'galaxy',
}

export const sceneMeta = (id: string): SceneMeta => SCENES.find((s) => s.id === id) ?? SCENES[0]!

/** The page background behind an app's scene. */
export const SCENE_BACKGROUNDS: Record<SplashApp, [string, string]> = Object.fromEntries(
  (Object.keys(SCENE_FOR_APP) as SplashApp[]).map((app) => [app, sceneMeta(SCENE_FOR_APP[app]).bg]),
) as Record<SplashApp, [string, string]>

/**
 * `GOScene(canvas, sceneId, tier, rgb, lt)` draws a scene on a plain 2D canvas, no libraries, and
 * returns a function that stops it. `tier` is `full` (60 fps, more of everything) or `lite` (30 fps,
 * fewer); `rgb` and `lt` are the app colour and a lighter tone of it, as "r,g,b". It also stops by
 * itself while the page is hidden. No template literals or backslashes in here: this whole file is
 * one string.
 */
export const SCENE_LIB = `
window.GOScene=function(canvas,sceneId,tier,rgb,lt){
  var ctx=canvas.getContext('2d'); if(!ctx) return function(){};
  var dpr=Math.min(window.devicePixelRatio||1, tier==='full'?2:1.5);
  var W=canvas.clientWidth, H=canvas.clientHeight;
  canvas.width=Math.round(W*dpr); canvas.height=Math.round(H*dpr); ctx.setTransform(dpr,0,0,dpr,0,0);
  var full=tier==='full', fps=full?60:30, step=1000/fps, TAU=6.2832;
  function rnd(a,b){return a+Math.random()*(b-a)}
  function pick(list){return list[Math.floor(Math.random()*list.length)]}
  function glow(x,y,r,color,a){
    var g=ctx.createRadialGradient(x,y,0,x,y,r);
    g.addColorStop(0,'rgba('+color+','+a+')'); g.addColorStop(1,'rgba('+color+',0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,r,0,TAU); ctx.fill();
  }
  function dot(x,y,r){ctx.beginPath(); ctx.arc(x,y,r,0,TAU); ctx.fill()}
  function bird(x,y,fl,col,sz){
    ctx.strokeStyle=col; ctx.lineWidth=1.6; ctx.lineCap='round'; ctx.beginPath();
    ctx.moveTo(x-7*sz,y-fl*sz); ctx.quadraticCurveTo(x-3*sz,y-(fl+2)*sz,x,y); ctx.quadraticCurveTo(x+3*sz,y-(fl+2)*sz,x+7*sz,y-fl*sz); ctx.stroke();
  }
  var scenes={};

  /* ===== Word candidates ===== */
  scenes.ocean={
    init:function(){
      var s={jellies:[],fish:[],specks:[]}, i, j, jn=full?3:2;
      for(i=0;i<jn;i++) s.jellies.push({x:rnd(W*0.15,W*0.85), y:rnd(H*0.2,H*1.1), s:rnd(0.55,1.1), p:rnd(0,6.28), v:rnd(9,20), d:rnd(-6,6)});
      s.jellies.sort(function(a,b){return a.s-b.s});
      for(i=0;i<(full?3:2);i++){
        var dir=Math.random()<0.5?-1:1, n=full?7:4, sch={dir:dir, x:rnd(0,W), y:rnd(H*0.18,H*0.7), v:rnd(16,30), s:rnd(0.7,1.2), fish:[]};
        for(j=0;j<n;j++) sch.fish.push({dx:-dir*rnd(0,46), dy:rnd(-14,14), p:rnd(0,6.28)});
        s.fish.push(sch);
      }
      for(i=0;i<(full?32:12);i++) s.specks.push({x:rnd(0,W), y:rnd(0,H), r:rnd(0.6,1.8), v:rnd(4,14), p:rnd(0,6.28)});
      return s;
    },
    jelly:function(j,t){
      var pulse=Math.sin(t*2.2+j.p), bw=34*j.s*(1.04-0.1*pulse), bh=26*j.s*(1+0.16*pulse);
      var a=0.35+0.45*(j.s/1.15), x=j.x+Math.sin(t*0.7+j.p)*8*j.s, y=j.y;
      var g=ctx.createRadialGradient(x,y-bh*0.25,2,x,y,bw*1.25);
      g.addColorStop(0,'rgba('+lt+','+Math.min(1,1.15*a)+')'); g.addColorStop(0.55,'rgba('+rgb+','+(0.8*a)+')'); g.addColorStop(1,'rgba('+rgb+',0.05)');
      if(full){ctx.shadowColor='rgba('+rgb+',0.9)'; ctx.shadowBlur=22*j.s}
      ctx.fillStyle=g; ctx.beginPath(); ctx.ellipse(x,y,bw,bh,0,Math.PI,0); ctx.quadraticCurveTo(x,y+bh*0.45,x-bw,y); ctx.fill();
      ctx.shadowBlur=0; ctx.strokeStyle='rgba('+lt+','+(0.55*a)+')'; ctx.lineWidth=1; ctx.beginPath(); ctx.ellipse(x,y,bw,bh,0,Math.PI,0); ctx.stroke();
      ctx.lineWidth=Math.max(0.8,1.5*j.s); ctx.lineCap='round';
      var n=full?7:5, len=64*j.s;
      for(var q=0;q<n;q++){
        var ox=x+((q/(n-1))*2-1)*bw*0.85, grad=ctx.createLinearGradient(0,y,0,y+len);
        grad.addColorStop(0,'rgba('+lt+','+(0.75*a)+')'); grad.addColorStop(1,'rgba('+rgb+',0)');
        ctx.strokeStyle=grad; ctx.beginPath(); ctx.moveTo(ox,y+bh*0.15);
        for(var k=1;k<=10;k++){var f=k/10; ctx.lineTo(ox+Math.sin(t*2.1+q*0.9+f*4+j.p)*(2+f*10)*j.s, y+bh*0.15+f*len);}
        ctx.stroke();
      }
    },
    fishAt:function(x,y,dir,s,wag){
      var bl=9*s, bh=3.6*s;
      ctx.save(); ctx.translate(x,y); ctx.scale(dir,1);
      ctx.fillStyle='rgba(190,235,255,0.62)';
      ctx.beginPath(); ctx.ellipse(0,0,bl,bh,0,0,TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-bl*0.8,0); ctx.lineTo(-bl*1.7,-bh*1.5+wag); ctx.lineTo(-bl*1.7,bh*1.5+wag); ctx.closePath(); ctx.fill();
      ctx.fillStyle='rgba(255,255,255,0.8)'; dot(bl*0.5,-bh*0.2,0.9*s);
      ctx.restore();
    },
    draw:function(s,t,dt){
      var i, j;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<(full?4:3);i++){
        var x0=W*(0.12+0.28*i)+Math.sin(t*0.3+i*1.7)*22, rg=ctx.createLinearGradient(0,0,0,H*0.95);
        rg.addColorStop(0,'rgba('+lt+',0.16)'); rg.addColorStop(1,'rgba('+lt+',0)');
        ctx.fillStyle=rg; ctx.beginPath(); ctx.moveTo(x0-10,-4); ctx.lineTo(x0+16,-4); ctx.lineTo(x0+78+i*10,H); ctx.lineTo(x0-46-i*8,H); ctx.closePath(); ctx.fill();
      }
      glow(W*0.5,H*1.05,H*1.1,rgb,0.28+0.07*Math.sin(t*1.3));
      for(i=0;i<s.specks.length;i++){var c=s.specks[i]; c.y-=c.v*dt; c.x+=Math.sin(t+c.p)*6*dt;
        if(c.y<-4){c.y=H+4; c.x=rnd(0,W)}
        ctx.fillStyle='rgba('+rgb+','+(0.25+0.2*Math.sin(t*2+c.p))+')'; dot(c.x,c.y,c.r);}
      ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.fish.length;i++){
        var sc=s.fish[i]; sc.x+=sc.dir*sc.v*dt;
        if(sc.dir>0&&sc.x>W+90){sc.x=-90; sc.y=rnd(H*0.18,H*0.7)} else if(sc.dir<0&&sc.x<-90){sc.x=W+90; sc.y=rnd(H*0.18,H*0.7)}
        for(j=0;j<sc.fish.length;j++){var f=sc.fish[j];
          this.fishAt(sc.x+f.dx, sc.y+f.dy+Math.sin(t*1.4+f.p)*4, sc.dir, sc.s, Math.sin(t*9+f.p)*1.6);}
      }
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.jellies.length;i++){var e=s.jellies[i]; e.y-=e.v*dt; e.x+=e.d*dt;
        if(e.y<-90||e.x<-40||e.x>W+40){e.y=H+70; e.x=rnd(W*0.1,W*0.9); e.d=rnd(-6,6)}
        this.jelly(e,t);}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.aurora={
    init:function(){
      var s={stars:[],shoot:null,next:3}, i;
      for(i=0;i<(full?70:28);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H*0.85), r:rnd(0.4,1.4), p:rnd(0,6.28), sp:rnd(0.8,2.4)});
      return s;
    },
    draw:function(s,t,dt){
      var i, x;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<(full?3:2);i++){
        var base=H*(0.26+0.17*i), g=ctx.createLinearGradient(0,base-34,0,base+46);
        g.addColorStop(0,'rgba('+rgb+',0)'); g.addColorStop(0.5,'rgba('+(i===1?'110,255,200':lt)+','+(0.26-0.05*i)+')'); g.addColorStop(1,'rgba('+rgb+',0)');
        ctx.fillStyle=g; ctx.beginPath();
        for(x=0;x<=W+8;x+=8){var y=base+Math.sin(x*0.011+t*0.4+i*1.6)*16+Math.sin(x*0.024-t*0.3+i)*8; if(x===0) ctx.moveTo(x,y-34); else ctx.lineTo(x,y-34);}
        for(x=W+8;x>=0;x-=8){var y2=base+Math.sin(x*0.011+t*0.4+i*1.6)*16+Math.sin(x*0.024-t*0.3+i)*8; ctx.lineTo(x,y2+46);}
        ctx.closePath(); ctx.fill();
      }
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(235,242,255,'+(0.3+0.5*(0.5+0.5*Math.sin(t*st.sp+st.p)))+')'; dot(st.x,st.y,st.r);}
      s.next-=dt;
      if(!s.shoot&&s.next<=0){s.shoot={x:rnd(W*0.3,W*0.95), y:rnd(0,H*0.3), vx:-rnd(220,320), vy:rnd(70,120), life:0.9}; s.next=rnd(2.5,5.5);}
      if(s.shoot){var m=s.shoot; m.x+=m.vx*dt; m.y+=m.vy*dt; m.life-=dt;
        var tg=ctx.createLinearGradient(m.x,m.y,m.x-m.vx*0.18,m.y-m.vy*0.18); tg.addColorStop(0,'rgba(255,255,255,0.9)'); tg.addColorStop(1,'rgba(255,255,255,0)');
        ctx.strokeStyle=tg; ctx.lineWidth=1.6; ctx.beginPath(); ctx.moveTo(m.x,m.y); ctx.lineTo(m.x-m.vx*0.18,m.y-m.vy*0.18); ctx.stroke();
        if(m.life<=0) s.shoot=null;}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.moonsea={
    init:function(){
      var s={stars:[],clouds:[]}, i;
      for(i=0;i<(full?40:18);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H*0.55), r:rnd(0.4,1.2), p:rnd(0,6.28)});
      for(i=0;i<3;i++) s.clouds.push({x:rnd(0,W), y:rnd(H*0.12,H*0.4), w:rnd(60,120), v:rnd(3,7)});
      return s;
    },
    draw:function(s,t,dt){
      var i, hz=H*0.62, mx=W*0.7, my=H*0.3, x;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(230,240,255,'+(0.25+0.35*(0.5+0.5*Math.sin(t*1.4+st.p)))+')'; dot(st.x,st.y,st.r);}
      glow(mx,my,H*0.8,'170,200,255',0.18); glow(mx,my,H*0.28,'230,240,255',0.35);
      ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(245,248,255,0.95)'; dot(mx,my,H*0.075);
      ctx.fillStyle='rgba(200,214,240,0.35)'; dot(mx-H*0.02,my-H*0.015,H*0.018); dot(mx+H*0.025,my+H*0.02,H*0.012);
      for(i=0;i<s.clouds.length;i++){var c=s.clouds[i]; c.x+=c.v*dt; if(c.x>W+c.w) c.x=-c.w;
        var cg=ctx.createLinearGradient(c.x-c.w,0,c.x+c.w,0); cg.addColorStop(0,'rgba(120,150,200,0)'); cg.addColorStop(0.5,'rgba(120,150,200,0.18)'); cg.addColorStop(1,'rgba(120,150,200,0)');
        ctx.fillStyle=cg; ctx.beginPath(); ctx.ellipse(c.x,c.y,c.w,9,0,0,TAU); ctx.fill();}
      var wg=ctx.createLinearGradient(0,hz,0,H); wg.addColorStop(0,'rgba(10,30,66,0.95)'); wg.addColorStop(1,'rgba(3,10,26,1)');
      ctx.fillStyle=wg; ctx.fillRect(0,hz,W,H-hz);
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<(full?26:14);i++){
        var yy=hz+4+i*((H-hz-6)/(full?26:14)), spread=14+i*5, wob=Math.sin(t*1.7+i*1.3)*spread*0.35;
        ctx.fillStyle='rgba(215,230,255,'+(0.26-i*0.007)+')'; ctx.fillRect(mx+wob-spread*0.5*(0.6+0.4*Math.sin(t*2.1+i)),yy,spread*(0.6+0.4*Math.sin(t*2.1+i)),1.6);
      }
      ctx.globalCompositeOperation='source-over';
      ctx.strokeStyle='rgba(120,160,220,0.18)'; ctx.lineWidth=1;
      for(i=0;i<5;i++){ctx.beginPath(); for(x=0;x<=W;x+=10){var yv=hz+10+i*((H-hz)/6)+Math.sin(x*0.03+t*(0.8+i*0.2)+i)*2.2; if(x===0) ctx.moveTo(x,yv); else ctx.lineTo(x,yv);} ctx.stroke();}
      var bx=(t*7)%(W+80)-40, by=hz+2+Math.sin(t*1.2)*1.2;
      ctx.fillStyle='rgba(8,16,34,0.95)'; ctx.beginPath(); ctx.moveTo(bx-9,by); ctx.lineTo(bx+9,by); ctx.lineTo(bx+5,by+4); ctx.lineTo(bx-6,by+4); ctx.closePath(); ctx.fill();
      ctx.fillStyle='rgba(235,240,255,0.8)'; ctx.beginPath(); ctx.moveTo(bx,by-1); ctx.lineTo(bx,by-17); ctx.lineTo(bx+9,by-1); ctx.closePath(); ctx.fill();
      ctx.fillStyle='rgba(200,214,240,0.75)'; ctx.beginPath(); ctx.moveTo(bx-1,by-1); ctx.lineTo(bx-1,by-13); ctx.lineTo(bx-8,by-1); ctx.closePath(); ctx.fill();
    }
  };

  scenes.lotus={
    init:function(){
      var s={pads:[],koi:[],ripples:[],next:1}, i, j;
      for(i=0;i<(full?7:5);i++) s.pads.push({x:rnd(W*0.08,W*0.92), y:rnd(H*0.12,H*0.82), r:rnd(15,27), a:rnd(0,6.28), flower:Math.random()<0.55, p:rnd(0,6.28)});
      var cols=[['255,140,66','255,244,230'],['255,96,60','255,200,150'],['250,250,245','255,150,90']];
      for(i=0;i<(full?3:2);i++) s.koi.push({cx:rnd(W*0.3,W*0.7), cy:rnd(H*0.3,H*0.7), ax:rnd(W*0.18,W*0.34), ay:rnd(H*0.1,H*0.22), w:rnd(0.22,0.38), p:rnd(0,6.28), c:cols[i%3], z:rnd(0.9,1.3)});
      return s;
    },
    pos:function(k,tt){return {x:k.cx+Math.cos(tt*k.w+k.p)*k.ax, y:k.cy+Math.sin(tt*k.w*1.7+k.p)*k.ay}},
    draw:function(s,t,dt){
      var i, j;
      ctx.globalCompositeOperation='lighter';
      glow(W*0.3,H*0.2,H*0.9,'120,220,210',0.12);
      for(i=0;i<(full?3:2);i++){var rg=ctx.createLinearGradient(0,0,0,H); rg.addColorStop(0,'rgba(200,255,240,0.10)'); rg.addColorStop(1,'rgba(200,255,240,0)'); ctx.fillStyle=rg;
        var x0=W*(0.2+0.3*i)+Math.sin(t*0.4+i)*14; ctx.beginPath(); ctx.moveTo(x0,0); ctx.lineTo(x0+22,0); ctx.lineTo(x0+90,H); ctx.lineTo(x0+10,H); ctx.closePath(); ctx.fill();}
      ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.koi.length;i++){var k=s.koi[i], head=this.pos(k,t), prev=this.pos(k,t-0.05), ang=Math.atan2(head.y-prev.y,head.x-prev.x), n=14, ca=Math.cos(ang), sa=Math.sin(ang);
        var seg=[];
        for(j=0;j<n;j++){var q=this.pos(k,t-j*0.07/k.w*0.3), sway=Math.sin(t*5.5-j*0.55)*j*0.28; seg.push({x:q.x-sa*sway, y:q.y+ca*sway});}
        var tail=seg[n-1];
        ctx.fillStyle='rgba('+k.c[0]+',0.5)'; ctx.beginPath(); ctx.moveTo(tail.x,tail.y);
        ctx.lineTo(tail.x-ca*15*k.z+sa*8*k.z,tail.y-sa*15*k.z-ca*8*k.z); ctx.lineTo(tail.x-ca*11*k.z,tail.y-sa*11*k.z); ctx.lineTo(tail.x-ca*15*k.z-sa*8*k.z,tail.y-sa*15*k.z+ca*8*k.z); ctx.closePath(); ctx.fill();
        for(j=n-1;j>=0;j--){var r=(8.6-j*0.52)*k.z; ctx.fillStyle='rgba('+k.c[0]+',0.9)'; dot(seg[j].x,seg[j].y,Math.max(1.6,r));}
        ctx.fillStyle='rgba('+k.c[1]+',0.9)'; dot(seg[3].x,seg[3].y,5.2*k.z); dot(seg[6].x,seg[6].y,4.2*k.z); dot(seg[9].x,seg[9].y,2.6*k.z);
        ctx.fillStyle='rgba('+k.c[0]+',0.6)'; var fs=seg[2];
        ctx.beginPath(); ctx.ellipse(fs.x-sa*9*k.z,fs.y+ca*9*k.z,6*k.z,2.4*k.z,ang+0.6,0,TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(fs.x+sa*9*k.z,fs.y-ca*9*k.z,6*k.z,2.4*k.z,ang-0.6,0,TAU); ctx.fill();
        ctx.fillStyle='rgba(20,20,20,0.85)'; dot(head.x+ca*5-sa*3.4,head.y+sa*5+ca*3.4,1); dot(head.x+ca*5+sa*3.4,head.y+sa*5-ca*3.4,1);}
      s.next-=dt; if(s.next<=0){s.ripples.push({x:rnd(W*0.1,W*0.9), y:rnd(H*0.15,H*0.9), r:2, life:1}); s.next=rnd(0.8,2);}
      ctx.lineWidth=1;
      for(i=s.ripples.length-1;i>=0;i--){var rp=s.ripples[i]; rp.r+=22*dt; rp.life-=0.45*dt; if(rp.life<=0){s.ripples.splice(i,1); continue}
        ctx.strokeStyle='rgba(210,255,248,'+(0.35*rp.life)+')'; ctx.beginPath(); ctx.ellipse(rp.x,rp.y,rp.r,rp.r*0.45,0,0,TAU); ctx.stroke();}
      for(i=0;i<s.pads.length;i++){var p=s.pads[i], py=p.y+Math.sin(t*0.8+p.p)*1.6;
        ctx.save(); ctx.translate(p.x,py); ctx.scale(1,0.5); ctx.rotate(p.a);
        ctx.fillStyle='rgba(22,110,76,0.92)'; ctx.beginPath(); ctx.moveTo(0,0); ctx.arc(0,0,p.r,0.35,TAU-0.05); ctx.closePath(); ctx.fill();
        ctx.strokeStyle='rgba(120,210,150,0.4)'; ctx.lineWidth=1; for(j=0;j<5;j++){ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(0.6+j*1.1)*p.r*0.9,Math.sin(0.6+j*1.1)*p.r*0.9); ctx.stroke();}
        ctx.restore();
        if(p.flower){var fy=py-3, bl=0.5+0.5*Math.sin(t*0.6+p.p);
          for(j=0;j<8;j++){var fa=j*0.785-1.57; ctx.save(); ctx.translate(p.x,fy); ctx.rotate(fa*0.55); ctx.fillStyle='rgba(255,'+(170+j*6)+',200,'+(0.78+0.15*bl)+')'; ctx.beginPath(); ctx.ellipse(0,-8,4.6,9,0,0,TAU); ctx.fill(); ctx.restore();}
          ctx.fillStyle='rgba(255,226,120,0.95)'; dot(p.x,fy-1,2.6);}
      }
    }
  };

  scenes.mountains={
    init:function(){
      var s={mist:[],birds:[]}, i;
      for(i=0;i<4;i++) s.mist.push({x:rnd(0,W), y:H*(0.5+0.12*i), w:rnd(140,240), v:rnd(4,10)*(1+i*0.3)});
      for(i=0;i<(full?4:2);i++) s.birds.push({x:rnd(0,W), y:rnd(H*0.1,H*0.4), v:rnd(10,18), p:rnd(0,6.28)});
      return s;
    },
    ridge:function(base,amp,seed,col){
      ctx.fillStyle=col; ctx.beginPath(); ctx.moveTo(0,H);
      for(var x=0;x<=W+6;x+=6){var y=base-Math.abs(Math.sin(x*0.011+seed))*amp-Math.sin(x*0.027+seed*2.1)*amp*0.35; ctx.lineTo(x,y);}
      ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
    },
    draw:function(s,t,dt){
      var i;
      ctx.globalCompositeOperation='lighter'; glow(W*0.78,H*0.28,H*0.9,'255,226,190',0.28); glow(W*0.78,H*0.28,H*0.22,'255,244,220',0.45); ctx.globalCompositeOperation='source-over';
      this.ridge(H*0.62,H*0.3,1.0,'rgba(120,146,190,0.55)');
      this.ridge(H*0.74,H*0.28,3.2,'rgba(80,108,160,0.7)');
      this.ridge(H*0.86,H*0.26,5.7,'rgba(46,70,118,0.85)');
      this.ridge(H*1.0,H*0.24,8.1,'rgba(22,38,74,0.97)');
      for(i=0;i<s.mist.length;i++){var m=s.mist[i]; m.x+=m.v*dt; if(m.x>W+m.w) m.x=-m.w;
        var g=ctx.createLinearGradient(m.x-m.w,0,m.x+m.w,0); g.addColorStop(0,'rgba(220,232,250,0)'); g.addColorStop(0.5,'rgba(220,232,250,0.22)'); g.addColorStop(1,'rgba(220,232,250,0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.ellipse(m.x,m.y,m.w,12,0,0,TAU); ctx.fill();}
      for(i=0;i<s.birds.length;i++){var b=s.birds[i]; b.x+=b.v*dt; if(b.x>W+20) b.x=-20; bird(b.x,b.y+Math.sin(t*0.8+b.p)*4,Math.sin(t*5+b.p)*3,'rgba(30,44,80,0.8)',1);}
    }
  };

  scenes.pages={
    init:function(){
      var s={sheets:[]}, i;
      for(i=0;i<(full?12:7);i++) s.sheets.push({x:rnd(0,W), y:rnd(0,H), w:rnd(24,40), vy:-rnd(16,36), vx:rnd(-6,6), p:rnd(0,6.28), sp:rnd(0.8,1.8), rot:rnd(-0.5,0.5), head:Math.random()<0.5});
      s.sheets.sort(function(a,b){return a.w-b.w});
      return s;
    },
    draw:function(s,t,dt){
      var i, j;
      ctx.globalCompositeOperation='lighter'; glow(W*0.5,H*1.0,H*1.1,rgb,0.22+0.05*Math.sin(t)); glow(W*0.2,H*0.1,H*0.7,lt,0.08); ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.sheets.length;i++){var p=s.sheets[i]; p.y+=p.vy*dt; p.x+=(p.vx+Math.sin(t*0.7+p.p)*8)*dt;
        if(p.y<-60){p.y=H+60; p.x=rnd(0,W)}
        var flip=Math.cos(t*p.sp+p.p), w=p.w, h=p.w*1.35, depth=0.35+0.6*(p.w/38);
        ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot+Math.sin(t*0.6+p.p)*0.25); ctx.scale(Math.max(0.12,Math.abs(flip)),1);
        ctx.fillStyle='rgba('+(flip>0?'244,248,255':'206,220,244')+','+depth+')'; ctx.fillRect(-w/2,-h/2,w,h);
        if(p.head){ctx.fillStyle='rgba('+rgb+','+(0.85*depth)+')'; ctx.fillRect(-w/2,-h/2,w,h*0.16);}
        ctx.fillStyle='rgba(80,100,140,'+(0.55*depth)+')';
        for(j=0;j<5;j++) ctx.fillRect(-w/2+w*0.12,-h/2+h*(0.28+j*0.13),w*(j===4?0.4:0.76),1.4);
        ctx.restore();}
    }
  };

  /* ===== Excel candidates ===== */
  scenes.jungle={
    init:function(){
      var s={far:[],near:[],vines:[],flies:[],mist:[]}, i, j, nf=full?9:6, nn=full?7:5;
      for(i=0;i<nf;i++) s.far.push({x:W*(i+0.5)/nf+rnd(-14,14), len:rnd(70,118), ang:rnd(-0.55,0.55), w:rnd(16,26), p:rnd(0,6.28)});
      for(i=0;i<nn;i++){var left=i%2===0; s.near.push({x:left?rnd(-10,W*0.22):rnd(W*0.78,W+10), len:rnd(90,150), ang:left?rnd(0.15,0.9):rnd(-0.9,-0.15), w:rnd(22,34), p:rnd(0,6.28)});}
      var nv=full?5:3;
      for(i=0;i<nv;i++){var v={x:W*(i+0.4)/nv+rnd(-16,16), len:rnd(H*0.28,H*0.5), p:rnd(0,6.28), leaves:[]};
        for(j=1;j<=4;j++) v.leaves.push({f:j/5, side:j%2?1:-1}); s.vines.push(v);}
      for(i=0;i<(full?26:12);i++) s.flies.push({x:rnd(W*0.05,W*0.95), y:rnd(H*0.15,H*0.85), sp:rnd(0.35,0.8), ph:rnd(0,6.28), amp:rnd(18,44)});
      for(i=0;i<3;i++) s.mist.push({x:rnd(0,W), y:rnd(H*0.55,H*0.95), r:rnd(90,150), v:rnd(3,8)});
      return s;
    },
    leaf:function(x,y,ang,len,w,fill,rib){
      ctx.save(); ctx.translate(x,y); ctx.rotate(ang);
      ctx.fillStyle=fill; ctx.beginPath(); ctx.moveTo(0,0); ctx.quadraticCurveTo(w,-len*0.5,0,-len); ctx.quadraticCurveTo(-w,-len*0.5,0,0); ctx.fill();
      ctx.strokeStyle=rib; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0,-len*0.92); ctx.stroke();
      ctx.restore();
    },
    draw:function(s,t,dt){
      var i, j;
      ctx.globalCompositeOperation='lighter';
      glow(W*0.5,H*0.35,H*0.9,rgb,0.10+0.03*Math.sin(t*0.6));
      for(i=0;i<s.mist.length;i++){var m=s.mist[i]; m.x+=m.v*dt; if(m.x>W+m.r) m.x=-m.r; glow(m.x,m.y,m.r,'120,200,160',0.07);}
      ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.far.length;i++){var a=s.far[i]; this.leaf(a.x,H+4,a.ang+Math.sin(t*0.7+a.p)*0.05,a.len,a.w,'rgba(9,44,26,0.92)','rgba(40,110,70,0.35)');}
      ctx.lineCap='round';
      for(i=0;i<s.vines.length;i++){var v=s.vines[i], sway=Math.sin(t*0.6+v.p)*9, px=[], py=[];
        ctx.strokeStyle='rgba(12,58,34,0.85)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(v.x,-4);
        for(j=1;j<=8;j++){var f=j/8, x=v.x+Math.sin(f*2.6+t*0.8+v.p)*6+sway*f, y=-4+v.len*f; ctx.lineTo(x,y); px.push(x); py.push(y);} ctx.stroke();
        for(j=0;j<v.leaves.length;j++){var lf=v.leaves[j], k=Math.min(7,Math.round(lf.f*8)); this.leaf(px[k],py[k],lf.side*(1.1+0.12*Math.sin(t*1.1+j+v.p))+3.14,16,7,'rgba(16,78,44,0.9)','rgba(60,140,90,0.3)');}
      }
      for(i=0;i<s.near.length;i++){var b=s.near[i]; this.leaf(b.x,H+6,b.ang+Math.sin(t*0.6+b.p)*0.045,b.len,b.w,'rgba(4,24,14,0.97)','rgba(30,90,56,0.3)');}
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.flies.length;i++){var fl=s.flies[i];
        var x2=fl.x+Math.sin(t*fl.sp+fl.ph)*fl.amp+Math.sin(t*fl.sp*0.37+fl.ph*2)*fl.amp*0.6,
            y2=fl.y+Math.cos(t*fl.sp*0.8+fl.ph)*fl.amp*0.5+Math.sin(t*fl.sp*0.29+fl.ph)*fl.amp*0.4,
            bl=0.5+0.5*Math.sin(t*1.6+fl.ph*3); bl=bl*bl;
        glow(x2,y2,full?15:11,'214,255,110',0.55*bl);
        ctx.fillStyle='rgba(250,255,200,'+(0.35+0.65*bl)+')'; dot(x2,y2,1.5);}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.rice={
    init:function(){
      var s={egrets:[],rows:[]}, i;
      for(i=0;i<(full?4:2);i++) s.egrets.push({x:rnd(0,W), y:rnd(H*0.12,H*0.4), v:rnd(16,28), p:rnd(0,6.28), z:rnd(0.9,1.4)});
      var n=full?9:6;
      for(i=0;i<n;i++) s.rows.push({y:H*0.5+i*(H*0.55/n), amp:2+i*0.9, len:7+i*3.2, dens:Math.round(W/(5+i*1.3)), shade:i/n});
      return s;
    },
    draw:function(s,t,dt){
      var i, j;
      ctx.globalCompositeOperation='lighter'; glow(W*0.25,H*0.5,H*1.0,'255,196,110',0.55); glow(W*0.25,H*0.5,H*0.32,'255,236,180',0.5); ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(60,70,40,0.55)'; ctx.beginPath(); ctx.moveTo(0,H*0.52); for(var x=0;x<=W;x+=12) ctx.lineTo(x,H*0.5-Math.abs(Math.sin(x*0.01+1))*14); ctx.lineTo(W,H*0.55); ctx.lineTo(0,H*0.55); ctx.closePath(); ctx.fill();
      for(i=0;i<s.rows.length;i++){var r=s.rows[i], g=Math.round(150+r.shade*40), col='rgba('+Math.round(190-r.shade*60)+','+g+','+Math.round(60-r.shade*20)+','+(0.65+r.shade*0.3)+')';
        ctx.strokeStyle=col; ctx.lineWidth=1+r.shade*1.4; ctx.lineCap='round'; ctx.beginPath();
        for(j=0;j<r.dens;j++){var bx=j*(W/r.dens)+(i%2)*3, sw=Math.sin(bx*0.02-t*1.5+i)*r.amp;
          ctx.moveTo(bx,r.y+r.len*0.4); ctx.quadraticCurveTo(bx+sw*0.4,r.y-r.len*0.1,bx+sw,r.y-r.len);}
        ctx.stroke();
        ctx.fillStyle='rgba(235,200,90,'+(0.55+r.shade*0.3)+')';
        for(j=0;j<r.dens;j+=3){var gx=j*(W/r.dens)+(i%2)*3, gs=Math.sin(gx*0.02-t*1.5+i)*r.amp; dot(gx+gs,r.y-r.len,1.1+r.shade);}}
      for(i=0;i<s.egrets.length;i++){var e=s.egrets[i]; e.x+=e.v*dt; if(e.x>W+30){e.x=-30; e.y=rnd(H*0.12,H*0.4)}
        var fl=Math.sin(t*4+e.p)*4.5*e.z, by=e.y+Math.sin(t*0.7+e.p)*3;
        ctx.strokeStyle='rgba(250,250,245,0.95)'; ctx.lineWidth=2*e.z; ctx.lineCap='round';
        ctx.beginPath(); ctx.moveTo(e.x-12*e.z,by-fl); ctx.quadraticCurveTo(e.x-5*e.z,by-fl-3,e.x,by); ctx.quadraticCurveTo(e.x+5*e.z,by-fl-3,e.x+12*e.z,by-fl); ctx.stroke();
        ctx.fillStyle='rgba(250,250,245,0.95)'; ctx.beginPath(); ctx.ellipse(e.x,by+1,5*e.z,2.2*e.z,0,0,TAU); ctx.fill();
        ctx.strokeStyle='rgba(250,250,245,0.9)'; ctx.lineWidth=1.3; ctx.beginPath(); ctx.moveTo(e.x+4*e.z,by); ctx.lineTo(e.x+9*e.z,by-2); ctx.moveTo(e.x-4*e.z,by+1); ctx.lineTo(e.x-12*e.z,by+3); ctx.stroke();}
    }
  };

  scenes.bamboo={
    init:function(){
      var s={stalks:[],leaves:[],shafts:[]}, i, n=full?15:9;
      for(i=0;i<n;i++){var z=rnd(0.3,1); s.stalks.push({x:rnd(0,W), w:6+z*11, z:z, p:rnd(0,6.28), nodes:rnd(34,60)});}
      s.stalks.sort(function(a,b){return a.z-b.z});
      for(i=0;i<(full?18:8);i++) s.leaves.push({x:rnd(0,W), y:rnd(-20,H), vy:rnd(10,24), p:rnd(0,6.28), rot:rnd(0,6.28), vr:rnd(-1,1)});
      for(i=0;i<3;i++) s.shafts.push({x:rnd(0,W), w:rnd(18,40), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i, j;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.shafts.length;i++){var sh=s.shafts[i], x0=sh.x+Math.sin(t*0.25+sh.p)*20, rg=ctx.createLinearGradient(0,0,0,H);
        rg.addColorStop(0,'rgba(200,255,200,0.18)'); rg.addColorStop(1,'rgba(200,255,200,0)'); ctx.fillStyle=rg;
        ctx.beginPath(); ctx.moveTo(x0,0); ctx.lineTo(x0+sh.w,0); ctx.lineTo(x0+sh.w+80,H); ctx.lineTo(x0+30,H); ctx.closePath(); ctx.fill();}
      glow(W*0.5,H*0.9,H*0.9,'90,200,140',0.14);
      ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.stalks.length;i++){var b=s.stalks[i], sway=Math.sin(t*0.5+b.p)*3*b.z, a=0.25+0.7*b.z;
        var g=ctx.createLinearGradient(b.x-b.w/2,0,b.x+b.w/2,0); g.addColorStop(0,'rgba(18,70,48,'+a+')'); g.addColorStop(0.45,'rgba(70,160,110,'+a+')'); g.addColorStop(1,'rgba(14,56,38,'+a+')');
        ctx.fillStyle=g; ctx.beginPath(); ctx.moveTo(b.x-b.w/2,H); ctx.lineTo(b.x-b.w/2+sway,-2); ctx.lineTo(b.x+b.w/2+sway,-2); ctx.lineTo(b.x+b.w/2,H); ctx.closePath(); ctx.fill();
        ctx.strokeStyle='rgba(8,36,24,'+(a*0.9)+')'; ctx.lineWidth=1.4; ctx.beginPath();
        for(j=0;j*b.nodes<H+b.nodes;j++){var yy=H-j*b.nodes, f=1-yy/H; ctx.moveTo(b.x-b.w/2+sway*f-1,yy); ctx.lineTo(b.x+b.w/2+sway*f+1,yy);} ctx.stroke();}
      for(i=0;i<s.leaves.length;i++){var l=s.leaves[i]; l.y+=l.vy*dt; l.x+=Math.sin(t*0.8+l.p)*16*dt; l.rot+=l.vr*dt; if(l.y>H+16){l.y=-16; l.x=rnd(0,W)}
        ctx.save(); ctx.translate(l.x,l.y); ctx.rotate(l.rot); ctx.fillStyle='rgba(120,200,120,0.55)'; ctx.beginPath(); ctx.moveTo(-9,0); ctx.quadraticCurveTo(0,-4,9,0); ctx.quadraticCurveTo(0,4,-9,0); ctx.fill(); ctx.restore();}
    }
  };

  scenes.butterflies={
    init:function(){
      var s={flowers:[],fly:[],pollen:[]}, i, cols=['255,214,102','255,140,170','150,220,255','255,170,90','200,160,255'];
      for(i=0;i<(full?16:9);i++) s.flowers.push({x:rnd(0,W), h:rnd(H*0.16,H*0.34), c:pick(cols), p:rnd(0,6.28), r:rnd(3,5.5)});
      var bc=[['255,160,60','255,230,150'],['120,200,255','230,250,255'],['255,120,170','255,220,230']];
      for(i=0;i<(full?5:3);i++) s.fly.push({x:rnd(0,W), y:rnd(H*0.2,H*0.7), sp:rnd(0.3,0.6), ph:rnd(0,6.28), amp:rnd(30,70), c:bc[i%3], z:rnd(0.8,1.3)});
      for(i=0;i<(full?24:10);i++) s.pollen.push({x:rnd(0,W), y:rnd(0,H), r:rnd(0.6,1.6), v:rnd(3,10), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i;
      ctx.globalCompositeOperation='lighter'; glow(W*0.7,H*0.1,H*0.9,'255,246,190',0.2);
      for(i=0;i<s.pollen.length;i++){var p=s.pollen[i]; p.y-=p.v*dt; p.x+=Math.sin(t*0.8+p.p)*7*dt; if(p.y<-4){p.y=H+4; p.x=rnd(0,W)}
        ctx.fillStyle='rgba(255,246,190,'+(0.25+0.3*Math.sin(t*2+p.p))+')'; dot(p.x,p.y,p.r);}
      ctx.globalCompositeOperation='source-over';
      ctx.strokeStyle='rgba(20,80,44,0.9)'; ctx.lineWidth=1.8; ctx.lineCap='round';
      for(i=0;i<s.flowers.length;i++){var f=s.flowers[i], sw=Math.sin(t*0.9+f.p)*5, top=H-f.h, tx=f.x+sw;
        ctx.strokeStyle='rgba(20,86,48,0.92)'; ctx.beginPath(); ctx.moveTo(f.x,H+2); ctx.quadraticCurveTo(f.x+sw*0.2,H-f.h*0.5,tx,top); ctx.stroke();
        ctx.fillStyle='rgba('+f.c+',0.92)'; for(var k=0;k<5;k++){var a=k*1.2566; dot(tx+Math.cos(a)*f.r,top+Math.sin(a)*f.r,f.r*0.85);}
        ctx.fillStyle='rgba(255,240,170,0.95)'; dot(tx,top,f.r*0.55);}
      for(i=0;i<s.fly.length;i++){var b=s.fly[i], x=b.x+Math.sin(t*b.sp+b.ph)*b.amp+Math.sin(t*b.sp*0.43+b.ph)*b.amp*0.8, y=b.y+Math.sin(t*b.sp*1.3+b.ph*2)*b.amp*0.45,
            fl=Math.abs(Math.sin(t*9+b.ph)), w=11*b.z*(0.25+0.75*fl), h=9*b.z;
        ctx.save(); ctx.translate(x,y); ctx.rotate(Math.sin(t*b.sp*1.3+b.ph)*0.3);
        ctx.fillStyle='rgba('+b.c[0]+',0.9)'; ctx.beginPath(); ctx.ellipse(-w*0.55,-h*0.3,w*0.6,h*0.6,-0.4,0,TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(w*0.55,-h*0.3,w*0.6,h*0.6,0.4,0,TAU); ctx.fill();
        ctx.fillStyle='rgba('+b.c[1]+',0.85)'; ctx.beginPath(); ctx.ellipse(-w*0.4,h*0.35,w*0.4,h*0.4,0.4,0,TAU); ctx.fill(); ctx.beginPath(); ctx.ellipse(w*0.4,h*0.35,w*0.4,h*0.4,-0.4,0,TAU); ctx.fill();
        ctx.fillStyle='rgba(30,20,20,0.9)'; ctx.fillRect(-0.8,-h*0.5,1.6,h*1.1);
        ctx.restore();}
    }
  };

  scenes.grid={
    init:function(){return {cs:full?26:32, src:[{x:W*0.25,y:H*0.4,t0:0},{x:W*0.75,y:H*0.65,t0:2.2}], digits:{}}},
    draw:function(s,t,dt){
      var cs=s.cs, cols=Math.ceil(W/cs), rows=Math.ceil(H/cs), cx, cy, i, k;
      ctx.strokeStyle='rgba('+rgb+',0.14)'; ctx.lineWidth=1; ctx.beginPath();
      for(cx=0;cx<=cols;cx++){ctx.moveTo(cx*cs+0.5,0); ctx.lineTo(cx*cs+0.5,H);}
      for(cy=0;cy<=rows;cy++){ctx.moveTo(0,cy*cs+0.5); ctx.lineTo(W,cy*cs+0.5);}
      ctx.stroke();
      ctx.font='11px Consolas, Menlo, monospace'; ctx.textAlign='center';
      for(cx=0;cx<cols;cx++) for(cy=0;cy<rows;cy++){
        var px=cx*cs+cs/2, py=cy*cs+cs/2, lit=0;
        for(i=0;i<s.src.length;i++){var o=s.src[i], d=Math.sqrt((px-o.x)*(px-o.x)+(py-o.y)*(py-o.y)), ph=((t+o.t0)%4.4)*110;
          var e=1-Math.abs(d-ph)/42; if(e>lit) lit=e;}
        if(lit>0.02){ctx.fillStyle='rgba('+lt+','+(lit*0.34)+')'; ctx.fillRect(cx*cs+1,cy*cs+1,cs-1,cs-1);
          if(lit>0.35){k=cx+'_'+cy; if(!s.digits[k]||Math.random()<0.02) s.digits[k]=String(Math.floor(Math.random()*10)); ctx.fillStyle='rgba(235,255,240,'+(lit*0.85)+')'; ctx.fillText(s.digits[k],px,py+4);}}
      }
      ctx.textAlign='start';
      ctx.globalCompositeOperation='lighter'; glow(W*0.5,H*1.0,H*0.9,rgb,0.12); ctx.globalCompositeOperation='source-over';
    }
  };

  /* ===== PowerPoint / PDF ===== */
  scenes.sunrise={
    init:function(){
      var s={clouds:[],balloons:[],birds:[]}, i;
      for(i=0;i<(full?5:3);i++) s.clouds.push({x:rnd(0,W), y:rnd(H*0.12,H*0.62), s:rnd(0.7,1.4), v:rnd(3,9)});
      var cols=[['255,209,102','255,122,89'],['255,236,214','255,159,110'],['255,122,89','200,70,90']];
      for(i=0;i<(full?3:2);i++) s.balloons.push({x:rnd(W*0.12,W*0.88), y:rnd(H*0.4,H*1.1), s:rnd(0.7,1.1), v:rnd(7,14), p:rnd(0,6.28), c:cols[i%3]});
      for(i=0;i<(full?5:2);i++) s.birds.push({x:rnd(0,W), y:rnd(H*0.15,H*0.5), v:rnd(14,26), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i, j;
      ctx.globalCompositeOperation='lighter'; glow(W*0.74,H*1.02,H*1.15,'255,186,110',0.5+0.06*Math.sin(t*0.8)); glow(W*0.74,H*1.02,H*0.5,'255,230,170',0.35); ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.clouds.length;i++){var c=s.clouds[i]; c.x+=c.v*dt; if(c.x>W+90) c.x=-90;
        ctx.fillStyle='rgba(255,226,208,0.22)';
        var parts=[[0,2,15],[17,-5,19],[37,0,14],[21,7,16],[8,8,12],[32,8,12]];
        ctx.beginPath();
        for(j=0;j<parts.length;j++){ctx.moveTo(c.x+(parts[j][0]+parts[j][2])*c.s,c.y+parts[j][1]*c.s); ctx.arc(c.x+parts[j][0]*c.s,c.y+parts[j][1]*c.s,parts[j][2]*c.s,0,TAU);}
        ctx.fill();}
      for(i=0;i<s.balloons.length;i++){var b=s.balloons[i]; b.y-=b.v*dt; if(b.y<-90){b.y=H+80; b.x=rnd(W*0.12,W*0.88)}
        var x=b.x+Math.sin(t*0.6+b.p)*10, y=b.y, r=19*b.s;
        var g=ctx.createLinearGradient(x-r,0,x+r,0); g.addColorStop(0,'rgba('+b.c[1]+',0.95)'); g.addColorStop(0.5,'rgba('+b.c[0]+',0.95)'); g.addColorStop(1,'rgba('+b.c[1]+',0.95)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,r,Math.PI,0); ctx.quadraticCurveTo(x+r*0.7,y+r*1.1,x+r*0.28,y+r*1.5); ctx.lineTo(x-r*0.28,y+r*1.5); ctx.quadraticCurveTo(x-r*0.7,y+r*1.1,x-r,y); ctx.fill();
        ctx.strokeStyle='rgba(255,255,255,0.35)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x,y-r); ctx.quadraticCurveTo(x+r*0.45,y,x+r*0.2,y+r*1.45); ctx.moveTo(x,y-r); ctx.quadraticCurveTo(x-r*0.45,y,x-r*0.2,y+r*1.45); ctx.stroke();
        ctx.strokeStyle='rgba(60,30,30,0.7)'; ctx.beginPath(); ctx.moveTo(x-r*0.22,y+r*1.5); ctx.lineTo(x-4*b.s,y+r*1.95); ctx.moveTo(x+r*0.22,y+r*1.5); ctx.lineTo(x+4*b.s,y+r*1.95); ctx.stroke();
        ctx.fillStyle='rgba(70,36,32,0.9)'; ctx.fillRect(x-5*b.s,y+r*1.95,10*b.s,6*b.s);}
      for(i=0;i<s.birds.length;i++){var d=s.birds[i]; d.x+=d.v*dt; if(d.x>W+20){d.x=-20; d.y=rnd(H*0.15,H*0.5)} bird(d.x,d.y+Math.sin(t*0.9+d.p)*4,Math.sin(t*6+d.p)*3.2,'rgba(40,18,30,0.75)',1);}
    }
  };

  scenes.leaves={
    init:function(){
      var s={leaves:[],dust:[]}, i, cols=['229,72,59','242,124,56','248,170,64','186,52,48','214,98,50'];
      for(i=0;i<(full?24:11);i++) s.leaves.push({x:rnd(0,W), y:rnd(-20,H), s:rnd(0.7,1.5), vy:rnd(14,32), p:rnd(0,6.28), rot:rnd(0,6.28), vr:rnd(-1.4,1.4), c:pick(cols)});
      s.leaves.sort(function(a,b){return a.s-b.s});
      for(i=0;i<(full?20:8);i++) s.dust.push({x:rnd(0,W), y:rnd(0,H), r:rnd(0.6,1.5), p:rnd(0,6.28)});
      return s;
    },
    leaf:function(r){
      ctx.beginPath(); ctx.moveTo(0,-r*1.15);
      ctx.bezierCurveTo(r*1.05,-r*0.55,r*0.95,r*0.55,0,r*0.95);
      ctx.bezierCurveTo(-r*0.95,r*0.55,-r*1.05,-r*0.55,0,-r*1.15);
      ctx.closePath(); ctx.fill();
    },
    draw:function(s,t,dt){
      var i;
      ctx.globalCompositeOperation='lighter'; glow(W*0.2,H*0.05,H*0.9,'255,180,110',0.16+0.04*Math.sin(t*0.5));
      for(i=0;i<s.dust.length;i++){var u=s.dust[i]; u.y-=3*dt; if(u.y<-4) u.y=H+4; ctx.fillStyle='rgba(255,210,160,'+(0.15+0.12*Math.sin(t*1.5+u.p))+')'; dot(u.x+Math.sin(t*0.5+u.p)*6,u.y,u.r);}
      ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.leaves.length;i++){var l=s.leaves[i];
        l.y+=l.vy*dt; l.x+=Math.sin(t*0.9+l.p)*22*dt; l.rot+=l.vr*dt; if(l.y>H+24){l.y=-24; l.x=rnd(0,W)}
        ctx.save(); ctx.translate(l.x,l.y); ctx.rotate(l.rot); ctx.scale(1,0.55+0.45*Math.abs(Math.sin(t*1.2+l.p)));
        ctx.fillStyle='rgba('+l.c+','+(0.45+0.35*(l.s/1.5))+')'; this.leaf(11*l.s);
        ctx.strokeStyle='rgba(90,24,20,0.55)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(0,-12*l.s); ctx.lineTo(0,12*l.s);
        ctx.moveTo(0,-3*l.s); ctx.lineTo(5*l.s,-8*l.s); ctx.moveTo(0,-3*l.s); ctx.lineTo(-5*l.s,-8*l.s);
        ctx.moveTo(0,3*l.s); ctx.lineTo(5*l.s,-1*l.s); ctx.moveTo(0,3*l.s); ctx.lineTo(-5*l.s,-1*l.s); ctx.stroke();
        ctx.restore();}
    }
  };

  /* ===== Markdown candidates ===== */
  scenes.snow={
    init:function(){
      var s={flakes:[],stars:[]}, i;
      for(i=0;i<(full?90:40);i++){var z=rnd(0.3,1); s.flakes.push({x:rnd(0,W), y:rnd(0,H), r:0.6+z*2, vy:8+z*26, p:rnd(0,6.28), z:z});}
      for(i=0;i<(full?40:16);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H*0.5), r:rnd(0.4,1.1), p:rnd(0,6.28)});
      return s;
    },
    pine:function(x,base,h,col){
      ctx.fillStyle=col; ctx.beginPath(); ctx.moveTo(x,base-h);
      for(var k=1;k<=4;k++){var yy=base-h+k*(h/4.4), ww=k*h*0.11; ctx.lineTo(x+ww,yy); ctx.lineTo(x+ww*0.55,yy); }
      ctx.lineTo(x+h*0.05,base); ctx.lineTo(x-h*0.05,base);
      for(var j=4;j>=1;j--){var y2=base-h+j*(h/4.4), w2=j*h*0.11; ctx.lineTo(x-w2*0.55,y2); ctx.lineTo(x-w2,y2);}
      ctx.closePath(); ctx.fill();
    },
    draw:function(s,t,dt){
      var i;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(235,242,255,'+(0.2+0.4*(0.5+0.5*Math.sin(t*1.3+st.p)))+')'; dot(st.x,st.y,st.r);}
      glow(W*0.8,H*0.2,H*0.7,'170,200,255',0.14); ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(8,16,34,0.92)'; ctx.beginPath(); ctx.moveTo(0,H); ctx.lineTo(0,H*0.84); for(var x=0;x<=W;x+=14) ctx.lineTo(x,H*0.84+Math.sin(x*0.02)*5-Math.sin(x*0.007)*8); ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
      this.pine(W*0.1,H*0.9,H*0.42,'rgba(10,26,40,0.95)'); this.pine(W*0.2,H*0.92,H*0.3,'rgba(10,26,40,0.95)'); this.pine(W*0.9,H*0.9,H*0.46,'rgba(10,26,40,0.95)'); this.pine(W*0.82,H*0.92,H*0.28,'rgba(10,26,40,0.95)');
      var cx=W*0.62, cy=H*0.84; ctx.fillStyle='rgba(30,22,26,0.96)'; ctx.fillRect(cx-16,cy-14,32,16); ctx.beginPath(); ctx.moveTo(cx-20,cy-14); ctx.lineTo(cx,cy-28); ctx.lineTo(cx+20,cy-14); ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation='lighter'; var fl=0.75+0.25*Math.sin(t*3.3)*Math.sin(t*1.7); ctx.fillStyle='rgba(255,196,96,'+(0.85*fl)+')'; ctx.fillRect(cx-5,cy-10,8,7); glow(cx-1,cy-6,26,'255,170,70',0.34*fl);
      for(i=0;i<s.flakes.length;i++){var f=s.flakes[i]; f.y+=f.vy*dt; f.x+=Math.sin(t*0.8+f.p)*10*dt*f.z; if(f.y>H+4){f.y=-4; f.x=rnd(0,W)}
        ctx.fillStyle='rgba(240,247,255,'+(0.35+0.5*f.z)+')'; dot(f.x,f.y,f.r);}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.ink={
    init:function(){return {blobs:[],next:0}},
    draw:function(s,t,dt){
      var i, j;
      s.next-=dt;
      if(s.next<=0){var cols=[rgb,lt,'120,90,220','60,200,200']; s.blobs.push({x:rnd(W*0.1,W*0.9), y:rnd(H*0.15,H*0.85), r:6, life:1, c:pick(cols), ph:rnd(0,6.28), n:full?7:4}); s.next=rnd(0.9,1.8);}
      ctx.globalCompositeOperation='lighter';
      glow(W*0.5,H*0.5,H*1.0,rgb,0.08);
      for(i=s.blobs.length-1;i>=0;i--){var b=s.blobs[i]; b.r+=(34-b.r*0.12)*dt*1.15; b.life-=0.2*dt; b.x+=Math.sin(t*0.3+b.ph)*3*dt; b.y-=2*dt; if(b.life<=0){s.blobs.splice(i,1); continue}
        for(j=0;j<b.n;j++){var a=j*TAU/b.n+b.ph+t*0.12, rr=b.r*(0.55+0.45*Math.sin(t*0.9+j*1.7+b.ph)), ox=Math.cos(a)*b.r*0.5, oy=Math.sin(a)*b.r*0.4;
          glow(b.x+ox,b.y+oy,rr+10,b.c,0.20*b.life);}
      }
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.sakura={
    init:function(){
      var s={petals:[]}, i;
      for(i=0;i<(full?34:15);i++) s.petals.push({x:rnd(0,W), y:rnd(-20,H), s:rnd(0.6,1.3), vy:rnd(14,30), p:rnd(0,6.28), rot:rnd(0,6.28), vr:rnd(-2,2), c:pick(['255,183,205','255,205,222','255,160,190'])});
      return s;
    },
    bloom:function(x,y,r){
      for(var k=0;k<5;k++){ctx.save(); ctx.translate(x,y); ctx.rotate(k*1.2566); ctx.fillStyle='rgba(255,196,214,0.92)'; ctx.beginPath(); ctx.ellipse(0,-r*0.9,r*0.62,r,0,0,TAU); ctx.fill(); ctx.restore();}
      ctx.fillStyle='rgba(255,236,160,0.95)'; dot(x,y,r*0.32);
    },
    draw:function(s,t,dt){
      var i, sway=Math.sin(t*0.5)*3;
      ctx.globalCompositeOperation='lighter'; glow(W*0.2,H*0.15,H*0.9,'255,170,200',0.14); ctx.globalCompositeOperation='source-over';
      ctx.strokeStyle='rgba(40,22,30,0.95)'; ctx.lineCap='round'; ctx.lineWidth=7; ctx.beginPath(); ctx.moveTo(-8,H*0.28+sway); ctx.quadraticCurveTo(W*0.18,H*0.12+sway,W*0.34,H*0.2+sway); ctx.stroke();
      ctx.lineWidth=4; ctx.beginPath(); ctx.moveTo(W*0.18,H*0.15+sway); ctx.quadraticCurveTo(W*0.24,H*0.34+sway,W*0.3,H*0.4+sway); ctx.stroke();
      var spots=[[0.06,0.26],[0.12,0.17],[0.2,0.14],[0.27,0.17],[0.33,0.2],[0.23,0.3],[0.29,0.39],[0.16,0.21]];
      for(i=0;i<spots.length;i++) this.bloom(W*spots[i][0],H*spots[i][1]+sway,7+(i%3)*1.5);
      for(i=0;i<s.petals.length;i++){var p=s.petals[i]; p.y+=p.vy*dt; p.x+=(Math.sin(t*0.9+p.p)*18+14)*dt; p.rot+=p.vr*dt; if(p.y>H+14||p.x>W+14){p.y=-14; p.x=rnd(-20,W*0.8)}
        ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.scale(1,0.4+0.6*Math.abs(Math.sin(t*1.5+p.p)));
        ctx.fillStyle='rgba('+p.c+',0.88)'; ctx.beginPath(); ctx.ellipse(0,0,5*p.s,3.4*p.s,0,0,TAU); ctx.fill(); ctx.restore();}
    }
  };

  /* ===== HTML candidates ===== */
  scenes.galaxy={
    init:function(){
      var s={dots:[],stars:[]}, i, n=full?620:260, arms=3;
      for(i=0;i<n;i++){var r=Math.pow(Math.random(),0.6)*Math.min(W,H*2)*0.46, arm=Math.floor(Math.random()*arms), a=arm*TAU/arms+r*0.022+rnd(-0.32,0.32)*(0.3+r/200);
        s.dots.push({r:r, a:a, z:rnd(0.5,1.6), hue:Math.random()});}
      for(i=0;i<(full?50:20);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H), r:rnd(0.3,1), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i, cx=W*0.62, cy=H*0.46, tilt=0.42, rot=t*0.06;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(225,230,255,'+(0.2+0.3*(0.5+0.5*Math.sin(t*1.3+st.p)))+')'; dot(st.x,st.y,st.r);}
      glow(cx,cy,H*0.5,'150,120,255',0.22); glow(cx,cy,H*0.16,'255,236,200',0.55);
      for(i=0;i<s.dots.length;i++){var d=s.dots[i], a=d.a+rot*(1+80/(d.r+40)), x=cx+Math.cos(a)*d.r, y=cy+Math.sin(a)*d.r*tilt;
        var col=d.hue<0.5?'190,170,255':(d.hue<0.85?'150,190,255':'255,210,170');
        ctx.fillStyle='rgba('+col+','+(0.35+0.4*Math.min(1,60/(d.r+20)))+')'; dot(x,y,d.z*(full?1.1:1.4));}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.synthwave={
    init:function(){return {}},
    draw:function(s,t,dt){
      var hz=H*0.56, i, cx=W*0.5;
      var sg=ctx.createLinearGradient(0,hz-H*0.36,0,hz); sg.addColorStop(0,'rgba(255,214,102,0.95)'); sg.addColorStop(0.5,'rgba(255,100,170,0.95)'); sg.addColorStop(1,'rgba(180,60,255,0.95)');
      ctx.save(); ctx.beginPath(); ctx.arc(cx,hz,H*0.34,Math.PI,0); ctx.clip(); ctx.fillStyle=sg; ctx.fillRect(cx-H*0.4,hz-H*0.4,H*0.8,H*0.4);
      ctx.fillStyle='rgba(14,5,34,1)'; for(i=0;i<7;i++){var yy=hz-H*0.3+i*H*0.045, hh=1+i*0.7; ctx.fillRect(cx-H*0.4,yy,H*0.8,hh);} ctx.restore();
      ctx.globalCompositeOperation='lighter'; glow(cx,hz,H*0.8,'255,90,170',0.16); ctx.globalCompositeOperation='source-over';
      var fg=ctx.createLinearGradient(0,hz,0,H); fg.addColorStop(0,'rgba(24,6,52,1)'); fg.addColorStop(1,'rgba(10,3,26,1)'); ctx.fillStyle=fg; ctx.fillRect(0,hz,W,H-hz);
      ctx.lineWidth=1.2; ctx.strokeStyle='rgba(255,90,200,0.7)';
      for(i=-12;i<=12;i++){ctx.beginPath(); ctx.moveTo(cx+i*8,hz); ctx.lineTo(cx+i*(W*0.11),H); ctx.stroke();}
      var off=(t*0.55)%1;
      for(i=0;i<9;i++){var f=(i+off)/9, y=hz+Math.pow(f,2.2)*(H-hz); ctx.strokeStyle='rgba(120,220,255,'+(0.25+0.6*f)+')'; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();}
      ctx.strokeStyle='rgba(120,220,255,0.9)'; ctx.beginPath(); ctx.moveTo(0,hz); ctx.lineTo(W,hz); ctx.stroke();
    }
  };

  scenes.city={
    init:function(){
      var s={b:[],cars:[],stars:[]}, x=-6, i;
      while(x<W){var w=rnd(22,46), h=rnd(H*0.22,H*0.7), win=[]; for(i=0;i<Math.floor(w/7)*Math.floor(h/9);i++) win.push({on:Math.random()<0.4, p:rnd(0,6.28)}); s.b.push({x:x,w:w,h:h,win:win}); x+=w+rnd(2,6);}
      for(i=0;i<(full?8:4);i++) s.cars.push({x:rnd(0,W), v:rnd(30,70)*(Math.random()<0.5?-1:1), y:H-rnd(3,10), c:Math.random()<0.5?'255,90,90':'255,240,200'});
      for(i=0;i<(full?30:12);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H*0.4), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i, j, k;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(225,230,255,'+(0.2+0.3*(0.5+0.5*Math.sin(t*1.2+st.p)))+')'; dot(st.x,st.y,0.8);}
      glow(W*0.82,H*0.2,H*0.5,'200,220,255',0.18); ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(244,247,255,0.95)'; dot(W*0.82,H*0.2,H*0.045);
      for(i=0;i<s.b.length;i++){var b=s.b[i]; ctx.fillStyle='rgba(10,14,28,0.96)'; ctx.fillRect(b.x,H-b.h,b.w,b.h);
        var cols=Math.floor(b.w/7);
        for(j=0;j<b.win.length;j++){var wn=b.win[j]; if(!wn.on&&Math.random()<0.0008) wn.on=true; else if(wn.on&&Math.random()<0.0006) wn.on=false;
          if(wn.on){var cx=j%cols, cy=Math.floor(j/cols); ctx.fillStyle='rgba(255,'+(200+Math.floor(wn.p*8))+',120,0.85)'; ctx.fillRect(b.x+3+cx*7,H-b.h+6+cy*9,3.2,4.4);}}}
      ctx.globalCompositeOperation='lighter';
      for(k=0;k<s.cars.length;k++){var c=s.cars[k]; c.x+=c.v*dt; if(c.x>W+30) c.x=-30; else if(c.x<-30) c.x=W+30;
        var tg=ctx.createLinearGradient(c.x,0,c.x-(c.v>0?1:-1)*26,0); tg.addColorStop(0,'rgba('+c.c+',0.9)'); tg.addColorStop(1,'rgba('+c.c+',0)');
        ctx.strokeStyle=tg; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(c.x,c.y); ctx.lineTo(c.x-(c.v>0?1:-1)*26,c.y); ctx.stroke();}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.bubbles={
    init:function(){
      var s={b:[]}, i;
      for(i=0;i<(full?16:8);i++) s.b.push({x:rnd(0,W), y:rnd(0,H), r:rnd(10,34), vy:rnd(6,18), p:rnd(0,6.28), h:rnd(0,360)});
      s.b.sort(function(a,c){return a.r-c.r});
      return s;
    },
    draw:function(s,t,dt){
      var i;
      ctx.globalCompositeOperation='lighter'; glow(W*0.5,H*0.3,H*1.0,'120,160,255',0.10); ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.b.length;i++){var b=s.b[i]; b.y-=b.vy*dt; b.x+=Math.sin(t*0.6+b.p)*10*dt; if(b.y<-b.r*2){b.y=H+b.r*2; b.x=rnd(0,W)}
        var hue=(b.h+t*18)%360, x=b.x, y=b.y, r=b.r*(1+0.04*Math.sin(t*2+b.p));
        var g=ctx.createRadialGradient(x,y,r*0.55,x,y,r);
        g.addColorStop(0,'rgba(255,255,255,0)'); g.addColorStop(0.75,'hsla('+hue+',90%,75%,0.18)'); g.addColorStop(0.92,'hsla('+((hue+80)%360)+',90%,70%,0.4)'); g.addColorStop(1,'hsla('+((hue+160)%360)+',90%,80%,0.55)');
        ctx.fillStyle=g; dot(x,y,r);
        ctx.strokeStyle='rgba(255,255,255,0.35)'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(x,y,r,0,TAU); ctx.stroke();
        ctx.fillStyle='rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.ellipse(x-r*0.4,y-r*0.45,r*0.2,r*0.1,-0.7,0,TAU); ctx.fill();}
    }
  };

  var scene=scenes[sceneId]||scenes.ocean, state=scene.init();
  var last=0, start=performance.now(), running=true, stopped=false, raf=0;
  function onVis(){running=!document.hidden; if(running&&!stopped){cancelAnimationFrame(raf); raf=requestAnimationFrame(frame)}}
  document.addEventListener('visibilitychange',onVis);
  function frame(now){
    if(stopped||!running) return;
    if(now-last<step-1){raf=requestAnimationFrame(frame); return}
    var dt=Math.min(0.1,(now-(last||now))/1000); last=now; var t=(now-start)/1000;
    ctx.clearRect(0,0,W,H);
    scene.draw(state,t,dt);
    raf=requestAnimationFrame(frame);
  }
  raf=requestAnimationFrame(frame);
  return function(){stopped=true; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange',onVis)};
};
`

/** What the splash page runs: start the app's scene on its canvas (nothing on the minimal tier). */
export const SCENE_BOOT = `
(function(){
  var b=document.body, c=document.getElementById('sea');
  if(!c||b.dataset.tier==='minimal'||!window.GOScene) return;
  window.GOScene(c,b.dataset.scene,b.dataset.tier,b.dataset.rgb,b.dataset.lt);
})();
`
