#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_FILES = [
  'BGM.mp3',
  'cmoney-logo-white.png',
  'gsap.min.js',
  'NotoSansTC-Bold.ttf',
  'NotoSansTC-Regular.ttf',
];
const HYPERFRAMES = `{
  "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
  "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
  "paths": {
    "blocks": "compositions",
    "components": "compositions/components",
    "assets": "assets"
  },
  "media": {
    "autoProxy": true
  }
}
`;

const argv = process.argv.slice(2);
const pi = argv.indexOf('--project');
const raw = pi >= 0 ? argv[pi + 1] : null;
if (!raw || raw.startsWith('--')) {
  console.error('缺少要初始化的 project 目錄，無法建立專案骨架。');
  console.error('用法：node stages/init-project.mjs --project <dir>');
  process.exit(2);
}

const project = path.resolve(raw);
const exists = (file) => {
  try { fs.lstatSync(file); return true; } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
};
const made = (rel) => console.log(`建立：${rel}`);
const skipped = (rel) => console.log(`已存在略過：${rel}`);

function ensureDirectory(dir, rel, { physical = false } = {}) {
  if (exists(dir)) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || (physical && stat.isSymbolicLink())) {
      throw new Error(
        `${rel} 已存在但不是${physical ? '實體' : ''}目錄，不能在不覆寫既有內容的前提下初始化。\n` +
        `請先移走 ${rel}，再重跑 node stages/init-project.mjs --project ${project}`,
      );
    }
    skipped(rel);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  made(rel);
}

try {
  ensureDirectory(project, project);

  const config = path.join(project, 'hyperframes.json');
  if (exists(config)) skipped('hyperframes.json');
  else {
    fs.writeFileSync(config, HYPERFRAMES);
    made('hyperframes.json');
  }

  const assetDir = path.join(project, 'assets');
  ensureDirectory(assetDir, 'assets/', { physical: true });
  for (const name of ASSET_FILES) {
    const src = path.join(ROOT, 'assets', name);
    const dst = path.join(assetDir, name);
    if (!fs.existsSync(src)) {
      throw new Error(
        `repo 共用資源缺少 assets/${name}，新專案無法取得渲染素材。\n` +
        '請先還原該共用資源，再重跑初始化。',
      );
    }
    if (exists(dst)) {
      const srcBytes = fs.statSync(src).size;
      const dstBytes = fs.statSync(dst).size;
      if (srcBytes === dstBytes) skipped(`assets/${name}`);
      else {
        console.warn(
          `已存在略過：assets/${name}（警告：檔案大小 ${dstBytes} bytes，` +
          `repo 來源是 ${srcBytes} bytes；可能是截斷檔或刻意換過的素材，請人工判斷）`,
        );
      }
      continue;
    }
    const tmp = `${dst}.tmp-init`;
    try {
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dst);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
    made(`assets/${name}`);
  }

  const template = path.join(project, 'template');
  if (exists(template)) {
    const stat = fs.lstatSync(template);
    if (stat.isSymbolicLink()) {
      let actual;
      try { actual = fs.realpathSync(template); } catch {
        throw new Error(
          `template symlink 已斷裂，無法解析到 repo 的唯讀版位：${template}\n` +
          `請先移走 ${template} 再重跑 node stages/init-project.mjs --project ${project}`,
        );
      }
      const expected = fs.realpathSync(path.join(ROOT, 'template'));
      if (actual !== expected) {
        throw new Error(
          `template symlink 指向錯誤：${actual}；預期是 ${expected}。\n` +
          `請先移走 ${template} 再重跑 node stages/init-project.mjs --project ${project}`,
        );
      }
    }
    skipped('template');
  } else {
    const target = path.relative(
      fs.realpathSync(project),
      fs.realpathSync(path.join(ROOT, 'template')),
    );
    fs.symlinkSync(target, template, 'dir');
    made(`template → ${target}`);
  }

  ensureDirectory(path.join(project, 'public'), 'public/');

  // 開場卡預設開。對標的 cmchipk 每支第 0 秒都有一張標題卡（docs/reference-reels.md §3），
  // 2026-08-29 光環 V2 以 project 層 main.config.json 開啟試片、主管未提異議，收為新專案預設。
  // 只在檔案不存在時寫，既有專案的 main.config.json 一個位元組都不動。
  const mainConfig = path.join(project, 'main.config.json');
  if (exists(mainConfig)) skipped('main.config.json');
  else {
    fs.writeFileSync(mainConfig, JSON.stringify({ intro: true }, null, 2) + '\n');
    made('main.config.json（intro: true）');
  }
} catch (e) {
  console.error(`初始化專案骨架失敗：${e.message}`);
  process.exit(1);
}
