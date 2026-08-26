/**
 * lint 的回歸測試。fixture 是 2026-08-26 真實被打回的版本，
 * 斷言的是「當時人眼抓到的缺陷，現在機器抓得到」。
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINT = path.join(ROOT, 'stages', 'lint-script.mjs');

function lint(fixture, args = []) {
  try {
    const out = execFileSync('node', [LINT, path.join(ROOT, 'fixtures', fixture), '--json', ...args],
      { encoding: 'utf8' });
    return { code: 0, report: JSON.parse(out) };
  } catch (e) {
    return { code: e.status, report: JSON.parse(e.stdout) };
  }
}
const ids = (r) => r.findings.filter((f) => f.severity === 'error').map((f) => f.id);

test('V4c 定版通過，且退出碼 0', () => {
  const { code, report } = lint('script.v4-nocta.txt');
  assert.equal(code, 0);
  assert.deepEqual(ids(report), []);
  assert.equal(report.cleanChars, 236);
  // 實測成片 48.6s 必須落在預估區間內
  assert.ok(report.estimatedSec[0] <= 48.6 && 48.6 <= report.estimatedSec[1],
    `48.6s 不在預估區間 ${report.estimatedSec}`);
});

test('V2 的講稿：片型舊名、字數超標、片長超過、HOOK 沒前置、CTA 未移除', () => {
  const { code, report } = lint('script.v1.txt');
  assert.equal(code, 1);
  for (const id of ['format.wrong-program-name', 'script.length', 'script.duration',
    'structure.hook-position', 'script.no-cta']) {
    assert.ok(ids(report).includes(id), `應該抓到 ${id}，實際 ${ids(report)}`);
  }
});

test('V3 送去付費生成的那一版：CTA 與「那天」都會擋下付費呼叫', () => {
  const { code, report } = lint('script.v3-final-b.txt');
  assert.equal(code, 1);
  assert.ok(ids(report).includes('script.no-cta'));
  assert.ok(ids(report).includes('wording.vague-time'));
});

test('V4（含 CTA）只剩 CTA 與字數，結構問題已修掉', () => {
  const { code, report } = lint('script.v4.txt');
  assert.equal(code, 1);
  assert.ok(ids(report).includes('script.no-cta'));
  assert.ok(!ids(report).includes('structure.hook-position'));
});

test('--hook=after-market 走 ROLE.md 原文結構，V4c 反而不合格', () => {
  const { report } = lint('script.v4-nocta.txt', ['--hook', 'after-market']);
  assert.ok(ids(report).includes('structure.greeting-first'),
    'ROLE.md 要求問候在第一段，V4c 是 HOOK 在第一段');
});

test('每份報告都必須帶出規格衝突，不得靜默選邊', () => {
  const { report } = lint('script.v4-nocta.txt');
  assert.ok(report.findings.some((f) => f.id === 'spec.conflict'));
});
