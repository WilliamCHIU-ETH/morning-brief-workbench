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
import { TEMPLATES } from './mg-templates.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex } = require(path.join(here, 'script-utils.js'));

let P;
try { P = resolveProject(); } catch (e) {
  console.error(e.message);
  console.error('用法：node stages/plan-mg.mjs --project <dir> [--write]');
  process.exit(2);
}
const WRITE = process.argv.includes('--write');

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
  const t = TEMPLATES[tid];
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
    d.nodes = picked.map((s) => br(s.replace(/^(鼎元的|公司的|該公司)/u, ''), 5));
    while (d.nodes.length < 3) d.nodes.push('—');
    if (!d.band) d.band = f.clauses.at(-1) ?? '';
  }
  return d;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const plan = readJson(P, 'segmentPlan');
const overrides = fs.existsSync(path.join(P.root, 'mg-overrides.json'))
  ? JSON.parse(fs.readFileSync(path.join(P.root, 'mg-overrides.json'), 'utf8')) : {};

// 時長：有 ledger 用真值，否則用 plan 的估計上緣（比較保守）
let ledger = null;
try { ledger = readJson(P, 'segmentLedger'); } catch { /* 付費之前沒有 */ }
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
    ? { id: overrides[s.id].template, why: 'mg-overrides.json 指定' }
    : pickTemplate(f);
  const t = TEMPLATES[pick.id];
  if (!t) { console.error(`格 ${s.id}：未知版型 ${pick.id}`); process.exit(1); }
  const data = { ...buildData(pick.id, f, o.text), ...(overrides[s.id]?.data ?? {}) };
  const err = t.validate(data);
  const dur = durOf(s);
  rows.push({
    id: s.id, template: pick.id, why: pick.why, durationSec: Number(dur.sec.toFixed(2)),
    durationFrom: dur.from, sourceText: o.text, responsibility: s.responsibility,
    extracted: { numbers: f.numbers.map((n) => n.matched), enumMarker: f.enumMarker, contrast: f.contrast },
    data, invalid: err,
  });
}

const bad = rows.filter((r) => r.invalid);
console.log(`素材格 ${rows.length} 個　版型：${rows.map((r) => `${r.id}=${r.template}`).join('　')}`);
console.log('');
for (const r of rows) {
  console.log(`格 ${r.id}  ${r.template.padEnd(13)} ${r.durationSec}s(${r.durationFrom})  ← ${r.why}`);
  console.log(`         原文：${r.sourceText}`);
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
  for (const r of rows) {
    const t = TEMPLATES[r.template];
    const { css, body: bodyHtml, tl } = t.render(C, r.data);
    const html = shell(`br${r.id}`, r.durationSec, css, bodyHtml, tl(r.durationSec), t.shiftY);
    fs.writeFileSync(path.join(dir, `${r.id}-${r.template}.html`), html);
  }
  writeJson(P, 'mg-plan.json', { generatedFrom: P.rel('segmentPlan'), slots: rows },
    { inputs: ['script', 'segmentPlan'] });
  console.log('');
  console.log(`已寫出 ${rows.length} 個 composition 到 compositions/，計畫在 mg-plan.json`);
}
process.exit(bad.length ? 1 : 0);
