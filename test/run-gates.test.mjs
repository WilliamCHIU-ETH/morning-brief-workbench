/**
 * Gate runner 的回歸測試。
 * 正例是 V4c 的真實 artifact；反例是 V2 的真實 artifact。
 * 斷言的是「2026-08-26 人眼抓到的缺陷，現在 gate 抓得到」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'stages', 'run-gates.mjs');

function run(fixture) {
  const args = [RUNNER, '--project', path.join(ROOT, 'fixtures', fixture), '--json'];
  try {
    return { code: 0, report: JSON.parse(execFileSync('node', args, { encoding: 'utf8' })) };
  } catch (e) {
    return { code: e.status, report: JSON.parse(e.stdout) };
  }
}
const byId = (r) => Object.fromEntries(r.results.map((x) => [x.id, x]));

test('V4c 的 artifact：沒有任何 failed，退出碼 0', () => {
  const { code, report } = run('project-v4c');
  assert.equal(code, 0);
  assert.equal(report.counts.failed ?? 0, 0);
  assert.equal(report.counts.error ?? 0, 0);
  const g = byId(report);
  assert.equal(g['ledger.alternation'].measured, 'P M P M P M P M P');
  assert.equal(g['ledger.coverage'].measured, 0.44);
  assert.match(g['caption.char-coverage'].measured, /量測 236／宣告 236／講稿 236/);
});

test('缺 artifact 的 gate 是 skipped，不是 passed', () => {
  const { report } = run('project-v4c');
  const g = byId(report);
  for (const id of ['video.fps-no-drop', 'mg.prompt-provenance', 'avatar.payload-locked']) {
    assert.equal(g[id].status, 'skipped', `${id} 應該 skipped`);
    assert.ok(g[id].note, `${id} 必須寫明原因`);
  }
});

test('ledger 缺 form 欄位時是 error，不是算出好看的覆蓋率', () => {
  const { code, report } = run('project-v2-noform');
  assert.equal(code, 1);
  const g = byId(report);
  for (const id of ['ledger.coverage', 'ledger.alternation', 'ledger.max-material-run']) {
    assert.equal(g[id].status, 'error', `${id} 應該 error`);
    assert.match(g[id].note, /form 不合法/);
  }
});

test('V2 的真實情形（12 格全 mg）：覆蓋率、交替、連續素材、字幕尾標點全部擋下', () => {
  const { code, report } = run('project-v2-allmg');
  assert.equal(code, 1);
  const g = byId(report);
  assert.equal(g['ledger.coverage'].status, 'failed');
  assert.ok(g['ledger.coverage'].measured > 0.9, '覆蓋率應接近 1');
  assert.equal(g['ledger.alternation'].status, 'failed');
  assert.equal(g['ledger.max-material-run'].status, 'failed');
  assert.equal(g['caption.no-trailing-punct'].status, 'failed');
  assert.equal(g['caption.snap-to-cuts'].status, 'failed');
});

test('零個 presenter 格必須 failed，不能因為 Math.min([]) 回 Infinity 而通過', () => {
  const { report } = run('project-v2-allmg');
  const g = byId(report);
  assert.equal(g['ledger.min-presenter'].status, 'failed');
  assert.equal(g['ledger.min-presenter'].measured, '0 格 presenter');
});

test('acceptance.json 的每一道 gate 都要有 runner 回報，不得漏掉', async () => {
  const fs = await import('node:fs');
  const acc = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/acceptance.json'), 'utf8'));
  const { report } = run('project-v4c');
  const reported = new Set(report.results.map((r) => r.id));
  const missing = acc.gates.map((g) => g.id).filter((id) => !reported.has(id));
  assert.deepEqual(missing, [], `acceptance.json 有 gate 沒被 runner 回報：${missing.join('、')}`);
});
