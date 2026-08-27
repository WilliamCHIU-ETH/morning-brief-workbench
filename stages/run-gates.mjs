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
import { resolveProject, sha256File, requireFresh } from './lib/project.mjs';

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
  const T = load('charTimes');
  const clean = T.map((c) => c.ch).join('');
  // 用整句比對而不是 indexOf('早安') + 固定 8 字：紅隊在 HOOK 裡塞一個「早安」，
  // 就讓檢查窗口落在錯的位置，真正的問候被滿版圖表整段蓋住而報通過。
  const FAMILY = /早安[^。？！]{0,6}親愛的投資人|早安[^。？！]{0,4}投資朋友|早安[^。？！]{0,8}投資人/u;
  const m = clean.match(FAMILY);
  if (!m) throw new Error('講稿裡找不到問候句（早安…投資人）');
  const at = m.index; const end = at + m[0].length - 1;
  const t0 = T[at].start; const t1 = T[end].end;
  const covering = L.segments.filter((s) =>
    MATERIAL.has(s.form) && s.endSec > t0 + EPS && s.startSec < t1 - EPS);
  return {
    ok: covering.length === 0,
    measured: `問候「${m[0]}」${t0.toFixed(2)}–${t1.toFixed(2)}s，` +
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
  // 所以倍率本身必須等於設定值。
  const speed = vdur('avatarRaw') / vdur('avatarSpeeded');
  const exp = th2.expected ?? 1.1; const tol = th2.tolerance ?? 0.03;
  return { ok: Math.abs(speed - exp) <= tol, measured: `${speed.toFixed(3)}（設定 ${exp} ±${tol}）` };
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
