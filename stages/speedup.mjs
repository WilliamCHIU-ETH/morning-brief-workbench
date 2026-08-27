#!/usr/bin/env node
/**
 * 主播影片加速。avatar/raw.mp4 → avatar/speeded.mp4
 *
 *   node stages/speedup.mjs --project <dir> [--factor 1.1]
 *
 * 倍率預設從 contracts/acceptance.json 的 video.speed-factor 讀。
 *
 * **必須設 `-r`。** 不設的話輸出 fps 會留在輸入 fps，25 × 1.2 = 30 需要的格數
 * 拿不到，ffmpeg 就丟格——實測丟掉 16.6%。判準寫在 video.fps-no-drop：
 * 輸出 fps ≥ 輸入 fps × 倍率。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProject } from './lib/project.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const acceptance = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/acceptance.json'), 'utf8'));

let P;
try { P = resolveProject(); } catch (e) {
  console.error(e.message);
  console.error('用法：node stages/speedup.mjs --project <dir> [--factor 1.1]');
  process.exit(2);
}
const argv = process.argv.slice(2);
const fi = argv.indexOf('--factor');
const FACTOR = Number(fi >= 0 ? argv[fi + 1]
  : acceptance.gates.find((g) => g.id === 'video.speed-factor')?.threshold?.expected ?? 1.1);

const src = P.path('avatarRaw');
if (!fs.existsSync(src)) {
  console.error(`缺 ${P.rel('avatarRaw')}。先跑 heygen.mjs 取得主播影片。`);
  process.exit(1);
}
const probe = (f, entries, stream = true) => execFileSync('ffprobe',
  ['-v', 'error', ...(stream ? ['-select_streams', 'v:0'] : []),
    '-show_entries', entries, '-of', 'default=nw=1:nk=1', f], { encoding: 'utf8' }).trim();

const [a, b] = probe(src, 'stream=r_frame_rate').split('/').map(Number);
const inFps = b ? a / b : a;
const inDur = Number(probe(src, 'format=duration', false));
// 輸出 fps 取「輸入 × 倍率」進位到常見值，並確保不低於它——這是 fps gate 的判準。
const need = inFps * FACTOR;
const outFps = [24, 25, 30, 50, 60].find((f) => f >= need - 1e-9) ?? Math.ceil(need);

// atempo 單次只吃 0.5–2.0，超出要串接。晨報用不到，但寫死上限會在別人改倍率時爆掉。
const tempo = [];
let rest = FACTOR;
while (rest > 2.0) { tempo.push('atempo=2.0'); rest /= 2.0; }
while (rest < 0.5) { tempo.push('atempo=0.5'); rest /= 0.5; }
tempo.push(`atempo=${rest}`);

const dst = P.path('avatarSpeeded');
fs.mkdirSync(path.dirname(dst), { recursive: true });
console.log(`輸入 ${inFps}fps ${inDur.toFixed(2)}s → 倍率 ${FACTOR} → 需要 ${need.toFixed(2)}fps → 輸出設 ${outFps}fps`);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src,
  '-filter_complex', `[0:v]setpts=${(1 / FACTOR).toFixed(6)}*PTS[v];[0:a]${tempo.join(',')}[a]`,
  '-map', '[v]', '-map', '[a]', '-r', String(outFps),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', dst], { stdio: ['ignore', 'inherit', 'inherit'] });

const outDur = Number(probe(dst, 'format=duration', false));
const realSpeed = inDur / outDur;
console.log(`輸出 ${outDur.toFixed(2)}s，實際倍率 ${realSpeed.toFixed(3)}`);
console.log(`fps 判準：${outFps} >= ${inFps} x ${realSpeed.toFixed(3)} = ${(inFps * realSpeed).toFixed(2)}　${outFps >= inFps * realSpeed - 1e-6 ? '通過' : '未通過'}`);
