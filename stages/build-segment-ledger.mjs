// 切段：以講稿文字錨點 → script-char-times.json 的真實時間。
// 欄位依 SKILL.md「切段規則」：id / startSec / endSec / anchor / responsibility。
// 額外帶 form（mg｜presenter｜device），因為 V3 的重點是覆蓋率而非只有切點。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProject, readJson, writeJson } from './lib/project.mjs';

const P = resolveProject();
const argv = process.argv.slice(2);
const di = argv.indexOf('--duration');
const DURATION = Number(di >= 0 ? argv[di + 1] : NaN);
if (!Number.isFinite(DURATION)) {
  throw new Error('usage: build-segment-ledger.mjs --project <dir> --duration <sec>');
}
const chars = readJson(P, 'charTimes');
const clean = chars.map((c) => c.ch).join('');

const PLAN = readJson(P, 'segmentPlan').map(
  (s) => [s.id, s.form, s.anchor, s.responsibility],
);

let cursor = 0;
const segments = PLAN.map(([id, form, anchor, responsibility]) => {
  const at = clean.indexOf(anchor, cursor);
  if (at < 0) throw new Error(`錨點找不到：${id} ${anchor.slice(0, 12)}…（cursor=${cursor}）`);
  if (at !== cursor) throw new Error(`錨點不連續：${id} 期望 ${cursor} 實得 ${at}`);
  const endIdx = at + anchor.length - 1;
  cursor = endIdx + 1;
  return { id, form, startSec: chars[at].start, endSec: chars[endIdx].end, anchor, responsibility };
});
// CTA 已從成片裁掉，講稿尾段不再覆蓋；只檢查切點連續
console.log(`覆蓋字元 ${cursor}/${clean.length}（尾段 ${clean.length-cursor} 字為已裁掉的 CTA）`);

// 相鄰格首尾接合：後一格起點 = 前一格終點，避免縫隙
for (let i = 1; i < segments.length; i++) segments[i].startSec = segments[i - 1].endSec;
segments[0].startSec = 0;
segments[segments.length - 1].endSec = DURATION;

segments.forEach((s) => { s.durationSec = +(s.endSec - s.startSec).toFixed(3); });

const total = DURATION;
const sum = (f) => segments.filter((s) => s.form === f).reduce((a, s) => a + (s.endSec - s.startSec), 0);
const cover = { mg: sum('mg'), presenter: sum('presenter'), device: sum('device') };
const out = { durationSec: total, visualForm: 'fullframe', coverage: {
  mgSec: +cover.mg.toFixed(2), deviceSec: +cover.device.toFixed(2), presenterSec: +cover.presenter.toFixed(2),
  materialPct: +(((cover.mg + cover.device) / total) * 100).toFixed(1),
  presenterPct: +((cover.presenter / total) * 100).toFixed(1),
}, segments };
writeJson(P, 'segmentLedger', out, { inputs: ['charTimes', 'segmentPlan'] });

console.log('id form      start    end     秒    責任');
for (const s of segments) {
  console.log(`${s.id} ${s.form.padEnd(9)} ${s.startSec.toFixed(2).padStart(6)} ${s.endSec.toFixed(2).padStart(6)} ${(s.endSec - s.startSec).toFixed(2).padStart(5)}  ${s.responsibility}`);
}
console.log('---');
console.log(JSON.stringify(out.coverage));
