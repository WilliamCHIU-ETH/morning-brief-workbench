#!/usr/bin/env node
/**
 * 渲染。MG 各格與主場景。
 *
 *   node stages/render.mjs --project <dir> slots     渲染 compositions/*.html → renders/
 *   node stages/render.mjs --project <dir> final     渲染 index.html → outputs/final.mp4
 *   node stages/render.mjs --project <dir> all       兩者依序
 *
 * 走 hyperframes CLI（npx，版本鎖在 0.8.3）。渲染之前一律先 check——
 * 一格 0 error 才渲染，否則是拿有問題的畫面去燒 CPU。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProject } from './lib/project.mjs';

const HF = ['--yes', 'hyperframes@0.8.3'];
let P;
try { P = resolveProject(); } catch (e) {
  console.error(e.message);
  console.error('用法：node stages/render.mjs --project <dir> slots|final|all');
  process.exit(2);
}
const cmd = process.argv.slice(2).find((a) => ['slots', 'final', 'all'].includes(a)) ?? 'all';
const run = (args, opts = {}) =>
  execFileSync('npx', [...HF, ...args], { cwd: P.root, encoding: 'utf8', ...opts });

/**
 * hyperframes check 吃的是**專案目錄**，不是單一 html；而且有 error 時退出碼非 0。
 * 所以要 (a) 幫每一格搭一個只有它的目錄，(b) 從 stdout 讀 JSON 而不是靠退出碼。
 * build-slots.sh 一直是這樣做的，我第一版寫成傳檔案路徑並讓 execFileSync 直接拋。
 */
function checkDir(dir) {
  let out;
  try {
    out = run(['check', dir, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    out = e.stdout ?? '';
  }
  const i = out.indexOf('{');
  if (i < 0) throw new Error(`hyperframes check 沒有輸出 JSON（${dir}）`);
  const j = JSON.parse(out.slice(i));
  const errs = ['lint', 'runtime', 'layout', 'motion', 'contrast']
    .reduce((a, k) => a + ((j[k] || {}).errorCount || 0), 0);
  const codes = ['lint', 'runtime', 'layout', 'motion', 'contrast']
    .flatMap((k) => ((j[k] || {}).findings || [])
      .filter((f) => f.severity === 'error').map((f) => `${k}:${f.code}`));
  return { errs, codes };
}

/** 為單一 composition 搭一個可以被 check 的臨時專案目錄。 */
function stageOne(file) {
  const dir = path.join(P.root, 'qa', path.basename(file, '.html'));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(P.root, 'compositions', file), path.join(dir, 'index.html'));
  fs.copyFileSync(path.join(P.root, 'hyperframes.json'), path.join(dir, 'hyperframes.json'));
  const link = path.join(dir, 'assets');
  try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.symlinkSync(path.join(P.root, 'assets'), link);
  return dir;
}

function preflightSlots() {
  const required = ['hyperframes.json', 'assets/gsap.min.js', 'template/layout.json'];
  const missing = required.filter((rel) => !fs.existsSync(path.join(P.root, rel)));
  if (missing.length) {
    console.error(
      `素材格渲染缺少專案骨架：\n  ${missing.join('\n  ')}\n` +
      'HyperFrames 的設定、動畫 runtime 或版位不完整，繼續會在渲染途中失敗。\n' +
      `下一步：node stages/init-project.mjs --project ${P.root}`,
    );
    process.exit(1);
  }

  const ledger = P.path('segmentLedger');
  const mgPlan = path.join(P.root, 'mg-plan.json');
  if (fs.existsSync(ledger) && fs.existsSync(mgPlan)) {
    const plan = JSON.parse(fs.readFileSync(mgPlan, 'utf8'));
    const slots = Array.isArray(plan) ? plan : (plan.slots ?? null);
    if (slots === null) {
      console.warn('警告：mg-plan.json 沒有 slots 欄位，無法判斷 composition 是否過期');
    } else if (slots.some((slot) => slot.durationFrom === 'plan-estimate')) {
      console.error(
        'ledger 已存在但 composition 用的還是估計時長。mg-plan.json 仍有 durationFrom="plan-estimate"，' +
        '繼續渲染會讓素材格與主播真實時間錯位。\n' +
        `下一步：node stages/plan-mg.mjs --project ${P.root} --write`,
      );
      process.exit(1);
    }
  }
}

if (cmd === 'slots' || cmd === 'all') {
  preflightSlots();
  const dir = path.join(P.root, 'compositions');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.html')) : [];
  if (!files.length) { console.error('compositions/ 裡沒有 html。先跑 plan-mg.mjs --write。'); process.exit(1); }
  fs.mkdirSync(path.join(P.root, 'renders'), { recursive: true });
  for (const f of files) {
    const qa = stageOne(f);
    const { errs, codes } = checkDir(path.relative(P.root, qa));
    if (errs) {
      console.error(`${f}：check 有 ${errs} 個 error（${codes.join('、')}），不渲染。`);
      process.exit(1);
    }
    const out = path.join('renders', `${path.basename(f, '.html')}.mp4`);
    console.log(`渲染 ${f} → ${out}`);
    // -o 是相對於 **process cwd**（這裡是 P.root），不是相對於傳進去的專案目錄。
    // 第一版寫成 '../../' + out，以為基準是 qa/<name>，結果 mp4 落到 P.root 的祖父目錄。
    run(['render', path.relative(P.root, qa), '-o', out],
      { stdio: ['ignore', 'inherit', 'inherit'] });
  }
}

if (cmd === 'final' || cmd === 'all') {
  if (!fs.existsSync(path.join(P.root, 'index.html'))) {
    console.error('缺 index.html。先跑 build-main.mjs。'); process.exit(1);
  }
  const { errs, codes } = checkDir('.');
  if (errs) {
    console.error(`index.html：check 有 ${errs} 個 error（${codes.join('、')}），不渲染。`);
    process.exit(1);
  }
  fs.mkdirSync(path.join(P.root, 'outputs'), { recursive: true });
  console.log('渲染主場景 → outputs/final.mp4');
  run(['render', '.', '-o', 'outputs/final.mp4'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const f = path.join(P.root, 'outputs/final.mp4');
  if (fs.existsSync(f)) {
    console.log(`成片：outputs/final.mp4（${(fs.statSync(f).size / 1048576).toFixed(1)} MB）`);
  }
}
