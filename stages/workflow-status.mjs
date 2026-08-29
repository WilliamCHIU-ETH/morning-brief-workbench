#!/usr/bin/env node
/**
 * 晨報產線的機器可讀 handoff。
 *
 *   node stages/workflow-status.mjs --project <dir> [--json]
 *
 * 這支不執行任何階段，也不碰付費 API；它只根據 canonical artifacts 回答：
 * 現在在哪裡、證據是什麼、下一個最小動作，以及是否停在唯一人工關卡。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProject, requireFresh } from './lib/project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
let P;
try { P = resolveProject(); } catch (e) {
  console.error(e.message);
  console.error('用法：node stages/workflow-status.mjs --project <dir> [--json]');
  process.exit(2);
}

const relProject = path.relative(process.cwd(), P.root) || '.';
const node = (file, ...args) => `node stages/${file} --project ${relProject}${args.length ? ` ${args.join(' ')}` : ''}`;
const npm = (script, ...args) => `npm run ${script} -- --project ${relProject}${args.length ? ` ${args.join(' ')}` : ''}`;
const exists = (rel) => fs.existsSync(path.join(P.root, rel));
const mtime = (rel) => exists(rel) ? fs.statSync(path.join(P.root, rel)).mtimeMs : 0;
const evidence = [];
const blockers = [];

function emit(state, owner, action, commands = [], extra = {}) {
  const report = {
    schemaVersion: 1,
    project: P.root,
    state,
    owner,
    action,
    commands,
    humanGate: state === 'awaiting-human-approval'
      ? { required: true, kind: 'paid-avatar-generation', irreversible: true }
      : { required: false },
    evidence,
    blockers,
    ...extra,
  };
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`狀態：${state}`);
    console.log(`負責：${owner}`);
    console.log(`下一步：${action}`);
    if (commands.length) {
      console.log('指令：');
      commands.forEach((cmd) => console.log(`  ${cmd}`));
    }
    if (blockers.length) {
      console.log('阻塞：');
      blockers.forEach((b) => console.log(`  - ${b}`));
    }
  }
  process.exit(0);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(P.root, rel), 'utf8'));
}

function stale(key, command) {
  try {
    const checked = requireFresh(P, key);
    if (checked.checked) evidence.push(`${P.rel(key)} provenance 已驗證（${checked.inputs} 個輸入）`);
    return false;
  } catch (e) {
    blockers.push(e.message);
    emit('stale-artifact', 'agent', `重建 ${P.rel(key)}`, [command]);
  }
}

if (!exists('hyperframes.json') || !exists('assets/gsap.min.js') || !exists('template/layout.json')) {
  const missing = ['hyperframes.json', 'assets/gsap.min.js', 'template/layout.json'].filter((f) => !exists(f));
  blockers.push(`專案骨架不完整：${missing.join('、')}`);
  emit('needs-initialization', 'agent', '初始化專案骨架', [node('init-project.mjs')]);
}
evidence.push('專案骨架完整');

if (!exists('script.txt')) emit('needs-script', 'agent', '從 docx 依 ROLE.md 寫出 script.txt');

let lint;
try {
  const out = execFileSync('node', [path.join(here, 'lint-script.mjs'), path.join(P.root, 'script.txt'), '--json'],
    { encoding: 'utf8' });
  lint = JSON.parse(out);
} catch (e) {
  try { lint = JSON.parse(e.stdout); } catch { lint = null; }
}
const lintErrors = lint?.findings?.filter((f) => f.severity === 'error') ?? [{ message: 'lint 沒有產出可讀報告' }];
if (lintErrors.length) {
  blockers.push(...lintErrors.map((f) => `${f.id ?? 'lint'}：${f.message}`));
  emit('script-needs-revision', 'agent', '修訂講稿直到 lint 0 error',
    [`npm run lint:script ${path.join(relProject, 'script.txt')}`]);
}
evidence.push(`script.txt lint 通過（clean ${lint.cleanChars} 字）`);

if (!exists('segment-plan.json')) {
  emit('needs-segment-plan', 'agent', '從講稿推導切段', [npm('plan', '--write')]);
}
stale('segmentPlan', npm('plan', '--write'));
const segmentPlan = readJson('segment-plan.json');
const missingResponsibility = segmentPlan
  .filter((s) => ['mg', 'device'].includes(s.form) && !String(s.responsibility ?? '').trim())
  .map((s) => s.id);
if (missingResponsibility.length) {
  blockers.push(`素材格 ${missingResponsibility.join('、')} 缺 responsibility`);
  emit('needs-editorial-responsibility', 'agent', '依講稿與 screenshot-standard.md 填入素材格責任');
}
evidence.push(`segment-plan.json ${segmentPlan.length} 格，素材責任齊全`);

if (!exists('shot-plan.json')) {
  emit('needs-device-shots', 'agent', '先驗選頁，再擷取 App 實機畫面',
    [node('capture-shots.mjs', '--dryrun'), node('capture-shots.mjs')]);
}
stale('shotPlan', node('capture-shots.mjs'));
const shotPlan = readJson('shot-plan.json');
const noFocus = Object.entries(shotPlan.slots ?? {}).filter(([, slot]) => !slot.focus).map(([id]) => id);
if (noFocus.length) {
  blockers.push(`shot-plan 素材格 ${noFocus.join('、')} 沒有 focus`);
  emit('shot-plan-needs-revision', 'agent', '把無可指畫面的句子押回主播並重建切段',
    [npm('plan', '--write'), node('capture-shots.mjs', '--dryrun'), node('capture-shots.mjs')]);
}
evidence.push(`shot-plan.json ${Object.keys(shotPlan.slots ?? {}).length} 格皆有 focus`);

if (!exists('mg-plan.json')) {
  emit('needs-material-compositions', 'agent', '依 shot-plan 產出素材格 composition',
    [node('plan-mg.mjs', '--write')]);
}
stale('mg-plan.json', node('plan-mg.mjs', '--write'));
evidence.push('mg-plan.json 已存在');

const upstreamBeforePay = ['script.txt', 'segment-plan.json', 'shot-plan.json', 'mg-plan.json'];
const newestBeforePay = Math.max(...upstreamBeforePay.map(mtime));
let gateReport = exists('gate-report.json') ? readJson('gate-report.json') : null;
if (!gateReport || mtime('gate-report.json') < newestBeforePay) {
  emit('needs-prepay-gates', 'agent', '跑付費前驗收門檻', [npm('gates')]);
}
const badGates = (gateReport.results ?? []).filter((g) => ['failed', 'error'].includes(g.status));
if (badGates.length) {
  blockers.push(...badGates.map((g) => `${g.id}：${g.note ?? g.measured ?? g.status}`));
  emit('gates-failed', 'agent', '依 gate-report 修復後重跑驗收', [npm('gates')]);
}
evidence.push(`gate-report.json 無 failed/error（${JSON.stringify(gateReport.counts ?? {})}）`);

if (!exists('heygen-request.json')) {
  emit('needs-avatar-dryrun', 'agent', '產生主播 payload 與成本估算（不花錢）', [npm('heygen', 'dryrun')]);
}

if (!exists('heygen-create-response.json')) {
  emit('awaiting-human-approval', 'human', '檢視完整講稿、dryrun payload 與成本後決定是否核准', [], {
    approvalCommand: npm('heygen', 'create', '--i-have-user-approval'),
  });
}

if (!exists('avatar/raw.mp4')) {
  emit('avatar-generating', 'agent', '輪詢既有主播請求直到影片下載完成', [npm('heygen', 'poll')]);
}
evidence.push('avatar/raw.mp4 已存在（付費步驟已完成）');

if (!exists('avatar/speeded.mp4')) emit('needs-speedup', 'agent', '加速主播影片並守 fps gate', [npm('speedup')]);
if (!exists('asr/subtitles.raw.json')) emit('needs-asr', 'agent', '產生逐字 ASR 時間', [npm('asr')]);
if (!exists('asr/script-char-times.json')) {
  emit('needs-alignment', 'agent', '以加速後片長執行強制對齊',
    [node('align-script.mjs', '--duration', '<加速後秒數>')]);
}
stale('charTimes', node('align-script.mjs', '--duration', '<加速後秒數>'));

if (!exists('segment-ledger.json')) {
  emit('needs-segment-ledger', 'agent', '以實際字時序建立 segment ledger',
    [node('build-segment-ledger.mjs', '--duration', '<加速後秒數>')]);
}
stale('segmentLedger', node('build-segment-ledger.mjs', '--duration', '<加速後秒數>'));

if (!exists('caption-ledger.json')) {
  emit('needs-caption-ledger', 'agent', '建立字幕 ledger', [node('build-caption-ledger.mjs')]);
}
stale('captionLedger', node('build-caption-ledger.mjs'));

const mgPlan = readJson('mg-plan.json');
if ((mgPlan.slots ?? []).some((slot) => slot.durationFrom !== 'ledger')) {
  emit('needs-material-retiming', 'agent', '用真實 segment ledger 重建素材格時長',
    [node('plan-mg.mjs', '--write')]);
}

const materialIds = segmentPlan.filter((s) => ['mg', 'device'].includes(s.form)).map((s) => s.id);
const renderedIds = exists('renders')
  ? fs.readdirSync(path.join(P.root, 'renders')).filter((f) => f.endsWith('.mp4')).map((f) => f.slice(0, 2)) : [];
if (materialIds.some((id) => !renderedIds.includes(id))) {
  emit('needs-slot-renders', 'agent', '驗證並渲染所有素材格', [npm('render', 'slots')]);
}
if (!exists('index.html')) emit('needs-main-assembly', 'agent', '組裝主場景', [node('build-main.mjs')]);
if (!exists('outputs/final.mp4')) emit('needs-final-render', 'agent', '渲染成片', [npm('render', 'final')]);

if (mtime('gate-report.json') < mtime('outputs/final.mp4')) {
  emit('needs-final-gates', 'agent', '對成片跑全量驗收', [npm('gates')]);
}
gateReport = readJson('gate-report.json');
const finalBad = (gateReport.results ?? []).filter((g) => ['failed', 'error'].includes(g.status));
if (finalBad.length) {
  blockers.push(...finalBad.map((g) => `${g.id}：${g.note ?? g.measured ?? g.status}`));
  emit('final-gates-failed', 'agent', '修復成片或 artifact 後重跑全量驗收', [npm('gates')]);
}

emit('ready-for-delivery-review', 'agent', '實際觀看成片，交付 gate 明細、黃金樣本比較與主觀風險');
