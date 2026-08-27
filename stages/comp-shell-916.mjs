import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProject, readJson } from './lib/project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const P = resolveProject();
const root = P.root;
// ledger 在付費（HeyGen → ASR → 對齊）之後才會有。MG 版型在付費之前就要能產出，
// 那時用 plan 的估計時長，所以這裡不能在 import 期就硬性要求 ledger。
let seg = [];
try { seg = readJson(P, 'segmentLedger').segments; } catch { seg = []; }
const D = Object.fromEntries(seg.map((s) => [s.id, s.durationSec]));

const C = {
  bg: '#0E1A2B', bg2: '#1C2B3F', text: '#FFFFFF', sub: '#9FB0C4',
  up: '#FF5561', upFill: '#E21E28', down: '#00A86B', hi: '#FFEC00', line: '#3A4A5E',
};

// fullframe 的三條硬約束（SKILL.md）：
//  1 尺寸必須 1080×1920，1:1 不縮放不裁切
//  2 覆蓋率不得過高（本輪由使用者指定全段覆蓋，缺口已記錄）
//  3 必須自己避開 y<254（標題板）與 y>1350（字幕框 1390–1640、關鍵數字禁區 1350–1680）
//    → 所有內容一律放進 #stage，由 #stage 幾何強制保證，不靠逐格自律
const SAFE_TOP = 254, SAFE_BOT = 1350, SAFE_X = 48;
const STAGE_W = 1080 - SAFE_X * 2;      // 984
const STAGE_H = SAFE_BOT - SAFE_TOP;    // 1096

const BASE = `
@font-face{font-family:'Noto Sans TC';src:url('assets/NotoSansTC-Regular.ttf') format('truetype');font-weight:400;font-display:block}
@font-face{font-family:'Noto Sans TC';src:url('assets/NotoSansTC-Bold.ttf') format('truetype');font-weight:700;font-display:block}
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}
body{font-family:'Noto Sans TC',sans-serif;color:${C.text}}
#root{position:relative;width:1080px;height:1920px;overflow:hidden}
#bg{position:absolute;inset:0;background:${C.bg}}
#stage{position:absolute;left:${SAFE_X}px;top:${SAFE_TOP}px;width:${STAGE_W}px;height:${STAGE_H}px;overflow:hidden}
#inner{position:absolute;left:0;top:0;width:100%;height:100%}
.t{position:absolute}
.h1{font-size:64px;font-weight:700;letter-spacing:.01em}
.sm{font-size:40px;font-weight:400;color:${C.sub}}
.hero{font-size:180px;font-weight:700;line-height:1}
`;

function shell(id, dur, css, body, tl, shiftY = 0) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=1080, height=1920" />
<title>${id}</title>
<style>${BASE}${css}</style>
</head>
<body>
<div id="root" data-composition-id="${id}" data-start="0" data-duration="${dur.toFixed(2)}" data-width="1080" data-height="1920" data-fps="30">
  <section id="scene" class="clip" data-start="0" data-duration="${dur.toFixed(2)}" data-track-index="1">
    <div id="bg"></div>
    <div id="stage">
      <div id="inner" style="transform:translateY(${shiftY}px)">
${body}
      </div>
    </div>
  </section>
</div>
<script src="assets/gsap.min.js"></script>
<script>
(function(){
  const tl = gsap.timeline({paused:true});
  function countUp(sel, to, at, dur, fmt){
    const el = document.querySelector(sel);
    const o = {v:0};
    tl.to(o, {v:to, duration:dur, ease:'power2.out', onUpdate:function(){ el.textContent = fmt(o.v); }}, at);
  }
  const int = (v)=>String(Math.round(v));
${tl}
  window.__timelines = window.__timelines || {};
  window.__timelines['${id}'] = tl;
})();
</script>
</body>
</html>
`;
}

export { shell, C, D, root, STAGE_W, STAGE_H };
