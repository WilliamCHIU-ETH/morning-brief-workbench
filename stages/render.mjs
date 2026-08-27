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

if (cmd === 'slots' || cmd === 'all') {
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
    run(['render', path.relative(P.root, qa), '-o', path.join('..', '..', out)],
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
