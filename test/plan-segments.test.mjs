/**
 * 規劃器的回歸測試。
 *
 * 核心斷言：結構約束把 2^28 種分割收斂到兩百多種，但**不決定編輯意圖**；
 * 一個兩分句的 hint 就把 V4c 釘成唯一解。這兩件都要鎖住——
 * 前者是規劃器的價值，後者是它的界線。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANNER = path.join(ROOT, 'stages', 'plan-segments.mjs');
const FIX = path.join(ROOT, 'fixtures', 'project-v4c');
const HINTS = path.join(FIX, 'plan-hints.json');

function plan(hints) {
  const saved = fs.existsSync(HINTS) ? fs.readFileSync(HINTS, 'utf8') : null;
  if (hints === null) fs.rmSync(HINTS, { force: true });
  else if (hints !== undefined) fs.writeFileSync(HINTS, JSON.stringify(hints));
  try {
    const out = execFileSync('node', [PLANNER, '--project', FIX], { encoding: 'utf8' });
    const slots = [...out.matchAll(/^(\d\d) (presenter|mg)\s+(\d+)-(\d+)/gm)]
      .map((m) => ({ id: m[1], form: m[2], from: Number(m[3]), to: Number(m[4]) }));
    const feasible = Number(out.match(/合法分割數：語速下緣 (\d+)/)?.[1]);
    const coverage = Number(out.match(/覆蓋率 ([\d.]+)%/)?.[1]);
    const robust = /語速兩端一致：是/.test(out);
    return { slots, feasible, coverage, robust, out };
  } finally {
    if (saved !== null) fs.writeFileSync(HINTS, saved);
    else fs.rmSync(HINTS, { force: true });
  }
}
const shape = (slots) => slots.map((s) => `${s.form[0].toUpperCase()}${s.from}-${s.to}`).join(' ');

test('沒有 hint 時仍產出結構合法的計畫，但不是 V4c 的那個', () => {
  const r = plan(null);
  assert.equal(r.slots.length, 9);
  assert.equal(r.slots[0].form, 'presenter');
  assert.equal(r.slots.at(-1).form, 'presenter');
  assert.ok(r.coverage <= 50, `覆蓋率 ${r.coverage}% 必須在門檻內`);
  assert.ok(r.feasible > 100, `合法分割應該有上百種，實得 ${r.feasible}`);
  // 規劃器會把「那市場選了什麼」放上圖表——結構約束管不到的編輯判斷
  assert.notEqual(shape(r.slots), shape(plan(undefined).slots));
});

test('一個兩分句的 hint 就把 V4c 釘成唯一解，9 格 form 與 anchor 全同', () => {
  const r = plan(undefined); // 用 fixture 裡真正的 plan-hints.json
  const v4c = JSON.parse(fs.readFileSync(path.join(FIX, 'segment-plan.json'), 'utf8'));
  assert.equal(r.slots.length, v4c.length);
  const expect = 'P0-3 M4-5 P6-9 M10-11 P12-13 M14-16 P17-22 M23-25 P26-28';
  assert.equal(shape(r.slots), expect);
  assert.deepEqual(r.slots.map((s) => s.form), v4c.map((s) => s.form));
});

test('嚴格交替、首末為 presenter，是結構上做不出來的違規', () => {
  const r = plan(undefined);
  for (let i = 1; i < r.slots.length; i++) {
    assert.notEqual(r.slots[i].form, r.slots[i - 1].form, `格 ${r.slots[i].id} 與前一格同 form`);
  }
});

test('計畫必須在語速區間兩端都合法，不能只在中點成立', () => {
  assert.ok(plan(undefined).robust);
  assert.ok(plan(null).robust);
});

test('hint 指到硬性主播分句時拒絕執行，不悄悄忽略', () => {
  assert.throws(() => plan({ material: ['早安'] }), /早安|硬性主播/);
});

test('hint 文字比對到多個分句時報錯，要求寫精確', () => {
  assert.throws(() => plan({ presenter: ['市場'] }), /比對到 2 個分句/);
});

test('responsibility 依 anchor 比對保留，程式不代填 mg 格的意圖', () => {
  const r = plan(undefined);
  assert.match(r.out, /揭露代價，全片最強的反轉/); // 從既有 plan 接回來的
  const v4c = JSON.parse(fs.readFileSync(path.join(FIX, 'segment-plan.json'), 'utf8'));
  assert.ok(v4c.filter((s) => s.form === 'mg').every((s) => s.responsibility));
});
