/**
 * 紅隊回歸測試。
 *
 * fixtures/attacks/ 裡每一個都是「gate 曾經放行的壞輸入」。2026-08-27 的紅隊
 * 用其中一個（x12-grandslam）做到 19 道全過、0 略過、exit 0——而那是一支 300 秒、
 * B-roll 全是 1x1 黑 PNG、payload 是 16:9 480p 的爛片。
 *
 * 每一條斷言的不只是「有擋下」，還包括「是哪一道 gate 擋的」——
 * 否則某天換成另一個理由失敗，這個測試會繼續綠燈而漏洞已經回來了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'stages', 'run-gates.mjs');

function run(name) {
  const args = [RUNNER, '--project', path.join(ROOT, 'fixtures', 'attacks', name), '--json'];
  try { return { code: 0, report: JSON.parse(execFileSync('node', args, { encoding: 'utf8' })) }; }
  catch (e) { return { code: e.status, report: e.stdout ? JSON.parse(e.stdout) : null }; }
}
const failedIds = (r) => r.results.filter((x) => x.status === 'failed' || x.status === 'error').map((x) => x.id);

const CASES = [
  ['x1-empty', ['script.lint-clean'], '空目錄曾經是「略過 20、exit 0」'],
  ['x3-lint-bypass', ['script.lint-clean'], '18 個 lint error 曾經只有 5 個到得了 gate'],
  ['x4-degenerate', ['ledger.alternation', 'caption.char-coverage'], '單段 ledger 讓四道 gate 真空通過'],
  ['x5-negative-mg', ['ledger.invariants'], '負數段長把 64.9% 的覆蓋率報成剛好 0.440'],
  ['x6-longform', ['ledger.duration-in-target'], '300 秒的片子，覆蓋率 0.087 看起來比 V4c 好'],
  ['x7b-empty-anchor2', ['plan.covers-script'], '零長度 anchor 讓格數與合法率失去意義'],
  ['x8-provenance', ['mg.prompt-provenance'], '四格 B-roll 是同一張 1x1 黑圖，報「全部配對」'],
  ['x10-avatar', ['avatar.payload-locked'], '16:9 480p、稿子是別支影片，通過付費前唯一的檢查'],
  ['x11b-stale-nosidecar', ['artifact.provenance-complete'], '刪掉 sidecar 就繞過 requireFresh'],
  ['x12-grandslam', ['ledger.duration-in-target', 'avatar.payload-locked', 'mg.prompt-provenance'],
    '曾經 19 道全過、0 略過、exit 0'],
  ['x13-greeting-under-chart', ['ledger.greeting-uncovered'], '真正的問候被滿版圖表蓋住而報通過'],
  ['x2-plan-allmg', ['plan.material-floor'], '全片上圖、主播不露臉，通過得比 V4c 漂亮'],
];

for (const [name, mustCatch, why] of CASES) {
  test(`${name}：${why}`, () => {
    const { code, report } = run(name);
    assert.equal(code, 1, `${name} 應該 exit 1`);
    const got = failedIds(report);
    for (const id of mustCatch) {
      assert.ok(got.includes(id), `${name} 應該被 ${id} 擋下，實際擋下的是：${got.join('、')}`);
    }
  });
}

test('黃金基準沒有被這些強化誤傷', () => {
  const args = [RUNNER, '--project', path.join(ROOT, 'fixtures', 'project-v4c'), '--json'];
  const report = JSON.parse(execFileSync('node', args, { encoding: 'utf8' }));
  assert.equal(report.counts.failed ?? 0, 0);
  assert.equal(report.counts.error ?? 0, 0);
});
