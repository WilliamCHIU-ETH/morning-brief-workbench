#!/usr/bin/env node
/**
 * 台股晨報主片組裝器（HyperFrames 線）。
 *
 * 這支程式存在的理由：auditor-format（85 行）與鼎元（75 行）各自手寫了一份 build-main.mjs，
 * 其中 28 行完全相同，而不同的那些行有一半是「不該不同」的 —— title-board 的 padding
 * 從 20px 32px 飄成 18px 30px、line-height 從 1.2 飄成 1.18，沒有任何地方定義過那組值。
 * 有規格的不飄（broll 與 caption 三支片位元組相同），沒家的才飄。
 *
 * 所以：版位一律讀 template/layout.json，每支片不同的東西一律讀 ledger 或 main.config.json。
 * 這支程式裡不得出現任何寫死的座標、顏色、字級或秒數。
 *
 * 用法（在專案根目錄）：
 *
 *   node scripts/build-main.mjs
 *
 * 讀什麼（全部相對於專案根）：
 *
 *   template/layout.json      版位唯一來源
 *   template/header.mjs       header 片段產生器
 *   segment-ledger.json       durationSec / visualForm / segments[]
 *   caption-ledger.json       字幕分段（陣列，或 {captions:[]}）
 *   script.txt      標題兩行（=== 區塊）
 *   renders/                  逐格 B-roll 成品，檔名以 <段號>- 開頭
 *   main.config.json          （選用）這支片的開關，見下
 *
 * main.config.json 全部欄位都可省略，省略時的預設值刻意等於 2026-08-25 鼎元成片的行為，
 * 這樣「抽進版型層」這件事本身可以先被驗證沒有走鐘，再逐項打開新功能：
 *
 *   {
 *     "compositionId": "<package.json 的 name>-main",
 *     "topBar":  "title-board",   // "header" | "title-board" | "none"
 *     "intro":   false,           // 開場卡（layout.intro.durationSec 秒）
 *     "openTitle": false,         // 主播模糊開場；與 intro 互斥，不增加片長
 *     "titleBoard": null,         // "hook" = 標題板改放正文 HOOK；null = 原片名
 *     "bgm":     false,           // 背景音樂；build-main 自動補混剛好片長的音軌
 *     "lead":    0,               // 素材格畫面前導秒數，實際值會依相鄰格與開場夾限
 *     "brandFrame": false,        // 底部品牌光暈
 *     "brollAudio": null,         // null = 依 layout.broll.audio.enabled
 *     "title": { "date": null, "label": null, "line2": null }  // null = 從講稿標題解析
 *   }
 *
 * topBar 為什麼是互斥的三選一：header-overlay-v2.png 的藍色 banner 在 y 0–375 不透明，
 * 會把 y 74–222 的 title-board 完全蓋掉。兩個一起開只會得到互相遮蔽的畫面。
 *
 * BGM 為什麼要預先混好：BGM.mp3 只有 52.0 秒，晨報成片通常 60 秒以上，直接掛會斷；
 * 而 hyperframes 0.8.3 有 data-loop／data-volume 但沒有 fade 屬性。所以 loop、fade 與
 * volume 一律由 ffmpeg 先做進一條剛好長度的軌。缺檔或片長不符時本程式會自動重混；
 * ffmpeg 真失敗才印出等價指令並停止，不會默默出一支沒有配樂的片。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { greetingWindow, openTitleEnd as resolveOpenTitleEnd, resolveLeads } from './lib/lead.mjs';
import { textTimeMatches } from './lib/rhythm.mjs';
import { requireFresh, resolveProject } from './lib/project.mjs';
// renderHeader 只在 topBar==='header' 時才需要，動態載入——
// template/header.mjs 目前沒人寫過（topBar 預設 title-board，這條路徑從未被走過），
// 靜態 import 會讓每一支不用 header 的片也在載入期就爆掉。真的選了 topBar=header
// 才在下面 die() 出「這個檔案不存在」，而不是無論用不用都先炸。

const here = path.dirname(fileURLToPath(import.meta.url));
const die = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };
let P;
try { P = resolveProject(); }
catch (e) { die(e.message); }
const root = P.root;
const readJson = (rel) => {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) die(`找不到 ${rel}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return die(`${rel} 不是合法 JSON：${e.message}`); }
};
const esc = (v) => String(v)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const n4 = (v) => Number(Number(v).toFixed(4));
const hexA = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) die(`brandWash.color 不是 #RRGGBB：${hex}`);
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// ── 輸入 ───────────────────────────────────────────────────────────────────

const L = readJson('template/layout.json');
const ledger = readJson('segment-ledger.json');
const captionsRaw = readJson('caption-ledger.json');
const captionInput = Array.isArray(captionsRaw) ? captionsRaw : captionsRaw.captions;
if (!Array.isArray(captionInput) || !captionInput.length) die('caption-ledger.json 沒有字幕');
const captions = captionInput.map((caption) => {
  const measured = Number(caption.end) - Number(caption.start);
  if (!Number.isFinite(measured) || !Number.isFinite(caption.duration)
    || Math.abs(Number(caption.duration) - measured) > 0.002) {
    die(`字幕 ${caption.id ?? '（無 id）'} 的 duration=${caption.duration}，但 end−start=${Number.isFinite(measured) ? measured.toFixed(4) : '無法計算'}；差距必須 <=0.002s。`);
  }
  return { ...caption, duration: n4(measured) };
});

const segments = ledger.segments;
if (!Array.isArray(segments) || !segments.length) die('segment-ledger.json 沒有 segments');
if (typeof ledger.durationSec !== 'number') die('segment-ledger.json 缺 durationSec');

const cfgFile = path.join(root, 'main.config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};

const pkg = fs.existsSync(path.join(root, 'package.json'))
  ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) : {};
const compositionId = cfg.compositionId || `${pkg.name || 'main'}-main`;

const TOP_BARS = new Set(['header', 'title-board', 'none']);
const topBar = cfg.topBar ?? 'title-board';
if (!TOP_BARS.has(topBar)) die(`topBar 只能是 ${[...TOP_BARS].join(' / ')}，收到 ${topBar}`);

const useIntro = cfg.intro === true;
const openTitleConfig = cfg.openTitle;
const openTitleObjectMode = openTitleConfig !== null && typeof openTitleConfig === 'object'
  && !Array.isArray(openTitleConfig);
if (![undefined, null, false, true].includes(openTitleConfig) && !openTitleObjectMode)
  die(`openTitle 必須是 boolean 或物件，收到 ${JSON.stringify(openTitleConfig)}`);
const useOpenTitle = openTitleConfig === true || openTitleObjectMode;
if (useIntro && useOpenTitle)
  die('main.config.json 的 intro 與 openTitle 互斥：兩者都會佔用開場時間，請只開一個。');
const preRollSec = openTitleObjectMode ? Number(openTitleConfig.preRollSec ?? 0) : 0;
if (!Number.isFinite(preRollSec) || preRollSec < 0)
  die(`openTitle.preRollSec 必須是 >=0 的有限秒數，收到 ${JSON.stringify(openTitleConfig?.preRollSec)}`);
const openTitleStyle = openTitleObjectMode
  ? (openTitleConfig.style ?? L.openTitle?.style?.default ?? 'plain') : 'plain';
if (!['plain', 'cover'].includes(openTitleStyle))
  die(`openTitle.style 只能是 plain 或 cover，收到 ${JSON.stringify(openTitleStyle)}`);
const useCoverTitle = openTitleObjectMode && openTitleStyle === 'cover';

const titleBoardConfig = cfg.titleBoard;
const titleBoardObjectMode = titleBoardConfig !== null && typeof titleBoardConfig === 'object'
  && !Array.isArray(titleBoardConfig);
const titleBoardMode = titleBoardObjectMode ? titleBoardConfig.mode : titleBoardConfig;
if (titleBoardObjectMode && titleBoardMode !== 'hook')
  die(`titleBoard 物件模式的 mode 必須是 "hook"，收到 ${JSON.stringify(titleBoardMode)}`);
if (titleBoardMode !== undefined && titleBoardMode !== null && titleBoardMode !== 'hook')
  die(`titleBoard 目前只接受 "hook" 或 {mode:"hook",accent:"gold"}；收到 ${JSON.stringify(titleBoardConfig)}`);
const titleBoardAccent = titleBoardObjectMode ? (titleBoardConfig.accent ?? null) : null;
if (titleBoardAccent !== null && titleBoardAccent !== 'gold')
  die(`titleBoard.accent 目前只接受 "gold"，收到 ${JSON.stringify(titleBoardAccent)}`);
const useHookTitle = titleBoardMode === 'hook';
const useBgm = cfg.bgm === true;
const brandFrameConfig = cfg.brandFrame;
if (![undefined, null, false, true, 'warm'].includes(brandFrameConfig))
  die(`brandFrame 只能是 boolean 或 "warm"，收到 ${JSON.stringify(brandFrameConfig)}`);
const useBrandFrame = brandFrameConfig === true || brandFrameConfig === 'warm';
const useWarmBrandFrame = brandFrameConfig === 'warm';
const leadSec = cfg.lead ?? 0;
if (typeof leadSec !== 'number' || !Number.isFinite(leadSec) || leadSec < 0)
  die(`lead 必須是大於等於 0 的秒數，收到 ${JSON.stringify(leadSec)}`);
const brollAudio = cfg.brollAudio ?? Boolean(L.broll.audio?.enabled);

// ── 標題：從講稿的 === 區塊解析 ────────────────────────────────────────────
// 切法與 app/scripts/script-utils.js 的 getTitleText 一致（支援三段式與前台四段式），
// 但不能 import 它 —— HyperFrames 專案必須自我完備才能兩個 session 同時 render。

function parseTitle() {
  const file = path.join(root, 'script.txt');
  if (!fs.existsSync(file)) return { date: null, label: null, line2: null };
  const parts = fs.readFileSync(file, 'utf8').split('===');
  const block = parts.length >= 3 ? (parts[parts.length - 2] || '') : (parts[0] || '');
  const lines = block.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  const [first = '', second = ''] = lines;
  const m = first.match(/^(\S+)\s+(.*)$/);
  return {
    date: m ? m[1].replace(/\D/g, '') : null,   // '08/21' → '0821'（layout.header.dateFormat = MMDD）
    label: m ? m[2] : (first || null),
    line1: first || null,
    line2: second || null,
  };
}

const parsed = parseTitle();
const title = {
  date: cfg.title?.date ?? parsed.date,
  label: cfg.title?.label ?? parsed.label,
  line1: cfg.title?.line1 ?? parsed.line1,
  line2: cfg.title?.line2 ?? parsed.line2,
};

function parseHook() {
  const file = path.join(root, 'script.txt');
  if (!fs.existsSync(file)) return null;
  const parts = fs.readFileSync(file, 'utf8').split('===');
  const body = parts.length >= 3 ? (parts.at(-1) || '') : '';
  const sentences = body.match(/[^。！？]*[。！？]/gu) ?? [];
  return sentences
    .map((s) => s.replace(/\s*\n\s*/g, '').trim())
    .find((s) => s.endsWith('？')) ?? null;
}

const oldOpenTitleMode = openTitleConfig === true;
const needsHook = useHookTitle || oldOpenTitleMode;
const hook = needsHook ? parseHook() : null;
const hookLine1 = title.date && title.label ? `${title.date} ${title.label}` : null;
if (needsHook && !hook)
  die('titleBoard=hook 或 openTitle=true 需要正文第一個以「？」結尾的完整句子，但 script.txt 找不到。');
if ((needsHook || (openTitleObjectMode && openTitleConfig.kicker === true)) && !hookLine1)
  die('HOOK 標題需要日期與片型；講稿標題第一行解析失敗，請在 main.config.json 的 title 指定 date／label。');

let openTitleContent = null;
if (openTitleObjectMode) {
  const maxChars = Number(L.openTitle?.main?.maxCharsPerLine);
  if (!Number.isInteger(maxChars) || maxChars <= 0)
    die('openTitle 物件模式需要 layout.openTitle.main.maxCharsPerLine（正整數）');
  const main = openTitleConfig.main;
  let lines;
  if (Array.isArray(main)) {
    if (!main.length || main.length > 2)
      die(`openTitle.main 陣列只能明寫 1～2 行，收到 ${main.length} 行`);
    if (main.some((line) => typeof line !== 'string' || !line.trim()))
      die('openTitle.main 陣列每一行都必須是非空字串');
    lines = main.map((line) => line.trim());
  } else if (typeof main === 'string' && main.trim()) {
    const chars = [...main.trim()];
    if (chars.length <= maxChars) {
      lines = [chars.join('')];
    } else {
      if (chars.length > maxChars * 2)
        die(`openTitle.main 最多兩行、每行 ${maxChars} 字；收到 ${chars.length} 字`);
      const middle = Math.ceil(chars.length / 2);
      const punctuation = /[，、：；！？。]/u;
      const candidates = chars.map((ch, index) => ({ ch, cut: index + 1 }))
        .filter(({ ch, cut }) => punctuation.test(ch) && cut < chars.length
          && cut <= maxChars && chars.length - cut <= maxChars)
        .sort((a, b) => Math.abs(a.cut - middle) - Math.abs(b.cut - middle));
      const cut = candidates[0]?.cut ?? middle;
      lines = [chars.slice(0, cut).join(''), chars.slice(cut).join('')];
    }
  } else {
    die('openTitle.main 是空的。init-project 刻意留空：這是編輯意圖，從講稿 HOOK 提煉'
      + ' 8 字主標（超過 layout 上限會走 4/4 兩行斷行）與一句 sub，填進 main.config.json 再重跑。');
  }
  if (lines.some((line) => [...line].length > maxChars))
    die(`openTitle.main 每行最多 ${maxChars} 字；收到「${lines.join('／')}」`);
  if (openTitleConfig.sub !== undefined && typeof openTitleConfig.sub !== 'string')
    die('openTitle.sub 必須是字串');
  if (openTitleConfig.kicker !== undefined && typeof openTitleConfig.kicker !== 'boolean')
    die('openTitle.kicker 必須是 boolean');
  openTitleContent = {
    lines,
    sub: openTitleConfig.sub?.trim() || null,
    kicker: openTitleConfig.kicker === true,
  };
}

if (topBar === 'header' && (!title.date || !title.label))
  die('topBar=header 需要 date 與 label；講稿標題第一行解析失敗，請在 main.config.json 的 title 指定');
if (topBar === 'title-board' && !title.line1)
  die('topBar=title-board 需要講稿標題；script.txt 的 === 區塊解析失敗');

// ── B-roll 檔名：從 renders/ 解析，不再手寫 NAMES 表 ───────────────────────
// 兩支手寫版各自維護一張 { '01': '01-tw-market' } 的對照表，那是 12 行純粹的抄寫工作，
// 而且抄錯不會有人發現（放錯格的 B-roll 一樣 render 得出來）。改成用段號前綴去比對，
// 命中 0 個或 2 個以上一律 fail closed。

const rendersDir = path.join(root, 'renders');
if (!fs.existsSync(rendersDir)) die('找不到 renders/');
const renderFiles = fs.readdirSync(rendersDir).filter((f) => f.toLowerCase().endsWith('.mp4'));

function resolveRender(segment) {
  if (segment.render) {
    if (!renderFiles.includes(segment.render))
      die(`段 ${segment.id} 的 ledger 指定 renders/${segment.render}，但檔案不存在`);
    return segment.render;
  }
  const id = String(segment.id);
  const hits = renderFiles.filter((f) => f === `${id}.mp4` || f.startsWith(`${id}-`));
  if (hits.length === 1) return hits[0];
  if (!hits.length)
    die(`段 ${id} 在 renders/ 找不到對應檔案（預期 ${id}.mp4 或 ${id}-*.mp4）。`
      + `目前有：${renderFiles.join('、') || '（空）'}`);
  return die(`段 ${id} 在 renders/ 命中多個檔案：${hits.join('、')}。`
    + '請在 segment-ledger.json 的該段加上 "render" 欄位指定唯一檔名');
}

// 只有 mg 段需要 renders/ 裡的檔案——avatar 影片本身是貫穿全片的一條 clip（見下方
// #avatar），presenter 段沒有素材蓋在上面，本來就不該去 renders/ 找對應檔案。
const shots = segments.filter((s) => s.form === 'mg').map((s, i) => {
  const duration = typeof s.durationSec === 'number'
    ? s.durationSec : n4(s.endSec - s.startSec);
  if (!(duration > 0)) die(`段 ${s.id} 的長度不是正數`);
  return { id: s.id, index: i, start: s.startSec, duration, file: resolveRender(s) };
});

// ── 時間軸：開場卡會把所有東西往後推 ───────────────────────────────────────

const introSec = useIntro ? Number(L.intro.durationSec) : 0;
if (useIntro && !(introSec > 0)) die('layout.json 的 intro.durationSec 不是正數');
const bodyDur = ledger.durationSec;
const timelineOffset = n4(introSec + preRollSec);
const totalDur = n4(bodyDur + timelineOffset);
const shift = (t) => n4(Number(t) + timelineOffset);

let openTitleEnd = 0;
try { openTitleEnd = resolveOpenTitleEnd(openTitleConfig, L); }
catch (e) { die(e.message); }

// 問候窗只服務 opt-in 的 lead；沒開 lead 時不得多讀 charTimes，維持預設路徑隔離。
let greetingEnd = 0;
if (leadSec > 0) {
  const charTimesFile = path.join(root, 'asr', 'script-char-times.json');
  let greeting = null;
  if (fs.existsSync(charTimesFile)) {
    const rawCharTimes = readJson('asr/script-char-times.json');
    const charTimes = Array.isArray(rawCharTimes)
      ? rawCharTimes : (rawCharTimes.chars ?? rawCharTimes.items ?? []);
    greeting = greetingWindow(charTimes);
  } else {
    console.error('⚠️ asr/script-char-times.json 不存在，問候夾限退回 caption-ledger.json。');
    const captionChars = captions.flatMap((caption) => [...String(caption.text ?? '')]
      .map((ch) => ({ ch, start: caption.start, end: caption.end })));
    greeting = greetingWindow(captionChars);
  }
  greetingEnd = greeting ? shift(greeting.end) : 0;
}
const leadShots = shots.map((shot) => ({ ...shot, start: shift(shot.start) }));
const leads = resolveLeads({ shots: leadShots, leadSec, openTitleEnd, greetingEnd });
const renderShots = shots.map((shot) => ({ ...shot, ...leads.get(shot.id) }));

// plan-mg 與 build-main 必須使用同一份 actualLead；先驗 provenance，再使用計畫與 slots。
try { requireFresh(P, 'mg-plan.json'); }
catch (e) { die(e.message); }
const mgPlanRaw = readJson('mg-plan.json');
const mgPlanSlots = Array.isArray(mgPlanRaw) ? mgPlanRaw : mgPlanRaw.slots;
if (!Array.isArray(mgPlanSlots)) die('mg-plan.json 沒有 slots 陣列');
for (const shot of renderShots) {
  const planned = mgPlanSlots.find((slot) => String(slot.id) === String(shot.id));
  const plannedLead = planned?.actualLead ?? (leadSec === 0 ? 0 : NaN);
  if (!planned || !Number.isFinite(plannedLead) || !Number.isFinite(planned.durationSec)
    || Math.abs(plannedLead - shot.actualLead) > 0.01
    || Math.abs(Number(planned.durationSec) - shot.renderDuration) > 0.01) {
    die(`格 ${shot.id} 的 mg-plan.json 前導與 build-main 不同，重跑 plan-mg 與 render slots。`);
  }

  shot.visualWindow = planned.visualWindow ?? null;
  shot.beats = planned.beats ?? [];
  shot.clipStart = shot.renderStart;
  shot.clipDuration = shot.renderDuration;
  shot.mediaStart = 0;
  if (shot.visualWindow) {
    const window = shot.visualWindow;
    if (!Number.isFinite(window.enterSec) || !Number.isFinite(window.exitSec)
      || window.enterSec < shot.start - 0.001 || window.exitSec > shot.start + shot.duration + 0.001
      || window.exitSec <= window.enterSec || !Number.isFinite(window.fadeSec) || window.fadeSec <= 0) {
      die(`格 ${shot.id} 的 visualWindow 不合法或超出該句段界；重跑 plan-mg，不要手改 mg-plan.json。`);
    }
    if (!Array.isArray(shot.beats) || !shot.beats.length) {
      die(`格 ${shot.id} 有 visualWindow 卻沒有 beats；重跑 plan-mg。`);
    }
    let cursor = 0;
    for (const beat of shot.beats) {
      if (typeof beat.anchor !== 'string' || !beat.anchor.length) {
        die(`格 ${shot.id} 有空的拍點文字錨；shot-plan 的每個 focus／second 都要對到該格句子。`);
      }
      const at = String(segments.find((segment) => String(segment.id) === String(shot.id))?.anchor ?? '')
        .indexOf(beat.anchor, cursor);
      if (at < 0) {
        die(`格 ${shot.id} 的拍點文字錨「${beat.anchor}」不在該格句子內或順序不符。`
          + '請重截讓 shot-plan target 與旁白成對，或改寫 responsibility／用 plan-hints.json 押回主播，再重跑 plan-mg。');
      }
      cursor = at + beat.anchor.length;
      if (!Number.isFinite(beat.atSec) || !Number.isFinite(beat.endSec)
        || beat.atSec < window.enterSec - 0.001 || beat.endSec > window.exitSec + 0.001) {
        die(`格 ${shot.id} 的拍點「${beat.anchor}」未被 visualWindow 完整涵蓋；重跑 plan-mg。`);
      }
    }
    shot.clipStart = shift(window.enterSec);
    shot.clipDuration = n4(window.exitSec - window.enterSec);
    shot.mediaStart = n4(shot.actualLead + window.enterSec - shot.start);
  }
  let renderDuration;
  try {
    renderDuration = Number(execFileSync('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(rendersDir, shot.file)],
      { encoding: 'utf8' }).trim());
  } catch { /* 交給下面的 fail-closed 訊息 */ }
  if (!Number.isFinite(renderDuration) || renderDuration < shot.renderDuration - 0.05) {
    die(`格 ${shot.id} 的 renders/${shot.file} 長度 ${Number.isFinite(renderDuration) ? `${renderDuration.toFixed(3)}s` : '無法讀取'}，短於需要的 ${shot.renderDuration.toFixed(3)}s；請重跑 npm run render -- --project ${root} slots。`);
  }
}

// ── 強調字：專案有 emphasis.json 才啟用；match 一律落到真正的逐字時間 ─────────

const materialWindows = renderShots.map((shot) => ({
  id: shot.id,
  anchor: segments.find((segment) => String(segment.id) === String(shot.id))?.anchor ?? '',
  renderStart: shot.clipStart,
  nominalStart: shift(shot.start),
  renderEnd: n4(shot.clipStart + shot.clipDuration),
}));
const alignEmphasisExit = ({ where, label, displayStart, exitAnchor, naturalEnd, exitMatch = null }) => {
  const EPS = 0.0001;
  // 段首第一字常比 ledger cut 晚幾十毫秒；文字錨若就是下一段（或其視覺窗口）的前綴，
  // 語意切點仍是段界，不能因 ASR 的起音延遲或淡出尾巴讓卡片壓住素材。視覺窗口
  // 沒有前導時 renderStart == nominalStart，所以不能只靠前導區間判斷：只要退場
  // 區間（錨到淡出結束）確實觸到該格開頭，就收攏到 renderStart。
  const ASR_ONSET_SLACK = 0.15;
  const aligned = materialWindows.find((shot) => (shot.renderStart < shot.nominalStart - EPS
    && ((exitAnchor >= shot.renderStart - EPS && exitAnchor <= shot.nominalStart + EPS)
      || (exitMatch && String(shot.anchor).startsWith(exitMatch))))
    || (exitMatch && String(shot.anchor).startsWith(exitMatch)
      && exitAnchor <= shot.renderStart + ASR_ONSET_SLACK
      && naturalEnd > shot.renderStart - EPS));
  const exitAt = aligned ? aligned.renderStart : naturalEnd;
  const advance = aligned ? Math.max(0, n4(exitAnchor - aligned.renderStart)) : 0;
  for (const shot of materialWindows) {
    const overlap = Math.max(0,
      n4(Math.min(exitAt, shot.renderEnd) - Math.max(displayStart, shot.renderStart)));
    if (overlap > advance + EPS) {
      die(`${where}「${label}」顯示 ${displayStart.toFixed(3)}–${exitAt.toFixed(3)}s，與素材格 ${shot.id} `
        + `${shot.renderStart.toFixed(3)}–${shot.renderEnd.toFixed(3)}s 重疊 ${overlap.toFixed(3)}s，`
        + `超過前導收合可容許的 ${advance.toFixed(3)}s。`);
    }
  }
  return { exitAt: n4(exitAt), advance, alignedShot: aligned?.id ?? null };
};

const emphasisFile = path.join(root, 'emphasis.json');
let emphasis = [];
if (fs.existsSync(emphasisFile)) {
  let rawEmphasis;
  try { rawEmphasis = JSON.parse(fs.readFileSync(emphasisFile, 'utf8')); }
  catch (e) { die(`emphasis.json 不是合法 JSON：${e.message}`); }
  if (!Array.isArray(rawEmphasis)) die('emphasis.json 必須是陣列');

  const charTimesFile = path.join(root, 'asr', 'script-char-times.json');
  if (!fs.existsSync(charTimesFile)) {
    die('emphasis.json 需要 asr/script-char-times.json 才能讓 item 在唸到時進場；先跑 ASR／align。');
  }
  const rawCharTimes = readJson('asr/script-char-times.json');
  const emphasisCharTimes = Array.isArray(rawCharTimes)
    ? rawCharTimes : (rawCharTimes.chars ?? rawCharTimes.items ?? []);
  const timeFor = (match, where) => {
    if (typeof match !== 'string' || !match.length) die(`${where} 的 match 必須是非空字串`);
    const hits = textTimeMatches(emphasisCharTimes, match);
    if (hits.length !== 1) {
      const listed = hits.length
        ? hits.map((hit) => `${hit.startSec.toFixed(2)}–${hit.endSec.toFixed(2)}s`).join('、')
        : '（沒有命中）';
      die(`${where} 的 match「${match}」必須唯一命中 asr/script-char-times.json，實際 ${hits.length} 次：${listed}`);
    }
    return hits[0];
  };

  const requireExitWithinDuration = (where, exitAt) => {
    if (exitAt > totalDur) {
      die(`${where} 的退場時間 ${exitAt.toFixed(3)}s 超過 durationSec ${totalDur}s，超出 ${(exitAt - totalDur).toFixed(3)}s。`);
    }
  };
  emphasis = rawEmphasis.map((entry, index) => {
    const where = `emphasis.json 第 ${index + 1} 項`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) die(`${where} 必須是物件`);
    if (entry.type === 'pop') {
      if (typeof entry.text !== 'string' || !entry.text.length) die(`${where} 的 pop.text 必須是非空字串`);
      if (typeof entry.holdSec !== 'number' || !Number.isFinite(entry.holdSec) || entry.holdSec < 0)
        die(`${where} 的 pop.holdSec 必須是大於等於 0 的秒數`);
      if (entry.style !== undefined && entry.style !== 'stamp')
        die(`${where} 的 pop.style 目前只接受 "stamp"`);
      const timing = timeFor(entry.match, `${where} pop`);
      const at = shift(timing.startSec);
      const naturalExit = n4(at + L.emphasis.pop.inSec + entry.holdSec + L.emphasis.pop.outSec);
      requireExitWithinDuration(where, naturalExit);
      const aligned = alignEmphasisExit({
        where, label: entry.text, displayStart: at,
        exitAnchor: naturalExit, naturalEnd: naturalExit,
      });
      return {
        ...entry,
        kind: 'pop',
        id: `emphasis-pop-${index + 1}`,
        at,
        exitAt: aligned.exitAt,
        fadeAt: n4(aligned.exitAt - L.emphasis.pop.outSec),
      };
    }
    if (entry.type === 'list') {
      if (typeof entry.title !== 'string' || !entry.title.length) die(`${where} 的 list.title 必須是非空字串`);
      if (!Array.isArray(entry.items) || !entry.items.length) die(`${where} 的 list.items 必須是非空陣列`);
      const items = entry.items.map((item, itemIndex) => {
        if (!item || typeof item.text !== 'string' || !item.text.length)
          die(`${where} 第 ${itemIndex + 1} 個 item.text 必須是非空字串`);
        const timing = timeFor(item.match, `${where} 第 ${itemIndex + 1} 個 item`);
        return {
          ...item,
          id: `emphasis-list-${index + 1}-item-${itemIndex + 1}`,
          at: shift(timing.startSec),
        };
      });
      const until = timeFor(entry.untilMatch, `${where} untilMatch`);
      const untilAt = shift(until.startSec);
      // titleMatch 是卡片（標題）自己的進場錨；沒有就沿用第一項的時間。
      // 標題不得晚於第一項——item 進場動畫掛在卡片底下，卡片還沒現身 item 會憑空出現。
      let cardAt = items[0].at;
      if (entry.titleMatch !== undefined) {
        const titleTiming = timeFor(entry.titleMatch, `${where} titleMatch`);
        cardAt = shift(titleTiming.startSec);
        if (cardAt > items[0].at) {
          die(`${where} 的 titleMatch「${entry.titleMatch}」時間 ${cardAt}s 晚於第一個 item「${items[0].text}」${items[0].at}s；`
            + `標題必須先於（或同時於）第一項進場。`);
        }
      }
      for (let itemIndex = 1; itemIndex < items.length; itemIndex++) {
        if (items[itemIndex].at < items[itemIndex - 1].at) {
          die(`${where} 的 item 順序反了：「${items[itemIndex - 1].text}」${items[itemIndex - 1].at}s 晚於「${items[itemIndex].text}」${items[itemIndex].at}s。`);
        }
      }
      for (const item of items) {
        if (item.at >= untilAt)
          die(`${where} 的 item「${item.text}」時間 ${item.at}s 必須早於 untilMatch ${untilAt}s。`);
      }
      const naturalExit = n4(untilAt + L.emphasis.list.outSec);
      requireExitWithinDuration(where, naturalExit);
      const aligned = alignEmphasisExit({
        where, label: entry.title, displayStart: cardAt,
        exitAnchor: untilAt, naturalEnd: naturalExit, exitMatch: entry.untilMatch,
      });
      return {
        ...entry,
        kind: 'list',
        id: `emphasis-list-${index + 1}`,
        items,
        at: cardAt,
        untilAt,
        exitAt: aligned.exitAt,
        fadeAt: n4(aligned.exitAt - L.emphasis.list.outSec),
      };
    }
    return die(`${where} 的 type 只能是 pop 或 list，收到 ${JSON.stringify(entry.type)}`);
  });
}

// ── CSS ───────────────────────────────────────────────────────────────────

const form = ledger.visualForm === 'fullframe'
  ? { ...L.broll, ...L.broll.fullframe } : L.broll;
if (ledger.visualForm && !['card', 'fullframe'].includes(ledger.visualForm))
  die(`segment-ledger.json 的 visualForm 只能是 card 或 fullframe，收到 ${ledger.visualForm}`);

const T = L.tracks;
const cap = L.caption;
const inner = cap.inner;
const tb = L.titleBoard;
const theme = L.theme;
if ((useCoverTitle || titleBoardAccent === 'gold' || useWarmBrandFrame)
  && !(theme?.goldLight && theme?.gold && theme?.amber && theme?.inkBrown && theme?.inkDeep))
  die('cover／gold／warm 主題需要完整的 layout.theme token');
const effectiveTitleAccent = titleBoardAccent ?? tb.accent ?? null;
const titleBoardBorderColor = effectiveTitleAccent === 'gold' ? theme.amber : tb.borderColor;
const titleBoardAccentCss = effectiveTitleAccent === 'gold'
  ? `;border-left:${tb.accentWidth}px solid ${theme.gold}` : '';
let hdr = null;
if (topBar === 'header') {
  let renderHeader;
  try {
    ({ renderHeader } = await import('../template/header.mjs'));
  } catch {
    die('topBar=header 需要 template/header.mjs（header 片段產生器），但這個檔案不存在。'
      + '目前只有 title-board 這個 topBar 有實作。');
  }
  hdr = renderHeader({ date: title.date, label: title.label, layout: L });
}

const BW = L.brandWash;
const brandCss = BW ? `
#brandwash{position:absolute;left:0;top:0;width:${L.canvas.width}px;height:${BW.height}px;background:linear-gradient(180deg,${BW.color} 0%,${hexA(BW.color, BW.midStopAlpha)} ${BW.midStopPct}%,${hexA(BW.color, 0)} 100%);pointer-events:none}
#brandlogo{position:absolute;left:${BW.logo.left}px;top:${BW.logo.top}px;width:${BW.logo.width}px;height:${BW.logo.height}px}` : '';

const brandHtml = BW ? `    <div id="brandwash"></div>
    <img id="brandlogo" src="assets/${BW.logo.asset}" alt="" />` : '';

const titleBoardCss = topBar === 'title-board' ? (useHookTitle ? `
.title-board{position:absolute;left:${tb.left}px;top:${tb.top}px;width:${tb.width}px;height:auto;min-height:${tb.hook.minHeight}px;padding:${tb.hook.padding};border-radius:${tb.borderRadius}px;background:${tb.background};color:${tb.color};border:${tb.borderWidth}px solid ${titleBoardBorderColor}${titleBoardAccentCss};transform:rotate(${tb.rotateDeg}deg);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;line-height:${tb.hook.lineHeight};box-shadow:${tb.boxShadow}}
.title-board .tl1{font-size:${tb.hook.line1.fontSize}px;font-weight:${tb.hook.line1.fontWeight};color:${tb.hook.line1.color};margin-bottom:${tb.hook.line1.marginBottom}px}
.title-board .tl2{font-size:${tb.hook.line2.fontSize}px;font-weight:${tb.hook.line2.fontWeight};line-height:${tb.hook.line2.lineHeight};color:${tb.hook.line2.color}}` : `
.title-board{position:absolute;left:${tb.left}px;top:${tb.top}px;width:${tb.width}px;height:${tb.height}px;padding:${title.line2 ? tb.twoLine.padding : tb.oneLine.padding};border-radius:${tb.borderRadius}px;background:${tb.background};color:${tb.color};border:${tb.borderWidth}px solid ${tb.borderColor};transform:rotate(${tb.rotateDeg}deg);display:flex;${title.line2 ? 'flex-direction:column;' : ''}align-items:center;justify-content:center;text-align:center;${title.line2 ? '' : `font-size:${tb.oneLine.fontSize}px;font-weight:700;`}line-height:${title.line2 ? tb.twoLine.lineHeight : tb.oneLine.lineHeight};box-shadow:${tb.boxShadow}}${title.line2 ? `
.title-board .tl1{font-size:${tb.twoLine.line1.fontSize}px;font-weight:${tb.twoLine.line1.fontWeight};color:${tb.twoLine.line1.color}}
.title-board .tl2{font-size:${tb.twoLine.line2.fontSize}px;font-weight:${tb.twoLine.line2.fontWeight}}` : ''}`) : '';

// 開場卡改為程式畫（layout.json 的 intro.programDrawn）。不再吃 intro-frame.jpg——
// 那張烙印「盤後日報」，且疊字會與烙印字重疊（2026-08-25 實測）。程式畫從此不會有烙印錯字。
const IP = L.intro.programDrawn;
const introCss = useIntro ? `
#intro-frame{position:absolute;left:0;top:0;width:${L.canvas.width}px;height:${L.canvas.height}px;background:${IP.background}}
#intro-logo{position:absolute;left:${Math.round((L.canvas.width - IP.logo.width) / 2)}px;top:${IP.logo.top}px;width:${IP.logo.width}px;height:${IP.logo.height}px}
.intro-line1{position:absolute;left:0;top:${IP.line1.top}px;width:${L.canvas.width}px;font-size:${IP.line1.fontSize}px;color:${IP.line1.color};font-weight:700;line-height:1;text-align:center}
.intro-line2{position:absolute;left:${Math.round((L.canvas.width - IP.line2.maxWidth) / 2)}px;top:${IP.line2.top}px;width:${IP.line2.maxWidth}px;font-size:${IP.line2.fontSize}px;color:${IP.line2.color};font-weight:700;line-height:${IP.line2.lineHeight};text-align:center}` : '';

const OT = L.openTitle;
const coverStyle = OT?.style?.cover;
if (useCoverTitle && !coverStyle) die('openTitle.style=cover 需要 layout.openTitle.style.cover token');
const openTitleCss = useCoverTitle ? `
#open-title{position:absolute;left:${OT.panel.left}px;top:${OT.panel.top}px;width:${OT.panel.width}px;height:${OT.panel.height}px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:${OT.panel.textAlign};pointer-events:none}
#open-title-kicker{font-size:${OT.kicker.fontSize}px;font-weight:${OT.kicker.fontWeight};line-height:${OT.kicker.lineHeight};letter-spacing:${OT.kicker.letterSpacing};color:${OT.kicker.color};margin-bottom:${OT.kicker.marginBottom}px;text-shadow:${OT.kicker.textShadow}}
#open-title-main{display:flex;flex-direction:column;align-items:center;justify-content:center;opacity:0}
.open-title-main-line1{position:relative;z-index:0;display:inline-block;font-size:${coverStyle.line1FontSize}px;font-weight:${OT.main.line1.fontWeight};line-height:${OT.main.line1.lineHeight};background-image:linear-gradient(${coverStyle.gradientAngleDeg}deg,${theme.goldLight},${theme.gold} ${coverStyle.goldStopPct}%,${theme.amber});-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;paint-order:stroke fill;-webkit-text-stroke:${coverStyle.line1StrokePx}px ${theme.inkBrown}}
.open-title-main-line2{position:relative;z-index:0;display:inline-block;font-size:${coverStyle.line2FontSize}px;font-weight:${OT.main.line2.fontWeight};line-height:${OT.main.line2.lineHeight};background-image:linear-gradient(${coverStyle.gradientAngleDeg}deg,${theme.goldLight},${theme.gold} ${coverStyle.goldStopPct}%,${theme.amber});-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;paint-order:stroke fill;-webkit-text-stroke:${coverStyle.line2StrokePx}px ${theme.inkBrown}}
.open-title-cover-line::before{content:attr(data-text);position:absolute;inset:0;z-index:-1;color:transparent;text-shadow:${coverStyle.outlineShadow}}
.open-title-main-line1.open-title-cover-line::before{-webkit-text-stroke:${coverStyle.line1OuterStrokePx}px ${coverStyle.outerStrokeColor}}
.open-title-main-line2.open-title-cover-line::before{-webkit-text-stroke:${coverStyle.line2OuterStrokePx}px ${coverStyle.outerStrokeColor}}
.open-title-cover-fill{position:absolute;inset:0;z-index:1;color:${theme.gold};-webkit-text-fill-color:${theme.gold};-webkit-text-stroke:0}
.open-title-cover-fill::before{content:attr(data-text);position:absolute;inset:0;color:${theme.goldLight};-webkit-text-fill-color:${theme.goldLight};-webkit-mask-image:linear-gradient(180deg,#000 0%,#000 ${coverStyle.goldStopPct}%,transparent 100%)}
.open-title-cover-fill::after{content:attr(data-text);position:absolute;inset:0;color:${theme.amber};-webkit-text-fill-color:${theme.amber};-webkit-mask-image:linear-gradient(180deg,transparent 0%,transparent ${coverStyle.goldStopPct}%,#000 100%)}
#open-title-sub{font-size:${OT.sub.fontSize}px;font-weight:${OT.sub.fontWeight};line-height:${OT.sub.lineHeight};color:${coverStyle.subColor};margin-top:${OT.sub.marginTop}px;padding:${coverStyle.subPadding};border-radius:${coverStyle.subBorderRadius}px;border-bottom:${coverStyle.subBorderBottomWidth}px solid ${theme.gold};background:${coverStyle.subBackground};text-shadow:${OT.sub.textShadow};opacity:0}` : (openTitleObjectMode ? `
#open-title{position:absolute;left:${OT.panel.left}px;top:${OT.panel.top}px;width:${OT.panel.width}px;height:${OT.panel.height}px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:${OT.panel.textAlign};pointer-events:none}
#open-title-kicker{font-size:${OT.kicker.fontSize}px;font-weight:${OT.kicker.fontWeight};line-height:${OT.kicker.lineHeight};letter-spacing:${OT.kicker.letterSpacing};color:${OT.kicker.color};margin-bottom:${OT.kicker.marginBottom}px;text-shadow:${OT.kicker.textShadow}}
#open-title-main{display:flex;flex-direction:column;align-items:center;justify-content:center;opacity:0}
.open-title-main-line1{font-size:${OT.main.line1.fontSize}px;font-weight:${OT.main.line1.fontWeight};line-height:${OT.main.line1.lineHeight};color:${OT.main.line1.color};text-shadow:${OT.main.line1.textShadow}}
.open-title-main-line2{font-size:${OT.main.line2.fontSize}px;font-weight:${OT.main.line2.fontWeight};line-height:${OT.main.line2.lineHeight};color:${OT.main.line2.color};text-shadow:${OT.main.line2.textShadow}}
#open-title-sub{font-size:${OT.sub.fontSize}px;font-weight:${OT.sub.fontWeight};line-height:${OT.sub.lineHeight};color:${OT.sub.color};margin-top:${OT.sub.marginTop}px;text-shadow:${OT.sub.textShadow};opacity:0}` : (useOpenTitle ? `
#open-title{position:absolute;left:${OT.panel.left}px;top:${OT.panel.top}px;width:${OT.panel.width}px;height:${OT.panel.height}px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:${OT.panel.textAlign};pointer-events:none}
#open-title-kicker{font-size:${OT.kicker.fontSize}px;font-weight:${OT.kicker.fontWeight};line-height:${OT.kicker.lineHeight};letter-spacing:${OT.kicker.letterSpacing};color:${OT.kicker.color};margin-bottom:${OT.kicker.marginBottom}px;text-shadow:${OT.kicker.textShadow}}
#open-title-hook{font-size:${OT.title.fontSize}px;font-weight:${OT.title.fontWeight};line-height:${OT.title.lineHeight};color:${OT.title.color};text-shadow:${OT.title.textShadow};display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${OT.title.maxLines};overflow:hidden}` : ''));

const BF = L.brandFrame;
const brandFrameColor = useBrandFrame
  ? (useWarmBrandFrame ? theme.amber : (BF.color ?? BW.color)) : null;
const brandFrameCss = useBrandFrame ? `
#brandframe-bottom{position:absolute;left:0;top:${BF.top}px;width:${L.canvas.width}px;height:${L.canvas.height - BF.top}px;background:linear-gradient(${BF.angleDeg}deg,${hexA(brandFrameColor, BF.startAlpha)},${hexA(brandFrameColor, BF.endAlpha)});pointer-events:none}` : '';

const E = L.emphasis;
const emphasisCss = emphasis.length ? `
.emphasis-pop{position:absolute;right:${E.pop.right}px;top:${E.pop.top}px;max-width:${E.pop.maxWidth}px;padding:${E.pop.padding};border-radius:${E.pop.borderRadius}px;background:${E.pop.background};color:${E.pop.color};font-size:${E.pop.fontSize}px;font-weight:${E.pop.fontWeight};line-height:${E.pop.lineHeight};text-align:${E.pop.textAlign};box-shadow:${E.pop.boxShadow};transform-origin:${E.pop.transformOrigin};opacity:0}
.emphasis-pop.stamp{background:${E.pop.stamp.background};color:${E.pop.stamp.color};box-shadow:${E.pop.stamp.boxShadow}}
.emphasis-list{position:absolute;left:${E.list.left}px;top:${E.list.top}px;width:${E.list.width}px;min-height:${E.list.minHeight}px;padding:${E.list.padding};border-radius:${E.list.borderRadius}px;background:${E.list.background};color:${E.list.color};box-shadow:${E.list.boxShadow};opacity:0}
.emphasis-list-title{font-size:${E.list.title.fontSize}px;font-weight:${E.list.title.fontWeight};line-height:${E.list.title.lineHeight};margin-bottom:${E.list.title.marginBottom}px}
.emphasis-list-item{font-size:${E.list.item.fontSize}px;font-weight:${E.list.item.fontWeight};line-height:${E.list.item.lineHeight};margin-top:${E.list.item.marginTop}px;opacity:0}` : '';

const css = `
@font-face{font-family:'${L.fonts.family}';src:url('assets/${L.fonts.regular}') format('truetype');font-weight:400;font-display:block}
@font-face{font-family:'${L.fonts.family}';src:url('assets/${L.fonts.bold}') format('truetype');font-weight:700;font-display:block}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${L.colors.stageBg};font-family:'${L.fonts.family}',sans-serif}
#root{position:relative;width:${L.canvas.width}px;height:${L.canvas.height}px;overflow:hidden;background:${L.colors.stageBg}}
#avatar{position:absolute;inset:0;width:${L.canvas.width}px;height:${L.canvas.height}px;object-fit:${L.avatar.objectFit}${useOpenTitle ? `;filter:blur(${OT.avatar.blurPx}px) brightness(${OT.avatar.brightness})` : ''}}${preRollSec > 0 ? `
#avatar-poster{position:absolute;inset:0;width:${L.canvas.width}px;height:${L.canvas.height}px;object-fit:${L.avatar.objectFit};filter:blur(${OT.avatar.blurPx}px) brightness(${OT.avatar.brightness})}` : ''}
.broll{position:absolute;left:${form.left}px;top:${form.top}px;width:${form.width}px;height:${form.height}px;object-fit:${form.objectFit}${form.borderRadius ? `;border-radius:${form.borderRadius}px` : ''}${form.boxShadow && form.boxShadow !== 'none' ? `;box-shadow:${form.boxShadow}` : ''}}${brandCss}${titleBoardCss}${hdr ? '\n' + hdr.css : ''}${introCss}${brandFrameCss}${openTitleCss}${emphasisCss}
.caption{position:absolute;left:${cap.left}px;top:${cap.top}px;width:${cap.width}px;height:${cap.height}px;display:flex;align-items:flex-start;justify-content:center;padding-top:${cap.paddingTop}px;text-align:center}
.caption-inner{max-width:${inner.maxWidth}px;padding:${inner.padding};border-radius:${inner.borderRadius}px;background:${L.colors.captionBg};color:${inner.color};font-size:${inner.fontSize}px;font-weight:${inner.fontWeight};line-height:${inner.lineHeight};letter-spacing:${inner.letterSpacing};text-shadow:${inner.textShadow};box-shadow:${inner.boxShadow}}
.caption-inner.long{font-size:${inner.longFontSize}px}`.trim();

// ── HTML 片段 ─────────────────────────────────────────────────────────────

const brollEls = renderShots.map((s) =>
  `      <video id="broll-${s.id}" class="clip broll" src="renders/${s.file}" muted playsinline data-start="${s.clipStart}" data-duration="${s.clipDuration}" data-media-start="${s.mediaStart}" data-track-index="${T.brollBase + s.index}"></video>`
).join('\n');

const brollAudioEls = brollAudio ? renderShots.map((s) =>
  `      <audio id="broll-audio-${s.id}" class="clip" src="renders/${s.file}" data-start="${s.clipStart}" data-duration="${s.clipDuration}" data-media-start="${s.mediaStart}" data-track-index="${T.brollAudioBase + s.index}" data-volume="${L.broll.audio.volume}"></audio>`
).join('\n') : '';

const capEls = captions.map((c) =>
  `      <div id="caption-${c.id}" class="clip caption" data-start="${shift(c.start)}" data-duration="${c.duration}" data-track-index="${T.caption}"><div class="caption-inner${c.cleanCharCount > inner.longThresholdChars ? ' long' : ''}">${esc(c.text)}</div></div>`
).join('\n');

const brollTweens = renderShots.filter((shot) => shot.visualWindow).map((shot) => {
  const start = shot.clipStart;
  const end = n4(shot.clipStart + shot.clipDuration);
  const fade = Math.min(Number(shot.visualWindow.fadeSec), shot.clipDuration / 4);
  return `        tl.fromTo('#broll-${shot.id}',{opacity:0},{opacity:1,duration:${fade.toFixed(4)},ease:'power2.out'},${start.toFixed(4)});
        tl.to('#broll-${shot.id}',{opacity:0,duration:${fade.toFixed(4)},ease:'power2.in'},${n4(end - fade).toFixed(4)});
        tl.set('#broll-${shot.id}',{opacity:0},${end.toFixed(4)});`;
}).join('\n');

const F = cap.fade;
const capTweens = captions.map((c) => {
  const start = shift(c.start), end = shift(c.end);
  // 模糊開場期間不出字幕：大標正在講同一句，字幕再出就是同一句話同時出現三次
  // （標題條、大標、字幕）。開場結束才讓字幕進來；整條都落在開場裡的字幕就不出。
  const visStart = useOpenTitle ? Math.max(start, openTitleEnd) : start;
  const delayed = visStart > start;
  const visDur = delayed ? n4(end - visStart) : c.duration;
  if (delayed && visDur <= 0)
    return `        tl.set('#caption-${c.id} .caption-inner',{opacity:0},${start.toFixed(4)});`;
  const fi = Math.min(F.inSec, visDur * F.maxRatio);
  const fo = Math.min(F.outSec, visDur * F.maxRatio);
  const out = n4(end - fo);
  const hide = delayed ? `        tl.set('#caption-${c.id} .caption-inner',{opacity:0},${start.toFixed(4)});\n` : '';
  return `${hide}        tl.fromTo('#caption-${c.id} .caption-inner',{opacity:0,y:${F.riseFromY}},{opacity:1,y:0,duration:${fi.toFixed(4)},ease:'${F.inEase}'},${visStart.toFixed(4)});
        tl.to('#caption-${c.id} .caption-inner',{opacity:0,duration:${fo.toFixed(4)},ease:'${F.outEase}'},${out.toFixed(4)});
        tl.set('#caption-${c.id} .caption-inner',{opacity:0},${end.toFixed(4)});`;
}).join('\n');

const titleBoardHtml = topBar === 'title-board'
  ? (useHookTitle
    ? `    <div id="title-board" class="title-board"><div id="title-board-kicker" class="tl1">${esc(hookLine1)}</div><div id="title-board-hook" class="tl2">${esc(hook)}</div></div>`
    : (title.line2
      ? `    <div class="title-board"><div class="tl1">${esc(title.line1)}</div><div class="tl2">${esc(title.line2)}</div></div>`
      : `    <div class="title-board">${esc(title.line1)}</div>`))
  : '';

const brandFrameHtml = useBrandFrame ? '    <div id="brandframe-bottom"></div>' : '';
const objectMainHtml = openTitleObjectMode ? openTitleContent.lines.map((line, index) => {
  const styleLine = openTitleContent.lines.length === 1 || index === openTitleContent.lines.length - 1
    ? 2 : 1;
  const coverFill = useCoverTitle
    ? `<span id="open-title-main-line-${index + 1}-fill" class="open-title-cover-fill" data-text="${esc(line)}" aria-hidden="true"></span>` : '';
  return `        <div id="open-title-main-line-${index + 1}" class="open-title-main-line${styleLine}${useCoverTitle ? ' open-title-cover-line' : ''}"${useCoverTitle ? ` data-text="${esc(line)}"` : ''}>${esc(line)}${coverFill}</div>`;
}).join('\n') : '';
const openTitleHtml = openTitleObjectMode ? `    <div id="open-title">
${openTitleContent.kicker ? `      <div id="open-title-kicker">${esc(hookLine1)}</div>\n` : ''}      <div id="open-title-main">
${objectMainHtml}
      </div>${openTitleContent.sub ? `
      <div id="open-title-sub">${esc(openTitleContent.sub)}</div>` : ''}
    </div>` : (useOpenTitle ? `    <div id="open-title">
      <div id="open-title-kicker">${esc(hookLine1)}</div>
      <div id="open-title-hook">${esc(hook)}</div>
    </div>` : '');
const emphasisHtml = emphasis.map((entry) => entry.kind === 'pop'
  ? `    <div id="${entry.id}" class="emphasis-pop${entry.style === 'stamp' ? ' stamp' : ''}">${esc(entry.text)}</div>`
  : `    <div id="${entry.id}" class="emphasis-list">
      <div id="${entry.id}-title" class="emphasis-list-title">${esc(entry.title)}</div>
${entry.items.map((item, index) => `      <div id="${item.id}" class="emphasis-list-item">${index + 1}. ${esc(item.text)}</div>`).join('\n')}
    </div>`).join('\n');

// 每個 timeline 可見元素都要有 id，否則 hyperframes check 會出 studio_missing_editable_id
// warning，而這條產線的驗收標準是 0 error 0 warning。
const introHtml = useIntro ? `    <div id="intro-frame" class="clip" data-start="0" data-duration="${introSec}" data-track-index="${T.intro}"></div>
    <img id="intro-logo" class="clip" src="assets/${IP.logo.asset}" alt="" data-start="0" data-duration="${introSec}" data-track-index="${T.intro + 1}" />
    <div id="intro-line1" class="clip intro-line1" data-start="0" data-duration="${introSec}" data-track-index="${T.intro + 2}">${esc(title.line1 ?? '')}</div>${title.line2 ? `
    <div id="intro-line2" class="clip intro-line2" data-start="0" data-duration="${introSec}" data-track-index="${T.intro + 3}">${esc(title.line2)}</div>` : ''}` : '';

let avatarPosterHtml = '';
if (preRollSec > 0) {
  const source = P.path('avatarSpeeded');
  const poster = path.join(root, 'assets', 'avatar-poster.jpg');
  if (!fs.existsSync(source)) die('openTitle.preRollSec > 0 需要 avatar/speeded.mp4 來擷取第一幀海報');
  const stale = !fs.existsSync(poster) || fs.statSync(poster).mtimeMs < fs.statSync(source).mtimeMs;
  if (stale) {
    fs.mkdirSync(path.dirname(poster), { recursive: true });
    try {
      execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
        '-frames:v', '1', '-q:v', '2', poster,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const detail = String(e.stderr || e.message || '').trim();
      die(`無法從 avatar/speeded.mp4 擷取第一幀${detail ? `：${detail}` : ''}`);
    }
  }
  if (!fs.existsSync(poster) || fs.statSync(poster).size === 0)
    die('ffmpeg 沒有產出可用的 assets/avatar-poster.jpg');
  avatarPosterHtml = `    <img id="avatar-poster" class="clip" src="assets/avatar-poster.jpg" alt="" data-start="0" data-duration="${preRollSec}" data-track-index="${T.avatar}" />`;
}

// ── BGM：缺檔或片長不符就自動混，只有 ffmpeg 真的失敗才停 ─────────────────

let bgmHtml = '';
if (useBgm) {
  const B = L.bgm;
  const mixed = path.join(root, 'assets', B.mixedFile);
  const src = path.join(root, 'assets', L.assets.bgm);
  const fadeOutAt = n4(totalDur - B.fadeOutSec);
  const filter = `afade=in:st=0:d=${B.fadeInSec},afade=out:st=${fadeOutAt}:d=${B.fadeOutSec},volume=${B.volume}`;
  const ffmpegArgs = ['-y', '-stream_loop', '-1', '-i', src, '-vn', '-t', String(totalDur), '-af', filter, mixed];
  // -vn 是必要的，不是保險：BGM.mp3 夾了一張 mjpeg 封面圖，m4a(ipod) 容器不收 ——
  // 少了 -vn 會失敗，而且會留下一個 0 byte 的壞檔（2026-08-25 實際踩到）。
  const cmd = `  ffmpeg -y -stream_loop -1 -i "${src}" -vn -t ${totalDur} \\\n`
    + `    -af "${filter}" \\\n`
    + `    "${mixed}"`;
  const probe = () => {
    if (!fs.existsSync(mixed)) return null;
    try {
      const seconds = Number(execFileSync('ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mixed],
        { encoding: 'utf8' }).trim());
      return Number.isFinite(seconds) ? seconds : null;
    } catch { return null; }
  };

  const before = probe();
  const invalidFile = fs.existsSync(mixed) && fs.statSync(mixed).size < B.minUsableBytes;
  const durationMismatch = before !== null
    && Math.abs(before - totalDur) > B.durationToleranceSec;
  if (!fs.existsSync(mixed) || invalidFile || durationMismatch) {
    const why = !fs.existsSync(mixed)
      ? `缺 assets/${B.mixedFile}`
      : invalidFile
        ? `assets/${B.mixedFile} 只有 ${fs.statSync(mixed).size} bytes`
        : `assets/${B.mixedFile} 長度 ${before.toFixed(3)}s 與成片 ${totalDur}s 差超過 ${B.durationToleranceSec}s`;
    console.error(`🎵 ${why}，自動用 ffmpeg 重混。`);
    try {
      execFileSync('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const detail = String(e.stderr || e.message || '').trim();
      die(`BGM 自動混音失敗${detail ? `：${detail}` : ''}\n\n等價指令：\n\n${cmd}\n`);
    }
  }

  const after = probe();
  if (!fs.existsSync(mixed) || fs.statSync(mixed).size < B.minUsableBytes)
    die(`ffmpeg 沒有產出可用的 assets/${B.mixedFile}。\n\n等價指令：\n\n${cmd}\n`);
  if (after === null) {
    console.error(`⚠️ 無法用 ffprobe 讀 assets/${B.mixedFile} 的長度，只驗了檔案非空。`);
  } else if (Math.abs(after - totalDur) > B.durationToleranceSec) {
    die(`assets/${B.mixedFile} 重混後仍是 ${after.toFixed(3)}s，與成片 ${totalDur}s 差超過 ${B.durationToleranceSec}s。\n\n等價指令：\n\n${cmd}\n`);
  }

  bgmHtml = `    <audio id="bgm" class="clip" src="assets/${B.mixedFile}" data-start="0" data-duration="${totalDur}" data-media-start="0" data-track-index="${T.bgm}"></audio>`;
}

// ── 組出 index.html ───────────────────────────────────────────────────────
// DOM 順序就是 z 序：avatar → broll → 頂欄 → 字幕 → 開場卡（蓋住全部）。
//
// 頂欄必須在 broll 之後，不能在之前 —— fullframe 形式的 B-roll 是 1080×1920 不透明全幅，
// 排在它前面的東西會被整片蓋掉。鼎元 v002 的手寫版就是把 title-board 放在 broll 之後，
// 所以成片第 25 秒看得到標題板。card 形式兩種順序都不影響（卡片在 y470–1210，撞不到頂欄），
// 所以統一放後面，兩種形式都安全。
// 開場卡放最後是因為它必須遮住第 0–1 秒的所有東西。

const body = [
  avatarPosterHtml,
  `    <video id="avatar" class="clip" src="public/input-video.mp4" muted playsinline data-start="${timelineOffset}" data-duration="${bodyDur}" data-media-start="0" data-track-index="${T.avatar}"></video>`,
  `    <audio id="avatar-audio" class="clip" src="public/input-video.mp4" data-start="${timelineOffset}" data-duration="${bodyDur}" data-media-start="0" data-track-index="${T.avatarAudio}" data-volume="1"></audio>`,
  brollEls,
  brandFrameHtml,
  hdr ? hdr.html : '',
  brandHtml,
  titleBoardHtml,
  openTitleHtml,
  emphasisHtml,
  capEls,
  brollAudioEls,
  bgmHtml,
  introHtml,
].filter(Boolean).join('\n');

// 開場期間常駐標題條先不出（否則 HOOK 同時出現在大標與標題條），拉焦時一起進來。
// 只有 hook 模式的標題板有 id；原兩行片名模式的 markup 不動，保住 V2 零差異。
const focusStart = useOpenTitle ? (preRollSec > 0 ? preRollSec : Number(OT.holdSec)) : 0;
const strapTween = (useOpenTitle && useHookTitle) ? `
        tl.set('#title-board',{opacity:0},0);
        tl.to('#title-board',{opacity:1,duration:${Number(OT.strapInSec).toFixed(4)},ease:'${OT.focusEase}'},${focusStart.toFixed(4)});` : '';
if (useOpenTitle && useHookTitle && !(Number(OT.strapInSec) > 0))
  die('openTitle 啟用且 titleBoard=hook 需要 layout.openTitle.strapInSec（>0）：標題條在拉焦時淡入的秒數。');

let objectOpenTitleEntryTweens = '';
if (openTitleObjectMode) {
  const enter = OT.enter;
  const required = [enter?.mainAtSec, enter?.mainDurationSec, enter?.mainFromScale,
    enter?.subAtSec, enter?.subDurationSec,
    useCoverTitle ? coverStyle?.subFromScale : enter?.subFromX];
  if (!required.every((value) => typeof value === 'number' && Number.isFinite(value)))
    die('openTitle 物件模式需要完整且為有限數字的 layout.openTitle.enter／style token');
  const subTween = useCoverTitle ? `
        tl.set('#open-title-sub',{opacity:0,scale:${coverStyle.subFromScale}},0);
        tl.to('#open-title-sub',{opacity:1,scale:1,duration:${enter.subDurationSec},ease:'${enter.subEase}'},${enter.subAtSec.toFixed(4)});` : `
        tl.set('#open-title-sub',{opacity:0,x:${enter.subFromX}},0);
        tl.to('#open-title-sub',{opacity:1,x:0,duration:${enter.subDurationSec},ease:'${enter.subEase}'},${enter.subAtSec.toFixed(4)});`;
  objectOpenTitleEntryTweens = `
        tl.set('#open-title-main',{opacity:0,scale:${enter.mainFromScale}},0);
        tl.to('#open-title-main',{opacity:1,scale:1,duration:${enter.mainDurationSec},ease:'${enter.mainEase}'},${enter.mainAtSec.toFixed(4)});${openTitleContent.sub ? subTween : ''}`;
}

const openTitleTweens = openTitleObjectMode ? `${objectOpenTitleEntryTweens}
        tl.to('#avatar',{filter:'blur(${OT.avatar.endBlurPx}px) brightness(${OT.avatar.endBrightness})',duration:${OT.focusSec},ease:'${OT.focusEase}'},${focusStart.toFixed(4)});
        tl.to('#open-title',{opacity:0,duration:${OT.focusSec},ease:'${OT.titleFadeEase}'},${focusStart.toFixed(4)});
        tl.set('#avatar',{filter:'${OT.avatar.clearFilter}'},${openTitleEnd.toFixed(4)});${strapTween}` : (useOpenTitle ? `
        tl.to('#avatar',{filter:'blur(${OT.avatar.endBlurPx}px) brightness(${OT.avatar.endBrightness})',duration:${OT.focusSec},ease:'${OT.focusEase}'},${Number(OT.holdSec).toFixed(4)});
        tl.to('#open-title',{opacity:0,duration:${OT.focusSec},ease:'${OT.titleFadeEase}'},${Number(OT.holdSec).toFixed(4)});
        tl.set('#avatar',{filter:'${OT.avatar.clearFilter}'},${openTitleEnd.toFixed(4)});${strapTween}` : '');

const emphasisTweens = emphasis.map((entry) => {
  if (entry.kind === 'pop') {
    const P = E.pop;
    const rotation = entry.style === 'stamp' ? P.stamp.rotationDeg : P.rotationDeg;
    return `
        tl.set('#${entry.id}',{opacity:0,scale:${P.entryScale},rotation:${rotation}},0);
        tl.to('#${entry.id}',{opacity:1,scale:1,duration:${P.inSec},ease:'${P.inEase}'},${entry.at.toFixed(4)});
        tl.to('#${entry.id}',{opacity:0,duration:${P.outSec},ease:'${P.outEase}'},${entry.fadeAt.toFixed(4)});
        tl.set('#${entry.id}',{opacity:0},${entry.exitAt.toFixed(4)});`;
  }
  const Q = E.list;
  const itemTweens = entry.items.map((item, itemIndex) => `
        tl.set('#${item.id}',{opacity:0,x:${Q.entryX}},0);
        tl.to('#${item.id}',{opacity:1,x:0,duration:${Q.itemInSec},ease:'${Q.itemInEase}'},${item.at.toFixed(4)});${itemIndex > 0 ? `
        tl.to('#${entry.items[itemIndex - 1].id}',{opacity:${Q.spokenOpacity ?? 0.5},duration:${Q.itemInSec},ease:'${Q.itemInEase}'},${item.at.toFixed(4)});` : ''}`).join('');
  return `
        tl.set('#${entry.id}',{opacity:0},0);
        tl.to('#${entry.id}',{opacity:1,duration:${Q.cardInSec},ease:'${Q.cardInEase}'},${entry.at.toFixed(4)});${itemTweens}
        tl.to('#${entry.id}',{opacity:0,duration:${Q.outSec},ease:'${Q.outEase}'},${entry.fadeAt.toFixed(4)});
        tl.set('#${entry.id}',{opacity:0},${entry.exitAt.toFixed(4)});`;
}).join('');

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<style>
${css}
</style>
</head>
<body>
  <div id="root" data-composition-id="${compositionId}" data-start="0" data-duration="${totalDur}" data-fps="${L.canvas.fps}" data-width="${L.canvas.width}" data-height="${L.canvas.height}">
${body}
    <script src="assets/${L.gsap}"></script>
    <script>
      (function(){
        const tl = gsap.timeline({paused:true});
${brollTweens}${brollTweens ? '\n' : ''}${capTweens}${openTitleTweens}${emphasisTweens}
        window.__timelines = window.__timelines || {};
        window.__timelines['${compositionId}'] = tl;
      })();
    </script>
  </div>
</body>
</html>
`;

fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(JSON.stringify({
  output: 'index.html',
  compositionId,
  visualForm: ledger.visualForm || 'card',
  topBar,
  intro: useIntro ? introSec : false,
  bgm: useBgm,
  brollAudio,
  titleBoard: useHookTitle ? 'hook' : 'title',
  openTitle: useOpenTitle ? openTitleEnd : false,
  brandFrame: useBrandFrame,
  emphasis: emphasis.length,
  lead: leadSec,
  actualLead: renderShots.map((s) => ({ id: s.id, sec: s.actualLead })),
  segments: segments.length,
  mgShots: shots.length,
  captions: captions.length,
  durationSec: totalDur,
  renders: shots.map((s) => `${s.id}→${s.file}`),
}));
