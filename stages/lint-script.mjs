#!/usr/bin/env node
/**
 * 晨報講稿 lint。把 晨報腳本_ROLE.md 的散文規則變成機檢。
 *
 *   node stages/lint-script.mjs <script.txt> [--speed 1.1] [--hook first|after-market] [--json]
 *
 * 字數一律走 app/scripts/script-utils.js 的 cleanBodyWithIndex——那是唯一的字數契約，
 * 這裡不自己數字元。門檻能從 contracts/acceptance.json 讀的就讀，避免兩處各寫一份。
 *
 * 退出碼：0 = 無 error；1 = 有 error。warn 與 info 不影響退出碼。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { getBodyAfterVoice, getTitleText, cleanBodyWithIndex, parseVoiceRules } =
  require(path.join(__dirname, 'script-utils.js'));

const ROOT = path.resolve(__dirname, '..');
const acceptance = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'contracts', 'acceptance.json'), 'utf8'),
);
const gate = (id) => acceptance.gates.find((g) => g.id === id)?.threshold ?? {};

// ── 校準常數 ────────────────────────────────────────────────────────────────
// 4.70–4.91 clean chars/s 是加速後的成品語速區間，來源 晨報講稿時長換算表.md 的五個實測點。
// 兩條路徑都被調到落在這個區間內：API 1.2×（raw 3.97 → 4.76）、Studio 1.1×（raw 4.39 → 4.83）。
// 因此區間是對「成品語速」的約束，與用哪條路徑加速無關。
const RATE_MIN = 4.70;
const RATE_MAX = 4.91;
const TARGET_SEC = { min: 42, max: 55 }; // V4c 48.6s 通過；V2 60.5s 被判定太長

// ── 禁用寫法（晨報腳本_ROLE.md「禁用寫法」節） ───────────────────────────────
const BANNED = [
  { re: /不僅[^。，]{0,20}而且/, label: '不僅⋯而且⋯' },
  { re: /不是[^。，]{0,20}而是/, label: '不是⋯而是⋯' },
  { re: /才算真(的|正)/, label: '才算真的／才算真正' },
  { re: /總而言之/, label: '總而言之' },
  { re: /深遠影響/, label: '深遠影響' },
  { re: /值得注意的是/, label: '值得注意的是' },
  { re: /不只如此/, label: '不只如此' },
  { re: /一定會漲/, label: '無條件的「一定會漲」' },
  { re: /確定受惠/, label: '無條件的「確定受惠」' },
  { re: /準備噴出/, label: '無條件的「準備噴出」' },
  { re: /投資人要留意(?![^。]*(若|如果|跌破|站上|量能|沒有))/, label: '沒有具體條件的「投資人要留意」' },
  { re: /後續值得關注/, label: '沒有具體條件的「後續值得關注」' },
  { re: /掌握市場脈動/, label: '制式結語' },
];

// 口播 CTA（2026-08-26 起移除）
const CTA = [
  { re: /開啟籌碼\s*K\s*線/, label: '口播 CTA：開啟籌碼K線' },
  { re: /頁籤/, label: '口播 CTA：提到頁籤' },
  { re: /查看主力動向/, label: '口播 CTA：查看主力動向' },
  { re: /投資決策更有依據/, label: '口播 CTA：制式結語' },
];

// 指涉不明的時間詞。「那天」是 2026-08-26 實際被抓到的問題。
const VAGUE_TIME = [/那天/, /前幾天/, /日前/, /近日/, /先前/];
const TIME_WORDS = /昨天|昨日|今天|今日|本週|上週/g;

// 價格點位當觀察點或進出場依據（陳述已發生事實可以）
const PRICE_TRIGGER = [
  { re: /觀察[^。]{0,20}\d+(\.\d+)?\s*元/, label: '以價格當觀察點' },
  { re: /\d+(\.\d+)?\s*元(附近|上下|關卡|之上|之下)/, label: '以價格當關卡' },
  { re: /(跌破|站上|突破)\s*\d+(\.\d+)?\s*元/, label: '以價格當進出場依據' },
];

// ── 參數 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const asJson = argv.includes('--json');
const hookMode = flag('hook', 'first'); // first = V4c 基準；after-market = ROLE.md 原文
if (!file) {
  console.error('用法：node stages/lint-script.mjs <script.txt> [--speed 1.1] [--hook first|after-market] [--json]');
  process.exit(2);
}

const raw = fs.readFileSync(file, 'utf8');
const findings = [];
const add = (severity, id, message, extra = {}) =>
  findings.push({ severity, id, message, ...extra });

// ── 標題區塊與正文 ─────────────────────────────────────────────────────────
const title = getTitleText(raw);
const body = getBodyAfterVoice(raw);
const chars = cleanBodyWithIndex(body);
const cleanCount = chars.length;

if (!raw.includes('===')) {
  add('error', 'format.title-block', '缺少 === 包夾的標題區塊');
} else {
  const titleLines = (title || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!titleLines.length) {
    add('error', 'format.title-block', '標題區塊是空的');
  } else if (!/^\d{2}\/\d{2}\s*台股晨報$/.test(titleLines[0])) {
    add('error', 'format.title-first-line',
      `標題第一行必須是「MM/DD 台股晨報」，收到「${titleLines[0]}」`,
      { source: '晨報腳本_ROLE.md 2026-08-26 變更紀錄' });
  }
  if (/籌碼\s*K\s*晨報/.test(title || '')) {
    add('error', 'format.wrong-program-name', '片型名稱是「台股晨報」，不是「籌碼K晨報」');
  }
}

const paragraphs = body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
if (!paragraphs.length) { add('error', 'format.empty-body', '正文是空的'); }

// 段落之間必須空一行：正文裡不應出現「非空行緊接非空行」
const bodyLines = body.split('\n');
for (let i = 1; i < bodyLines.length; i++) {
  if (bodyLines[i].trim() && bodyLines[i - 1].trim()) {
    add('error', 'format.paragraph-blank-line',
      `第 ${i + 1} 行與上一行之間缺少空行（段落之間空一行）`,
      { evidence: bodyLines[i].slice(0, 24) });
    break;
  }
}

if (/[—–]|--/.test(body)) {
  add('error', 'format.no-em-dash', '不使用破折號，改用句號或換行',
    { evidence: (body.match(/.{0,10}(—+|–|--).{0,10}/) || [])[0] });
}
if (/https?:\/\/|www\./.test(body)) {
  add('error', 'format.no-url', '不朗讀網址');
}
for (const m of body.matchAll(/（[^）]{6,}）/g)) {
  add('error', 'format.no-parenthetical', '不朗讀括號說明', { evidence: m[0].slice(0, 24) });
}

// ── 字數與片長 ─────────────────────────────────────────────────────────────
const estMin = cleanCount / RATE_MAX;
const estMax = cleanCount / RATE_MIN;
const lenGate = gate('script.length');
if (lenGate.minChars && cleanCount < lenGate.minChars) {
  add('error', 'script.length', `clean ${cleanCount} 字低於下限 ${lenGate.minChars}`);
}
if (lenGate.maxChars && cleanCount > lenGate.maxChars) {
  add('error', 'script.length', `clean ${cleanCount} 字超過上限 ${lenGate.maxChars}`);
}
if (estMin > TARGET_SEC.max) {
  add('error', 'script.duration',
    `預估片長 ${estMin.toFixed(1)}–${estMax.toFixed(1)}s，下緣已超過上限 ${TARGET_SEC.max}s`);
} else if (estMax > TARGET_SEC.max) {
  add('warn', 'script.duration',
    `預估片長 ${estMin.toFixed(1)}–${estMax.toFixed(1)}s，上緣超過 ${TARGET_SEC.max}s`);
}
if (estMax < TARGET_SEC.min) {
  add('warn', 'script.duration', `預估片長 ${estMin.toFixed(1)}–${estMax.toFixed(1)}s，可能太短`);
}

// ── 結構 ───────────────────────────────────────────────────────────────────
const GREETING = /早安[，,]\s*親愛的投資人/;
if (!GREETING.test(body)) {
  add('error', 'structure.greeting', '缺少「早安，親愛的投資人」');
}
const firstPara = paragraphs[0] || '';
const firstSentence = (body.match(/^[^。？！]*[。？！]/) || [firstPara])[0].trim();
const hookIsQuestion = /？$/.test(firstSentence);

if (hookMode === 'first') {
  if (GREETING.test(firstPara)) {
    add('error', 'structure.hook-position',
      'HOOK 必須在第一句，問候不得出現在 HOOK 之前',
      { evidence: firstPara.slice(0, 30), source: '晨報腳本_ROLE_變更提案.md 變更 A／B' });
  } else if (!hookIsQuestion) {
    add('error', 'structure.hook-is-question',
      `HOOK 必須是問句，收到「${firstSentence.slice(0, 30)}」`);
  }
} else {
  const gi = paragraphs.findIndex((p) => GREETING.test(p));
  const hi = paragraphs.findIndex((p) => /？/.test(p));
  if (gi !== 0) add('error', 'structure.greeting-first', '問候必須在第一段');
  if (hi <= gi) add('error', 'structure.hook-position', 'HOOK 必須在昨日台股與昨晚美股之後');
}

// ── 用詞 ───────────────────────────────────────────────────────────────────
for (const b of BANNED) {
  const m = body.match(b.re);
  if (m) add('error', 'wording.banned', `禁用寫法：${b.label}`, { evidence: m[0] });
}
for (const c of CTA) {
  const m = body.match(c.re);
  if (m) add('error', 'script.no-cta', c.label, { evidence: m[0], source: '2026-08-26 使用者裁定移除' });
}
for (const v of VAGUE_TIME) {
  const m = body.match(v);
  if (m) {
    add('error', 'wording.vague-time',
      `時間指涉不明：「${m[0]}」。要嘛寫實際日期，要嘛寫「昨日」`,
      { evidence: (body.match(new RegExp(`.{0,8}${m[0]}.{0,10}`)) || [])[0] });
  }
}
const timeHits = body.match(TIME_WORDS) || [];
const maxTime = gate('script.time-word-repeat').maxTimeWords ?? 4;
if (timeHits.length > maxTime) {
  add('warn', 'script.time-word-repeat',
    `時間指稱詞 ${timeHits.length} 次，上限 ${maxTime}（${[...new Set(timeHits)].join('／')}）`,
    { source: 'Carrie 2026-08-25 回饋第 5 項' });
}

// ── 數字 ───────────────────────────────────────────────────────────────────
for (const m of body.matchAll(/\d+\.\d+/g)) {
  add('warn', 'number.no-decimal',
    `口播數字不帶小數：${m[0]}`,
    { evidence: (body.match(new RegExp(`.{0,6}${m[0].replace('.', '\\.')}.{0,6}`)) || [])[0],
      note: 'V4c 的漲停價 74.8 元刻意保留，取整會失真。此規則與 V4c 基準衝突，見報告末。' });
}
for (const p of PRICE_TRIGGER) {
  const m = body.match(p.re);
  if (m) add('error', 'number.price-as-trigger', `${p.label}：${m[0]}`);
}

// ── 句長與段落 ─────────────────────────────────────────────────────────────
let cursor = 0;
for (const p of paragraphs) {
  const pc = cleanBodyWithIndex(p).length;
  if (pc > 70) {
    add('warn', 'style.paragraph-too-long',
      `段落 ${cleanBodyWithIndex(p).length} 字，超過 70（每個段落只承載一個判斷）`,
      { evidence: p.slice(0, 24) });
  }
  cursor += pc;
}
for (const s of body.split(/(?<=[。？！])/)) {
  const sc = cleanBodyWithIndex(s).length;
  if (sc > 40) {
    add('warn', 'style.sentence-too-long', `單句 ${sc} 字，超過 40（以短句為主）`,
      { evidence: s.trim().slice(0, 24) });
  }
}

// ── 主動回報規格衝突 ───────────────────────────────────────────────────────
add('info', 'spec.conflict',
  'ROLE.md 寫「HOOK 放在昨日台股與昨晚美股之後」，但品質基準 V4c 是 HOOK 前置（變更提案 A 尚未併回 ROLE.md）。' +
  '本次以 --hook=' + hookMode + ' 檢查。SKILL.md 對 HOOK 位置沒有規定，因此無法據 SKILL.md 裁決。');
if (findings.some((f) => f.id === 'number.no-decimal')) {
  add('info', 'spec.conflict',
    'ROLE.md 的「數字取整、口播不帶小數」與 V4c 保留漲停價 74.8 元衝突。目前只給 warn，不擋。');
}

// ── 輸出 ───────────────────────────────────────────────────────────────────
const counts = { error: 0, warn: 0, info: 0 };
findings.forEach((f) => { counts[f.severity]++; });
const report = {
  file: path.resolve(file),
  title: (title || '').split('\n').map((s) => s.trim()).filter(Boolean),
  cleanChars: cleanCount,
  paragraphs: paragraphs.length,
  voiceRules: parseVoiceRules(raw).length,
  estimatedSec: [Number(estMin.toFixed(1)), Number(estMax.toFixed(1))],
  rateBand: [RATE_MIN, RATE_MAX],
  hookMode,
  counts,
  findings,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const tag = { error: '錯誤', warn: '警告', info: '資訊' };
  console.log(`${path.basename(file)}  clean ${cleanCount} 字  ${paragraphs.length} 段  ` +
    `預估 ${report.estimatedSec[0]}–${report.estimatedSec[1]}s  hook=${hookMode}`);
  console.log(`錯誤 ${counts.error}　警告 ${counts.warn}　資訊 ${counts.info}`);
  for (const sev of ['error', 'warn', 'info']) {
    for (const f of findings.filter((x) => x.severity === sev)) {
      console.log(`  [${tag[sev]}] ${f.id}  ${f.message}`);
      if (f.evidence) console.log(`           證據：${f.evidence.replace(/\n/g, ' ')}`);
      if (f.source) console.log(`           依據：${f.source}`);
      if (f.note) console.log(`           註：${f.note}`);
    }
  }
}
process.exit(counts.error ? 1 : 0);
