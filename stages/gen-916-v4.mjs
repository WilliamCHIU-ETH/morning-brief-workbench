import fs from 'node:fs';
import path from 'node:path';
import { shell, C, D, root } from './comp-shell-916-v4.mjs';
const out = {};

/* 02 台股／美股 上下等高分割。主數字同字級，落差交給顏色 */
out['02-market-split'] = shell('br02', D['02'], `
#m-title{left:0;top:0}
.blk{position:absolute;left:0;width:984px;height:404px;border-radius:28px;background:${C.bg2}}
#m-up{top:112px;border:5px solid ${C.up}}
#m-dn{top:568px;border:5px solid ${C.down}}
.blk .lb{position:absolute;left:40px;top:30px;font-size:46px;font-weight:700;color:${C.sub};line-height:1}
.blk .row{position:absolute;left:40px;top:106px;display:flex;align-items:baseline;gap:16px}
.blk .num{font-size:140px;font-weight:700;line-height:1}
.blk .u{font-size:54px;font-weight:700;line-height:1}
.blk .sub{position:absolute;left:40px;top:302px;font-size:40px;color:${C.sub};line-height:1}
#m-line{position:absolute;left:242px;top:538px;width:500px;height:5px;background:${C.line};border-radius:3px}
`, `
      <div class="t h1" id="m-title">昨日盤勢</div>
      <div class="blk" id="m-up">
        <div class="lb">台股</div>
        <div class="row"><span class="num" id="m-n1" style="color:${C.up}">0</span><span class="u" style="color:${C.up}">點</span></div>
        <div class="sub">收 44,933 點</div>
      </div>
      <div id="m-line"></div>
      <div class="blk" id="m-dn">
        <div class="lb">道瓊</div>
        <div class="row"><span class="num" id="m-n2" style="color:${C.down}">0</span><span class="u" style="color:${C.down}">點</span></div>
        <div class="sub">昨晚</div>
      </div>
`, `
  const plus=(v)=>'+'+Math.round(v);
  const minus=(v)=>'\\u2212'+Math.round(v);
  tl.fromTo('#m-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.38,ease:'power3.out'},0);
  tl.fromTo('#m-up',{y:26,autoAlpha:0},{y:0,autoAlpha:1,duration:.42,ease:'power3.out'},.36);
  countUp('#m-n1',214,.62,.9,plus);
  tl.fromTo('#m-line',{scaleX:0,autoAlpha:0},{scaleX:1,autoAlpha:1,duration:.3,ease:'power2.out'},1.72);
  tl.fromTo('#m-dn',{y:26,autoAlpha:0},{y:0,autoAlpha:1,duration:.42,ease:'power3.out'},2.02);
  countUp('#m-n2',703,2.28,1.0,minus);
  tl.to('#m-up',{autoAlpha:.7,duration:.4,ease:'power2.out'},2.28);
  tl.to('#m-title,#m-up,#m-line,#m-dn',{y:-30,duration:.5,ease:'power2.in'},${(D['02']-.6).toFixed(2)});
`, 24);

/* 04 需求鏈條，三節加結論帶。第三節最後轉強調黃 */
out['04-demand-chain'] = shell('br04', D['04'], `
#d-title{left:0;top:0}
.node{position:absolute;top:290px;width:300px;height:250px;border-radius:26px;background:${C.bg2};border:5px solid ${C.line};display:flex;align-items:center;justify-content:center;text-align:center;padding:0 20px}
.node span{font-size:54px;font-weight:700;color:${C.sub};line-height:1.25}
#d-n1{left:0}
#d-n2{left:342px}
#d-n3{left:684px}
.arw{position:absolute;top:400px;width:30px;height:30px;border-top:6px solid ${C.line};border-right:6px solid ${C.line};transform:rotate(45deg)}
#d-a1{left:306px}
#d-a2{left:648px}
#d-band{position:absolute;left:0;top:660px;width:984px;height:150px;border-radius:26px;background:${C.upFill};display:flex;align-items:center;justify-content:center}
#d-band span{font-size:64px;font-weight:700}
`, `
      <div class="t h1" id="d-title">需求從哪裡來</div>
      <div class="node" id="d-n1"><span>AI<br />資料中心</span></div>
      <div class="arw" id="d-a1"></div>
      <div class="node" id="d-n2"><span>CPO</span></div>
      <div class="arw" id="d-a2"></div>
      <div class="node" id="d-n3"><span id="d-n3t">光通訊<br />產品</span></div>
      <div id="d-band"><span>下半年進入放量階段</span></div>
`, `
  tl.fromTo('#d-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.38,ease:'power3.out'},0);
  tl.fromTo('#d-n1',{x:-28,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},.34);
  tl.fromTo('#d-a1',{autoAlpha:0},{autoAlpha:1,duration:.24,ease:'power2.out'},.66);
  tl.fromTo('#d-n2',{x:-28,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},.86);
  tl.fromTo('#d-a2',{autoAlpha:0},{autoAlpha:1,duration:.24,ease:'power2.out'},1.18);
  tl.fromTo('#d-n3',{x:-28,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},1.38);
  tl.to('#d-n3',{borderColor:'${C.hi}',duration:.34,ease:'power2.out'},2.1);
  tl.to('#d-n3t',{color:'${C.hi}',duration:.34,ease:'power2.out'},2.1);
  tl.fromTo('#d-band',{y:40,autoAlpha:0},{y:0,autoAlpha:1,duration:.42,ease:'power3.out'},2.6);
  tl.to('#d-title,#d-n1,#d-a1,#d-n2,#d-a2,#d-n3,#d-band',{autoAlpha:0,duration:.45,ease:'power2.in'},${(D['04']-.5).toFixed(2)});
`, 74);

/* 06 時間差。空白比字更重要 */
out['06-time-gap'] = shell('br06', D['06'], `
#g-title{left:0;top:0}
#g-lead{position:absolute;left:0;top:108px;font-size:52px;font-weight:700;color:${C.hi}}
#g-axis{position:absolute;left:56px;top:640px;width:872px;height:6px;background:${C.line};border-radius:3px}
#g-d1{position:absolute;left:34px;top:614px;width:58px;height:58px;border-radius:50%;background:${C.upFill}}
#g-d2{position:absolute;left:892px;top:614px;width:58px;height:58px;border-radius:50%;border:6px solid ${C.line};background:${C.bg}}
#g-l1{position:absolute;left:0;top:700px;width:440px;height:190px}
#g-l1 .k{position:absolute;left:0;top:0;font-size:44px;font-weight:700;color:${C.up};line-height:1}
#g-l1 .n{position:absolute;left:0;top:66px;font-size:104px;font-weight:700;color:${C.up};line-height:1.1}
#g-l2{position:absolute;right:0;top:706px;width:360px;text-align:right;font-size:48px;font-weight:700;color:${C.sub}}
#g-gap{position:absolute;left:242px;top:476px;width:500px;text-align:center;font-size:64px;font-weight:700;color:${C.sub}}
`, `
      <div class="t h1" id="g-title">時間差</div>
      <div id="g-lead">投入已定，出貨未到</div>
      <div id="g-gap">還沒發生</div>
      <div id="g-axis"></div>
      <div id="g-d1"></div>
      <div id="g-d2"></div>
      <div id="g-l1"><div class="k">規劃投入</div><div class="n"><span id="g-num">0</span> 億元</div></div>
      <div id="g-l2">實際出貨</div>
`, `
  tl.fromTo('#g-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},0);
  tl.fromTo('#g-lead',{autoAlpha:0},{autoAlpha:1,duration:.3,ease:'power2.out'},.3);
  tl.fromTo('#g-axis',{scaleX:0,transformOrigin:'0% 50%'},{scaleX:1,duration:.5,ease:'power2.out'},.6);
  tl.fromTo('#g-d1',{scale:.4,autoAlpha:0},{scale:1,autoAlpha:1,duration:.34,ease:'back.out(1.6)'},.7);
  tl.fromTo('#g-l1',{y:20,autoAlpha:0},{y:0,autoAlpha:1,duration:.32,ease:'power2.out'},.86);
  countUp('#g-num',12,.94,.7,int);
  tl.fromTo('#g-d2',{scale:.4,autoAlpha:0},{scale:1,autoAlpha:1,duration:.32,ease:'back.out(1.5)'},1.86);
  tl.fromTo('#g-l2',{y:20,autoAlpha:0},{y:0,autoAlpha:1,duration:.3,ease:'power2.out'},2.0);
  tl.fromTo('#g-gap',{y:26,autoAlpha:0},{y:0,autoAlpha:1,duration:.4,ease:'power3.out'},2.7);
`, 34);

/* 08 兩個觀察指標。等重不分主次 */
out['08-watch-two'] = shell('br08', D['08'], `
#w-title{left:0;top:0}
#w-lead{position:absolute;left:0;top:112px;font-size:56px;font-weight:700}
.wrow{position:absolute;left:0;width:984px;height:190px;border-radius:26px;background:${C.bg2};border:5px solid ${C.line};display:flex;align-items:center;gap:34px;padding:0 40px}
#w-r1{top:330px}
#w-r2{top:566px}
.wbox{flex:0 0 auto;width:64px;height:64px;border:6px solid ${C.line};border-radius:10px}
.wtx{font-size:54px;font-weight:700;line-height:1.2}
`, `
      <div class="t h1" id="w-title">今日觀察</div>
      <div id="w-lead">今天先看兩件事</div>
      <div class="wrow" id="w-r1"><div class="wbox"></div><div class="wtx">光通訊族群<br />有沒有一起轉強</div></div>
      <div class="wrow" id="w-r2"><div class="wbox"></div><div class="wtx">鼎元的量能<br />有沒有延續</div></div>
`, `
  tl.fromTo('#w-title',{x:-36,autoAlpha:0},{x:0,autoAlpha:1,duration:.36,ease:'power3.out'},0);
  tl.fromTo('#w-lead',{autoAlpha:0},{autoAlpha:1,duration:.32,ease:'power2.out'},.32);
  tl.fromTo('#w-r1',{x:-40,autoAlpha:0},{x:0,autoAlpha:1,duration:.42,ease:'power3.out'},.7);
  tl.fromTo('#w-r2',{x:-40,autoAlpha:0},{x:0,autoAlpha:1,duration:.42,ease:'power3.out'},1.4);
  tl.to('#w-title,#w-lead,#w-r1,#w-r2',{y:26,duration:.5,ease:'power2.in'},${(D['08']-.6).toFixed(2)});
`, 44);

for (const [n, h] of Object.entries(out)) fs.writeFileSync(path.join(root, 'compositions', `${n}.html`), h);
console.log(JSON.stringify({ written: Object.keys(out) }));
