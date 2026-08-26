import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProject, readJson, writeJson } from './lib/project.mjs';

const P = resolveProject();
const T = readJson(P, 'charTimes');
const ledgerSeg = readJson(P, 'segmentLedger');
const DURATION = ledgerSeg.durationSec;
const raw = fs.readFileSync(P.path('script'), 'utf8');

// 依 references/caption-contract.md：8–18 字、最短 0.9s、無孤字、終止標點優先。
const MIN_CH = 8, MAX_CH = 18, HARD_CH = 26, MIN_DUR = 0.9;

// 用原文重建每個 clean char 的「後面接的標點」，決定 reason
const body = raw.split('===').slice(2).join('===');
const terminal = new Set(['。', '？', '！']);
const clause = new Set(['，', '、', '；', '：']);
const followPunct = T.map((c) => {
  let j = c.origIdx + 1;
  while (j < body.length && /\s/.test(body[j])) j++;
  return body[j] || '';
});

// 1) 候選切點：任何 breakAfter
const cuts = [];
let acc = 0;
for (let i = 0; i < T.length; i++) {
  acc++;
  const isTerm = terminal.has(followPunct[i]);
  const isClause = clause.has(followPunct[i]);
  const isBreak = T[i].breakAfter || isTerm || isClause;
  if (i === T.length - 1) { cuts.push({ end: i, reason: 'script-end' }); break; }
  if (!isBreak) { if (acc >= HARD_CH) { cuts.push({ end: i, reason: 'hard-cap' }); acc = 0; } continue; }
  if (acc < MIN_CH) {
    // 太短，除非是終止標點（完整口語單位）才切
    if (isTerm && acc >= 4) { cuts.push({ end: i, reason: 'terminal-punctuation' }); acc = 0; }
    continue;
  }
  cuts.push({ end: i, reason: isTerm ? 'terminal-punctuation' : 'clause-boundary' });
  acc = 0;
}

// 2) 組段
let segs = [];
let start = 0;
for (const cut of cuts) {
  segs.push({ from: start, to: cut.end, reason: cut.reason });
  start = cut.end + 1;
}
if (start < T.length) segs.push({ from: start, to: T.length - 1, reason: 'script-end' });

// 3) 合併過短（字數<4 或 時長<MIN_DUR）到前一段
const merged = [];
for (const s of segs) {
  const dur = T[s.to].end - T[s.from].start;
  const len = s.to - s.from + 1;
  if (merged.length && (len < 4 || dur < MIN_DUR) && (merged.at(-1).to - merged.at(-1).from + 1) + len <= MAX_CH + 4) {
    merged.at(-1).to = s.to; merged.at(-1).reason = s.reason;
  } else merged.push({ ...s });
}

// 4) 文字用原文切片（保留標點），時間用 char times
const cutSet = new Set(ledgerSeg.segments.map((s) => s.startSec));
const ledger = merged.map((s, idx) => {
  const a = T[s.from].origIdx;
  const bIdx = T[s.to].origIdx;
  let b = bIdx + 1;
  while (b < body.length && /[，。？！、；：」』）〉》”’]/.test(body[b])) b++;
  const text = body.slice(a, b).replace(/\s+/g, '');
  return {
    id: `CAP-${String(idx + 1).padStart(2, '0')}`,
    text,
    start: Number(T[s.from].start.toFixed(2)),
    end: Number(T[s.to].end.toFixed(2)),
    duration: 0,
    cleanCharCount: s.to - s.from + 1,
    scriptCharRange: [s.from, s.to],
    reason: s.reason,
  };
});

// 5) 相鄰接續：end = 下一段 start；最後一段收到片尾
for (let i = 0; i < ledger.length - 1; i++) ledger[i].end = ledger[i + 1].start;
ledger.at(-1).end = DURATION;

// 6) 與 B-roll cut 的關係：貼齊，不是錯開（2026-08-26 修正）
//
// caption-contract 第 8 條原文：「**除非同屬一個句子／beat 的刻意同步**，B-roll cut 與
// 字幕切換不得落在同一 frame；預設至少錯開 0.15 秒。」
//
// 這條產線每一個 B-roll cut 都等於一個句子邊界——segment ledger 的切點就是前一段最後
// 一個字的語音結束，而附近的字幕切點是同一個句子邊界。兩者源自同一份逐字時間，
// 不是兩個獨立變化恰好相撞，所以命中的是第 8 條的例外，不是它要防的情況。
//
// 舊實作只做了「推開 0.18s」那一半，沒有實作例外。後果實測（V4）：九個切點沒有一個重合，
// 每個邊界都有 0.19–0.28s 的區間，畫面已經換成 MG 而字幕還在講上一句的內容
// （例如 26.49s 時間差圖已出現，字幕還在講「產品組合正從LED轉向光通訊」）。
// 那是觀眾會注意到的內容錯位，比第 8 條要防的「畫面跳」更嚴重。
//
// 另一個理由：第 8 條的「畫面跳」是針對 card 形式（970×740 疊在主播上）——那時 B-roll 與
// 字幕是兩個各自獨立的元素，同時變動確實像故障。fullframe 形式下 B-roll 就是整個畫面，
// 切點本身就是一次場景切換，字幕跟著換是一次統一的剪接，不是兩個競爭的變化。
// 專案 2026-08-25 從 card 改成 fullframe 時沒有回頭檢視這條規則。
const MIN_OFFSET = 0.15;
const EPS = 1e-6;
const MIN_CAP_DUR = 0.3;
const brollCuts = ledgerSeg.segments.flatMap((s) => [s.startSec, s.endSec]);

// 兩段式：先只動 start，再統一重算 end。
// 一段式（邊貼邊改 end）會讓同一條字幕被多個 cut 反覆貼齊而壓成 0 秒。
// 只往前貼（往停頓的開頭），不往後推。
// 理由：segment ledger 的切點站在停頓的開頭（前一句最後一字結束），
// caption 原本站在停頓的結尾（自己第一字開始），兩者相隔就是那個停頓 0.19–0.28s。
// 往前貼會讓字幕提前出現——那是標準字幕做法（觀眾在字被唸出時已經看到文字），
// 而且只會讓字幕變長，對可讀性只有好處。往後推則會讓字幕晚於語音，是退步。
// 判準是語意的，不是距離的：只有當 B-roll 切點落在「這條字幕前面那個停頓」之內才貼齊。
// 停頓 = 前一個字的語音結束 → 本條第一個字的語音開始。兩個端點都直接查 T（逐字時間），
// 所以不需要任何視窗常數。實測 V4 的八個停頓是 0.000–0.450s，若寫死視窗就會漏掉
// 問候之後那個 0.450s 的（那正是使用者回報「b-roll 在早安時就開始」的同一個邊界）。
for (let i = 1; i < ledger.length; i++) {
  const first = ledger[i].scriptCharRange[0];
  if (first <= 0) continue;
  const pauseFrom = T[first - 1].end;      // 前一個字講完
  const pauseTo = T[first].start;          // 本條第一個字開始
  let best = null;
  for (const c of brollCuts) {
    if (c < pauseFrom - EPS || c > pauseTo + EPS) continue;
    if (best === null || c > best) best = c;
  }
  if (best === null) continue;
  const snapped = Number(best.toFixed(2));
  if (snapped - ledger[i - 1].start < MIN_CAP_DUR) continue;   // 會壓垮前一條就不貼
  ledger[i].start = snapped;
}
for (let i = 0; i < ledger.length - 1; i++) ledger[i].end = ledger[i + 1].start;
ledger.at(-1).end = DURATION;
for (const c of ledger) c.duration = Number((c.end - c.start).toFixed(3));


// 2026-08-26：短於下限的字幕併進前一條。
// 起因是 Studio 的 TTS 比 API 快，HOOK 被擠壓成「今天還能追嗎？」只剩 0.8s（下限 0.9s）。
// 7 個字 0.8 秒讀不完。併進前一條後字數會超過 soft cap 但仍在 hard cap 之內——
// 讀不完是硬傷，字數超軟上限只是偏好，兩者衝突時以可讀性為先。
{
  const arr = ledger.captions ?? ledger;
  for (let i = arr.length - 1; i > 0; i--) {
    if (arr[i].end - arr[i].start >= MIN_DUR - 1e-6) continue;
    const prev = arr[i - 1], cur = arr[i];
    if (prev.cleanCharCount + cur.cleanCharCount > HARD_CH) {
      console.warn(`${cur.id} 過短但併入後超過 hard cap ${HARD_CH}，未併`);
      continue;
    }
    const joiner = /[，。、；：？！]$/u.test(prev.text) ? '' : '，';
    prev.text = `${prev.text}${joiner}${cur.text}`;
    prev.end = cur.end;
    prev.duration = Number((cur.end - prev.start).toFixed(3));
    prev.cleanCharCount += cur.cleanCharCount;
    prev.scriptCharRange = [prev.scriptCharRange[0], cur.scriptCharRange[1]];
    prev.reason = `${prev.reason}+merged-short`;
    arr.splice(i, 1);
  }
  arr.forEach((c, i) => { c.id = `CAP-${String(i + 1).padStart(2, '0')}`; });
}

// 2026-08-26 使用者 audit：字幕結尾不要句號、逗號、頓號。
// 保留 ？與 ！ —— 那兩個承載語氣，去掉會讓問句讀起來像陳述句。
for (const c of ledger.captions ?? ledger) {
  c.text = String(c.text).replace(/[。，、；：]+$/u, '');
}

writeJson(P, 'captionLedger', ledger, { inputs: ['charTimes', 'segmentLedger', 'script'] });

// 機械檢查
const problems = [];
const cleanAll = T.map((x) => x.ch).join('');
const coveredChars = ledger.reduce((a, c) => a + c.cleanCharCount, 0);
if (coveredChars !== T.length) problems.push(`char coverage ${coveredChars}/${T.length}`);
ledger.forEach((c, i) => {
  if (c.duration < MIN_DUR) problems.push(`${c.id} duration ${c.duration}s < ${MIN_DUR}`);
  if (c.cleanCharCount > HARD_CH) problems.push(`${c.id} ${c.cleanCharCount} chars > hard cap ${HARD_CH}`);
  if (c.cleanCharCount < 4) problems.push(`${c.id} orphan ${c.cleanCharCount} chars`);
  if (i && c.start < ledger[i - 1].end - 0.001) problems.push(`${c.id} overlaps previous`);
  for (const cut of brollCuts) if (i && Math.abs(c.start - cut) < MIN_OFFSET - EPS && Math.abs(c.start - cut) > 0.011) problems.push(`${c.id} start ${c.start} 靠近但未貼齊 B-roll cut ${cut}`);
});
console.log(JSON.stringify({
  captions: ledger.length,
  minDuration: Math.min(...ledger.map((x) => x.duration)),
  maxChars: Math.max(...ledger.map((x) => x.cleanCharCount)),
  minChars: Math.min(...ledger.map((x) => x.cleanCharCount)),
  coveredChars, problems,
  overSoftCap: ledger.filter((x) => x.cleanCharCount > MAX_CH).map((x) => `${x.id}:${x.cleanCharCount}`),
}, null, 2));
