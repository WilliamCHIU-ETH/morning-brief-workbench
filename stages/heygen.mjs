#!/usr/bin/env node
/**
 * 主播影片生成。**這是整條線唯一不可逆且有成本的步驟。**
 *
 *   node stages/heygen.mjs --project <dir> dryrun      建 payload、估成本，不呼叫
 *   node stages/heygen.mjs --project <dir> create --i-have-user-approval
 *   node stages/heygen.mjs --project <dir> poll        輪詢並下載到 avatar/raw.mp4
 *
 * create 有三道自己的鎖，缺一不可：
 *   1. `--i-have-user-approval` 旗標必須明寫。agent 不得在使用者沒點頭時帶上它。
 *   2. payload 必須逐欄符合 contracts/avatar-generation.json。
 *   3. 付費前階段的 gate 必須全部通過（run-gates 退出碼 0）。
 *
 * 金鑰從環境變數 HEYGEN_API_KEY 讀，不進 repo。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveProject } from './lib/project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex, getTitleText } = require(path.join(here, 'script-utils.js'));

const acceptance = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/acceptance.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/avatar-generation.json'), 'utf8'));

let P;
try { P = resolveProject(); } catch (e) {
  console.error(e.message);
  console.error('用法：node stages/heygen.mjs --project <dir> dryrun|create|poll');
  process.exit(2);
}
const argv = process.argv.slice(2);
const cmd = argv.find((a) => ['dryrun', 'create', 'poll'].includes(a)) ?? 'dryrun';
const APPROVED = argv.includes('--i-have-user-approval');

const raw = fs.readFileSync(P.path('script'), 'utf8');
const body = getBodyAfterVoice(raw);
const cleanChars = cleanBodyWithIndex(body).length;
const title = (getTitleText(raw) || '').split('\n').map((s) => s.trim()).filter(Boolean);

// raw 秒數用未加速的語速推。加速後的區間是 acceptance.calibration，
// 除以速度倍率得到生成端的原始長度。
const SPEED = acceptance.gates.find((g) => g.id === 'video.speed-factor')?.threshold?.expected ?? 1.1;
const [rMin, rMax] = acceptance.calibration.rateBand;
const rawSec = [cleanChars / (rMax / SPEED), cleanChars / (rMin / SPEED)];
const USD_PER_SEC = 0.05;                    // HeyGen Photo Avatar 單價

function buildPayload() {
  const p = { ...lock.payload };
  for (const l of lock.locked) {
    const parts = l.field.split('.');
    let o = p;
    while (parts.length > 1) { const k = parts.shift(); o[k] = o[k] ?? {}; o = o[k]; }
    o[parts[0]] = l.value;
  }
  p.avatar_id = process.env.MB_AVATAR_ID || lock.notLocked?.$avatarId || '2ee530cfcdc62055d8b34a95b0c94300';
  p.voice_id = process.env.MB_VOICE_ID || lock.notLocked?.$voiceId || 'df750e70c02c421fac1b532dfeb0989b';
  p.script = body.split('\n').map((s) => s.trim()).filter(Boolean).join('\n\n');
  p.title = `${(title[1] || title[0] || 'morning-brief').replace(/[^\w一-鿿-]/g, '')}`.slice(0, 60);
  return p;
}

if (cmd === 'dryrun') {
  const payload = buildPayload();
  fs.writeFileSync(path.join(P.root, 'heygen-request.json'), `${JSON.stringify(payload, null, 2)}\n`);
  // 出示用的版本：id 加註人名，講稿折成一行摘要。
  // 講稿在這個區塊上面已經完整出示過，塞進來只會讓 payload 沒法掃視——
  // 而使用者要核准的正是「送出去的是不是我看過的那份設定」。
  const label = (k, v) => {
    if (k === 'avatar_id') return lock.registry?.avatars?.[v];
    if (k === 'voice_id') return lock.registry?.voices?.[v];
    return null;
  };
  const lines = [];
  const walk = (o, indent) => {
    const keys = Object.keys(o);
    keys.forEach((k, i) => {
      const v = o[k];
      const comma = i < keys.length - 1 ? ',' : '';
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        lines.push(`${indent}"${k}": { ${Object.entries(v).map(([a, b2]) => `"${a}": ${JSON.stringify(b2)}`).join(', ')} }${comma}`);
        return;
      }
      const shown = k === 'script'
        ? `"<${cleanBodyWithIndex(String(v)).length} clean 字，即上方講稿>"`
        : JSON.stringify(v);
      const note = label(k, v);
      lines.push(`${indent}"${k}": ${shown}${comma}${note ? `   // ${note}` : ''}`);
    });
  };
  console.log('── 要送出的 payload ──────────────────────────────────');
  console.log('{');
  walk(payload, '  ');
  lines.forEach((l) => console.log(l));
  console.log('}');
  console.log('');
  console.log('── 成本 ──────────────────────────────────────────────');
  console.log(`clean ${cleanChars} 字 → 生成端原始長度約 ${rawSec[0].toFixed(1)}–${rawSec[1].toFixed(1)} 秒`);
  console.log(`Photo Avatar $${USD_PER_SEC}／秒 → 本次約 $${(rawSec[0] * USD_PER_SEC).toFixed(2)}–$${(rawSec[1] * USD_PER_SEC).toFixed(2)}`);
  console.log('');
  console.log('已寫入 heygen-request.json。**這一步沒有花錢。**');
  console.log('接下來必須把上面的 payload 與成本出示給使用者，取得明確同意，才可以：');
  console.log(`  node stages/heygen.mjs --project ${path.relative(process.cwd(), P.root)} create --i-have-user-approval`);
  process.exit(0);
}

if (cmd === 'create') {
  if (!APPROVED) {
    console.error('拒絕執行：缺少 --i-have-user-approval。');
    console.error('這是整條線唯一不可逆且有成本的步驟。先跑 dryrun，把 payload 與成本出示給使用者，');
    console.error('取得明確同意之後才可以帶上這個旗標。**不得在使用者沒點頭時自行帶上。**');
    process.exit(3);
  }
  // 付費前的 gate 必須全過。錢花下去之後再發現講稿不合格是不可逆的浪費。
  try {
    execFileSync('node', [path.join(here, 'run-gates.mjs'), '--project', P.root],
      { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    console.error('拒絕執行：付費前的 gate 沒有全部通過。先修到 exit 0 再來。');
    process.exit(4);
  }
  const KEY = (process.env.HEYGEN_API_KEY || '').trim();
  if (!KEY) {
    console.error('缺少環境變數 HEYGEN_API_KEY。金鑰不進 repo，請在執行前設好。');
    process.exit(5);
  }
  const payload = JSON.parse(fs.readFileSync(path.join(P.root, 'heygen-request.json'), 'utf8'));
  const res = await fetch('https://api.heygen.com/v3/videos', {
    method: 'POST',
    headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  fs.writeFileSync(path.join(P.root, 'heygen-create-response.json'), `${JSON.stringify(data, null, 2)}\n`);
  if (!res.ok) { console.error(`HTTP ${res.status}`, JSON.stringify(data)); process.exit(1); }
  console.log('video_id=' + (data?.data?.video_id ?? data?.video_id));
  console.log(`接著：node stages/heygen.mjs --project ${path.relative(process.cwd(), P.root)} poll`);
  process.exit(0);
}

if (cmd === 'poll') {
  const KEY = (process.env.HEYGEN_API_KEY || '').trim();
  if (!KEY) { console.error('缺少環境變數 HEYGEN_API_KEY。'); process.exit(5); }
  const created = JSON.parse(fs.readFileSync(path.join(P.root, 'heygen-create-response.json'), 'utf8'));
  const id = created?.data?.video_id ?? created?.video_id;
  for (let i = 0; i < 90; i++) {
    const r = await fetch(`https://api.heygen.com/v3/videos/${id}`, { headers: { 'X-Api-Key': KEY } });
    const d = (await r.json().catch(() => ({})))?.data ?? {};
    if (d.failure_code || d.failure_message) {
      console.error('生成失敗：', d.failure_code, d.failure_message); process.exit(1);
    }
    if (d.video_url) {
      fs.writeFileSync(path.join(P.root, 'heygen-video.json'), `${JSON.stringify(d, null, 2)}\n`);
      const buf = Buffer.from(await (await fetch(d.video_url)).arrayBuffer());
      const out = P.path('avatarRaw');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      console.log(`done duration=${d.duration}s  saved ${P.rel('avatarRaw')} (${(buf.length / 1048576).toFixed(1)} MB)`);
      console.log('注意：這是原始檔，還沒加速。下一步是 ffmpeg 加速，且必須守 fps gate。');
      process.exit(0);
    }
    console.log(`[${i * 10}s] ${d.status ?? 'processing'}`);
    await new Promise((r2) => setTimeout(r2, 10000));
  }
  console.error('輪詢超時'); process.exit(1);
}
