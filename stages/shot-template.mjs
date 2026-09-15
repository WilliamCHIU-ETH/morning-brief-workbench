/**
 * `shot` 版型：把一張 App 實機截圖放進素材格，黃框框住正在講的那個數字或那一列。
 *
 * 2026-08-27 會議裁定素材格全面改用實機截圖，對標 IG cmchipk 的「大盤小報」「三大法人」。
 * 從對標影片拆解出來的素材格只有三件事：真實數字、黃色圓角框、框跟著旁白移動。
 * 這個版型就只做這三件事，不多。
 *
 * 為什麼是獨立檔而不是塞進 mg-templates.mjs：另一個 session 正在改那個檔（chain 1～3 節），
 * 分檔避免打架；plan-mg.mjs 只要 `{ ...TEMPLATES, shot: SHOT }` 就能用。
 *
 * data：
 *   image     相對專案根的路徑，必須在 assets/ 底下（composition 會被複製到 qa/<slot>/，
 *             只有 assets/ 有 symlink 過去）。
 *   imageW/H  原圖像素。plan-mg 用 imageSize() 量，不由人填。
 *   cropTop   裁掉頂部多少像素（狀態列）。對標片的截圖從 App 標頭開始，沒有 iOS 狀態列。
 *   focusList [{x,y,w,h}, ...] 同頁 N 拍的空間槽；存在時取代 focus／focus2，至少一項。
 *   focus／focus2 舊格式維持相容，內部依序映射成 focusList。
 *   second    可選。接在全部同頁拍之後，以交叉淡變切到第二頁。
 *
 * 幾何：截圖等比縮到舞台寬 984px，垂直位移讓 focus 置中；#stage 由 comp-shell 保證避開
 * 標題板（y<254）與字幕框（y>1350）。
 */

import fs from 'node:fs';
import { SHOT_BEAT_TIMING, shotBeatTweenSec } from './lib/rhythm.mjs';

const STAGE_W = 984;
const STAGE_H = 1096;
const PAD = 14;          // 黃框比目標多留的邊
const BORDER = 6;

/** 讀 PNG／JPEG 的像素尺寸，不靠外部套件。 */
export function imageSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15（不含 DHT/JPG/DAC）
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  throw new Error(`看不出 ${file} 的尺寸（只支援 PNG／JPEG）`);
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const colorWithAlpha = (hex, alpha) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`spotlight.color 必須是 #RRGGBB，收到 ${hex}`);
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};
const rectOk = (r, W, H) => r && num(r.x) && num(r.y) && num(r.w) && num(r.h)
  && r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H;

/** focusList 存在時完全取代舊 focus／focus2；否則把舊格式映成同一個內部序列。 */
export function shotFocusList(data) {
  if (data && Object.prototype.hasOwnProperty.call(data, 'focusList')) return data.focusList;
  return [data?.focus, data?.focus2].filter(Boolean);
}

export const SHOT = {
  shiftY: 0,
  required: ['image', 'imageW', 'imageH'],
  defaults: { cropTop: 0 },
  validate(d) {
    if (!d.image || typeof d.image !== 'string') return 'shot 需要 image（相對專案根的路徑）';
    if (!d.image.startsWith('assets/')) return `image 必須放在 assets/ 底下（render 只把 assets/ symlink 進 qa/），收到 ${d.image}`;
    if (!num(d.imageW) || !num(d.imageH) || d.imageW <= 0 || d.imageH <= 0) return 'shot 需要 imageW／imageH（由 plan-mg 量，不手填）';
    if (!num(d.cropTop) || d.cropTop < 0 || d.cropTop >= d.imageH) return 'cropTop 必須是 0 ～ imageH 之間的像素數';
    const H = d.imageH - d.cropTop;
    const explicitFocusList = Object.prototype.hasOwnProperty.call(d, 'focusList');
    if (explicitFocusList && (!Array.isArray(d.focusList) || !d.focusList.length)) {
      return 'focusList 存在時必須是至少一項的 rect 陣列';
    }
    if (!explicitFocusList && d.focus2 && !d.focus) return 'focus2 需要先有 focus';
    const focuses = shotFocusList(d);
    if (!Array.isArray(focuses) || !focuses.length) return 'shot 需要 focus，或至少一項 focusList';
    for (const [index, focus] of focuses.entries()) {
      if (!rectOk({ ...focus, y: focus?.y - d.cropTop }, d.imageW, H)) {
        return `focusList[${index}] 不在圖內（圖 ${d.imageW}×${d.imageH}，cropTop ${d.cropTop}）：${JSON.stringify(focus)}`;
      }
    }
    // second：同一格的全部同頁拍結束後接續第二頁。拍點處交叉淡變，各自有黃框。
    if (d.second) {
      const e = d.second;
      if (!e.image || typeof e.image !== 'string' || !e.image.startsWith('assets/')) {
        return `second.image 必須是 assets/ 底下的路徑，收到 ${e && e.image}`;
      }
      if (!num(e.imageW) || !num(e.imageH) || e.imageW <= 0 || e.imageH <= 0) return 'second 需要 imageW／imageH（由 plan-mg 量，不手填）';
      if (!num(e.cropTop) || e.cropTop < 0 || e.cropTop >= e.imageH) return 'second.cropTop 必須是 0 ～ imageH 之間的像素數';
      if (!e.focus) return 'second 需要 focus：第二頁沒有可框之物就不該切過去';
      if (!rectOk({ ...e.focus, y: e.focus.y - e.cropTop }, e.imageW, e.imageH - e.cropTop)) {
        return `second.focus 不在圖內：${JSON.stringify(e.focus)}`;
      }
      if (e.focus2 && !rectOk({ ...e.focus2, y: e.focus2.y - e.cropTop }, e.imageW, e.imageH - e.cropTop)) {
        return `second.focus2 不在圖內：${JSON.stringify(e.focus2)}`;
      }
    }
    return null;
  },
  render(C, d, { spotlight, beats = [] } = {}) {
    const spotlightShadow = spotlight?.alpha > 0
      ? `,0 0 0 ${spotlight.spreadPx}px ${colorWithAlpha(spotlight.color, spotlight.alpha)}`
      : '';
    const s = STAGE_W / d.imageW;
    const shownH = (d.imageH - d.cropTop) * s;          // 裁掉狀態列後的高度（舞台像素）
    const minY = Math.min(0, STAGE_H - shownH);          // 最多往上捲到底

    const box = (r) => ({
      left: r.x * s - PAD, top: (r.y - d.cropTop) * s - PAD,
      width: r.w * s + PAD * 2, height: r.h * s + PAD * 2,
    });
    const yFor = (r) => {
      if (!r) return 0;
      const cy = (r.y - d.cropTop + r.h / 2) * s;
      return Math.max(minY, Math.min(0, STAGE_H / 2 - cy));
    };
    const r = (v) => Number(v.toFixed(1));
    const focuses = shotFocusList(d);
    const boxes = focuses.map(box);
    const focusYs = focuses.map(yFor);
    const b1 = boxes[0];
    const y1 = focusYs[0];

    // 推近的原點放在第一拍黃框中心，後續 N 拍都以同一原點做絕對 transform。
    const ox = r(b1.left + b1.width / 2);
    const oy = r(b1.top + b1.height / 2);

    const sec = d.second;
    let secCss = '';
    let secBody = '';
    let g2 = null;
    if (sec) {
      const s2 = STAGE_W / sec.imageW;
      const shownH2 = (sec.imageH - sec.cropTop) * s2;
      const minY2 = Math.min(0, STAGE_H - shownH2);
      const bb = {
        left: sec.focus.x * s2 - PAD, top: (sec.focus.y - sec.cropTop) * s2 - PAD,
        width: sec.focus.w * s2 + PAD * 2, height: sec.focus.h * s2 + PAD * 2,
      };
      const cy2 = (sec.focus.y - sec.cropTop + sec.focus.h / 2) * s2;
      const bb2 = sec.focus2 ? {
        left: sec.focus2.x * s2 - PAD, top: (sec.focus2.y - sec.cropTop) * s2 - PAD,
        width: sec.focus2.w * s2 + PAD * 2, height: sec.focus2.h * s2 + PAD * 2,
      } : null;
      const yB = sec.focus2
        ? Math.max(minY2, Math.min(0, STAGE_H / 2 - (sec.focus2.y - sec.cropTop + sec.focus2.h / 2) * s2))
        : null;
      g2 = { y: Math.max(minY2, Math.min(0, STAGE_H / 2 - cy2)), b: bb, b2: bb2, yB };
      secCss = `#shot2{position:absolute;left:0;top:0;width:${STAGE_W}px;height:${r(shownH2)}px;overflow:hidden;will-change:transform;transform-origin:${r(bb.left + bb.width / 2)}px ${r(bb.top + bb.height / 2)}px}
#shot2 img{position:absolute;left:0;top:${r(-sec.cropTop * s2)}px;width:${STAGE_W}px;height:${r(sec.imageH * s2)}px;display:block}
#hl2{position:absolute;border:${BORDER}px solid ${C.hi};border-radius:18px;box-shadow:0 0 0 4px rgba(0,0,0,.35),0 0 28px rgba(255,236,0,.55)${spotlightShadow};pointer-events:none;transform-origin:center;will-change:transform,opacity}
`;
      secBody = `
      <div id="shot2">
        <img src="${sec.image}" alt="" width="${STAGE_W}" height="${r(sec.imageH * s2)}" />
        <div id="hl2" style="left:${r(bb.left)}px;top:${r(bb.top)}px;width:${r(bb.width)}px;height:${r(bb.height)}px"></div>
      </div>`;
    }
    const css = `
#shot{position:absolute;left:0;top:0;width:${STAGE_W}px;height:${r(shownH)}px;overflow:hidden;will-change:transform;transform-origin:${ox}px ${oy}px}
#shot img{position:absolute;left:0;top:${r(-d.cropTop * s)}px;width:${STAGE_W}px;height:${r(d.imageH * s)}px;display:block}
#hl{position:absolute;border:${BORDER}px solid ${C.hi};border-radius:18px;box-shadow:0 0 0 4px rgba(0,0,0,.35),0 0 28px rgba(255,236,0,.55)${spotlightShadow};pointer-events:none;transform-origin:center;will-change:transform,opacity}
${secCss}`;
    const body = `      <div id="shot">
        <img src="${d.image}" alt="" width="${STAGE_W}" height="${r(d.imageH * s)}" />
${b1 ? `        <div id="hl" style="left:${r(b1.left)}px;top:${r(b1.top)}px;width:${r(b1.width)}px;height:${r(b1.height)}px"></div>` : ''}
      </div>${secBody}`;

    // 畫面本身先在視覺窗口露出；同頁 N 拍與換頁都使用 planner 算好的 P3 transition。
    // 沒有 ASR 的付費前預覽才依序退回比例時間，仍不限制 focusList 長度。
    const tl = (dur) => {
      const samePageBeats = beats.filter((beat) => beat.kind === 'focus' || beat.kind === 'focus2');
      const beatForFocus = (index) => beats.find((beat) => Number(beat.focusIndex) === index)
        ?? samePageBeats[index];
      const localAt = (beat, fallback) => {
        const value = Number(beat?.localTransitionStartSec ?? beat?.localSec);
        return Math.max(0, Math.min(dur - 0.05, Number.isFinite(value) ? value : fallback));
      };
      const focusAts = focuses.map((_, index) => localAt(
        beatForFocus(index),
        index === 0 ? 0.4 : Math.max(0.9, dur * ((index + 1) / (focuses.length + 1))),
      ));
      const secondBeat = beats.find((beat) => beat.kind === 'second');
      const secondAt = localAt(
        secondBeat,
        Math.max(0.9, dur * ((focuses.length + 1) / (focuses.length + 2))),
      );
      const parts = [
        // 初始位移交給 GSAP（tl.set 是 0 秒 tween，seek-safe）。寫在 CSS transform 會被
        // GSAP 的 y／scale tween 整條覆蓋（lint:gsap_css_transform_conflict）。
        `  tl.set('#shot',{y:${r(y1)}},0);`,
        `  tl.fromTo('#shot',{autoAlpha:0},{autoAlpha:1,duration:.25,ease:'power2.out'},0);`,
        // 極慢推近：整格從 1.00 到 1.03。對標片的截圖是靜態的，這一點呼吸感人眼幾乎看不到，
        // 但 hyperframes check 的 layout:sweep_static 會把長時間完全不動的格判 error。
        `  tl.fromTo('#shot',{scale:1},{scale:1.03,duration:${dur.toFixed(2)},ease:'none'},0);`,
      ];
      const firstBeat = beatForFocus(0);
      const firstTweenSec = Number(firstBeat?.tweenSec ?? shotBeatTweenSec('focus'));
      parts.push(`  tl.fromTo('#hl',{autoAlpha:0,scale:.82},{autoAlpha:1,scale:1,duration:${firstTweenSec.toFixed(2)},ease:'back.out(1.5)'},${focusAts[0].toFixed(2)});`);

      for (let index = 1; index < boxes.length; index++) {
        const target = boxes[index];
        const beat = beatForFocus(index);
        const tweenSec = Number(beat?.tweenSec ?? shotBeatTweenSec('focus2'));
        const at = focusAts[index].toFixed(2);
        parts.push(`  tl.to('#shot',{y:${r(focusYs[index])},duration:${tweenSec.toFixed(2)},ease:'power2.inOut'},${at});`);
        // 每一拍都以第一框為原點寫絕對 transform；N>2 時不會累積前一拍的相對誤差。
        parts.push(`  tl.to('#hl',{x:${r(target.left - b1.left)},y:${r(target.top - b1.top)},width:${r(target.width)},height:${r(target.height)},duration:${tweenSec.toFixed(2)},ease:'power2.inOut'},${at});`);
      }

      if (g2) {
        const at = secondAt.toFixed(2);
        parts.push(`  tl.set('#shot2',{y:${r(g2.y)},autoAlpha:0},0);`);
        parts.push(`  tl.set('#hl2',{autoAlpha:0,scale:.82},0);`);
        // 跨頁不是閃切：兩頁在同一拍交叉淡變，避免一幀黑場也保留換頁感。
        parts.push(`  tl.to('#shot',{autoAlpha:0,duration:${SHOT_BEAT_TIMING.secondSec.toFixed(2)},ease:'power2.inOut'},${at});`);
        parts.push(`  tl.to('#shot2',{autoAlpha:1,duration:${SHOT_BEAT_TIMING.secondSec.toFixed(2)},ease:'power2.inOut'},${at});`);
        parts.push(`  tl.fromTo('#shot2',{scale:1},{scale:1.03,duration:${dur.toFixed(2)},ease:'none'},0);`);
        parts.push(`  tl.to('#hl2',{autoAlpha:1,scale:1,duration:${SHOT_BEAT_TIMING.secondSec.toFixed(2)},ease:'back.out(1.5)'},${at});`);
        if (g2.b2) {
          // 第二頁內的細部收框是同一拍的第二階段；planner 把「交叉淡變＋停一拍＋收框」
          // 全算進 arrivalSec，P4 再從最後到位處量可讀停留。
          const scheduledAt2 = secondAt + SHOT_BEAT_TIMING.secondSec
            + SHOT_BEAT_TIMING.secondFocus2DelaySec;
          const fallbackLatest = dur - SHOT_BEAT_TIMING.secondFocus2Sec - 0.05;
          const at2 = secondBeat
            ? scheduledAt2 : Math.min(fallbackLatest, Math.max(secondAt, scheduledAt2));
          if (at2 >= secondAt && at2 <= fallbackLatest) {
            parts.push(`  tl.to('#shot2',{y:${r(g2.yB)},duration:${SHOT_BEAT_TIMING.secondFocus2Sec.toFixed(2)},ease:'power2.inOut'},${at2.toFixed(2)});`);
            parts.push(`  tl.to('#hl2',{x:${r(g2.b2.left - g2.b.left)},y:${r(g2.b2.top - g2.b.top)},width:${r(g2.b2.width)},height:${r(g2.b2.height)},duration:${SHOT_BEAT_TIMING.secondFocus2Sec.toFixed(2)},ease:'power2.inOut'},${at2.toFixed(2)});`);
          }
        }
      }
      return `\n${parts.join('\n')}\n`;
    };
    return { css, body, tl };
  },
};
