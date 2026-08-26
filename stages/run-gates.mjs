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
import { resolveProject, sha256File } from './lib/project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex } = require(path.join(here, 'script-utils.js'));

const acceptance = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/acceptance.json'), 'utf8'));
const P = resolveProject();
const asJson = process.argv.includes('--json');
const EPS = 0.02;

const results = [];
const has = (key) => fs.existsSync(P.path(key));
const load = (key) => JSON.parse(fs.readFileSync(P.path(key), 'utf8'));

function record(id, status, measured, detail = {}) {
  results.push({ id, status, measured, ...detail });
}
/** needs: artifact keys 必須都在，否則 skipped。 */
function gate(id, needs, fn) {
  const spec = acceptance.gates.find((g) => g.id === id);
  if (!spec) return record(id, 'error', null, { note: 'acceptance.json 沒有這道 gate' });
  const missing = needs.filter((k) => !has(k));
  if (missing.length) {
    return record(id, 'skipped', null,
      { note: `缺 ${missing.map((k) => P.rel(k)).join('、')}`, rule: spec.rule });
  }
  try {
    const { ok, measured, note } = fn(spec.threshold ?? {}, spec);
    record(id, ok ? 'passed' : 'failed', measured, { rule: spec.rule, ...(note ? { note } : {}) });
  } catch (e) {
    record(id, 'error', null, { note: e.message, rule: spec.rule });
  }
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
  const bad = L.segments.filter((s) => !FORMS.has(s.form));
  if (bad.length) {
    throw new Error(
      `${bad.length}/${L.segments.length} 格的 form 不合法（只能是 presenter／mg／device）：` +
      `${bad.slice(0, 4).map((s) => `${s.id}=${JSON.stringify(s.form)}`).join('、')}` +
      `${bad.length > 4 ? '…' : ''}。缺 form 就無法判斷哪些格是素材，覆蓋率與交替都量不出來。`);
  }
  return L;
}

gate('ledger.alternation', ['segmentLedger'], (t) => {
  const S = segmentsOf().segments;
  const forms = S.map((s) => s.form);
  let adjacent = 0;
  for (let i = 1; i < forms.length; i++) {
    if (MATERIAL.has(forms[i]) && MATERIAL.has(forms[i - 1])) adjacent++;
  }
  const ok = adjacent <= (t.adjacentMaterialSlots ?? 0)
    && forms[0] === (t.firstForm ?? 'presenter')
    && forms.at(-1) === (t.lastForm ?? 'presenter');
  return { ok, measured: forms.map((f) => (MATERIAL.has(f) ? 'M' : 'P')).join(' ') };
});

gate('ledger.min-presenter', ['segmentLedger'], (t) => {
  const S = segmentsOf().segments.filter((s) => !MATERIAL.has(s.form));
  // 零個主播格必須是 failed。Math.min([]) 會回 Infinity 而「通過」——
  // 那正是 V2 的情形（12 格全 mg），也是最該被擋下來的一支。
  if (!S.length) return { ok: false, measured: '0 格 presenter' };
  const min = Math.min(...S.map((s) => s.endSec - s.startSec));
  return { ok: min >= (t.minPresenterSec ?? 3), measured: Number(min.toFixed(2)) };
});

gate('ledger.max-material-run', ['segmentLedger'], (t) => {
  const S = segmentsOf().segments;
  let run = 0, max = 0;
  for (const s of S) {
    if (MATERIAL.has(s.form)) { run += s.endSec - s.startSec; max = Math.max(max, run); }
    else run = 0;
  }
  return { ok: max <= (t.maxMaterialRunSec ?? 6.5), measured: Number(max.toFixed(2)) };
});

gate('ledger.coverage', ['segmentLedger'], (t) => {
  const L = segmentsOf();
  const mat = L.segments.filter((s) => MATERIAL.has(s.form))
    .reduce((a, s) => a + (s.endSec - s.startSec), 0);
  const cov = mat / L.durationSec;
  return { ok: cov <= (t.maxCoverage ?? 0.5), measured: Number(cov.toFixed(3)) };
});

gate('ledger.greeting-uncovered', ['segmentLedger', 'script', 'charTimes'], () => {
  const L = segmentsOf();
  const T = load('charTimes');
  const clean = T.map((c) => c.ch).join('');
  const at = clean.indexOf('早安');
  if (at < 0) throw new Error('講稿裡找不到問候句');
  const end = at + '早安親愛的投資人'.length - 1;
  const t0 = T[at].start, t1 = T[Math.min(end, T.length - 1)].end;
  const covering = L.segments.filter((s) =>
    MATERIAL.has(s.form) && s.endSec > t0 + EPS && s.startSec < t1 - EPS);
  return {
    ok: covering.length === 0,
    measured: `問候 ${t0.toFixed(2)}–${t1.toFixed(2)}s，` +
      (covering.length ? `被 ${covering.map((s) => s.id).join('／')} 蓋住` : '落在 presenter 段內'),
  };
});

// ── caption ledger 層 ──────────────────────────────────────────────────────
gate('caption.no-trailing-punct', ['captionLedger'], (t) => {
  const caps = load('captionLedger');
  const bad = caps.filter((c) => /[。，、；：]$/u.test(c.text));
  return { ok: bad.length <= (t.maxTrailingPunct ?? 0),
    measured: bad.length ? bad.map((c) => `${c.id}「${c.text.slice(-6)}」`).join('，') : 0 };
});

gate('caption.char-coverage', ['captionLedger', 'script'], () => {
  const caps = load('captionLedger');
  const sum = caps.reduce((a, c) => a + (c.cleanCharCount ?? 0), 0);
  const scriptChars = cleanBodyWithIndex(getBodyAfterVoice(fs.readFileSync(P.path('script'), 'utf8'))).length;
  return { ok: sum === scriptChars, measured: `${sum}/${scriptChars}` };
});

gate('caption.snap-to-cuts', ['captionLedger', 'segmentLedger'], (t) => {
  const caps = load('captionLedger');
  const S = load('segmentLedger').segments; // 只需要切點，不需要 form
  // 量測定義：內部 B-roll 切點（不含 0 與片尾）中，有字幕邊界落在同一時間的比率。
  // 方向刻意是「每一次場景切換都要有字幕跟著換」，不是反過來。
  const cuts = S.slice(1).map((s) => s.startSec);
  const bounds = new Set(caps.map((c) => c.start).concat(caps.map((c) => c.end)));
  const matched = cuts.filter((c) => [...bounds].some((b) => Math.abs(b - c) < EPS));
  const ratio = cuts.length ? matched.length / cuts.length : 1;
  return { ok: ratio >= (t.minSnapRatio ?? 0.9),
    measured: `${matched.length}/${cuts.length} = ${ratio.toFixed(3)}`,
    note: '量測方向：內部 B-roll 切點是否都有字幕邊界重合' };
});

// ── 影片層 ─────────────────────────────────────────────────────────────────
const ffprobe = (file, field) => execFileSync('ffprobe',
  ['-v', 'error', '-select_streams', 'v:0', '-show_entries', `stream=${field}`,
    '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }).trim();

gate('video.fps-no-drop', ['avatarRaw', 'avatarSpeeded'], () => {
  const parse = (s) => { const [a, b] = s.split('/').map(Number); return b ? a / b : a; };
  const inFps = parse(ffprobe(P.path('avatarRaw'), 'r_frame_rate'));
  const outFps = parse(ffprobe(P.path('avatarSpeeded'), 'r_frame_rate'));
  const inDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', P.path('avatarRaw')], { encoding: 'utf8' }).trim());
  const outDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', P.path('avatarSpeeded')], { encoding: 'utf8' }).trim());
  const speed = inDur / outDur;
  return { ok: outFps >= inFps * speed - 1e-6,
    measured: `${outFps} >= ${inFps} x ${speed.toFixed(3)} = ${(inFps * speed).toFixed(2)}` };
});

// ── B-roll provenance ─────────────────────────────────────────────────────
gate('mg.prompt-provenance', ['brollProvenance'], () => {
  const prov = load('brollProvenance');
  const slots = prov.slots ?? prov.entries ?? [];
  if (!slots.length) throw new Error('provenance 裡沒有 slots');
  const bad = [];
  for (const s of slots) {
    const out = s.outputPath && path.join(P.root, s.outputPath);
    if (!out || !fs.existsSync(out)) { bad.push(`${s.id}（output 不存在）`); continue; }
    if (s.outputSha256 && sha256File(out) !== s.outputSha256) bad.push(`${s.id}（hash 不符）`);
  }
  return { ok: !bad.length, measured: bad.length ? bad.join('、') : `${slots.length} 格全部配對` };
});

// ── 需要人工或外部工具的 gate：明確標成 manual，不假裝通過 ─────────────────
for (const id of ['mg.hyperframes-clean', 'frame.qa-text-match']) {
  const spec = acceptance.gates.find((g) => g.id === id);
  record(id, 'manual', null,
    { rule: spec?.rule, note: '需要 hyperframes check／定格比對，由 build-slots.sh 與 qa-frames.sh 產生，尚未接進本 runner' });
}

// ── 主播 payload 鎖定 ──────────────────────────────────────────────────────
{
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/avatar-generation.json'), 'utf8'));
  const payloadFile = path.join(P.root, 'heygen-request.json');
  if (!fs.existsSync(payloadFile)) {
    record('avatar.payload-locked', 'skipped', null,
      { rule: lock.gate.rule, note: '缺 heygen-request.json（還沒生成）' });
  } else {
    const sent = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    const diff = [];
    for (const l of lock.locked) {
      const got = l.field.split('.').reduce((o, k) => (o ?? {})[k], sent);
      if (JSON.stringify(got) !== JSON.stringify(l.value)) {
        diff.push(`${l.field}：送 ${JSON.stringify(got)}，鎖定值 ${JSON.stringify(l.value)}`);
      }
    }
    record('avatar.payload-locked', diff.length ? 'failed' : 'passed',
      diff.length ? diff.join('；') : '三欄與鎖定值相同', { rule: lock.gate.rule });
  }
}

// ── 輸出 ───────────────────────────────────────────────────────────────────
const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
const report = { project: P.root, generatedFrom: 'contracts/acceptance.json', counts, results };
fs.writeFileSync(P.path('gateReport'), `${JSON.stringify(report, null, 2)}\n`);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const mark = { passed: '通過', failed: '未通過', skipped: '略過', manual: '人工', error: '錯誤' };
  console.log(`${P.root}`);
  console.log(Object.entries(counts).map(([k, v]) => `${mark[k]} ${v}`).join('　'));
  console.log('');
  for (const r of results) {
    console.log(`[${mark[r.status]}] ${r.id.padEnd(28)} ${r.measured ?? ''}`);
    if (r.note) console.log(`         ${r.note}`);
  }
}
process.exit(results.some((r) => r.status === 'failed' || r.status === 'error') ? 1 : 0);
