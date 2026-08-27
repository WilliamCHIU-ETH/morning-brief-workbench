#!/usr/bin/env node
/**
 * npm run demo —— 30 秒看懂這個 repo 在做什麼。
 *
 * 刻意做成對照而不是快樂路徑：只跑黃金樣本會看起來像「所有測試都會過的專案」，
 * 沒有說服力。並排跑一個攻擊樣本，才看得出門檻真的會擋。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (project) => {
  const args = [path.join(ROOT, 'stages', 'run-gates.mjs'), '--project', path.join(ROOT, project), '--json'];
  try { return JSON.parse(execFileSync('node', args, { encoding: 'utf8' })); }
  catch (e) { return JSON.parse(e.stdout); }
};
const line = (s = '─') => console.log(s.repeat(66));

console.log('');
console.log('台股晨報工作台　·　黃金樣本 vs 攻擊樣本');
line();

const good = run('fixtures/project-v4c');
const bad = run('fixtures/attacks/x12-grandslam');
const n = (r, k) => r.counts[k] ?? 0;

console.log(`黃金樣本  project-v4c            通過 ${String(n(good, 'passed')).padStart(2)}　未通過 ${n(good, 'failed')}`);
console.log(`          （2026-08-26 實際出片的那一支，48.6 秒）`);
console.log('');
console.log(`攻擊樣本  x12-grandslam          通過 ${String(n(bad, 'passed')).padStart(2)}　未通過 ${n(bad, 'failed')}`);
console.log(`          （強化之前，這一支是 19 道全過、exit 0）`);
console.log('');
for (const r of bad.results.filter((x) => x.status === 'failed' || x.status === 'error').slice(0, 6)) {
  console.log(`  ↳ ${r.id.padEnd(30)} ${String(r.measured ?? r.note ?? '').slice(0, 30)}`);
}
line();
console.log('那一支攻擊樣本的真面目：片長 300 秒（目標 42–55）、語速 0.77 字／秒、');
console.log('字幕 9 張每張停 33 秒、B-roll 四格是同一張 1×1 黑 PNG、payload 是 16:9 480p。');
console.log('');
console.log('接著看：');
console.log('  npm run gates -- --project fixtures/project-v4c     完整 28 道');
console.log('  npm run plan  -- --project fixtures/project-v4c     從講稿推導切段');
console.log('  cat contracts/acceptance.json                       每道門檻與它的反例');
console.log('');
