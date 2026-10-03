import { DEFAULT_SCENE_FOR_APP, SCENES, sceneMeta } from '../../shared/opening-scenes-meta'

export { DEFAULT_SCENE_FOR_APP, SCENES, sceneMeta }
export type { SceneMeta } from '../../shared/opening-scenes-meta'

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
      var s={stars:[],shoot:null,next:3,pines:[]}, i;
      for(i=0;i<(full?90:36);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H*0.6), r:rnd(0.4,1.4), p:rnd(0,6.28), sp:rnd(0.8,2.4)});
      for(i=0;i<(full?26:14);i++) s.pines.push({x:rnd(-10,W+10), h:rnd(H*0.1,H*0.24)});
      return s;
    },
    curtains:function(t,hz,alpha){
      var x, p, cols=[[110,255,190],[90,200,255],[190,130,255]], step=full?3:5, g, yTop, yBot, inten, pass;
      for(pass=0;pass<3;pass++){
        p=cols[pass];
        g=ctx.createLinearGradient(0,hz*0.1,0,hz*0.78);
        g.addColorStop(0,'rgba('+p[0]+','+p[1]+','+p[2]+',0)'); g.addColorStop(0.55,'rgba('+p[0]+','+p[1]+','+p[2]+',0.5)'); g.addColorStop(1,'rgba('+p[0]+','+p[1]+','+p[2]+',0.85)');
        ctx.fillStyle=g;
        for(x=0;x<W;x+=step){
          yTop=hz*0.14+Math.sin(x*0.012+t*0.5+pass*1.4)*hz*0.07+Math.sin(x*0.031-t*0.7+pass)*hz*0.035+pass*hz*0.05;
          yBot=hz*0.66+Math.sin(x*0.009-t*0.35+pass*2)*hz*0.07;
          inten=0.5+0.5*Math.sin(x*0.02+t*0.6+pass*2.1); inten=inten*inten*(0.6+0.4*Math.sin(x*0.07-t*1.1+pass));
          ctx.globalAlpha=alpha*inten*(pass===0?0.9:0.55);
          ctx.fillRect(x,yTop,step+1,yBot-yTop);
        }
      }
      ctx.globalAlpha=1;
    },
    draw:function(s,t,dt){
      var i, x, hz=H*0.74;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(235,242,255,'+(0.3+0.5*(0.5+0.5*Math.sin(t*st.sp+st.p)))+')'; dot(st.x,st.y,st.r);}
      this.curtains(t,hz,1);
      glow(W*0.5,hz*0.55,H*0.9,'90,230,180',0.07);
      s.next-=dt;
      if(!s.shoot&&s.next<=0){s.shoot={x:rnd(W*0.3,W*0.95), y:rnd(0,H*0.3), vx:-rnd(220,320), vy:rnd(70,120), life:0.9}; s.next=rnd(2.5,5.5);}
      if(s.shoot){var m=s.shoot; m.x+=m.vx*dt; m.y+=m.vy*dt; m.life-=dt;
        var tg=ctx.createLinearGradient(m.x,m.y,m.x-m.vx*0.18,m.y-m.vy*0.18); tg.addColorStop(0,'rgba(255,255,255,0.9)'); tg.addColorStop(1,'rgba(255,255,255,0)');
        ctx.strokeStyle=tg; ctx.lineWidth=1.6; ctx.beginPath(); ctx.moveTo(m.x,m.y); ctx.lineTo(m.x-m.vx*0.18,m.y-m.vy*0.18); ctx.stroke();
        if(m.life<=0) s.shoot=null;}
      ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(6,12,26,0.98)'; ctx.fillRect(0,hz,W,H-hz);
      ctx.save(); ctx.beginPath(); ctx.rect(0,hz,W,H-hz); ctx.clip(); ctx.translate(0,2*hz); ctx.scale(1,-1); ctx.globalCompositeOperation='lighter'; this.curtains(t+0.7,hz,0.32); ctx.restore();
      ctx.globalCompositeOperation='source-over';
      var wg=ctx.createLinearGradient(0,hz,0,H); wg.addColorStop(0,'rgba(6,14,30,0.15)'); wg.addColorStop(1,'rgba(4,8,18,0.8)'); ctx.fillStyle=wg; ctx.fillRect(0,hz,W,H-hz);
      ctx.strokeStyle='rgba(160,220,240,0.12)'; ctx.lineWidth=1;
      for(i=0;i<5;i++){ctx.beginPath(); for(x=0;x<=W;x+=10){var yv=hz+8+i*((H-hz)/5.5)+Math.sin(x*0.04+t*(0.9+i*0.2)+i)*1.6; if(x===0) ctx.moveTo(x,yv); else ctx.lineTo(x,yv);} ctx.stroke();}
      ctx.fillStyle='rgba(4,8,18,1)'; ctx.beginPath(); ctx.moveTo(0,hz+2); for(x=0;x<=W;x+=10) ctx.lineTo(x,hz-Math.abs(Math.sin(x*0.008+2.2))*H*0.1-Math.sin(x*0.02)*5); ctx.lineTo(W,hz+2); ctx.closePath(); ctx.fill();
      for(i=0;i<s.pines.length;i++){var pn=s.pines[i]; ctx.beginPath(); ctx.moveTo(pn.x,hz-pn.h); ctx.lineTo(pn.x+pn.h*0.2,hz+1); ctx.lineTo(pn.x-pn.h*0.2,hz+1); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(pn.x,hz-pn.h*0.72); ctx.lineTo(pn.x+pn.h*0.28,hz-pn.h*0.2); ctx.lineTo(pn.x-pn.h*0.28,hz-pn.h*0.2); ctx.closePath(); ctx.fill();}
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
      var s={leaves:[],dust:[],pile:[]}, i, cols=['229,72,59','242,124,56','248,170,64','186,52,48','214,98,50','250,196,70'];
      for(i=0;i<(full?46:22);i++) s.leaves.push({x:rnd(0,W), y:rnd(-20,H), s:rnd(0.7,1.6), vy:rnd(14,34), p:rnd(0,6.28), rot:rnd(0,6.28), vr:rnd(-1.4,1.4), c:pick(cols), fan:Math.random()<0.25});
      s.leaves.sort(function(a,b){return a.s-b.s});
      for(i=0;i<(full?26:10);i++) s.dust.push({x:rnd(0,W), y:rnd(0,H), r:rnd(0.6,1.6), p:rnd(0,6.28)});
      for(i=0;i<(full?60:30);i++) s.pile.push({x:rnd(0,W), y:H-rnd(0,H*0.1), r:rnd(5,10), rot:rnd(0,6.28), c:pick(cols)});
      return s;
    },
    leaf:function(r){
      ctx.beginPath(); ctx.moveTo(0,-r*1.15);
      ctx.bezierCurveTo(r*1.05,-r*0.55,r*0.95,r*0.55,0,r*0.95);
      ctx.bezierCurveTo(-r*0.95,r*0.55,-r*1.05,-r*0.55,0,-r*1.15);
      ctx.closePath(); ctx.fill();
    },
    ginkgo:function(r){
      ctx.beginPath(); ctx.moveTo(0,r*0.9); ctx.lineTo(-r*1.05,-r*0.45); ctx.quadraticCurveTo(0,-r*1.25,r*1.05,-r*0.45); ctx.closePath(); ctx.fill();
    },
    branch:function(t,sx,flip){
      var i, x=flip?W-sx:sx;
      ctx.strokeStyle='rgba(36,16,14,0.97)'; ctx.lineCap='round'; ctx.lineWidth=11; ctx.beginPath(); ctx.moveTo(x,-10); ctx.quadraticCurveTo(x+(flip?-1:1)*W*0.1,H*0.12,x+(flip?-1:1)*W*0.2,H*0.2); ctx.stroke();
      ctx.lineWidth=5; ctx.beginPath(); ctx.moveTo(x+(flip?-1:1)*W*0.09,H*0.1); ctx.quadraticCurveTo(x+(flip?-1:1)*W*0.14,H*0.24,x+(flip?-1:1)*W*0.12,H*0.34); ctx.stroke();
      var pts=[[0.04,0.06],[0.09,0.1],[0.14,0.14],[0.19,0.19],[0.11,0.2],[0.12,0.33],[0.16,0.1],[0.07,0.2]];
      for(i=0;i<pts.length;i++){var px=x+(flip?-1:1)*W*pts[i][0], py=H*pts[i][1], sw=Math.sin(t*0.8+i)*0.18;
        ctx.save(); ctx.translate(px,py); ctx.rotate((flip?-1:1)*(1.9+i*0.35)+sw); ctx.fillStyle='rgba('+(i%3===0?'250,170,64':i%3===1?'229,72,59':'214,98,50')+',0.92)'; this.leaf(10+(i%3)*2); ctx.restore();}
    },
    draw:function(s,t,dt){
      var i;
      ctx.globalCompositeOperation='lighter'; glow(W*0.2,H*0.05,H*0.95,'255,180,110',0.18+0.04*Math.sin(t*0.5));
      for(i=0;i<3;i++){var x0=W*(0.1+0.3*i)+Math.sin(t*0.3+i)*16, rg=ctx.createLinearGradient(0,0,0,H); rg.addColorStop(0,'rgba(255,200,140,0.12)'); rg.addColorStop(1,'rgba(255,200,140,0)'); ctx.fillStyle=rg;
        ctx.beginPath(); ctx.moveTo(x0,0); ctx.lineTo(x0+30,0); ctx.lineTo(x0+130,H); ctx.lineTo(x0+30,H); ctx.closePath(); ctx.fill();}
      for(i=0;i<s.dust.length;i++){var u=s.dust[i]; u.y-=3*dt; if(u.y<-4) u.y=H+4; ctx.fillStyle='rgba(255,210,160,'+(0.15+0.12*Math.sin(t*1.5+u.p))+')'; dot(u.x+Math.sin(t*0.5+u.p)*6,u.y,u.r);}
      ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.pile.length;i++){var q=s.pile[i]; ctx.save(); ctx.translate(q.x,q.y); ctx.rotate(q.rot); ctx.scale(1,0.5); ctx.fillStyle='rgba('+q.c+',0.8)'; this.leaf(q.r); ctx.restore();}
      this.branch(t,-6,false); this.branch(t,-6,true);
      for(i=0;i<s.leaves.length;i++){var l=s.leaves[i];
        l.y+=l.vy*dt; l.x+=Math.sin(t*0.9+l.p)*22*dt; l.rot+=l.vr*dt; if(l.y>H+24){l.y=-24; l.x=rnd(0,W)}
        ctx.save(); ctx.translate(l.x,l.y); ctx.rotate(l.rot); ctx.scale(1,0.55+0.45*Math.abs(Math.sin(t*1.2+l.p)));
        ctx.fillStyle='rgba('+l.c+','+(0.45+0.35*(l.s/1.6))+')'; if(l.fan) this.ginkgo(10*l.s); else this.leaf(11*l.s);
        ctx.strokeStyle='rgba(90,24,20,0.55)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(0,-12*l.s); ctx.lineTo(0,12*l.s);
        ctx.moveTo(0,-3*l.s); ctx.lineTo(5*l.s,-8*l.s); ctx.moveTo(0,-3*l.s); ctx.lineTo(-5*l.s,-8*l.s); ctx.moveTo(0,3*l.s); ctx.lineTo(5*l.s,-1*l.s); ctx.moveTo(0,3*l.s); ctx.lineTo(-5*l.s,-1*l.s); ctx.stroke();
        ctx.restore();}
    }
  };
  /* ===== Markdown candidates ===== */
  scenes.snow={
    init:function(){
      var s={flakes:[],stars:[],smoke:[],next:0}, i;
      for(i=0;i<(full?90:40);i++){var z=rnd(0.3,1); s.flakes.push({x:rnd(0,W), y:rnd(0,H), r:0.6+z*2, vy:8+z*26, p:rnd(0,6.28), z:z});}
      for(i=0;i<(full?40:16);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H*0.5), r:rnd(0.4,1.1), p:rnd(0,6.28)});
      return s;
    },
    pine:function(x,base,h,col,snow){
      var k, y;
      ctx.fillStyle=col; ctx.beginPath(); ctx.moveTo(x,base-h);
      for(k=1;k<=4;k++){y=base-h+k*(h/4.4); ctx.lineTo(x+k*h*0.11,y); ctx.lineTo(x+k*h*0.11*0.55,y);}
      ctx.lineTo(x+h*0.05,base); ctx.lineTo(x-h*0.05,base);
      for(k=4;k>=1;k--){y=base-h+k*(h/4.4); ctx.lineTo(x-k*h*0.11*0.55,y); ctx.lineTo(x-k*h*0.11,y);}
      ctx.closePath(); ctx.fill();
      if(snow){ctx.fillStyle='rgba(225,236,250,0.85)'; for(k=1;k<=4;k++){y=base-h+k*(h/4.4); ctx.beginPath(); ctx.moveTo(x-k*h*0.11,y); ctx.quadraticCurveTo(x,y-h*0.06,x+k*h*0.11,y); ctx.quadraticCurveTo(x,y-h*0.025,x-k*h*0.11,y); ctx.fill();}}
    },
    cabin:function(cx,gy,u,t){
      var bw=3.2*u, bh=1.7*u, x0=cx-bw/2, y0=gy-bh, i, fl=0.75+0.25*Math.sin(t*3.3)*Math.sin(t*1.7);
      ctx.globalCompositeOperation='lighter'; var sg=ctx.createRadialGradient(cx,gy,2,cx,gy,bw*1.1); sg.addColorStop(0,'rgba(255,190,100,'+(0.26*fl)+')'); sg.addColorStop(1,'rgba(255,190,100,0)'); ctx.fillStyle=sg; ctx.beginPath(); ctx.ellipse(cx,gy+u*0.1,bw*1.1,u*0.45,0,0,TAU); ctx.fill(); ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(58,36,28,0.98)'; ctx.fillRect(x0,y0,bw,bh);
      ctx.strokeStyle='rgba(30,18,14,0.9)'; ctx.lineWidth=1; ctx.beginPath(); for(i=1;i<8;i++){ctx.moveTo(x0,y0+i*bh/8); ctx.lineTo(x0+bw,y0+i*bh/8);} ctx.stroke();
      ctx.fillStyle='rgba(84,54,40,0.9)'; for(i=0;i<8;i++){ctx.beginPath(); ctx.arc(x0,y0+i*bh/8+bh/16,bh/18,0,TAU); ctx.fill(); ctx.beginPath(); ctx.arc(x0+bw,y0+i*bh/8+bh/16,bh/18,0,TAU); ctx.fill();}
      ctx.fillStyle='rgba(40,26,22,1)'; ctx.beginPath(); ctx.moveTo(x0-0.35*u,y0+0.02*u); ctx.lineTo(cx,y0-1.15*u); ctx.lineTo(x0+bw+0.35*u,y0+0.02*u); ctx.closePath(); ctx.fill();
      ctx.fillStyle='rgba(236,244,255,0.95)'; ctx.beginPath(); ctx.moveTo(x0-0.42*u,y0+0.08*u); ctx.lineTo(cx,y0-1.22*u); ctx.lineTo(x0+bw+0.42*u,y0+0.08*u); ctx.lineTo(x0+bw+0.3*u,y0-0.06*u); ctx.quadraticCurveTo(cx+bw*0.3,y0-0.55*u,cx,y0-1.02*u); ctx.quadraticCurveTo(cx-bw*0.3,y0-0.55*u,x0-0.3*u,y0-0.06*u); ctx.closePath(); ctx.fill();
      ctx.fillStyle='rgba(70,44,36,1)'; ctx.fillRect(cx+bw*0.22,y0-1.05*u,0.34*u,0.8*u); ctx.fillStyle='rgba(236,244,255,0.95)'; ctx.fillRect(cx+bw*0.22-0.04*u,y0-1.1*u,0.42*u,0.12*u);
      var wins=[[x0+0.38*u,y0+0.4*u,0.62*u,0.58*u],[x0+bw-1.0*u,y0+0.4*u,0.62*u,0.58*u]], k2;
      for(k2=0;k2<2;k2++){var w=wins[k2]; ctx.globalCompositeOperation='lighter'; glow(w[0]+w[2]/2,w[1]+w[3]/2,u*1.1,'255,170,70',0.2*fl); ctx.globalCompositeOperation='source-over';
        ctx.fillStyle='rgba(255,'+Math.round(184+20*fl)+',92,'+(0.82+0.15*fl)+')'; ctx.fillRect(w[0],w[1],w[2],w[3]);
        ctx.strokeStyle='rgba(50,30,24,0.95)'; ctx.lineWidth=2; ctx.strokeRect(w[0],w[1],w[2],w[3]); ctx.beginPath(); ctx.moveTo(w[0]+w[2]/2,w[1]); ctx.lineTo(w[0]+w[2]/2,w[1]+w[3]); ctx.moveTo(w[0],w[1]+w[3]/2); ctx.lineTo(w[0]+w[2],w[1]+w[3]/2); ctx.stroke();
        ctx.fillStyle='rgba(236,244,255,0.9)'; ctx.fillRect(w[0]-0.06*u,w[1]+w[3],w[2]+0.12*u,0.07*u);}
      var dx=cx-0.22*u; ctx.fillStyle='rgba(34,20,16,1)'; ctx.fillRect(dx,gy-1.15*u,0.44*u,1.15*u); ctx.fillStyle='rgba(255,210,120,0.95)'; dot(dx+0.34*u,gy-0.55*u,0.03*u);
      ctx.fillStyle='rgba(60,38,30,1)'; ctx.fillRect(dx-0.2*u,gy-0.06*u,0.84*u,0.06*u);
      var lx=x0+bw+0.18*u, ly=y0+0.35*u; ctx.strokeStyle='rgba(30,18,14,0.9)'; ctx.lineWidth=1.2; ctx.beginPath(); ctx.moveTo(lx,ly-0.2*u); ctx.lineTo(lx,ly); ctx.stroke();
      ctx.globalCompositeOperation='lighter'; glow(lx,ly+0.08*u,u*0.7,'255,190,90',0.4*fl); ctx.globalCompositeOperation='source-over'; ctx.fillStyle='rgba(255,226,150,0.95)'; dot(lx,ly+0.08*u,0.07*u);
      ctx.fillStyle='rgba(54,34,26,0.95)'; for(i=0;i<5;i++){var fx=x0-1.3*u+i*0.3*u; if(i<4||true){ctx.fillRect(fx,gy-0.45*u,0.07*u,0.45*u);}} ctx.fillRect(x0-1.3*u,gy-0.36*u,1.3*u,0.05*u);
      ctx.fillStyle='rgba(236,244,255,0.9)'; for(i=0;i<5;i++) ctx.fillRect(x0-1.3*u+i*0.3*u-0.01*u,gy-0.5*u,0.09*u,0.05*u);
    },
    draw:function(s,t,dt){
      var i, u=H*0.105, cx=W*0.64, gy=H*0.86;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(235,242,255,'+(0.2+0.4*(0.5+0.5*Math.sin(t*1.3+st.p)))+')'; dot(st.x,st.y,st.r);}
      glow(W*0.82,H*0.2,H*0.7,'170,200,255',0.14); ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(240,246,255,0.95)'; dot(W*0.82,H*0.2,H*0.04); ctx.fillStyle='rgba(8,16,34,0.45)'; dot(W*0.82+H*0.012,H*0.2-H*0.006,H*0.034);
      ctx.fillStyle='rgba(20,34,62,0.95)'; ctx.beginPath(); ctx.moveTo(0,H*0.84); for(var x=0;x<=W;x+=12) ctx.lineTo(x,H*0.72-Math.abs(Math.sin(x*0.006+1.3))*H*0.1); ctx.lineTo(W,H*0.84); ctx.closePath(); ctx.fill();
      var gg=ctx.createLinearGradient(0,H*0.82,0,H); gg.addColorStop(0,'rgba(34,52,90,1)'); gg.addColorStop(1,'rgba(14,24,48,1)'); ctx.fillStyle=gg;
      ctx.beginPath(); ctx.moveTo(0,H); ctx.lineTo(0,H*0.86); for(var x2=0;x2<=W;x2+=14) ctx.lineTo(x2,H*0.86+Math.sin(x2*0.02)*4-Math.sin(x2*0.007)*7); ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
      this.pine(W*0.08,H*0.92,H*0.46,'rgba(8,22,38,0.97)',true); this.pine(W*0.17,H*0.94,H*0.3,'rgba(8,22,38,0.97)',true); this.pine(W*0.93,H*0.92,H*0.5,'rgba(8,22,38,0.97)',true); this.pine(W*0.85,H*0.94,H*0.3,'rgba(8,22,38,0.97)',true); this.pine(W*0.37,H*0.9,H*0.22,'rgba(14,30,52,0.95)',false);
      this.cabin(cx,gy,u,t);
      s.next-=dt; if(s.next<=0){s.smoke.push({x:cx+1.1*u*0.5+0.2*u,y:gy-1.9*u,r:3,life:1}); s.next=0.35;}
      for(i=s.smoke.length-1;i>=0;i--){var sm=s.smoke[i]; sm.y-=14*dt; sm.x+=(Math.sin(t*0.9+i)*6+7)*dt; sm.r+=5*dt; sm.life-=0.32*dt; if(sm.life<=0){s.smoke.splice(i,1); continue}
        ctx.fillStyle='rgba(200,214,236,'+(0.28*sm.life)+')'; dot(sm.x,sm.y,sm.r);}
      ctx.globalCompositeOperation='lighter';
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
      s.clouds=[]; for(i=0;i<(full?5:3);i++) s.clouds.push({x:rnd(0,W), y:rnd(H*0.1,H*0.46), w:rnd(60,130), v:rnd(3,8), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i, j, k;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(225,230,255,'+(0.2+0.3*(0.5+0.5*Math.sin(t*1.2+st.p)))+')'; dot(st.x,st.y,0.8);}
      glow(W*0.82,H*0.2,H*0.5,'200,220,255',0.18); ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(244,247,255,0.95)'; dot(W*0.82,H*0.2,H*0.045);
      for(i=0;i<s.clouds.length;i++){var cl=s.clouds[i]; cl.x+=cl.v*dt; if(cl.x>W+cl.w) cl.x=-cl.w;
        var lit=Math.max(0,1-Math.abs(cl.x-W*0.82)/(W*0.35)), cy=cl.y+Math.sin(t*0.3+cl.p)*3;
        ctx.fillStyle='rgba('+(70+Math.round(90*lit))+','+(84+Math.round(90*lit))+','+(120+Math.round(80*lit))+',0.4)'; ctx.beginPath();
        ctx.moveTo(cl.x+cl.w*0.5,cy); ctx.arc(cl.x,cy,cl.w*0.5,0,TAU); ctx.moveTo(cl.x+cl.w*0.7,cy-4); ctx.arc(cl.x+cl.w*0.3,cy-6,cl.w*0.38,0,TAU); ctx.moveTo(cl.x-cl.w*0.1,cy-2); ctx.arc(cl.x-cl.w*0.4,cy+2,cl.w*0.36,0,TAU); ctx.fill();}
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

  /* ===== more scenes ===== */
  scenes.rain={
    init:function(){
      var s={bokeh:[],drops:[],streaks:[]}, i, cols=['255,200,110','120,170,255','255,120,170','230,240,255','150,255,200'];
      for(i=0;i<(full?20:10);i++) s.bokeh.push({x:rnd(0,W), y:rnd(H*0.1,H*0.95), r:rnd(10,34), c:pick(cols), p:rnd(0,6.28), a:rnd(0.12,0.3)});
      for(i=0;i<(full?42:20);i++) s.drops.push({x:rnd(0,W), y:rnd(0,H), r:rnd(1.6,4.2), vy:0, wait:rnd(0,4), trail:[]});
      for(i=0;i<(full?40:18);i++) s.streaks.push({x:rnd(0,W), y:rnd(0,H), l:rnd(10,24), v:rnd(260,420)});
      return s;
    },
    draw:function(s,t,dt){
      var i, j;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.bokeh.length;i++){var b=s.bokeh[i]; glow(b.x,b.y,b.r,b.c,b.a*(0.7+0.3*Math.sin(t*0.9+b.p)));}
      ctx.globalCompositeOperation='source-over';
      ctx.strokeStyle='rgba(190,210,240,0.16)'; ctx.lineWidth=1; ctx.beginPath();
      for(i=0;i<s.streaks.length;i++){var r=s.streaks[i]; r.y+=r.v*dt; r.x-=r.v*0.12*dt; if(r.y>H){r.y=-r.l; r.x=rnd(0,W+40)} ctx.moveTo(r.x,r.y); ctx.lineTo(r.x-r.l*0.12,r.y+r.l);}
      ctx.stroke();
      for(i=0;i<s.drops.length;i++){var d=s.drops[i];
        d.wait-=dt; if(d.wait<=0){d.vy=rnd(30,90); d.wait=rnd(0.4,2.4)} d.vy*=Math.pow(0.4,dt*3);
        d.y+=d.vy*dt; d.trail.push(d.y); if(d.trail.length>14) d.trail.shift();
        if(d.y>H+8){d.y=-6; d.x=rnd(0,W); d.trail=[]}
        if(d.trail.length>1){var tg=ctx.createLinearGradient(0,d.trail[0],0,d.y); tg.addColorStop(0,'rgba(210,225,250,0)'); tg.addColorStop(1,'rgba(210,225,250,0.28)'); ctx.strokeStyle=tg; ctx.lineWidth=d.r*0.55; ctx.beginPath(); ctx.moveTo(d.x,d.trail[0]); ctx.lineTo(d.x,d.y); ctx.stroke();}
        ctx.fillStyle='rgba(215,230,255,0.28)'; ctx.beginPath(); ctx.ellipse(d.x,d.y,d.r*0.85,d.r*1.15,0,0,TAU); ctx.fill();
        ctx.fillStyle='rgba(255,255,255,0.7)'; dot(d.x-d.r*0.3,d.y-d.r*0.35,d.r*0.28);}
    }
  };

  scenes.campfire={
    init:function(){
      var s={flames:[],sparks:[],stars:[],acc:0}, i;
      for(i=0;i<(full?60:26);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H*0.6), r:rnd(0.4,1.2), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i, fx=W*0.5, fy=H*0.84, n;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(235,242,255,'+(0.25+0.4*(0.5+0.5*Math.sin(t*1.2+st.p)))+')'; dot(st.x,st.y,st.r);}
      ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(10,18,36,0.97)'; ctx.beginPath(); ctx.moveTo(0,H); ctx.lineTo(0,H*0.82); for(var x=0;x<=W;x+=12) ctx.lineTo(x,H*0.82+Math.sin(x*0.012)*6-Math.sin(x*0.004)*9); ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
      ctx.fillStyle='rgba(6,10,22,1)'; ctx.beginPath(); ctx.moveTo(W*0.14,H*0.86); ctx.lineTo(W*0.22,H*0.66); ctx.lineTo(W*0.3,H*0.86); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(W*0.72,H*0.88); ctx.lineTo(W*0.82,H*0.62); ctx.lineTo(W*0.92,H*0.88); ctx.closePath(); ctx.fill();
      ctx.fillStyle='rgba(255,190,110,0.5)'; ctx.beginPath(); ctx.moveTo(W*0.22,H*0.86); ctx.lineTo(W*0.2,H*0.77); ctx.lineTo(W*0.24,H*0.77); ctx.closePath(); ctx.fill();
      var fl=0.8+0.2*Math.sin(t*9)*Math.sin(t*5.3);
      ctx.globalCompositeOperation='lighter'; glow(fx,fy-20,H*0.7,'255,140,50',0.2*fl); glow(fx,fy+4,H*0.32,'255,170,80',0.28*fl); ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(60,34,22,1)'; ctx.save(); ctx.translate(fx,fy+4); ctx.rotate(0.35); ctx.fillRect(-26,-3,52,7); ctx.rotate(-0.7); ctx.fillRect(-26,-3,52,7); ctx.restore();
      s.acc+=dt*(full?90:44); n=Math.floor(s.acc); s.acc-=n;
      for(i=0;i<n;i++) s.flames.push({x:fx+rnd(-16,16), y:fy, vx:rnd(-10,10), vy:-rnd(50,100), life:1, r:rnd(9,17)});
      if(Math.random()<dt*14) s.sparks.push({x:fx+rnd(-10,10), y:fy-10, vx:rnd(-24,24), vy:-rnd(60,130), life:1});
      ctx.globalCompositeOperation='lighter';
      for(i=s.flames.length-1;i>=0;i--){var f=s.flames[i]; f.life-=dt*1.15; if(f.life<=0){s.flames.splice(i,1); continue}
        f.x+=(f.vx+Math.sin(t*6+i)*8)*dt; f.y+=f.vy*dt;
        var col=f.life>0.6?'255,230,140':(f.life>0.3?'255,150,50':'220,60,30'); glow(f.x,f.y,f.r*(0.5+f.life),col,0.5*f.life);}
      for(i=s.sparks.length-1;i>=0;i--){var sp=s.sparks[i]; sp.life-=dt*0.5; if(sp.life<=0){s.sparks.splice(i,1); continue}
        sp.x+=(sp.vx+Math.sin(t*3+i)*10)*dt; sp.y+=sp.vy*dt; ctx.fillStyle='rgba(255,200,110,'+sp.life+')'; dot(sp.x,sp.y,1.3);}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.fireworks={
    init:function(){return {rockets:[],bursts:[],next:0.3,stars:[]}},
    draw:function(s,t,dt){
      var i, j, hz=H*0.78;
      var cols=['255,120,120','255,210,100','120,220,255','190,140,255','140,255,170','255,160,220'];
      s.next-=dt;
      if(s.next<=0){s.rockets.push({x:rnd(W*0.15,W*0.85), y:hz, ty:rnd(H*0.15,H*0.45), c:pick(cols)}); s.next=rnd(0.7,1.5);}
      ctx.fillStyle='rgba(8,12,30,1)'; ctx.fillRect(0,hz,W,H-hz);
      ctx.fillStyle='rgba(6,9,22,1)'; ctx.beginPath(); ctx.moveTo(0,hz); for(var x=0;x<=W;x+=18) ctx.lineTo(x,hz-4-((x*7)%23)*0.6-Math.abs(Math.sin(x*0.05))*8); ctx.lineTo(W,hz); ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation='lighter';
      for(i=s.rockets.length-1;i>=0;i--){var r=s.rockets[i]; r.y-=(hz-r.ty)*1.5*dt; ctx.fillStyle='rgba(255,230,180,0.9)'; dot(r.x,r.y,1.6); glow(r.x,r.y+6,10,'255,210,140',0.4);
        if(r.y<=r.ty){var n=full?70:36, parts=[]; for(j=0;j<n;j++){var a=j*TAU/n+rnd(-0.05,0.05), sp=rnd(70,185)*(Math.random()<0.5?1:0.62); parts.push({a:a, sp:sp});}
          s.bursts.push({x:r.x, y:r.y, age:0, c:r.c, parts:parts}); s.rockets.splice(i,1);}}
      for(i=s.bursts.length-1;i>=0;i--){var b=s.bursts[i]; b.age+=dt; if(b.age>2.6){s.bursts.splice(i,1); continue}
        var fade=Math.max(0,1-b.age/2.6);
        glow(b.x,b.y,H*0.55*(1-b.age/2.6),b.c,0.2*fade);
        for(j=0;j<b.parts.length;j++){var q=b.parts[j], px=b.x+Math.cos(q.a)*q.sp*(1-Math.exp(-b.age*2.2)), py=b.y+Math.sin(q.a)*q.sp*(1-Math.exp(-b.age*2.2))+28*b.age*b.age;
          ctx.fillStyle='rgba('+b.c+','+(fade*0.95)+')'; dot(px,py,1.7+fade*1.3);
          ctx.fillStyle='rgba('+b.c+','+(fade*0.25)+')'; dot(px-Math.cos(q.a)*5,py-Math.sin(q.a)*5+2,1);
          ctx.fillStyle='rgba('+b.c+','+(fade*0.18)+')'; dot(px,H-(py-hz)*0.35-(H-hz)*0.2+ (hz-H*0.0),0.8);}}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.lanterns={
    init:function(){
      var s={l:[],stars:[]}, i, cols=[['255,120,60','255,200,120'],['255,90,70','255,180,110'],['255,170,60','255,230,150']];
      for(i=0;i<(full?16:8);i++){var z=rnd(0.4,1.3); s.l.push({x:rnd(0,W), y:rnd(0,H*1.2), z:z, v:8+z*12, p:rnd(0,6.28), c:pick(cols)});}
      s.l.sort(function(a,b){return a.z-b.z});
      for(i=0;i<(full?44:18);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H*0.7), r:rnd(0.4,1.1), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(230,238,255,'+(0.2+0.35*(0.5+0.5*Math.sin(t*1.2+st.p)))+')'; dot(st.x,st.y,st.r);}
      glow(W*0.5,H*1.1,H*1.0,'255,150,70',0.12);
      for(i=0;i<s.l.length;i++){var L=s.l[i]; L.y-=L.v*dt; if(L.y<-60){L.y=H+60; L.x=rnd(0,W)}
        var x=L.x+Math.sin(t*0.5+L.p)*10*L.z, y=L.y, w=15*L.z, h=20*L.z, fl=0.8+0.2*Math.sin(t*5+L.p);
        glow(x,y,w*3.2,L.c[0],0.22*fl);
        var g=ctx.createLinearGradient(x,y-h,x,y+h); g.addColorStop(0,'rgba('+L.c[1]+',0.95)'); g.addColorStop(1,'rgba('+L.c[0]+',0.9)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.moveTo(x-w*0.7,y-h); ctx.quadraticCurveTo(x-w*1.2,y,x-w*0.6,y+h); ctx.lineTo(x+w*0.6,y+h); ctx.quadraticCurveTo(x+w*1.2,y,x+w*0.7,y-h); ctx.closePath(); ctx.fill();
        ctx.strokeStyle='rgba(120,40,20,0.5)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x-w*0.7,y-h); ctx.lineTo(x+w*0.7,y-h); ctx.moveTo(x-w*0.6,y+h); ctx.lineTo(x+w*0.6,y+h); ctx.moveTo(x,y-h); ctx.lineTo(x,y+h); ctx.stroke();
        ctx.fillStyle='rgba(255,240,190,'+(0.85*fl)+')'; ctx.beginPath(); ctx.ellipse(x,y+h*0.45,w*0.28,h*0.3,0,0,TAU); ctx.fill();}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.desert={
    init:function(){
      var s={stars:[],sand:[],shoot:null,next:2}, i;
      for(i=0;i<(full?70:30);i++) s.stars.push({x:rnd(0,W), y:rnd(0,H*0.55), r:rnd(0.4,1.3), p:rnd(0,6.28)});
      for(i=0;i<(full?40:16);i++) s.sand.push({x:rnd(0,W), y:rnd(H*0.6,H), v:rnd(20,60), p:rnd(0,6.28)});
      return s;
    },
    dune:function(base,amp,seed,light,dark){
      var x, y, g=ctx.createLinearGradient(0,base-amp,0,H); g.addColorStop(0,light); g.addColorStop(1,dark); ctx.fillStyle=g; ctx.beginPath(); ctx.moveTo(0,H);
      for(x=0;x<=W+8;x+=8){y=base-Math.abs(Math.sin(x*0.007+seed))*amp-Math.sin(x*0.019+seed*1.7)*amp*0.2; ctx.lineTo(x,y);} ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
    },
    draw:function(s,t,dt){
      var i;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.stars.length;i++){var st=s.stars[i]; ctx.fillStyle='rgba(240,238,255,'+(0.25+0.45*(0.5+0.5*Math.sin(t*1.3+st.p)))+')'; dot(st.x,st.y,st.r);}
      glow(W*0.28,H*0.28,H*0.7,'255,230,200',0.2); glow(W*0.28,H*0.28,H*0.2,'255,244,226',0.5);
      s.next-=dt; if(!s.shoot&&s.next<=0){s.shoot={x:rnd(W*0.4,W),y:rnd(0,H*0.25),vx:-rnd(240,340),vy:rnd(60,100),life:0.8}; s.next=rnd(3,6);}
      if(s.shoot){var m=s.shoot; m.x+=m.vx*dt; m.y+=m.vy*dt; m.life-=dt; var tg=ctx.createLinearGradient(m.x,m.y,m.x-m.vx*0.18,m.y-m.vy*0.18); tg.addColorStop(0,'rgba(255,255,255,0.9)'); tg.addColorStop(1,'rgba(255,255,255,0)'); ctx.strokeStyle=tg; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(m.x,m.y); ctx.lineTo(m.x-m.vx*0.18,m.y-m.vy*0.18); ctx.stroke(); if(m.life<=0) s.shoot=null;}
      ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(250,246,240,0.96)'; dot(W*0.28,H*0.28,H*0.055);
      this.dune(H*0.66,H*0.16,1.0,'rgba(190,120,110,0.95)','rgba(110,60,80,0.95)');
      this.dune(H*0.8,H*0.15,3.4,'rgba(150,84,86,0.97)','rgba(70,36,60,0.98)');
      this.dune(H*0.97,H*0.14,6.2,'rgba(88,46,64,0.99)','rgba(34,18,40,1)');
      ctx.fillStyle='rgba(255,214,170,0.35)';
      for(i=0;i<s.sand.length;i++){var d=s.sand[i]; d.x+=d.v*dt; if(d.x>W+6){d.x=-6; d.y=rnd(H*0.6,H)} dot(d.x,d.y+Math.sin(t*2+d.p)*2,1);}
    }
  };

  scenes.matrix={
    init:function(){
      var s={cols:[]}, cs=full?16:20, n=Math.ceil(W/cs), i, chars='0123456789ABCDEF=+-*/<>{}#%';
      for(i=0;i<n;i++) s.cols.push({x:i*cs+cs/2, y:rnd(-H,H), v:rnd(40,130), len:Math.floor(rnd(8,18)), glyph:[]});
      s.cs=cs; s.chars=chars;
      for(i=0;i<n;i++) for(var j=0;j<20;j++) s.cols[i].glyph.push(chars.charAt(Math.floor(Math.random()*chars.length)));
      return s;
    },
    draw:function(s,t,dt){
      var i, j, cs=s.cs;
      ctx.font=(cs-3)+'px Consolas, Menlo, monospace'; ctx.textAlign='center';
      for(i=0;i<s.cols.length;i++){var c=s.cols[i]; c.y+=c.v*dt; if(c.y-c.len*cs>H){c.y=-rnd(0,H*0.5); c.v=rnd(40,130)}
        if(Math.random()<dt*4) c.glyph[Math.floor(Math.random()*c.glyph.length)]=s.chars.charAt(Math.floor(Math.random()*s.chars.length));
        for(j=0;j<c.len;j++){var y=c.y-j*cs; if(y<-cs||y>H+cs) continue; var a=(1-j/c.len);
          ctx.fillStyle=j===0?'rgba(235,255,240,0.95)':'rgba('+lt+','+(a*0.75)+')'; ctx.fillText(c.glyph[(j+i)%20],c.x,y);}}
      ctx.textAlign='start';
      ctx.globalCompositeOperation='lighter'; glow(W*0.5,H*1.05,H*0.9,rgb,0.1); ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.waves={
    init:function(){return {}},
    draw:function(s,t,dt){
      var i, x, n=full?7:5;
      ctx.globalCompositeOperation='lighter'; ctx.lineWidth=2; ctx.lineCap='round';
      for(i=0;i<n;i++){
        var hue=(200+i*28+t*14)%360, base=H*(0.28+0.1*i/n*5), amp=H*(0.08+0.05*Math.sin(t*0.5+i)), f1=0.012+i*0.003, f2=0.021+i*0.004;
        ctx.strokeStyle='hsla('+hue+',95%,66%,0.85)'; ctx.shadowColor='hsla('+hue+',95%,60%,0.9)'; ctx.shadowBlur=full?14:0;
        ctx.beginPath();
        for(x=0;x<=W;x+=6){var y=base+Math.sin(x*f1+t*(0.8+i*0.15)+i)*amp+Math.sin(x*f2-t*1.1+i*2)*amp*0.45; if(x===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);}
        ctx.stroke(); ctx.shadowBlur=0;
        var g=ctx.createLinearGradient(0,base-amp,0,base+amp*3); g.addColorStop(0,'hsla('+hue+',95%,60%,0.12)'); g.addColorStop(1,'hsla('+hue+',95%,60%,0)'); ctx.fillStyle=g;
        ctx.beginPath(); for(x=0;x<=W;x+=6){var y2=base+Math.sin(x*f1+t*(0.8+i*0.15)+i)*amp+Math.sin(x*f2-t*1.1+i*2)*amp*0.45; if(x===0) ctx.moveTo(x,y2); else ctx.lineTo(x,y2);} ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath(); ctx.fill();
      }
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.warp={
    init:function(){
      var s={stars:[]}, i;
      for(i=0;i<(full?170:80);i++) s.stars.push({a:rnd(0,TAU), r:rnd(2,Math.max(W,H)*0.6), v:rnd(0.6,1.8), c:Math.random()});
      return s;
    },
    draw:function(s,t,dt){
      var i, cx=W*0.5+Math.sin(t*0.3)*W*0.04, cy=H*0.5+Math.cos(t*0.25)*H*0.05, mx=Math.max(W,H)*0.62;
      ctx.globalCompositeOperation='lighter';
      glow(cx,cy,H*0.9,'90,110,255',0.1); glow(cx,cy,H*0.25,'180,200,255',0.18);
      for(i=0;i<s.stars.length;i++){var st=s.stars[i], r0=st.r; st.r*=1+dt*st.v*1.15+0.002; if(st.r>mx){st.r=rnd(2,20); st.a=rnd(0,TAU); r0=st.r}
        var x0=cx+Math.cos(st.a)*r0, y0=cy+Math.sin(st.a)*r0, x1=cx+Math.cos(st.a)*st.r, y1=cy+Math.sin(st.a)*st.r, br=Math.min(1,st.r/(mx*0.6));
        ctx.strokeStyle=st.c<0.7?'rgba(220,230,255,'+(0.2+0.7*br)+')':'rgba(180,190,255,'+(0.2+0.7*br)+')'; ctx.lineWidth=0.4+br*1.8; ctx.beginPath(); ctx.moveTo(x0-(x1-x0)*2.5,y0-(y1-y0)*2.5); ctx.lineTo(x1,y1); ctx.stroke();}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.cloudsea={
    init:function(){
      var s={layers:[]}, i, j, cols=['rgba(255,200,170,0.55)','rgba(238,148,152,0.7)','rgba(150,108,172,0.85)','rgba(58,56,118,0.95)'], n=full?12:8;
      for(i=0;i<4;i++){var L={v:4+i*5, y:H*(0.46+i*0.15), c:cols[i], puffs:[]}; for(j=0;j<n;j++) L.puffs.push({x:j*(W*1.3/n), r:rnd(30,60)*(0.8+i*0.25), dy:rnd(-10,10)}); s.layers.push(L);}
      s.birds=[]; for(i=0;i<3;i++) s.birds.push({x:rnd(0,W), y:rnd(H*0.1,H*0.35), v:rnd(12,22), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i, j, L;
      ctx.globalCompositeOperation='lighter'; glow(W*0.5,H*0.62,H*0.95,'255,190,120',0.45+0.05*Math.sin(t*0.6)); glow(W*0.5,H*0.62,H*0.3,'255,236,190',0.5); ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='rgba(70,60,120,0.75)'; ctx.beginPath(); ctx.moveTo(W*0.62,H*0.7); ctx.lineTo(W*0.75,H*0.4); ctx.lineTo(W*0.9,H*0.7); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(W*0.05,H*0.72); ctx.lineTo(W*0.17,H*0.46); ctx.lineTo(W*0.3,H*0.72); ctx.closePath(); ctx.fill();
      for(i=0;i<s.layers.length;i++){L=s.layers[i]; ctx.fillStyle=L.c; ctx.beginPath();
        for(j=0;j<L.puffs.length;j++){var p=L.puffs[j]; p.x+=L.v*dt; if(p.x>W+p.r*2) p.x-=W*1.3+p.r*4; var py=L.y+p.dy+Math.sin(t*0.4+j+i)*3;
          ctx.moveTo(p.x+p.r,py); ctx.arc(p.x,py,p.r,0,TAU);}
        ctx.fill(); ctx.fillRect(0,L.y+10,W,H);}
      for(i=0;i<s.birds.length;i++){var b=s.birds[i]; b.x+=b.v*dt; if(b.x>W+20) b.x=-20; bird(b.x,b.y+Math.sin(t*0.8+b.p)*4,Math.sin(t*5+b.p)*3,'rgba(50,30,70,0.8)',1);}
    }
  };

  scenes.kites={
    init:function(){
      var s={kites:[],clouds:[],birds:[]}, i, cols=['255,86,86','255,214,80','80,210,255','255,120,200','140,255,170'];
      for(i=0;i<(full?5:3);i++) s.kites.push({x:rnd(W*0.12,W*0.88), y:rnd(H*0.18,H*0.5), ax:rnd(W*0.1,W*0.9), p:rnd(0,6.28), c:pick(cols), z:rnd(0.8,1.3)});
      for(i=0;i<4;i++) s.clouds.push({x:rnd(0,W), y:rnd(H*0.08,H*0.6), s:rnd(0.8,1.5), v:rnd(3,8)});
      for(i=0;i<3;i++) s.birds.push({x:rnd(0,W), y:rnd(H*0.1,H*0.5), v:rnd(10,20), p:rnd(0,6.28)});
      return s;
    },
    draw:function(s,t,dt){
      var i, j;
      ctx.globalCompositeOperation='lighter'; glow(W*0.85,H*0.1,H*0.8,'255,246,200',0.22); ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.clouds.length;i++){var c=s.clouds[i]; c.x+=c.v*dt; if(c.x>W+80) c.x=-80; ctx.fillStyle='rgba(255,255,255,0.35)'; ctx.beginPath();
        var pr=[[0,0,16],[18,-6,20],[38,0,15],[22,6,17]]; for(j=0;j<pr.length;j++){ctx.moveTo(c.x+(pr[j][0]+pr[j][2])*c.s,c.y+pr[j][1]*c.s); ctx.arc(c.x+pr[j][0]*c.s,c.y+pr[j][1]*c.s,pr[j][2]*c.s,0,TAU);} ctx.fill();}
      for(i=0;i<s.birds.length;i++){var b=s.birds[i]; b.x+=b.v*dt; if(b.x>W+20) b.x=-20; bird(b.x,b.y+Math.sin(t*0.8+b.p)*4,Math.sin(t*5+b.p)*3,'rgba(20,40,80,0.7)',1);}
      for(i=0;i<s.kites.length;i++){var k=s.kites[i], x=k.x+Math.sin(t*0.6+k.p)*26, y=k.y+Math.sin(t*0.9+k.p)*12, ang=Math.sin(t*0.8+k.p)*0.22, sz=17*k.z, tx=Math.sin(t*0.6+k.p)*8;
        ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x,y+sz); ctx.quadraticCurveTo((x+k.ax)/2+Math.sin(t+k.p)*14,(y+H)/2,k.ax,H+4); ctx.stroke();
        ctx.save(); ctx.translate(x,y); ctx.rotate(ang);
        ctx.strokeStyle='rgba(255,255,255,0.75)'; ctx.lineWidth=1.4; ctx.beginPath(); ctx.moveTo(0,sz); for(j=1;j<=11;j++) ctx.lineTo(Math.sin(t*3.2+j*0.7+k.p)*(3+j*0.9),sz+j*7*k.z); ctx.stroke();
        ctx.fillStyle='rgba('+k.c+',0.95)'; for(j=2;j<=10;j+=3){ctx.beginPath(); ctx.ellipse(Math.sin(t*3.2+j*0.7+k.p)*(3+j*0.9),sz+j*7*k.z,3.2,1.8,0.6,0,TAU); ctx.fill();}
        ctx.fillStyle='rgba('+k.c+',0.95)'; ctx.beginPath(); ctx.moveTo(0,-sz*1.15); ctx.lineTo(sz*0.75,-sz*0.1); ctx.lineTo(0,sz); ctx.lineTo(-sz*0.75,-sz*0.1); ctx.closePath(); ctx.fill();
        ctx.fillStyle='rgba(255,255,255,0.28)'; ctx.beginPath(); ctx.moveTo(0,-sz*1.15); ctx.lineTo(sz*0.75,-sz*0.1); ctx.lineTo(0,-sz*0.1); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(0,sz); ctx.lineTo(-sz*0.75,-sz*0.1); ctx.lineTo(0,-sz*0.1); ctx.closePath(); ctx.fill();
        ctx.strokeStyle='rgba(60,40,40,0.7)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(0,-sz*1.15); ctx.lineTo(0,sz); ctx.moveTo(-sz*0.75,-sz*0.1); ctx.lineTo(sz*0.75,-sz*0.1); ctx.stroke();
        ctx.restore();}
      ctx.fillStyle='rgba(40,110,60,0.95)'; ctx.beginPath(); ctx.moveTo(0,H); for(var x=0;x<=W;x+=14) ctx.lineTo(x,H*0.94-Math.sin(x*0.01)*6); ctx.lineTo(W,H); ctx.closePath(); ctx.fill();
    }
  };

  scenes.lava={
    init:function(){
      var s={b:[]}, i, cols=['255,90,120','255,160,60','190,90,255','255,110,200','255,200,90'];
      for(i=0;i<(full?9:6);i++) s.b.push({x:rnd(0.1,0.9), y:rnd(0,1), r:rnd(0.12,0.26), sp:rnd(0.12,0.3), p:rnd(0,6.28), c:pick(cols)});
      return s;
    },
    draw:function(s,t,dt){
      var i;
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<s.b.length;i++){var b=s.b[i], x=W*(b.x+Math.sin(t*b.sp+b.p)*0.12), y=H*(0.5+Math.sin(t*b.sp*0.8+b.p*2)*0.55), r=H*b.r*(1+0.12*Math.sin(t*0.7+b.p));
        glow(x,y,r*1.5,b.c,0.55); glow(x,y,r*0.7,'255,240,220',0.28);}
      ctx.globalCompositeOperation='source-over';
    }
  };

  scenes.sunsetbeach={
    init:function(){
      var s={birds:[],clouds:[]}, i;
      for(i=0;i<3;i++) s.birds.push({x:rnd(0,W), y:rnd(H*0.1,H*0.4), v:rnd(10,20), p:rnd(0,6.28)});
      for(i=0;i<4;i++) s.clouds.push({x:rnd(0,W), y:rnd(H*0.1,H*0.4), w:rnd(60,140), v:rnd(2,6)});
      return s;
    },
    palm:function(x,y,h,t,flip){
      var i, d=flip?-1:1, tx=x+d*h*0.28, ty=y-h;
      ctx.strokeStyle='rgba(22,10,24,0.98)'; ctx.lineWidth=5; ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(x,y); ctx.quadraticCurveTo(x+d*h*0.05,y-h*0.55,tx,ty); ctx.stroke();
      ctx.lineWidth=2.4;
      for(i=0;i<7;i++){var a=-1.15+i*0.42+Math.sin(t*0.9+i)*0.05, len=h*0.5; ctx.beginPath(); ctx.moveTo(tx,ty); ctx.quadraticCurveTo(tx+Math.cos(a)*len*0.6*d*(i<3.5?1:1),ty+Math.sin(a)*len*0.35-len*0.25,tx+Math.cos(a)*len*d,ty+Math.sin(a)*len*0.6+len*0.2); ctx.stroke();}
    },
    draw:function(s,t,dt){
      var i, x, hz=H*0.62;
      ctx.globalCompositeOperation='lighter'; glow(W*0.5,hz,H*1.0,'255,150,90',0.5); glow(W*0.5,hz,H*0.3,'255,226,170',0.5); ctx.globalCompositeOperation='source-over';
      for(i=0;i<s.clouds.length;i++){var c=s.clouds[i]; c.x+=c.v*dt; if(c.x>W+c.w) c.x=-c.w; var cg=ctx.createLinearGradient(c.x-c.w,0,c.x+c.w,0); cg.addColorStop(0,'rgba(255,170,150,0)'); cg.addColorStop(0.5,'rgba(255,170,150,0.35)'); cg.addColorStop(1,'rgba(255,170,150,0)'); ctx.fillStyle=cg; ctx.beginPath(); ctx.ellipse(c.x,c.y,c.w,7,0,0,TAU); ctx.fill();}
      ctx.save(); ctx.beginPath(); ctx.rect(0,0,W,hz); ctx.clip(); ctx.fillStyle='rgba(255,226,170,0.97)'; dot(W*0.5,hz-H*0.02,H*0.13); ctx.restore();
      var wg=ctx.createLinearGradient(0,hz,0,H); wg.addColorStop(0,'rgba(140,70,110,0.95)'); wg.addColorStop(1,'rgba(36,18,56,1)'); ctx.fillStyle=wg; ctx.fillRect(0,hz,W,H-hz);
      ctx.globalCompositeOperation='lighter';
      for(i=0;i<(full?22:12);i++){var yy=hz+3+i*((H-hz-6)/(full?22:12)), sp=10+i*4, ww=sp*(0.6+0.4*Math.sin(t*2+i)); ctx.fillStyle='rgba(255,210,150,'+(0.5-i*0.02)+')'; ctx.fillRect(W*0.5-ww/2+Math.sin(t*1.5+i*1.2)*sp*0.25,yy,ww,1.8);}
      ctx.globalCompositeOperation='source-over';
      ctx.strokeStyle='rgba(255,200,170,0.2)'; ctx.lineWidth=1; for(i=0;i<4;i++){ctx.beginPath(); for(x=0;x<=W;x+=10){var yv=hz+12+i*((H-hz)/4.5)+Math.sin(x*0.03+t*(0.8+i*0.2)+i)*2; if(x===0) ctx.moveTo(x,yv); else ctx.lineTo(x,yv);} ctx.stroke();}
      ctx.fillStyle='rgba(22,10,24,0.98)'; ctx.beginPath(); ctx.moveTo(0,H); ctx.lineTo(0,H*0.9); for(x=0;x<=W*0.3;x+=10) ctx.lineTo(x,H*0.9-Math.sin(x*0.02)*5-x*0.02); ctx.lineTo(W*0.3,H); ctx.closePath(); ctx.fill();
      this.palm(W*0.09,H*0.92,H*0.5,t,false); this.palm(W*0.17,H*0.94,H*0.34,t,false);
      for(i=0;i<s.birds.length;i++){var b=s.birds[i]; b.x+=b.v*dt; if(b.x>W+20) b.x=-20; bird(b.x,b.y+Math.sin(t*0.8+b.p)*4,Math.sin(t*5+b.p)*3,'rgba(40,18,40,0.8)',1);}
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
