#!/usr/bin/env node
/**
 * 從講稿推導 segment plan。
 *
 *   node stages/plan-segments.mjs --project <dir> [--write] [--alternatives 3]
 *
 * ## 為什麼不是分類器
 *
 * 逐分句判斷「這句該不該上圖」在 V4c 的資料上就對不起來：帶數字的分句 1 是主播（HOOK），
 * 帶疑問的 25／26 是素材，帶列舉的 18–21 是主播而 24 是素材。那些標籤是編輯判斷
 * （slot 07 被指定為全片最強的反轉，要主播的臉），不是文字特徵的函數。
 *
 * 所以這支程式不猜意圖。它做兩件事：
 *
 *  1. **讓不合法的結構做不出來。** 分句是唯一的切點單位（V4c 的 9 個切點全部落在分句邊界），
 *     在此之上用 DP 找出滿足 acceptance.json 全部門檻的分割：嚴格 P／M 交替、首末為
 *     presenter、最短主播段、最長連續素材、覆蓋率上限、問候不得被蓋。
 *  2. **在付費之前就能判斷可行性。** 沒有 ASR 時用校準語速估時長，並且在語速區間的兩個
 *     端點都驗一次——只在區間中點成立的計畫是脆的，真音檔一到就會破。
 *
 * `responsibility` 一律留空給人填。那是 B-roll prompt 的依據，屬於編輯意圖；
 * 結構是機器的事，意圖是人的事。已存在的 plan 會依 anchor 比對保留原本的 responsibility。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveProject, writeJson } from './lib/project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex } = require(path.join(here, 'script-utils.js'));

const acceptance = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/acceptance.json'), 'utf8'));
const th = (id) => acceptance.gates.find((g) => g.id === id)?.threshold ?? {};
const MIN_PRESENTER = th('ledger.min-presenter').minPresenterSec ?? 3.0;
const MAX_MATERIAL_RUN = th('ledger.max-material-run').maxMaterialRunSec ?? 6.5;
const MAX_COVERAGE = th('ledger.coverage').maxCoverage ?? 0.5;
const TARGET_COVERAGE = acceptance.gates.find((g) => g.id === 'ledger.coverage')?.observed ?? 0.44;

// 語速區間：計畫必須在兩個端點都合法
const RATE = [4.70, 4.91];

let P;
try { P = resolveProject(); } catch (e) {
  console.error(e.message);
  console.error('用法：node stages/plan-segments.mjs --project <dir> [--write] [--alternatives N]');
  process.exit(2);
}
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const WRITE = argv.includes('--write');
const N_ALT = Number(flag('alternatives', 3));

// ── 分句 ───────────────────────────────────────────────────────────────────
const raw = fs.readFileSync(P.path('script'), 'utf8');
const body = getBodyAfterVoice(raw);
const T = cleanBodyWithIndex(body);
const clean = T.map((c) => c.char).join('');

const isTerminalAfter = (i) => {
  let j = T[i].origIdx + 1;
  while (j < body.length && /\s/.test(body[j])) j++;
  return /[。？！]/.test(body[j] ?? '');
};

const clauses = [];
{
  let from = 0;
  for (let i = 0; i < T.length; i++) {
    if (!T[i].breakAfter && i !== T.length - 1) continue;
    clauses.push({
      idx: clauses.length, from, to: i,
      text: clean.slice(from, i + 1),
      chars: i - from + 1,
      terminal: isTerminalAfter(i),
    });
    from = i + 1;
  }
}

// ── 時長：有 charTimes 就用真值，否則用語速估 ───────────────────────────────
let realTimes = null;
if (fs.existsSync(P.path('charTimes'))) {
  realTimes = JSON.parse(fs.readFileSync(P.path('charTimes'), 'utf8'));
}
const durationsFor = (rate) => clauses.map((c) =>
  (realTimes ? realTimes[c.to].end - (c.from === 0 ? 0 : realTimes[c.from - 1].end) : c.chars / rate));
const totalFor = (d) => d.reduce((a, b) => a + b, 0);

// ── 特徵標記：回報用，不決定 form ───────────────────────────────────────────
const GREETING = /早安|親愛的投資人/;
const feature = (c) => {
  const f = [];
  if (GREETING.test(c.text)) f.push('greeting');
  if (/[0-9]/.test(c.text)) f.push('number');
  if (/嗎$|什麼$|有沒有/.test(c.text)) f.push('question');
  if (/不要|先不|降低期待|追價/.test(c.text)) f.push('risk-action');
  return f;
};
clauses.forEach((c) => { c.features = feature(c); });

// ── 硬性主播分句 ───────────────────────────────────────────────────────────
// 1) 問候：ledger.greeting-uncovered 要求它落在 presenter 段。
// 2) 第一個句子（HOOK）：變更提案 A／B 要求 HOOK 前置且由主播講。
// 3) 最後一個句子（風險與行動）：ROLE.md 要求風險附具體行動，那是人講的。
const firstSentenceEnd = clauses.findIndex((c) => c.terminal);
const lastSentenceStart = (() => {
  for (let i = clauses.length - 2; i >= 0; i--) if (clauses[i].terminal) return i + 1;
  return 0;
})();
const hints = fs.existsSync(path.join(P.root, 'plan-hints.json'))
  ? JSON.parse(fs.readFileSync(path.join(P.root, 'plan-hints.json'), 'utf8')) : {};

/**
 * hint 可以寫分句索引，也可以寫分句文字（子字串比對）。
 * 建議寫文字：索引會因為講稿任何一處增刪而位移，文字不會。
 */
function resolveHint(list, label) {
  const out = new Set();
  for (const h of list ?? []) {
    if (typeof h === 'number') {
      if (!clauses[h]) throw new Error(`plan-hints.json 的 ${label} 指到不存在的分句 ${h}`);
      out.add(h);
      continue;
    }
    const hit = clauses.filter((c) => c.text.includes(h));
    if (!hit.length) throw new Error(`plan-hints.json 的 ${label} 找不到分句包含「${h}」`);
    if (hit.length > 1) {
      throw new Error(`plan-hints.json 的 ${label}「${h}」比對到 ${hit.length} 個分句` +
        `（${hit.map((c) => c.idx).join('、')}），請寫得更精確`);
    }
    out.add(hit[0].idx);
  }
  return out;
}

const forcedPresenter = new Set();
const forcedMaterial = resolveHint(hints.material, 'material');
clauses.forEach((c, i) => {
  if (c.features.includes('greeting')) forcedPresenter.add(i);
  if (i <= firstSentenceEnd) forcedPresenter.add(i);
  if (i >= lastSentenceStart) forcedPresenter.add(i);
});
resolveHint(hints.presenter, 'presenter').forEach((i) => forcedPresenter.add(i));
for (const i of forcedMaterial) {
  if (forcedPresenter.has(i)) {
    console.error(`plan-hints.json 要求分句 ${i} 是素材，但它是硬性主播分句（${clauses[i].features.join('／') || 'HOOK 或結尾'}）`);
    process.exit(2);
  }
}

// ── DP：找出成本最低的合法分割 ─────────────────────────────────────────────
//
// 狀態 (i, lastForm, matBucket)：前 i 個分句已分配完，最後一段是 lastForm，
// 累計素材時長落在 matBucket（0.1s 為一格）。覆蓋率是全域項但對段是可加的，
// 所以放進狀態就能做精確 DP。
const BUCKET = 0.1;

function solve(rate, wantAlternatives = 1) {
  const D = durationsFor(rate);
  const total = totalFor(D);
  const maxMat = MAX_COVERAGE * total;
  const nB = Math.floor(maxMat / BUCKET) + 1;
  const n = clauses.length;
  const INF = Infinity;
  // dp[i][form][b] = { cost, from } ；form 0=presenter 1=material
  const dp = Array.from({ length: n + 1 }, () =>
    [Array(nB).fill(null), Array(nB).fill(null)]);
  dp[0][0][0] = { cost: 0, prev: null };   // 虛擬起點：視為「上一段是 material」以便第一段必須是 presenter
  dp[0][1][0] = { cost: 0, prev: null };

  const runCost = (a, b, form, D) => {
    // a..b 這一段的成本（不含覆蓋率，覆蓋率在最後算）
    let cost = 0;
    // 切點偏好落在終止標點：段尾不是終止標點就加一點成本
    if (b < clauses.length - 1 && !clauses[b].terminal) cost += 1;
    if (form === 1) {
      cost -= 0.5;                                    // 多一段素材＝多一個節奏點
      const anyNumber = clauses.slice(a, b + 1).some((c) => c.features.includes('number'));
      const anyHint = clauses.slice(a, b + 1).some((c) => forcedMaterial.has(c.idx));
      if (!anyNumber && !anyHint) cost += 2;          // 沒有可視覺化的東西就上圖，代價較高
    }
    return cost;
  };

  for (let i = 0; i < n; i++) {
    for (let form = 0; form < 2; form++) {
      for (let b = 0; b < nB; b++) {
        const cell = dp[i][form][b];
        if (!cell) continue;
        const nextForm = 1 - form;                    // 嚴格交替
        let dur = 0;
        for (let j = i; j < n; j++) {
          dur += D[j];
          const seg = clauses.slice(i, j + 1);
          if (nextForm === 1 && seg.some((c) => forcedPresenter.has(c.idx))) break;
          if (nextForm === 0 && seg.some((c) => forcedMaterial.has(c.idx))) break;
          if (nextForm === 1 && dur > MAX_MATERIAL_RUN + 1e-9) break;
          if (nextForm === 0 && dur < MIN_PRESENTER - 1e-9) continue;
          const nb = nextForm === 1 ? b + Math.round(dur / BUCKET) : b;
          if (nb >= nB) continue;
          const c = cell.cost + runCost(i, j, nextForm, D);
          const cur = dp[j + 1][nextForm][nb];
          if (!cur || c < cur.cost) {
            dp[j + 1][nextForm][nb] = { cost: c, prev: { i, form, b, from: i, to: j, runForm: nextForm } };
          }
        }
      }
    }
  }

  // 終點：最後一段必須是 presenter
  const cands = [];
  for (let b = 0; b < nB; b++) {
    const cell = dp[n][0][b];
    if (!cell) continue;
    const coverage = (b * BUCKET) / total;
    cands.push({ cost: cell.cost + 100 * Math.abs(coverage - TARGET_COVERAGE), coverage, b, cell });
  }
  cands.sort((x, y) => x.cost - y.cost);

  const plans = [];
  for (const cand of cands.slice(0, wantAlternatives)) {
    const runs = [];
    let node = cand.cell.prev, i = n, form = 0, b = cand.b;
    while (node) {
      runs.unshift({ from: node.from, to: node.to, form: node.runForm === 1 ? 'mg' : 'presenter' });
      const p = dp[node.i][node.form][node.b];
      ({ i, form, b } = node);
      node = p ? p.prev : null;
    }
    plans.push({ runs, coverage: cand.coverage, cost: Number(cand.cost.toFixed(3)), total });
  }
  return { plans, total, feasible: cands.length };
}

// ── 在語速區間兩端都求解，取交集才算穩健 ────────────────────────────────────
const lo = solve(RATE[0], N_ALT);
const hi = solve(RATE[1], N_ALT);
const key = (p) => p.runs.map((r) => `${r.from}-${r.to}:${r.form[0]}`).join('|');
const hiKeys = new Set(hi.plans.map(key));

if (!lo.plans.length || !hi.plans.length) {
  console.error('找不到任何合法分割。可能原因：講稿太短撐不出 ' +
    `${MIN_PRESENTER}s 的主播段，或硬性主播分句太長導致覆蓋率無法達到門檻。`);
  console.error(`分句 ${clauses.length} 個，clean ${T.length} 字，` +
    `估計片長 ${(T.length / RATE[1]).toFixed(1)}–${(T.length / RATE[0]).toFixed(1)}s`);
  process.exit(1);
}

const chosen = lo.plans.find((p) => hiKeys.has(key(p))) ?? lo.plans[0];
const mgCount = chosen.runs.filter((r) => r.form === 'mg').length;
if (mgCount < 3) {
  console.error(`只規劃出 ${mgCount} 個素材格（下界 3）。覆蓋率 ${(chosen.coverage * 100).toFixed(1)}%。`);
  console.error('講稿太短或硬性主播分句佔比過高，撐不出晨報該有的素材節奏。先改講稿。');
  process.exit(1);
}
const robust = hiKeys.has(key(chosen));

// ── 輸出 ───────────────────────────────────────────────────────────────────
const prev = fs.existsSync(P.path('segmentPlan'))
  ? JSON.parse(fs.readFileSync(P.path('segmentPlan'), 'utf8')) : [];
const prevByAnchor = new Map(prev.map((p) => [p.anchor, p.responsibility]));

const plan = chosen.runs.map((r, k) => {
  const anchor = clean.slice(clauses[r.from].from, clauses[r.to].to + 1);
  return {
    id: String(k + 1).padStart(2, '0'),
    form: r.form,
    anchor,
    responsibility: prevByAnchor.get(anchor) ?? null,
    derivation: {
      clauses: [r.from, r.to],
      chars: anchor.length,
      estSec: [Number((anchor.length / RATE[1]).toFixed(2)), Number((anchor.length / RATE[0]).toFixed(2))],
      features: [...new Set(clauses.slice(r.from, r.to + 1).flatMap((c) => c.features))],
      forced: clauses.slice(r.from, r.to + 1).some((c) => forcedPresenter.has(c.idx)) ? 'presenter'
        : clauses.slice(r.from, r.to + 1).some((c) => forcedMaterial.has(c.idx)) ? 'material-hint' : null,
    },
  };
});

console.log(`分句 ${clauses.length} 個 → ${plan.length} 格　覆蓋率 ${(chosen.coverage * 100).toFixed(1)}%　` +
  `成本 ${chosen.cost}　語速兩端一致：${robust ? '是' : '否'}`);
console.log(`合法分割數：語速下緣 ${lo.feasible}、上緣 ${hi.feasible}`);
console.log('');
console.log('格 form      分句    字  估秒        責任');
for (const s of plan) {
  console.log(`${s.id} ${s.form.padEnd(9)} ${String(s.derivation.clauses[0]).padStart(2)}-${String(s.derivation.clauses[1]).padEnd(2)} ` +
    `${String(s.derivation.chars).padStart(3)} ${s.derivation.estSec.join('–').padEnd(11)} ` +
    `${s.responsibility ?? '（待填）'}`);
}
if (!robust) {
  console.log('');
  console.log('注意：這個分割在語速區間兩端不一致，真音檔到位後可能需要重算。');
}
const missing = plan.filter((s) => s.form === 'mg' && !s.responsibility);
if (missing.length) {
  console.log('');
  console.log(`${missing.length} 個素材格還沒有 responsibility：${missing.map((s) => s.id).join('、')}`);
  console.log('那是 B-roll prompt 的依據，屬編輯意圖，程式不代填。');
}

if (WRITE) {
  writeJson(P, 'segmentPlan', plan, { inputs: ['script'] });
  console.log('');
  console.log(`已寫入 ${P.rel('segmentPlan')}`);
}
