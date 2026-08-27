#!/usr/bin/env node
/**
 * ASR。avatar/speeded.mp4 → asr/subtitles.raw.json
 *
 *   node stages/asr.mjs --project <dir>
 *
 * 用 whisper.cpp 的 whisper-cli（Homebrew 套件 whisper-cpp），不是 Python 的 whisper。
 * 兩者 JSON schema 不同，normalize-whispercpp.js 只吃前者。
 *
 * `-ml 1` 逐字時間戳，`-ojf` 輸出 full JSON。**不要把講稿當成 prompt 餵進去**——
 * 文字真值由後面的 align-script.mjs 用強制對齊處理。
 *
 * 模型路徑：MB_WHISPER_MODEL 或 .cache/whisper/ggml-base-q5_1.bin（見 npm run setup:whisper）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveProject, writeJson } from './lib/project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);

let P;
try { P = resolveProject(); } catch (e) {
  console.error(e.message);
  console.error('用法：node stages/asr.mjs --project <dir>');
  process.exit(2);
}
const MODEL = process.env.MB_WHISPER_MODEL || path.join(ROOT, '.cache/whisper/ggml-base-q5_1.bin');
if (!fs.existsSync(MODEL)) {
  console.error(`缺 whisper 模型：${MODEL}`);
  console.error('跑 `npm run setup:whisper` 下載，或設 MB_WHISPER_MODEL 指到既有的 .bin。');
  process.exit(1);
}
const src = P.path('avatarSpeeded');
if (!fs.existsSync(src)) {
  console.error(`缺 ${P.rel('avatarSpeeded')}。先跑 speedup.mjs。`);
  process.exit(1);
}

const dir = path.dirname(P.path('asrRaw'));
fs.mkdirSync(dir, { recursive: true });
const wav = path.join(dir, 'audio.wav');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
  { stdio: ['ignore', 'inherit', 'inherit'] });

const stem = path.join(dir, 'whisper');
execFileSync('whisper-cli', ['-m', MODEL, '-l', 'zh', '-ml', '1', '-ojf', '-of', stem, wav],
  { stdio: ['ignore', 'inherit', 'inherit'] });

const rawJson = `${stem}.json`;
if (!fs.existsSync(rawJson)) { console.error(`whisper-cli 沒有產出 ${rawJson}`); process.exit(1); }

const { normalizeWhisperCpp } = require(path.join(here, "normalize-whispercpp.js"));
const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=nw=1:nk=1', src], { encoding: 'utf8' }).trim();
const normalized = normalizeWhisperCpp(
  JSON.parse(fs.readFileSync(rawJson, 'utf8')), { duration: Number(probe) });

writeJson(P, 'asrRaw', normalized, { inputs: ['avatarSpeeded'] });
const words = (normalized.segments ?? []).reduce((a, s) => a + (s.words?.length ?? 0), 0);
console.log(`ASR 完成：${normalized.segments?.length ?? 0} 段、${words} 個字，寫入 ${P.rel('asrRaw')}`);
