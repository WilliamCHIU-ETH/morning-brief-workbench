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

  // Golden 樣式收為新專案預設。沿革：2026-08-29 光環 V2 以 intro: true 收為預設；
  // 2026-08-30 審閱反饋後 V3 換成「主播模糊開場＋金色雙行大標＋HOOK 常駐標題板＋bgm＋lead 0.4」，
  // 光環 V3 與 0831 金居 v7 兩支正式樣本逐欄相同（docs/editing-techniques.md 有每一招的出處）。
  // openTitle.main／sub 刻意留空：那是編輯意圖（從講稿 HOOK 提煉、main 建議 8 字走 4/4 斷行），
  // 程式不代填，build-main 會擋空字串。只在檔案不存在時寫，既有專案一個位元組都不動。
  const mainConfig = path.join(project, 'main.config.json');
  if (exists(mainConfig)) skipped('main.config.json');
  else {
    fs.writeFileSync(mainConfig, JSON.stringify({
      intro: false,
      openTitle: { main: '', sub: '', preRollSec: 2.5, kicker: false, style: 'cover' },
      titleBoard: { mode: 'hook', accent: 'gold' },
      bgm: true,
      lead: 0.4,
      spotlight: 0.35,
      brandFrame: false,
    }, null, 2) + '\n');
    made('main.config.json（golden 樣式；openTitle.main／sub 待編輯填入）');
  }

  // 配音預設走 MiniMax 音檔路線（兩支正式樣本皆是；HeyGen 內建 TTS 是 fallback）。
  // provider／model／voiceId／speeds／gapSec 是兩支樣本共用的校準值；
  // pauses 是逐句的編輯判斷，刻意留空陣列，寫法見 CLAUDE.md 的配音一節。
  const voiceConfig = path.join(project, 'voice.json');
  if (exists(voiceConfig)) skipped('voice.json');
  else {
    fs.writeFileSync(voiceConfig, JSON.stringify({
      provider: 'minimax',
      model: 'speech-2.8-hd',
      voiceId: 'moss_audio_3a75102e-54db-11f1-981b-8a143315d498',
      speeds: { hook: 1.25, body: 1.15, close: 1.08 },
      speedDivisor: 1,
      gapSec: 0.45,
      pauses: [],
      rewrites: [{ from: '早安，親愛的投資人', to: '早安親愛的投資人' }],
      numerals: 'chinese',
      pronunciation: ['跌/(die2)'],
    }, null, 2) + '\n');
    made('voice.json（MiniMax 校準值；pauses 待編輯填入）');
  }
} catch (e) {
  console.error(`初始化專案骨架失敗：${e.message}`);
  process.exit(1);
}
