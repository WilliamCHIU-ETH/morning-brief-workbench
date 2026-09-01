#!/usr/bin/env node
/**
 * 從 segment-plan 的素材格自動產出全幅 MG composition。
 *
 *   node stages/plan-mg.mjs --project <dir> [--write]
 *
 * 這一步取代「每支影片手寫四格 HTML＋GSAP」。做法對齊 app/ 既有的
 * `graphic-broll-plan.js`（那支自動規劃的是 card-v1，最多三張文字卡）：
 * 吃講稿與 plan，吐一份計畫，再由版型庫算出 composition。
 *
 * 三個階段，每一階段的判斷都寫進 mg-plan.json 供稽核：
 *   1. 抽取  從該格的原文（含標點）抽出數字、單位、方向、列舉項、對比詞
 *   2. 選型  依抽取結果挑版型，規則寫死在 pickTemplate()
 *   3. 補值  抽不到的欄位用版型 defaults 補，所以一定產得出合法 composition
 *
 * `mg-overrides.json` 可以逐格覆寫任何欄位。設計立場：**永遠先產出可用的東西，
 * 再讓人改文案**，而不是缺欄位就停下來等人填。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveProject, readJson, writeJson } from './lib/project.mjs';
import { greetingWindow, openTitleEnd as resolveOpenTitleEnd, resolveLeads } from './lib/lead.mjs';
import { computeVisualWindow, resolveOrderedBeatTimes } from './lib/rhythm.mjs';
import { TEMPLATES } from './mg-templates.mjs';
import { SHOT, imageSize } from './shot-template.mjs';

// 2026-08-27 會議：素材格全面改實機截圖。shot 版型放獨立檔（另一個 session 正在改 mg-templates.mjs）。
const ALL = { ...TEMPLATES, shot: SHOT };

const here = path.dirname(fileURLToPath(import.meta.url));
const acceptance = JSON.parse(fs.readFileSync(path.join(here, '..', 'contracts', 'acceptance.json'), 'utf8'));
const visualWindowThreshold = acceptance.gates.find((gate) => gate.id === 'shot.visual-window')?.threshold;
if (!visualWindowThreshold) throw new Error('contracts/acceptance.json 缺 shot.visual-window.threshold');
const require = createRequire(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex } = require(path.join(here, 'script-utils.js'));

let P;
try { P = resolveProject(); } catch (e) {
  console.error(e.message);
  console.error('用法：node stages/plan-mg.mjs --project <dir> [--write]');
  process.exit(2);
}
const WRITE = process.argv.includes('--write');

const mainConfigFile = P.path('mainConfig');
let mainConfig = {};
if (fs.existsSync(mainConfigFile)) {
  try { mainConfig = JSON.parse(fs.readFileSync(mainConfigFile, 'utf8')); }
  catch (e) {
    console.error(`main.config.json 不是合法 JSON：${e.message}`);
    process.exit(1);
  }
}
const spotlightAlpha = mainConfig.spotlight ?? 0;
if (typeof spotlightAlpha !== 'number' || !Number.isFinite(spotlightAlpha) || spotlightAlpha < 0) {
  console.error(`main.config.json 的 spotlight 必須是 0～0.6 之間的數字，收到 ${JSON.stringify(spotlightAlpha)}`);
  process.exit(1);
}
const openTitleConfig = mainConfig.openTitle;
const openTitleObject = openTitleConfig !== null && typeof openTitleConfig === 'object'
  && !Array.isArray(openTitleConfig);
if (![undefined, null, false, true].includes(openTitleConfig) && !openTitleObject) {
  console.error(`main.config.json 的 openTitle 必須是 boolean 或物件，收到 ${JSON.stringify(openTitleConfig)}`);
  process.exit(1);
}
const useOpenTitle = openTitleConfig === true || openTitleObject;
const preRollSec = openTitleObject ? Number(openTitleConfig.preRollSec ?? 0) : 0;
const needsLayout = spotlightAlpha > 0 || useOpenTitle;
const layout = needsLayout ? readJson(P, 'layout') : null;
const spotlightMax = spotlightAlpha > 0 ? Number(layout.spotlight?.maxAlpha) : null;
if (spotlightAlpha > 0 && (!Number.isFinite(spotlightMax) || spotlightAlpha > spotlightMax)) {
  console.error(`main.config.json 的 spotlight 必須是 0～${Number.isFinite(spotlightMax) ? spotlightMax : 'layout.spotlight.maxAlpha'} 之間的數字，收到 ${JSON.stringify(spotlightAlpha)}`);
  process.exit(1);
}
const spotlight = spotlightAlpha > 0 ? {
  alpha: spotlightAlpha,
  color: layout.spotlight.color,
  spreadPx: layout.spotlight.spreadPx,
} : null;
const leadSec = mainConfig.lead ?? 0;
if (typeof leadSec !== 'number' || !Number.isFinite(leadSec) || leadSec < 0) {
  console.error(`main.config.json 的 lead 必須是 >=0 的秒數，收到 ${JSON.stringify(leadSec)}`);
  process.exit(1);
}
let openTitleEndSec = 0;
try { openTitleEndSec = resolveOpenTitleEnd(openTitleConfig, layout); }
catch (e) { console.error(e.message); process.exit(1); }

// ── 原文對照:plan 的 anchor 是 clean 文字,抽取需要標點 ─────────────────────
const raw = fs.readFileSync(P.path('script'), 'utf8');
const body = getBodyAfterVoice(raw);
const T = cleanBodyWithIndex(body);
const clean = T.map((c) => c.char).join('');

function originalTextOf(anchor, fromChar) {
  const at = clean.indexOf(anchor, fromChar);
  if (at < 0) throw new Error(`anchor 在講稿裡找不到：${anchor.slice(0, 16)}…`);
  const end = at + anchor.length - 1;
  let b = T[end].origIdx + 1;
  while (b < body.length && /[，。？！、；：]/.test(body[b])) b++;
  return { text: body.slice(T[at].origIdx, b).replace(/\s+/g, ''), at, end };
}

// ── 抽取 ───────────────────────────────────────────────────────────────────
const UNITS = ['億元', '億', '萬元', '萬', '點', '元', '%', '檔', '家', '成'];
const UP = /漲|升|增|攻|買超|轉強|走高|放量/;
const DOWN = /跌|挫|減|賣超|轉弱|走低|縮/;
const TIME_PREFIX = /^(昨日|昨天|今日|今天|昨晚|上週|本週|所以|不過|但)/;
const ENUM = /(先看|觀察|看)?(兩件事|三件事|兩個|三個|兩件|三件|兩項|三項)/;
const CONTRAST = /不過|然而|但是|但|還沒|未到|沒發生|尚未/;

const clausesOf = (text) => text.split(/[，。？！、；：]/).map((s) => s.trim()).filter(Boolean);

function numericFacts(text) {
  const unitAlt = UNITS.map((u) => u.replace('%', '%')).join('|');
  const re = new RegExp(`([\\u4e00-\\u9fffA-Za-z]{0,8}?)([^\\u4e00-\\u9fff]{0,3}?)([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(${unitAlt})`, 'g');
  const out = [];
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 10), m.index + m[1].length);
    // 順序很重要。m[1] 會把時間詞、主語、副詞、動詞全部黏在一起：
    //   「昨日台股只漲」→ 去時間詞 →「台股只漲」→ 切動詞 →「台股只」→ 去副詞 →「台股」
    //   「美股道瓊還重挫」→ 切動詞 →「美股道瓊還」→ 去副詞 →「美股道瓊」→ 去市場前綴 →「道瓊」
    // 先去副詞再切動詞會失敗（尾巴是動詞不是副詞）；
    // 先去市場前綴會把「台股只」剝成「只」。
    let subject = m[1].replace(TIME_PREFIX, '');
    const vb = subject.search(new RegExp(`${UP.source}|${DOWN.source}`));
    if (vb > 0) subject = subject.slice(0, vb);
    subject = subject.replace(/(只|還|再|又|也|大|小|微|重|逆勢|約|共|逾|的)+$/u, '');
    // 市場前綴後面還有兩字以上的指數名時才剝（「台股」本身就是主語）
    subject = subject.replace(/^(美股|台股|陸股|日股|歐股)(?=.{2,})/u, '');
    subject = subject.replace(/^(公司|該公司|本公司)(?=.{2,})/u, '');
    out.push({
      subject: subject || null,
      value: Number(m[3].replace(/,/g, '')),
      unit: m[4],
      dir: DOWN.test(before) ? 'down' : UP.test(before) ? 'up' : null,
      matched: m[0],
    });
  }
  return out;
}

function extract(slotText) {
  const cl = clausesOf(slotText);
  return {
    clauses: cl,
    numbers: numericFacts(slotText),
    enumMarker: (slotText.match(ENUM) ?? [null])[0],
    contrast: (slotText.match(CONTRAST) ?? [null])[0],
  };
}

// ── 選型 ───────────────────────────────────────────────────────────────────
function pickTemplate(f) {
  const sameUnit = f.numbers.length >= 2
    && f.numbers[0].unit === f.numbers[1].unit;
  if (sameUnit) return { id: 'stat-compare', why: `2 筆同單位數字（${f.numbers[0].unit}）` };
  if (f.enumMarker && f.clauses.length >= 2) {
    return { id: 'checklist', why: `列舉詞「${f.enumMarker}」＋${f.clauses.length} 個分句` };
  }
  if (f.contrast && f.numbers.length >= 1) {
    return { id: 'gap', why: `對比詞「${f.contrast}」＋1 筆數字（${f.numbers[0].matched}）` };
  }
  if (f.contrast) return { id: 'gap', why: `對比詞「${f.contrast}」，無數字` };
  return { id: 'chain', why: '無同單位數字、無列舉、無對比，落到因果鏈' };
}

// ── 補值 ───────────────────────────────────────────────────────────────────
const br = (s, at = 5) => (s.length > at + 2 ? `${s.slice(0, at)}<br />${s.slice(at)}` : s);
const stripLead = (s) => s.replace(/^(所以|那|而|不過|但)/, '');

function buildData(tid, f, slotText) {
  const t = ALL[tid];
  const d = { ...t.defaults };
  if (tid === 'stat-compare') {
    d.title = f.clauses[0]?.match(TIME_PREFIX) ? `${f.clauses[0].match(TIME_PREFIX)[0]}盤勢` : d.title;
    d.items = f.numbers.slice(0, 2).map((n) => ({
      label: n.subject || '—', value: n.value, unit: n.unit, dir: n.dir ?? 'up',
    }));
  } else if (tid === 'checklist') {
    const lead = f.clauses.find((c) => ENUM.test(c));
    d.lead = stripLead(lead ?? '');
    d.rows = f.clauses.filter((c) => c !== lead).slice(0, 2).map((c) => br(c, 5));
    while (d.rows.length < 2) d.rows.push('—');
  } else if (tid === 'gap') {
    const n = f.numbers[0];
    // 「不過」常自成一個分句（「…擴產。不過，這裡有個時間差。」），
    // 那時標題要往後一個分句取，否則 stripLead 之後會是空字串。
    const ci = f.clauses.findIndex((c) => CONTRAST.test(c));
    let titleSrc = ci >= 0 ? stripLead(f.clauses[ci]) : '';
    if (!titleSrc && ci >= 0 && f.clauses[ci + 1]) titleSrc = f.clauses[ci + 1];
    d.title = (titleSrc.replace(/^這裡有個/u, '') || d.title);
    d.lead = f.clauses.find((c, i) => i !== ci && c !== titleSrc) ?? '';
    if (n) {
      d.left = { label: n.subject || '已投入', value: n.value, unit: n.unit };
    } else {
      d.left = { label: '已發生', value: 0, unit: '' };
    }
    d.right = { label: '尚未發生' };
  } else if (tid === 'chain') {
    // 最弱的一個抽取。節點取前面分句以「與／和／、」再切，不足三節時把最後一個
    // 分句拆成「主語→節點三」「述語→結論帶」。
    const parts = [];
    for (const c of f.clauses) for (const p of c.split(/與|和/)) if (p.trim()) parts.push(p.trim());
    // 節點寬 300px、字級 54px，超過 10 字就爆框。最後一個 part 通常是
    // 「主語＋述語」（「鼎元的光通訊產品下半年進入放量階段」），
    // 在時間／動詞處切開：主語留在節點，述語進結論帶。
    const PRED = /下半年|上半年|今年|明年|本季|下季|進入|開始|預期|將|升溫|放量階段/u;
    const picked = parts.slice(0, 3);
    const last = picked[picked.length - 1] ?? '';
    const cut = last.search(PRED);
    if (cut > 0 && (last.length > 10 || picked.length < 3)) {
      picked[picked.length - 1] = last.slice(0, cut);
      d.band = last.slice(cut);
    }
    // 不手動插 <br>：hyperframes-core 規則明講強制斷行會跟自然換行打架、疊字。
    // 節點框讓 CSS（max-width + word-break）自己換行。
    // 不足三節就照實給 1～2 個：mg-templates.mjs 的 chain 版型會置中重排，
    // 不再用「—」佔位——空格子一眼就看得出「這格沒抽到東西」，比留白更差。
    d.nodes = picked.map((s) => s.replace(/^(公司的|該公司|本公司)/u, ''));
    // band 不能等於任何一個節點。fallback 取最後一個分句時，那個分句往往就是
    // 第三個節點本身，結果同一句話在畫面上出現兩次。
    if (!d.band) {
      const last = f.clauses.at(-1) ?? '';
      d.band = picked.some((s) => s === last || last.includes(s) || s.includes(last)) ? '' : last;
    }
  }
  return d;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const plan = readJson(P, 'segmentPlan');
const overridesFile = P.path('mgOverrides');
const hasOverrides = fs.existsSync(overridesFile);
let overrides = {};
if (hasOverrides) {
  try { overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8')); }
  catch (e) {
    console.error(`mg-overrides.json 不是合法 JSON：${e.message}`);
    process.exit(1);
  }
}

// 截圖計畫（capture-shots.mjs 寫出）。某格在這裡有 entry 就用 shot 版型放實機截圖，
// 沒有的格才落到抽數字選版型。截圖優先於「自動選版型」（會議裁定的方向）；
// 但 mg-overrides.json **明寫** template 的格是編輯的明確決定，優先於截圖——
// 2026-08-30 起這樣排序，理由：三大法人數字要用建構卡而不是 App 法人頁（口徑對不上）。
const hasShotPlan = fs.existsSync(P.path('shotPlan'));
const shotSlots = hasShotPlan ? (readJson(P, 'shotPlan').slots ?? {}) : {};
function shotData(id) {
  const e = shotSlots[id];
  const abs = e.image ? path.join(P.root, e.image) : null;
  const dims = abs && fs.existsSync(abs) ? imageSize(abs) : { w: 0, h: 0 };
  const d = { cropTop: 0, ...e, imageW: dims.w, imageH: dims.h };
  if (e.second?.image) {
    const abs2 = path.join(P.root, e.second.image);
    const dims2 = fs.existsSync(abs2) ? imageSize(abs2) : { w: 0, h: 0 };
    d.second = { cropTop: 0, ...e.second, imageW: dims2.w, imageH: dims2.h };
  }
  return d;
}

// 時長：有 ledger 用真值，否則用 plan 的估計上緣（比較保守）。付費前沒有 ledger 時
// 無法知道逐格 room，前導一律 0；付費後重跑就會用共享 resolver 補上渲染長度。
let ledger = null;
try { ledger = readJson(P, 'segmentLedger'); } catch { /* 付費之前沒有 */ }
if (!ledger) console.log('尚無 segment-ledger.json，素材格前導暫以 0s 規劃；付費後請重跑 plan-mg。');

let charTimesCache;
let charTimesUsed = false;
let captionFallbackUsed = false;
function loadCharTimes() {
  if (charTimesCache !== undefined) return charTimesCache;
  try {
    const raw = readJson(P, 'charTimes');
    const arr = Array.isArray(raw) ? raw : (raw.chars ?? raw.items ?? []);
    charTimesCache = arr.length ? arr : null;
    if (charTimesCache) charTimesUsed = true;
  } catch { charTimesCache = null; }
  return charTimesCache;
}
function fallbackGreetingWindow() {
  let raw;
  try { raw = readJson(P, 'captionLedger'); }
  catch { return null; }
  const captions = Array.isArray(raw) ? raw : (raw.captions ?? []);
  const chars = captions.flatMap((caption) => [...String(caption.text ?? '')]
    .map((ch) => ({ ch, start: caption.start, end: caption.end })));
  captionFallbackUsed = true;
  console.log('asr/script-char-times.json 不存在，問候夾限退回 caption-ledger.json。');
  return greetingWindow(chars);
}

let leadById = new Map();
if (ledger) {
  let greetingEnd = 0;
  if (leadSec > 0) {
    const window = greetingWindow(loadCharTimes()) ?? (charTimesCache ? null : fallbackGreetingWindow());
    greetingEnd = window ? Number((window.end + preRollSec).toFixed(4)) : 0;
  }
  const leadShots = ledger.segments.filter((segment) => segment.form === 'mg').map((segment) => ({
    id: segment.id,
    start: Number((segment.startSec + preRollSec).toFixed(4)),
    duration: typeof segment.durationSec === 'number'
      ? segment.durationSec : segment.endSec - segment.startSec,
  }));
  leadById = resolveLeads({ shots: leadShots, leadSec, openTitleEnd: openTitleEndSec, greetingEnd });
}

// shot-plan 只負責空間。focus／focus2／second 依序各需要一個「真的命中畫面」的 target，
// 到這裡才用 ASR 字時間把文字錨換成拍點。second.focus2 是同一個 second 主張內的細部
// 收框，不另造一個沒有文字錨的拍點；它會在 second 拍後接續 tween。
function resolveShotRhythm(slot, data, lead) {
  if (!ledger) return { beats: [], visualWindow: null };
  const segment = ledger.segments.find((entry) => String(entry.id) === String(slot.id));
  if (!segment) throw new Error(`格 ${slot.id} 在 segment-ledger.json 找不到，無法計算視覺窗口。`);
  const charTimes = loadCharTimes();
  if (!charTimes) {
    throw new Error(`格 ${slot.id} 是 shot，但缺 asr/script-char-times.json，無法把 targets 解析成拍點；先跑 ASR／align，再重跑 plan-mg。`);
  }

  const specs = [
    { kind: 'focus', rect: 'focus' },
    ...(data.focus2 ? [{ kind: 'focus2', rect: 'focus2' }] : []),
    ...(data.second ? [{ kind: 'second', rect: 'second.focus' }] : []),
  ];
  const targets = (data.targets ?? []).map((target, targetIndex) => ({ ...target, targetIndex }))
    .filter((target) => target.target !== null && target.target !== undefined
      && String(target.target).length && typeof target.by === 'string' && target.by.length);
  if (targets.length < specs.length) {
    throw new Error(`格 ${slot.id} 有 ${specs.length} 個空間拍點（${specs.map((spec) => spec.rect).join('、')}），`
      + `但 shot-plan.json 只有 ${targets.length} 個帶 by 的 target。每個框／換頁都要有該句中的文字錨；`
      + '請重截讓 target 與 focus 成對，或改寫 responsibility／用 plan-hints.json 押回主播。');
  }
  const selected = targets.slice(0, specs.length);
  let timed;
  try {
    timed = resolveOrderedBeatTimes({
      charTimes,
      segment,
      anchors: selected.map((target) => String(target.target)),
      minGapSec: Number(visualWindowThreshold.minBeatGapSec),
    });
  } catch (error) {
    throw new Error(`格 ${slot.id} 的拍點無法解析：${error.message} `
      + 'shot-plan 的 target 必須逐一存在於該格句子且照字序排列；請重截，或改寫 responsibility／用 plan-hints.json 押回主播。');
  }
  const beats = timed.map((beat, index) => ({
    ...specs[index],
    anchor: beat.anchor,
    targetIndex: selected[index].targetIndex,
    by: selected[index].by,
    atSec: beat.atSec,
    endSec: beat.endSec,
    rawAtSec: beat.rawAtSec,
    rawEndSec: beat.rawEndSec,
    localSec: Number((beat.atSec - segment.startSec + lead.actualLead).toFixed(4)),
    localEndSec: Number((beat.endSec - segment.startSec + lead.actualLead).toFixed(4)),
    timing: beat.timing,
  }));
  const visualWindow = computeVisualWindow({
    segmentStartSec: segment.startSec,
    segmentEndSec: segment.endSec,
    beats,
    leadSec: Number(visualWindowThreshold.leadSec),
    tailSec: Number(visualWindowThreshold.tailSec),
    // 2s 是 gate 硬下界；單拍靜態 shot 以 3s 為規劃中心，對齊本次 audit 對格 04 的 3–4s 判準。
    minSec: beats.length === 1
      ? Number(visualWindowThreshold.singleBeatTargetMinSec ?? visualWindowThreshold.minSec)
      : Number(visualWindowThreshold.minSec),
    maxSec: Number(visualWindowThreshold.maxSec),
    fadeSec: Number(visualWindowThreshold.fadeSec),
  });
  return { beats, visualWindow };
}

// 建構卡的資料只來自 mg-overrides.json（那是編輯寫的內容，不抽），這裡把 atText
// 限定在該 ledger 段內唯一比對，再換成以 nominal 素材格起點為 0 的秒數。
function resolveCard(s, data) {
  const d = { ...data, items: (data.items ?? []).map((it) => ({ ...it })) };
  const ct = loadCharTimes();
  const segment = ledger?.segments.find((x) => x.id === s.id);
  for (const it of d.items) {
    if (!it.atText) continue;
    if (!ct || !segment) { delete it.at; continue; }
    const nominalSec = typeof segment.durationSec === 'number'
      ? segment.durationSec : segment.endSec - segment.startSec;
    const scoped = ct.filter((char) => Number(char.start) >= segment.startSec - 0.5
      && Number(char.start) < segment.endSec);
    const text = scoped.map((char) => char.ch ?? char.char ?? '').join('');
    const hits = [];
    for (let from = 0; from <= text.length;) {
      const at = text.indexOf(it.atText, from);
      if (at < 0) break;
      hits.push(at);
      from = at + 1;
    }
    const seconds = hits.map((at) => Number(scoped[at]?.start)).filter(Number.isFinite);
    if (hits.length !== 1 || seconds.length !== 1) {
      console.error(`格 ${s.id} 的建構卡 atText「${it.atText}」在該段命中 ${hits.length} 次；秒數：${seconds.length ? seconds.join('、') : '（無）'}。命中必須唯一。`);
      process.exit(1);
    }
    const at = Number((seconds[0] - segment.startSec).toFixed(2));
    if (!(at >= 0 && at < nominalSec)) {
      console.error(`格 ${s.id} 的建構卡 atText「${it.atText}」得到 at=${at}s，不在 0～${nominalSec}s 的 nominal 素材格內。`);
      process.exit(1);
    }
    it.at = at;
  }
  return d;
}

const durOf = (s) => {
  const hit = ledger?.segments.find((x) => x.id === s.id);
  if (hit) return { sec: hit.durationSec, from: 'ledger' };
  return { sec: s.derivation?.estSec?.[1] ?? 5, from: 'plan-estimate' };
};

const { shell, C } = await import('./comp-shell-916.mjs');

const rows = [];
let cursor = 0;
for (const s of plan) {
  const o = originalTextOf(s.anchor, cursor);
  cursor = o.end + 1;
  if (s.form !== 'mg') continue;
  const f = extract(o.text);
  const pick = overrides[s.id]?.template
    ? { id: overrides[s.id].template, why: `mg-overrides.json 指定${shotSlots[s.id] ? '（蓋過 shot-plan 的截圖）' : ''}` }
    : shotSlots[s.id]
      ? { id: 'shot', why: `shot-plan.json 有截圖（${shotSlots[s.id].page ?? shotSlots[s.id].image}）` }
      : pickTemplate(f);
  const t = ALL[pick.id];
  if (!t) { console.error(`格 ${s.id}：未知版型 ${pick.id}`); process.exit(1); }
  const data = pick.id === 'shot'
    ? { ...shotData(s.id), ...(overrides[s.id]?.data ?? {}) }
    : pick.id === 'card'
      ? resolveCard(s, overrides[s.id]?.data ?? {})
      : { ...buildData(pick.id, f, o.text), ...(overrides[s.id]?.data ?? {}) };
  const err = pick.id === 'shot' && !(data.image && fs.existsSync(path.join(P.root, data.image)))
    ? `截圖檔不存在：${data.image || '（shot-plan 沒填 image）'}`
    : t.validate(data);
  const dur = durOf(s);
  const nominalSec = Number(dur.sec.toFixed(2));
  const lead = leadById.get(s.id) ?? {
    actualLead: 0,
    renderStart: ledger?.segments.find((segment) => segment.id === s.id)?.startSec ?? 0,
    renderDuration: nominalSec,
  };
  let beats = [];
  let visualWindow = null;
  if (pick.id === 'shot' && !err) {
    try { ({ beats, visualWindow } = resolveShotRhythm(s, data, lead)); }
    catch (error) { console.error(error.message); process.exit(1); }
  }
  rows.push({
    id: s.id, template: pick.id, why: pick.why,
    nominalSec, actualLead: lead.actualLead, durationSec: Number(lead.renderDuration.toFixed(2)),
    durationFrom: dur.from, sourceText: o.text, responsibility: s.responsibility,
    ...(visualWindow ? { visualWindow, beats } : {}),
    extracted: { numbers: f.numbers.map((n) => n.matched), enumMarker: f.enumMarker, contrast: f.contrast },
    data, invalid: err,
  });
}

const bad = rows.filter((r) => r.invalid);
console.log(`素材格 ${rows.length} 個　版型：${rows.map((r) => `${r.id}=${r.template}`).join('　')}`);
console.log('');
for (const r of rows) {
  console.log(`格 ${r.id}  ${r.template.padEnd(13)} ${r.durationSec}s(${r.durationFrom}；nominal ${r.nominalSec}s + lead ${r.actualLead}s)  ← ${r.why}`);
  console.log(`         原文：${r.sourceText}`);
  if (r.visualWindow) {
    console.log(`         窗口：${r.visualWindow.enterSec.toFixed(2)}–${r.visualWindow.exitSec.toFixed(2)}s（${r.visualWindow.durationSec.toFixed(2)}s）；拍點 ${r.beats.map((beat) => `${beat.anchor}@${beat.atSec.toFixed(2)}`).join(' → ')}`);
  }
  console.log(`         資料：${JSON.stringify(r.data, null, 0)}`);
  if (r.invalid) console.log(`         不合法：${r.invalid}`);
}

if (WRITE) {
  if (bad.length) {
    console.error('');
    console.error(`${bad.length} 格資料不合版型要求，不寫出。用 mg-overrides.json 補：${bad.map((r) => r.id).join('、')}`);
    process.exit(1);
  }
  const dir = path.join(P.root, 'compositions');
  fs.mkdirSync(dir, { recursive: true });
  const expectedCompositions = new Set(rows.map((row) => `${row.id}-${row.template}.html`));
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.html'))) {
    const ownsId = rows.some((row) => file.startsWith(`${row.id}-`));
    if (ownsId && !expectedCompositions.has(file)) fs.rmSync(path.join(dir, file));
  }
  for (const r of rows) {
    const t = ALL[r.template];
    const { css, body: bodyHtml, tl } = t.render(C, r.data, {
      spotlight, lead: r.actualLead, beats: r.beats ?? [], visualWindow: r.visualWindow ?? null,
    });
    const html = shell(`br${r.id}`, r.durationSec, css, bodyHtml, tl(r.durationSec), t.shiftY);
    fs.writeFileSync(path.join(dir, `${r.id}-${r.template}.html`), html);
  }
  const mgPlan = spotlight
    ? { generatedFrom: P.rel('segmentPlan'), spotlight: { alpha: spotlight.alpha }, slots: rows }
    : { generatedFrom: P.rel('segmentPlan'), slots: rows };
  if (leadSec > 0) mgPlan.lead = leadSec;
  writeJson(P, 'mg-plan.json', mgPlan,
    { inputs: ['script', 'segmentPlan', ...(ledger ? ['segmentLedger'] : []),
      ...(hasShotPlan ? ['shotPlan'] : []), ...(hasOverrides ? ['mgOverrides'] : []),
      ...(needsLayout ? ['layout'] : []),
      ...(spotlight || leadSec > 0 || useOpenTitle ? ['mainConfig'] : []),
      ...(charTimesUsed ? ['charTimes'] : []), ...(captionFallbackUsed ? ['captionLedger'] : [])] });
  console.log('');
  console.log(`已寫出 ${rows.length} 個 composition 到 compositions/，計畫在 mg-plan.json`);
}
process.exit(bad.length ? 1 : 0);
