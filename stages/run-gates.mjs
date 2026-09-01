#!/usr/bin/env node
/**
 * Gate runner。把 contracts/acceptance.json 的門檻真的跑起來。
 *
 *   node stages/run-gates.mjs --project <dir> [--json]
 *
 * 三個原則：
 *  - **不靜默通過。** 缺 artifact 的 gate 是 skipped 並寫明原因，不算 pass。
 *  - **門檻只在 acceptance.json 定義一次。** 這裡只實作量測，不重寫數字。
 *  - **量測定義寫在 measured 欄位裡**，讓報告本身可稽核。
 *
 * 退出碼：0 = 沒有 failed；1 = 有 failed。skipped 不影響退出碼但會印出來。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveProject, sha256File, requireFresh, readJson } from './lib/project.mjs';
import { greetingWindow } from './lib/lead.mjs';
import {
  checkAudioCleanMatchesScript,
  checkAudioShaMatchesTrack,
  payloadContractDifferences,
} from './lib/heygen-audio.mjs';
import { imageSize } from './shot-template.mjs';
import { axDateMatchesDataAsOf, normalizeIsoDate } from './lib/as-of-shot.mjs';
import { shotBeatTweenSec } from './lib/rhythm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex } = require(path.join(here, 'script-utils.js'));

const acceptance = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/acceptance.json'), 'utf8'));
let P;
try { P = resolveProject(); } catch (e) {
  console.error(e.message);
  console.error('用法：node stages/run-gates.mjs --project <dir> [--json]');
  process.exit(2);
}
const asJson = process.argv.includes('--json');
const EPS = 0.02;

const results = [];
const has = (key) => fs.existsSync(P.path(key));

// 必要 artifact：always 永遠必要；一旦付費生成過（avatar/raw.mp4 存在），afterAvatar 也變必要。
const REQUIRED = new Set(acceptance.requiredArtifacts?.always ?? []);
const paid = fs.existsSync(P.path('avatarRaw'));
if (paid) for (const f of acceptance.requiredArtifacts?.afterAvatar ?? []) REQUIRED.add(f);
// 讀檔一律先驗 provenance。裸讀會讓過期 artifact 產生誤診：
// 講稿改了但 plan 沒重建時，plan.covers-script 會報「anchor 找不到」，
// 讓人去改講稿或改 plan，而真正該做的是重跑 plan-segments。
const load = (key) => { requireFresh(P, key); return JSON.parse(fs.readFileSync(P.path(key), 'utf8')); };

function record(id, status, measured, detail = {}) {
  results.push({ id, status, measured, ...detail });
}
/** needs: artifact keys 必須都在，否則 skipped。 */
function gate(id, needs, fn) {
  const spec = acceptance.gates.find((g) => g.id === id);
  if (!spec) return record(id, 'error', null, { note: 'acceptance.json 沒有這道 gate' });
  const missing = needs.filter((k) => !has(k));
  if (missing.length) {
    // 缺的是必要 artifact 就是 failed。skipped 只留給「這個階段還沒到」。
    const req = missing.filter((k) => REQUIRED.has(P.rel(k)));
    return record(id, req.length ? 'failed' : 'skipped', null,
      { note: `缺 ${missing.map((k) => P.rel(k)).join('、')}`
        + (req.length ? `（其中 ${req.map((k) => P.rel(k)).join('、')} 是必要 artifact）` : ''),
        rule: spec.rule });
  }
  try {
    const { ok, measured, note } = fn(spec.threshold ?? {}, spec);
    record(id, ok ? 'passed' : 'failed', measured, { rule: spec.rule, ...(note ? { note } : {}) });
  } catch (e) {
    record(id, 'error', null, { note: e.message, rule: spec.rule });
  }
}

function cleanOfScript() {
  return cleanBodyWithIndex(getBodyAfterVoice(fs.readFileSync(P.path('script'), 'utf8')));
}

// ── 講稿層：委派給 lint，不重複實作規則 ─────────────────────────────────────
let lintReport = null;
if (has('script')) {
  try {
    const out = execFileSync('node', [path.join(here, 'lint-script.mjs'), P.path('script'), '--json'],
      { encoding: 'utf8' });
    lintReport = JSON.parse(out);
  } catch (e) { lintReport = e.stdout ? JSON.parse(e.stdout) : null; }
}
const lintHas = (id) => Boolean(lintReport?.findings.some((f) => f.id === id && f.severity === 'error'));

for (const id of ['script.length', 'script.hook-first', 'script.no-cta', 'script.time-word-repeat']) {
  gate(id, ['script'], () => {
    if (!lintReport) throw new Error('lint 沒有產出報告');
    const map = {
      'script.length': ['script.length'],
      'script.hook-first': ['structure.hook-position', 'structure.hook-is-question'],
      'script.no-cta': ['script.no-cta'],
      'script.time-word-repeat': [],           // lint 只給 warn，這裡照 warn 判
    };
    if (id === 'script.time-word-repeat') {
      const w = lintReport.findings.find((f) => f.id === 'script.time-word-repeat');
      return { ok: !w, measured: w ? w.message : '未超過上限',
        note: w ? '這是 warn 級，不擋成片，但屬未解決的回饋第 5 項' : undefined };
    }
    const hit = map[id].filter(lintHas);
    return { ok: !hit.length, measured: hit.length ? hit.join('、') : `clean ${lintReport.cleanChars} 字` };
  });
}

// ── segment ledger 層 ──────────────────────────────────────────────────────
const MATERIAL = new Set(['mg', 'device']);
const FORMS = new Set(['presenter', 'mg', 'device']);

/**
 * 讀 segments 並強制 form 合法。
 *
 * 沒有這道檢查的話，缺 form 欄位的 ledger（V1／V2 就是這樣）會讓每一格都被當成
 * presenter，覆蓋率算出 0，於是覆蓋率 gate 完美通過——實際上 V2 的覆蓋率是 96.9%。
 * 量測不到就要爆掉，不能給出一個好看的數字。
 */
function segmentsOf() {
  const L = load('segmentLedger');
  const S = L.segments;
  const bad = S.filter((s) => !FORMS.has(s.form));
  if (bad.length) {
    throw new Error(
      `${bad.length}/${S.length} 格的 form 不合法（只能是 presenter／mg／device）：` +
      `${bad.slice(0, 4).map((s) => `${s.id}=${JSON.stringify(s.form)}`).join('、')}` +
      `${bad.length > 4 ? '…' : ''}。缺 form 就無法判斷哪些格是素材，覆蓋率與交替都量不出來。`);
  }
  return L;
}

/** 時間軸不變量。沒有這些，覆蓋率可以用負數段長湊成任何想要的值。 */
function checkInvariants(L) {
  const S = L.segments;
  const bad = [];
  if (!S.length) bad.push('segments 是空的');
  S.forEach((s, i) => {
    const d = s.endSec - s.startSec;
    if (!(d > 0)) bad.push(`格 ${s.id} 長度 ${d.toFixed(3)}s（必須為正）`);
    if (i > 0 && Math.abs(s.startSec - S[i - 1].endSec) > 1e-6) {
      bad.push(`格 ${s.id} 起點 ${s.startSec} 不接前一格終點 ${S[i - 1].endSec}`);
    }
  });
  if (S.length && Math.abs(S[0].startSec) > 1e-6) bad.push(`首格起點是 ${S[0].startSec}，必須為 0`);
  if (S.length && Math.abs(L.durationSec - S.at(-1).endSec) > 1e-6) {
    bad.push(`durationSec ${L.durationSec} 不等於末格終點 ${S.at(-1).endSec}`);
  }
  return bad;
}

gate('ledger.invariants', ['segmentLedger'], () => {
  const L = segmentsOf();
  const bad = checkInvariants(L);
  return { ok: !bad.length, measured: bad.length ? bad.slice(0, 3).join('；') : `${L.segments.length} 段全部成立` };
});

gate('ledger.duration-in-target', ['segmentLedger'], (th2) => {
  const L = load('segmentLedger');
  const ok = L.durationSec >= (th2.minSec ?? 42) && L.durationSec <= (th2.maxSec ?? 55);
  return { ok, measured: `${L.durationSec}s（目標 ${th2.minSec}–${th2.maxSec}s）` };
});

gate('ledger.duration-matches-video', ['segmentLedger', 'avatarSpeeded'], (th2) => {
  const L = load('segmentLedger');
  const real = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', P.path('avatarSpeeded')], { encoding: 'utf8' }).trim());
  const diff = Math.abs(real - L.durationSec);
  return { ok: diff <= (th2.toleranceSec ?? 0.5),
    measured: `宣告 ${L.durationSec}s／實際 ${real.toFixed(2)}s（差 ${diff.toFixed(2)}s）` };
});

// ── 講稿:整份 lint 都必須乾淨 ─────────────────────────────────────────────
// 逐項對應是錯的做法：lint 有 18 個 error id，原本只有 4 道 gate 對應 5 個，
// 剩下 14 個（朗讀網址、禁用寫法、價格當進出場依據、指涉不明時間詞、缺問候…）
// 永遠到不了 gate。lint 加規則時不會有人記得同步加 gate。
gate('script.lint-clean', ['script'], () => {
  if (!lintReport) throw new Error('lint 沒有產出報告');
  const errs = lintReport.findings.filter((f) => f.severity === 'error');
  const byId = [...new Set(errs.map((f) => f.id))];
  return { ok: errs.length === 0,
    measured: errs.length ? `${errs.length} 個 error：${byId.join('、')}` : `0 error（clean ${lintReport.cleanChars} 字）` };
});

gate('ledger.alternation', ['segmentLedger'], (th2) => {
  const L = segmentsOf();
  const S = L.segments;
  // 單段 ledger 會讓「相鄰素材格 0、首末皆 presenter」全部真空成立。
  if (S.length < 3) return { ok: false, measured: `${S.length} 段（至少要 3 段才談得上交替）` };
  const forms = S.map((s) => s.form);
  if (!forms.some((f) => MATERIAL.has(f))) return { ok: false, measured: '0 個素材格' };
  let adjacent = 0;
  for (let i = 1; i < forms.length; i++) {
    if (MATERIAL.has(forms[i]) && MATERIAL.has(forms[i - 1])) adjacent++;
  }
  const ok = adjacent <= (th2.adjacentMaterialSlots ?? 0)
    && forms[0] === (th2.firstForm ?? 'presenter')
    && forms.at(-1) === (th2.lastForm ?? 'presenter');
  return { ok, measured: forms.map((f) => (MATERIAL.has(f) ? 'M' : 'P')).join(' ') };
});

gate('ledger.min-presenter', ['segmentLedger'], (th2) => {
  const S = segmentsOf().segments.filter((s) => !MATERIAL.has(s.form));
  // 零個主播格必須 failed。Math.min([]) 會回 Infinity 而「通過」。
  if (!S.length) return { ok: false, measured: '0 格 presenter' };
  const min = Math.min(...S.map((s) => s.endSec - s.startSec));
  return { ok: min >= (th2.minPresenterSec ?? 3), measured: Number(min.toFixed(2)) };
});

gate('ledger.max-material-run', ['segmentLedger'], (th2) => {
  const S = segmentsOf().segments;
  const mat = S.filter((s) => MATERIAL.has(s.form));
  if (!mat.length) return { ok: false, measured: '0 個素材格' };
  let run = 0, max = 0;
  for (const s of S) {
    if (MATERIAL.has(s.form)) { run += s.endSec - s.startSec; max = Math.max(max, run); }
    else run = 0;
  }
  return { ok: max <= (th2.maxMaterialRunSec ?? 6.5), measured: Number(max.toFixed(2)) };
});

gate('ledger.coverage', ['segmentLedger'], (th2) => {
  const L = segmentsOf();
  const mat = L.segments.filter((s) => MATERIAL.has(s.form))
    .reduce((a2, s) => a2 + (s.endSec - s.startSec), 0);
  const cov = mat / L.durationSec;
  // 上界防素材蓋滿（V2 為 0.969）；下界防純講話頭（紅隊的 300 秒片子是 0.087）。
  const ok = cov <= (th2.maxCoverage ?? 0.5) && cov >= (th2.minCoverage ?? 0.25);
  return { ok, measured: Number(cov.toFixed(3)) };
});

gate('ledger.greeting-uncovered', ['segmentLedger', 'script', 'charTimes'], () => {
  const L = segmentsOf();
  const window = greetingWindow(load('charTimes'));
  // 用整句比對而不是 indexOf('早安') + 固定 8 字：紅隊在 HOOK 裡塞一個「早安」，
  // 就讓檢查窗口落在錯的位置，真正的問候被滿版圖表整段蓋住而報通過。
  if (!window) throw new Error('講稿裡找不到問候句（早安…投資人）');
  const covering = L.segments.filter((s) =>
    MATERIAL.has(s.form) && s.endSec > window.start + EPS && s.startSec < window.end - EPS);
  return {
    ok: covering.length === 0,
    measured: `問候「${window.text}」${window.start.toFixed(2)}–${window.end.toFixed(2)}s，` +
      (covering.length ? `被 ${covering.map((s) => s.id).join('／')} 蓋住` : '落在 presenter 段內'),
  };
});

gate('plan.matches-ledger', ['segmentPlan', 'segmentLedger'], () => {
  const plan = load('segmentPlan');
  const L = load('segmentLedger');
  const bad = [];
  if (plan.length !== L.segments.length) bad.push(`格數 plan ${plan.length} vs ledger ${L.segments.length}`);
  const n = Math.min(plan.length, L.segments.length);
  for (let i = 0; i < n; i++) {
    const a2 = plan[i]; const b2 = L.segments[i];
    if (a2.id !== b2.id) bad.push(`第 ${i + 1} 格 id ${a2.id}≠${b2.id}`);
    else if (a2.form !== b2.form) bad.push(`格 ${a2.id} form ${a2.form}≠${b2.form}`);
    else if (a2.anchor !== b2.anchor) bad.push(`格 ${a2.id} anchor 不同`);
  }
  return { ok: !bad.length, measured: bad.length ? bad.slice(0, 3).join('；') : `${n}/${n} 逐格相同` };
});

gate('plan.covers-script', ['segmentPlan', 'script'], () => {
  const plan = load('segmentPlan');
  const T = cleanOfScript();
  const clean = T.map((c) => c.char).join('');
  let cursor = 0;
  const empty = plan.filter((s) => !s.anchor || !s.anchor.length);
  // 空 anchor 讓 indexOf('') 永遠回 cursor，於是「接續」與「切在分句邊界」都成立。
  if (empty.length) {
    return { ok: false, measured: `${empty.length} 格的 anchor 是空的（${empty.map((s) => s.id).join('、')}）` };
  }
  for (const s of plan) {
    const at = clean.indexOf(s.anchor, cursor);
    if (at < 0) throw new Error(`格 ${s.id} 的 anchor 在講稿裡找不到`);
    if (at !== cursor) throw new Error(`格 ${s.id} 的 anchor 不接續：期望字元 ${cursor}，實得 ${at}`);
    cursor = at + s.anchor.length;
  }
  return { ok: cursor === clean.length, measured: `${cursor}/${clean.length}` };
});

gate('plan.cuts-on-clause-boundary', ['segmentPlan', 'script'], () => {
  const plan = load('segmentPlan');
  const T = cleanOfScript();
  const clean = T.map((c) => c.char).join('');
  const boundary = new Set(T.map((c, i) => (c.breakAfter || i === T.length - 1 ? i : -1)).filter((i) => i >= 0));
  let cursor = 0; const bad = [];
  for (const s of plan) {
    const at = clean.indexOf(s.anchor, cursor);
    const end = at + s.anchor.length - 1;
    if (!boundary.has(end)) bad.push(s.id);
    cursor = end + 1;
  }
  return { ok: !bad.length, measured: `${plan.length - bad.length}/${plan.length}`,
    note: bad.length ? `格 ${bad.join('、')} 的邊界不在分句邊界` : undefined };
});

gate('plan.material-floor', ['segmentPlan', 'script'], (th2) => {
  const plan = load('segmentPlan');
  const T = cleanOfScript();
  const mg = plan.filter((s) => MATERIAL.has(s.form));
  const chars = mg.reduce((a2, s) => a2 + s.anchor.length, 0);
  const cov = T.length ? chars / T.length : 0;
  const ok = mg.length >= (th2.minMaterialSlots ?? 3) && mg.length <= (th2.maxMaterialSlots ?? 6)
    && cov >= (th2.minCoverage ?? 0.25) && cov <= (th2.maxCoverage ?? 0.5);
  return { ok, measured: `${mg.length} 格／${(cov * 100).toFixed(1)}%（以字數計）` };
});

gate('plan.material-slot-length', ['segmentPlan'], (th2) => {
  const plan = load('segmentPlan');
  const mg = plan.filter((s) => MATERIAL.has(s.form));
  if (!mg.length) return { ok: false, measured: '0 個素材格', note: '見 plan.material-floor' };
  const maxSec = Number(th2.maxSec);
  const rateFloor = Number(acceptance.calibration?.rateBand?.[0]);
  if (!Number.isFinite(maxSec) || !Number.isFinite(rateFloor) || rateFloor <= 0) {
    throw new Error('acceptance.json 缺有效的 maxSec 或 calibration.rateBand 下緣');
  }
  const measured = mg.map((s) => {
    // 不信任 plan 自己宣告的 estSec：用 anchor 與同一份契約的語速下緣重算上緣。
    // 這也讓早於 derivation 欄位的黃金樣本 V4c 可驗，不必為新 gate 修改 fixture。
    const upper = Number((String(s.anchor ?? '').length / rateFloor).toFixed(2));
    return { id: s.id, upper };
  });
  const longest = measured.reduce((a2, s) => (s.upper > a2.upper ? s : a2));
  return { ok: longest.upper <= maxSec,
    measured: `最長 ${longest.upper.toFixed(1)}s／上限 ${maxSec}s（格 ${longest.id}）` };
});

gate('plan.responsibility-present', ['segmentPlan'], () => {
  const plan = load('segmentPlan');
  const mg = plan.filter((s) => MATERIAL.has(s.form));
  // 0 個素材格不能算通過。與 ledger.min-presenter 的 Math.min([]) 同一類問題。
  if (!mg.length) return { ok: false, measured: '0 個素材格', note: '見 plan.material-floor' };
  const missing = mg.filter((s) => !s.responsibility);
  return { ok: !missing.length, measured: `${mg.length - missing.length}/${mg.length}`,
    note: missing.length ? `格 ${missing.map((s) => s.id).join('、')} 還沒填` : undefined };
});

// ── caption ledger 層 ──────────────────────────────────────────────────────
const capChars = (text) => cleanBodyWithIndex(String(text ?? '')).length;

gate('caption.no-trailing-punct', ['captionLedger'], (th2) => {
  const caps = load('captionLedger');
  // 先 trim。紅隊實測：句號後加一個半形空格就放過，10 個變體 9 個放過。
  // 收尾引號、半形句點逗點、刪節號也要算。
  const TRAIL = /[。，、；：.,;:…]["」』）\]]?\s*$/u;
  const bad = caps.filter((c) => TRAIL.test(String(c.text ?? '').trim()));
  return { ok: bad.length <= (th2.maxTrailingPunct ?? 0),
    measured: bad.length ? bad.map((c) => `${c.id}「${String(c.text).trim().slice(-6)}」`).join('，') : 0 };
});

gate('caption.char-coverage', ['captionLedger', 'script'], () => {
  const caps = load('captionLedger');
  // 從 text 內容量，不讀 cleanCharCount 欄位。紅隊把 text 寫成空字串、
  // 欄位湊到 236，原本的實作回報「236/236 通過」。
  const counted = caps.reduce((a2, c) => a2 + capChars(c.text), 0);
  const declared = caps.reduce((a2, c) => a2 + (c.cleanCharCount ?? 0), 0);
  const scriptChars = cleanOfScript().length;
  const mismatch = caps.filter((c) => (c.cleanCharCount ?? -1) !== capChars(c.text));
  const ok = counted === scriptChars && !mismatch.length;
  return { ok, measured: `量測 ${counted}／宣告 ${declared}／講稿 ${scriptChars}`
    + (mismatch.length ? `；${mismatch.length} 張的宣告值與內容不符（${mismatch.slice(0, 3).map((c) => c.id).join('、')}）` : '') };
});

gate('caption.duration-sane', ['captionLedger'], (th2) => {
  const caps = load('captionLedger');
  if (!caps.length) return { ok: false, measured: '0 張字幕' };
  const bad = [];
  for (const c of caps) {
    const d = c.end - c.start;
    if (d < (th2.minSec ?? 0.9) || d > (th2.maxSec ?? 8)) bad.push(`${c.id} ${d.toFixed(1)}s`);
    else if (capChars(c.text) > (th2.maxChars ?? 26)) bad.push(`${c.id} ${capChars(c.text)} 字`);
  }
  return { ok: !bad.length,
    measured: bad.length ? `${bad.length} 張越界：${bad.slice(0, 4).join('、')}` : `${caps.length} 張全部在範圍內` };
});

gate('caption.snap-to-cuts', ['captionLedger', 'segmentLedger'], (th2) => {
  const caps = load('captionLedger');
  const S = load('segmentLedger').segments;
  const cuts = S.slice(1).map((s) => s.startSec);
  // 沒有切點不能算滿分。單段 ledger 原本會拿到 0/0 = 1.000。
  if (cuts.length < (th2.minCuts ?? 1)) return { ok: false, measured: `${cuts.length} 個切點` };
  const bounds = new Set(caps.map((c) => c.start).concat(caps.map((c) => c.end)));
  const matched = cuts.filter((c) => [...bounds].some((b) => Math.abs(b - c) < EPS));
  const ratio = matched.length / cuts.length;
  return { ok: ratio >= (th2.minSnapRatio ?? 0.9),
    measured: `${matched.length}/${cuts.length} = ${ratio.toFixed(3)}`,
    note: '量測方向：內部 B-roll 切點是否都有字幕邊界重合' };
});

// ── 影片層 ─────────────────────────────────────────────────────────────────
const ffprobe = (file, field) => execFileSync('ffprobe',
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', `stream=${field}`,
    '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }).trim();

const vdur = (key) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=nw=1:nk=1', P.path(key)], { encoding: 'utf8' }).trim());

gate('video.fps-no-drop', ['avatarRaw', 'avatarSpeeded'], () => {
  const parse = (s) => { const [x, y] = s.split('/').map(Number); return y ? x / y : x; };
  const inFps = parse(ffprobe(P.path('avatarRaw'), 'r_frame_rate'));
  const outFps = parse(ffprobe(P.path('avatarSpeeded'), 'r_frame_rate'));
  const speed = vdur('avatarRaw') / vdur('avatarSpeeded');
  return { ok: outFps >= inFps * speed - 1e-6,
    measured: `${outFps} >= ${inFps} x ${speed.toFixed(3)} = ${(inFps * speed).toFixed(2)}` };
});

gate('video.speed-factor', ['avatarRaw', 'avatarSpeeded'], (th2) => {
  // 光看 fps 不夠：speed 是從時長反推的，逐位元複製（speed=1）與放慢一半
  // （speed=0.5）都會讓 fps 門檻退化甚至更鬆。語速校準是對「加速後」講的，
  // 所以倍率本身必須等於該路線的設定值。
  const speed = vdur('avatarRaw') / vdur('avatarSpeeded');
  const audioRoute = has('voiceTrack');
  const expectedField = audioRoute ? 'audioRouteExpected' : 'expected';
  const exp = Number(th2[expectedField]);
  const tol = Number(th2.tolerance ?? 0.03);
  if (!Number.isFinite(exp)) throw new Error(`video.speed-factor.${expectedField} 不是有效數字`);
  const route = audioRoute ? '音檔路線' : '文字路線';
  return {
    ok: Math.abs(speed - exp) <= tol,
    measured: `${route}：${speed.toFixed(3)}（設定 ${exp} ±${tol}）`,
  };
});

// ── B-roll provenance ─────────────────────────────────────────────────────
gate('mg.prompt-provenance', ['brollProvenance'], () => {
  const prov = load('brollProvenance');
  const slots = prov.slots ?? prov.entries ?? [];
  if (!slots.length) throw new Error('provenance 裡沒有 slots');
  const bad = [];
  const seen = new Map();
  for (const s of slots) {
    const out = s.outputPath && path.join(P.root, s.outputPath);
    if (!out || !fs.existsSync(out)) { bad.push(`${s.id}（output 不存在）`); continue; }
    // outputSha256 必填。原本是「欄位在才比對」，於是不寫就跳過整個比對，
    // 四格指向同一張 1x1 黑 PNG 也會報「全部配對」。
    if (!s.outputSha256) { bad.push(`${s.id}（缺 outputSha256）`); continue; }
    const h = sha256File(out);
    if (h !== s.outputSha256) { bad.push(`${s.id}（hash 不符）`); continue; }
    if (seen.has(h)) bad.push(`${s.id} 與 ${seen.get(h)} 的 output 完全相同`);
    else seen.set(h, s.id);
    if (!s.promptPath || !fs.existsSync(path.join(P.root, s.promptPath))) {
      bad.push(`${s.id}（prompt 檔不存在）`);
    }
  }
  return { ok: !bad.length, measured: bad.length ? bad.join('、') : `${slots.length} 格全部配對且互不相同` };
});

// ── 截圖層：2026-08-27 會議裁定素材格改實機截圖（docs/reference-reels.md）────────
gate('shot.focus-present', ['segmentPlan', 'shotPlan'], () => {
  const plan = load('segmentPlan');
  const slots = load('shotPlan').slots ?? {};
  const mg = plan.filter((s) => MATERIAL.has(s.form));
  if (!mg.length) return { ok: false, measured: '0 個素材格', note: '見 plan.material-floor' };
  const bad = [];
  for (const s of mg) {
    const e = slots[s.id];
    if (!e) { bad.push(`${s.id}（shot-plan 沒有這格）`); continue; }
    const abs = e.image ? path.join(P.root, e.image) : null;
    if (!abs || !fs.existsSync(abs)) { bad.push(`${s.id}（截圖檔不存在）`); continue; }
    // 沒有 focus ＝ 這句話沒有可指的數字或列表。對標片 16 個素材格全部有；
    // 沒有可指之物的句子該留在主播臉上，不是放一張無關的截圖。
    if (!e.focus) { bad.push(`${s.id}（沒有 focus）`); continue; }
    const { w, h } = imageSize(abs);
    const f = e.focus;
    const inside = f.w > 0 && f.h > 0 && f.x >= 0 && f.y >= 0 && f.x + f.w <= w && f.y + f.h <= h;
    if (!inside) bad.push(`${s.id}（focus 超出圖外 ${w}×${h}）`);
  }
  return { ok: !bad.length, measured: bad.length ? bad.join('、') : `${mg.length}/${mg.length} 格都有截圖與 focus` };
});

// 視覺窗口只量 shot 圖層，不改 ledger coverage／alternation 的句子語意。
// 一旦任一 shot 有窗口，就要求所有 shot 都有；否則舊的整句蓋屏會從缺欄位處漏回來。
{
  const id = 'shot.visual-window';
  const spec = acceptance.gates.find((g) => g.id === id);
  if (!has('mg-plan.json')) {
    record(id, 'skipped', null, { rule: spec?.rule, note: '缺 mg-plan.json' });
  } else if (!has('segmentLedger')) {
    record(id, 'skipped', null, { rule: spec?.rule, note: '缺 segment-ledger.json' });
  } else {
    try {
      const rawPlan = load('mg-plan.json');
      const slots = Array.isArray(rawPlan) ? rawPlan : (rawPlan.slots ?? []);
      const shotSlots = slots.filter((slot) => slot.template === 'shot');
      const withWindow = shotSlots.filter((slot) => slot.visualWindow);
      if (!withWindow.length) {
        record(id, 'skipped', null, { rule: spec?.rule, note: 'mg-plan.json 的 shot 格尚無 visualWindow（舊計畫或尚無 ASR）' });
      } else {
        const threshold = spec?.threshold ?? {};
        const minSec = Number(threshold.minSec);
        const maxSec = Number(threshold.maxSec);
        const fadeSec = Number(threshold.fadeSec);
        const minBeatGapSec = Number(threshold.minBeatGapSec);
        const leadSec = Number(threshold.leadSec);
        const dwellMinSec = Number(threshold.dwellMinSec);
        if (!(Number.isFinite(minSec) && Number.isFinite(maxSec) && minSec > 0 && maxSec >= minSec
          && Number.isFinite(fadeSec) && fadeSec > 0
          && Number.isFinite(minBeatGapSec) && minBeatGapSec >= 0
          && Number.isFinite(leadSec) && leadSec >= 0
          && Number.isFinite(dwellMinSec) && dwellMinSec >= 0)) {
          throw new Error('acceptance.json 的 shot.visual-window minSec／maxSec／fadeSec／minBeatGapSec／leadSec／dwellMinSec 不合法');
        }
        const segments = new Map(load('segmentLedger').segments
          .map((segment) => [String(segment.id), segment]));
        const bad = [];
        const measured = [];
        const overMax = [];
        for (const slot of shotSlots) {
          const window = slot.visualWindow;
          const segment = segments.get(String(slot.id));
          if (!window) { bad.push(`${slot.id} 缺 visualWindow`); continue; }
          if (!segment) { bad.push(`${slot.id} 在 ledger 找不到段界`); continue; }
          const enter = Number(window.enterSec);
          const exit = Number(window.exitSec);
          const duration = exit - enter;
          if (!(Number.isFinite(enter) && Number.isFinite(exit) && exit > enter)) {
            bad.push(`${slot.id} 窗口時間不合法`); continue;
          }
          if (enter < segment.startSec - EPS || exit > segment.endSec + EPS) {
            bad.push(`${slot.id} ${enter.toFixed(2)}–${exit.toFixed(2)}s 超出段界 ${segment.startSec.toFixed(2)}–${segment.endSec.toFixed(2)}s`);
          }
          if (!Number.isFinite(Number(window.durationSec))
            || Math.abs(Number(window.durationSec) - duration) > EPS) {
            bad.push(`${slot.id} durationSec 與 exit−enter 不符`);
          }
          if (duration < minSec - EPS) bad.push(`${slot.id} 窗口 ${duration.toFixed(2)}s 小於 ${minSec}s`);
          if (!Number.isFinite(Number(window.fadeSec)) || Math.abs(Number(window.fadeSec) - fadeSec) > EPS) {
            bad.push(`${slot.id} fadeSec ${JSON.stringify(window.fadeSec)} ≠ ${fadeSec}s`);
          }
          const beats = Array.isArray(slot.beats) ? slot.beats : [];
          let lastReadableDwell = null;
          if (!beats.length) {
            bad.push(`${slot.id} 0 個拍點`);
          } else {
            let previousAt = -Infinity;
            let previousArrival = null;
            const transitions = [];
            const arrivals = [];
            for (const [index, beat] of beats.entries()) {
              const at = Number(beat.atSec);
              const end = Number(beat.endSec);
              if (!(Number.isFinite(at) && Number.isFinite(end) && end >= at)) {
                bad.push(`${slot.id} 拍點「${beat.anchor ?? '?'}」時間不合法`); continue;
              }
              if (at < previousAt - EPS) bad.push(`${slot.id} 拍點順序反了`);
              if (Number.isFinite(previousAt) && at - previousAt < minBeatGapSec - EPS) {
                bad.push(`${slot.id} 相鄰拍點只隔 ${(at - previousAt).toFixed(2)}s，小於 ${minBeatGapSec}s`);
              }
              previousAt = at;
              if (at < enter - EPS || end > exit + EPS) {
                bad.push(`${slot.id} 拍點「${beat.anchor ?? '?'}」${at.toFixed(2)}–${end.toFixed(2)}s 不在窗口內`);
              }

              let expectedTween;
              try {
                expectedTween = shotBeatTweenSec(beat.kind, {
                  secondFocus2: beat.kind === 'second' && Boolean(slot.data?.second?.focus2),
                });
              } catch (error) {
                bad.push(`${slot.id} 拍點「${beat.anchor ?? '?'}」${error.message}`);
                continue;
              }
              const tween = Number(beat.tweenSec);
              const transition = Number(beat.transitionStartSec);
              const arrival = Number(beat.arrivalSec);
              if (!(Number.isFinite(tween) && Number.isFinite(transition) && Number.isFinite(arrival))) {
                bad.push(`${slot.id} 拍點「${beat.anchor ?? '?'}」缺 tweenSec／transitionStartSec／arrivalSec`);
                continue;
              }
              if (Math.abs(tween - expectedTween) > EPS) {
                bad.push(`${slot.id} 拍點「${beat.anchor ?? '?'}」tweenSec ${tween.toFixed(2)} ≠ 實際版型 ${expectedTween.toFixed(2)}s`);
              }
              if (Math.abs(arrival - (transition + tween)) > EPS) {
                bad.push(`${slot.id} 拍點「${beat.anchor ?? '?'}」arrivalSec 不等於 transitionStartSec＋tweenSec`);
              }
              const expectedTransition = Math.max(
                enter,
                at - leadSec,
                previousArrival === null ? -Infinity : previousArrival + dwellMinSec,
              );
              if (Math.abs(transition - expectedTransition) > EPS) {
                bad.push(`${slot.id} 拍點「${beat.anchor ?? '?'}」切換起點 ${transition.toFixed(2)}s，應為 ${expectedTransition.toFixed(2)}s（anchor 前導 ${leadSec}s，且不得擠壓前拍 ${dwellMinSec}s 停留）`);
              }
              if (transition < enter - EPS || arrival > exit + EPS) {
                bad.push(`${slot.id} 拍點「${beat.anchor ?? '?'}」切換 ${transition.toFixed(2)}–${arrival.toFixed(2)}s 不在窗口內`);
              }
              if (previousArrival !== null && transition - previousArrival < dwellMinSec - EPS) {
                bad.push(`${slot.id} 拍點 ${index} 到位後只停留 ${(transition - previousArrival).toFixed(2)}s 就切下一拍，小於 ${dwellMinSec}s`);
              }
              transitions.push(transition);
              arrivals.push(arrival);
              previousArrival = arrival;
            }

            if (arrivals.length === beats.length) {
              const fadeStart = exit - fadeSec;
              lastReadableDwell = fadeStart - arrivals.at(-1);
              if (lastReadableDwell < dwellMinSec - EPS) {
                bad.push(`${slot.id} 末拍到位後只停留 ${lastReadableDwell.toFixed(2)}s 就開始淡出，小於 ${dwellMinSec}s`);
              }
              if (duration > maxSec + EPS) {
                const requiredStart = Math.min(...transitions);
                const requiredEnd = Math.max(
                  ...beats.map((beat) => Number(beat.endSec)),
                  arrivals.at(-1) + dwellMinSec + fadeSec,
                );
                const requiredSpan = requiredEnd - requiredStart;
                if (!(requiredSpan > maxSec + EPS)) {
                  bad.push(`${slot.id} 窗口 ${duration.toFixed(2)}s 超過 ${maxSec}s，但拍點切換＋可讀停留只需 ${requiredSpan.toFixed(2)}s`);
                } else if (typeof window.overMaxReason !== 'string' || !window.overMaxReason.trim()) {
                  bad.push(`${slot.id} 超過 ${maxSec}s 卻沒有 overMaxReason`);
                } else {
                  overMax.push(`${slot.id}：${window.overMaxReason}`);
                }
              }
            }
          }
          measured.push(`${slot.id} ${duration.toFixed(2)}s/${beats.length}拍${lastReadableDwell === null ? '' : `／末拍停留 ${lastReadableDwell.toFixed(2)}s`}`);
        }
        record(id, bad.length ? 'failed' : 'passed',
          bad.length ? bad.slice(0, 5).join('；') : measured.join('、'),
          { rule: spec?.rule, ...((bad.length > 5 || overMax.length) ? {
            note: [...(bad.length > 5 ? [`另有 ${bad.length - 5} 項`] : []), ...overMax].join('；'),
          } : {}) });
      }
    } catch (error) {
      record(id, 'error', null, { rule: spec?.rule, note: error.message });
    }
  }
}

// 歷史模式：逐格 dataAsOf 必須等於頂層 asOf；日K格還要由 AX 日期與四個 OHLC 原文作證。
// revenue 是月資料，沒有單日查價線；它仍逐格記 dataAsOf／captureTime，但 axDate／axOhlc 必須是 null，
// 不能捏造不存在的 AX 證據。
{
  const id = 'shot.data-as-of';
  const spec = acceptance.gates.find((g) => g.id === id);
  if (!has('shotPlan')) {
    record(id, 'skipped', null, { rule: spec?.rule, note: '缺 shot-plan.json' });
  } else {
    try {
      const sp = load('shotPlan');
      if (!Object.hasOwn(sp, 'asOf')) {
        record(id, 'skipped', null, { rule: spec?.rule, note: 'shot-plan.json 沒有 asOf（非歷史模式）' });
      } else {
        const bad = [];
        const topAsOf = normalizeIsoDate(sp.asOf);
        if (!topAsOf || topAsOf !== sp.asOf) bad.push(`頂層 asOf 不是 canonical YYYY-MM-DD：${JSON.stringify(sp.asOf)}`);
        const entries = Object.entries(sp.slots ?? {});
        if (!entries.length) bad.push('slots 是空的');
        let kline = 0;
        let revenue = 0;
        for (const [slotId, entry] of entries) {
          if (entry.dataAsOf !== sp.asOf) bad.push(`${slotId} dataAsOf ${JSON.stringify(entry.dataAsOf)} ≠ 頂層 ${JSON.stringify(sp.asOf)}`);
          const capture = entry.captureTime ? new Date(entry.captureTime) : null;
          if (!capture || Number.isNaN(capture.getTime())) bad.push(`${slotId} 缺有效 captureTime`);
          if (String(entry.page ?? '').endsWith('/kLine')) {
            kline += 1;
            if (!axDateMatchesDataAsOf(entry.axDate, entry.dataAsOf)) {
              bad.push(`${slotId} axDate ${JSON.stringify(entry.axDate)} ≠ dataAsOf ${JSON.stringify(entry.dataAsOf)}`);
            }
            const keys = ['開', '高', '低', '收'];
            const missing = keys.filter((key) => typeof entry.axOhlc?.[key] !== 'string'
              || !/^[\d.,]+$/u.test(entry.axOhlc[key]));
            if (missing.length) bad.push(`${slotId} axOhlc 缺 ${missing.join('／')}`);
          } else if (String(entry.page ?? '').endsWith('/revenue')) {
            revenue += 1;
            if (entry.axDate !== null || entry.axOhlc !== null) bad.push(`${slotId} revenue 不得捏造日K AX 證據`);
          } else {
            bad.push(`${slotId} 是 ${entry.page ?? '未知頁'}；歷史模式只接受 kLine／revenue`);
          }
        }
        if (!kline) bad.push('0 格日K，沒有任何 AX 日期／OHLC 可驗證 asOf');
        record(id, bad.length ? 'failed' : 'passed',
          bad.length ? bad.slice(0, 5).join('；') : `${kline} 格日K AX 日期＋OHLC吻合；${revenue} 格 revenue 的 dataAsOf 吻合`,
          { rule: spec?.rule, ...(bad.length > 5 ? { note: `另有 ${bad.length - 5} 項` } : {}) });
      }
    } catch (error) {
      record(id, 'error', null, { rule: spec?.rule, note: error.message });
    }
  }
}

// 一般測試模式：拿過去的講稿測試產線時，截圖日期與講稿刻意不對齊（App 頁首永遠是今天）。
// 歷史模式優先，由 shot.data-as-of 驗證，不再拿「拍攝日」判前一日窗口。
{
  const spec = acceptance.gates.find((g) => g.id === 'shot.captured-same-day');
  let shotMeta = null;
  try { shotMeta = has('shotPlan') ? JSON.parse(fs.readFileSync(P.path('shotPlan'), 'utf8')) : null; } catch { /* 讀不到就照常驗 */ }
  const historicalMode = shotMeta && Object.hasOwn(shotMeta, 'asOf');
  const testMode = shotMeta?.mode === 'test';
  // 測試模式不能只靠 shot-plan 自報（reviewer 2026-08-29）：專案目錄名必須以 -test 結尾，
  // 這樣每一條路徑都寫著「測試」，不會有人把它當正式片發出去。
  const isTestDir = /-test$/u.test(path.basename(P.root));
  if (historicalMode) {
    record('shot.captured-same-day', 'skipped', null,
      { rule: spec?.rule, note: '歷史模式，由 shot.data-as-of 驗證。' });
  } else if (testMode && !isTestDir) {
    record('shot.captured-same-day', 'failed', null,
      { rule: spec?.rule, note: `shot-plan.json 宣告 mode=test，但專案目錄「${path.basename(P.root)}」不是以 -test 結尾。測試專案的目錄名必須以 -test 結尾（例：20260826-yadian-test）；正式專案不得帶 --test-mode。` });
  } else if (testMode && !shotMeta?.capturedAt) {
    record('shot.captured-same-day', 'failed', null,
      { rule: spec?.rule, note: '測試模式也必須有 capturedAt（capture-shots.mjs 會寫）；手放的 shot-plan 沒有時間戳，不能靠 mode=test 混過。' });
  } else if (testMode) {
    record('shot.captured-same-day', 'skipped', null,
      { rule: spec?.rule, note: '測試模式（shot-plan.json mode=test，目錄名 -test）：截圖日期與講稿刻意不對齊，頁首數字會對不上旁白。正式出片不得帶 --test-mode。' });
  } else {
  gate('shot.captured-same-day', ['script', 'shotPlan'], () => {
    const sp = load('shotPlan');
    const m = fs.readFileSync(P.path('script'), 'utf8').match(/^(\d{2})\/(\d{2})\s*台股晨報/m);
    if (!m) return { ok: false, measured: '講稿標題解析不出 MM/DD' };
    const cap = sp.capturedAt ? new Date(sp.capturedAt) : null;
    if (!cap || Number.isNaN(cap.getTime())) return { ok: false, measured: 'shot-plan.json 缺 capturedAt（capture-shots.mjs 會寫；手放的截圖沒有）' };
    // 晨報 D 講的是 D-1 的收盤。App 頁首永遠是「現在」，所以截圖只能在 D-1 13:30 ～ D 09:00（台北）之間拍，
    // 否則頁首數字與講稿對不上。年份取 capturedAt 的年，講稿標題不帶年。
    const tpe = new Date(cap.getTime() + 8 * 3600e3);
    const D = Date.UTC(tpe.getUTCFullYear(), Number(m[1]) - 1, Number(m[2]));
    const start = new Date(D - 24 * 3600e3 + (13 * 60 + 30) * 60e3);
    const end = new Date(D + 9 * 3600e3);
    const fmt = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
    return { ok: tpe >= start && tpe <= end,
      measured: `截於 ${fmt(tpe)} 台北；窗口 ${fmt(start)} ～ ${fmt(end)}` };
  });
  }
}

// ── artifact 的 provenance 必須齊全 ────────────────────────────────────────
{
  const spec = acceptance.gates.find((g) => g.id === 'artifact.provenance-complete');
  const derived = ['charTimes', 'segmentLedger', 'captionLedger', 'segmentPlan'].filter(has);
  if (!derived.length) {
    record('artifact.provenance-complete', 'skipped', null, { rule: spec?.rule, note: '尚無任何衍生 artifact' });
  } else {
    const bad = [];
    for (const key of derived) {
      const side = P.sidecar(key);
      // sidecar 原本是可選的，於是刪掉它或把 inputs 寫成 [] 就繞過 requireFresh。
      // 手寫 artifact 天生沒有 sidecar——那正是最可疑的一類輸入。
      if (!fs.existsSync(side)) { bad.push(`${P.rel(key)} 缺 sidecar`); continue; }
      const prov = JSON.parse(fs.readFileSync(side, 'utf8'));
      const inputs = (prov.inputs ?? []).map((i) => i.path);
      if (!inputs.length) bad.push(`${P.rel(key)} 的 inputs 是空的`);
      else if (!inputs.includes('script.txt')) bad.push(`${P.rel(key)} 的 inputs 沒有宣告 script.txt`);
    }
    record('artifact.provenance-complete', bad.length ? 'failed' : 'passed',
      bad.length ? bad.join('；') : `${derived.length} 個 artifact 的 sidecar 齊全`, { rule: spec?.rule });
  }
}

// ── hyperframes check：跑得動就跑，跑不動明說缺什麼 ─────────────────────────
{
  const spec = acceptance.gates.find((g) => g.id === 'mg.hyperframes-clean');
  const compDir = path.join(P.root, 'compositions');
  const needs = [
    [compDir, 'compositions/'],
    [path.join(P.root, 'hyperframes.json'), 'hyperframes.json'],
    [path.join(P.root, 'assets', 'gsap.min.js'), 'assets/gsap.min.js'],
  ].filter(([f]) => !fs.existsSync(f)).map(([, label]) => label);
  const htmls = fs.existsSync(compDir)
    ? fs.readdirSync(compDir).filter((f) => f.endsWith('.html')) : [];
  if (needs.length || !htmls.length) {
    record('mg.hyperframes-clean', 'skipped', null,
      { rule: spec?.rule, note: needs.length ? `缺 ${needs.join('、')}` : 'compositions/ 裡沒有 html' });
  } else {
    const results = [];
    for (const file of htmls) {
      const qa = path.join(P.root, 'qa', path.basename(file, '.html'));
      fs.mkdirSync(qa, { recursive: true });
      fs.copyFileSync(path.join(compDir, file), path.join(qa, 'index.html'));
      fs.copyFileSync(path.join(P.root, 'hyperframes.json'), path.join(qa, 'hyperframes.json'));
      const link = path.join(qa, 'assets');
      try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* ignore */ }
      fs.symlinkSync(path.join(P.root, 'assets'), link);
      let errs = -1;
      try {
        const out = execFileSync('npx', ['--yes', 'hyperframes@0.8.3', 'check', qa, '--json'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const j = JSON.parse(out.slice(out.indexOf('{')));
        errs = ['lint', 'runtime', 'layout', 'motion', 'contrast']
          .reduce((a2, k) => a2 + ((j[k] || {}).errorCount || 0), 0);
      } catch (e) { errs = -1; }
      results.push({ file, errs });
    }
    const bad = results.filter((r) => r.errs !== 0);
    record('mg.hyperframes-clean', bad.length ? 'failed' : 'passed',
      bad.length ? bad.map((r) => `${r.file}:${r.errs < 0 ? 'check 失敗' : `${r.errs} error`}`).join('、')
        : `${results.length} 格全部 0 error`,
      { rule: spec?.rule });
  }
}

// ── 仍然需要人工的 gate：明確標成 manual，不假裝通過 ───────────────────────
for (const id of ['frame.qa-text-match']) {
  const spec = acceptance.gates.find((g) => g.id === id);
  record(id, 'manual', null,
    { rule: spec?.rule, note: '定格畫面與 prompt 的文字比對需要人看，由 qa-frames.sh 產生素材' });
}

// ── 主播 payload:逐欄比對整份 payload,並驗稿子對得上 ──────────────────────
{
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/avatar-generation.json'), 'utf8'));
  const payloadFile = path.join(P.root, 'heygen-request.json');
  if (!fs.existsSync(payloadFile)) {
    const req = REQUIRED.has('heygen-request.json');
    record('avatar.payload-locked', req ? 'failed' : 'skipped', null,
      { rule: lock.gate.rule, note: '缺 heygen-request.json' + (req ? '（已付費生成過，這是必要 artifact）' : '（還沒生成）') });
  } else {
    const sent = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    const isAudioRoute = Object.hasOwn(sent, 'audioTrack') || Object.hasOwn(sent, 'audio_asset_id');
    if (isAudioRoute) {
      const { audioTrack: _audioTrack, ...payload } = sent;
      const diff = payloadContractDifferences(payload, lock, {
        audioRoute: true,
        allowPendingAsset: true,
      });
      try {
        const trackMeta = readJson(P, 'voiceTrackMeta');
        const cleanCheck = checkAudioCleanMatchesScript(
          fs.readFileSync(P.path('script'), 'utf8'), trackMeta);
        if (!cleanCheck.ok) {
          diff.push(
            `voice/track.json 的 clean 原文與 script.txt 正文不符（合成 ${cleanCheck.actualLength} 字、講稿 ${cleanCheck.expectedLength} 字）`);
        }
        const shaCheck = checkAudioShaMatchesTrack(P.path('voiceTrack'), trackMeta);
        if (!shaCheck.ok) diff.push('track.mp3 sha256 與 voice/track.json 不符');
        if (sent.audioTrack?.path !== P.rel('voiceTrack')) {
          diff.push(`audioTrack.path 必須是 ${P.rel('voiceTrack')}`);
        }
        if (sent.audioTrack?.sha256 !== shaCheck.actual) {
          diff.push('heygen-request.json 的 audioTrack.sha256 與待上傳音檔不符');
        }
      } catch (error) {
        diff.push(error.message);
      }
      record('avatar.payload-locked', diff.length ? 'failed' : 'passed',
        diff.length ? diff.slice(0, 4).join('；') : '音檔 payload 逐欄相符，合成原文與音檔 sha256 一致',
        { rule: lock.gate.rule });
    } else {
      const diff = [];
      // 逐欄比對契約 payload 的每一個鍵，不只 locked 陣列那兩欄。
      // 原本只比 2 欄，於是 16:9 480p、engine 是 talking_photo 的 payload 通過了
      // 整條產線唯一的付費前檢查。
      const walk = (want, got, prefix = '') => {
        for (const [k, v] of Object.entries(want)) {
          const g = got?.[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, g, `${prefix}${k}.`); continue; }
          if (JSON.stringify(g) !== JSON.stringify(v)) {
            diff.push(`${prefix}${k}：送 ${JSON.stringify(g)}，契約 ${JSON.stringify(v)}`);
          }
        }
      };
      walk(lock.payload, sent);
      for (const l of lock.locked) {
        const got = l.field.split('.').reduce((o, k) => (o ?? {})[k], sent);
        if (JSON.stringify(got) !== JSON.stringify(l.value)) {
          diff.push(`${l.field}：送 ${JSON.stringify(got)}，鎖定值 ${JSON.stringify(l.value)}`);
        }
      }
      // 送出去生成的稿子必須就是 script.txt 的正文。否則主播講的是別支影片。
      if (has('script')) {
        const want = cleanOfScript().map((c) => c.char).join('');
        const sentText = sent.script ?? sent.input_text ?? '';
        const gotClean = cleanBodyWithIndex(String(sentText)).length
          ? cleanBodyWithIndex(String(sentText)).map((c) => c.char).join('') : '';
        if (gotClean !== want) {
          diff.push(`script／input_text 與 script.txt 不符（送出 ${gotClean.length} 字、講稿 ${want.length} 字）`);
        }
      }
      record('avatar.payload-locked', diff.length ? 'failed' : 'passed',
        diff.length ? diff.slice(0, 4).join('；') : `payload 逐欄相符，稿子與 script.txt 一致`,
        { rule: lock.gate.rule });
    }
  }
}

// ── 輸出 ───────────────────────────────────────────────────────────────────
const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
// 產線分兩個階段。付費之前，下游 gate 是「還沒輪到」；付費之後，同樣的 skipped 是缺件。
// 沒有這個區分，「通過 10　略過 18　exit 0」讀起來像成功——那是紅隊第一條的變形。
const phase = paid ? 'post-avatar' : 'pre-avatar';
const applicable = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.error ?? 0);
const report = { project: P.root, phase, generatedFrom: 'contracts/acceptance.json', counts, results };
fs.writeFileSync(P.path('gateReport'), `${JSON.stringify(report, null, 2)}\n`);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const mark = { passed: '通過', failed: '未通過', skipped: '略過', manual: '人工', error: '錯誤' };
  console.log(`${P.root}`);
  const phaseLabel = paid ? '付費後（主播影片已存在）' : '付費前（尚未生成主播影片）';
  console.log(`階段：${phaseLabel}`);
  console.log(`適用 ${applicable} 道　通過 ${counts.passed ?? 0}　未通過 ${(counts.failed ?? 0) + (counts.error ?? 0)}`
    + (counts.skipped ? `　｜　待下一階段 ${counts.skipped} 道` : '')
    + (counts.manual ? `　｜　人工 ${counts.manual} 道` : ''));
  if (!paid && counts.skipped) {
    console.log(`　　那 ${counts.skipped} 道要有主播影片與 ASR 才驗得到。**略過不等於通過。**`);
  }
  console.log('');
  for (const r of results) {
    console.log(`[${mark[r.status]}] ${r.id.padEnd(28)} ${r.measured ?? ''}`);
    if (r.note) console.log(`         ${r.note}`);
  }
}
process.exit(results.some((r) => r.status === 'failed' || r.status === 'error') ? 1 : 0);
