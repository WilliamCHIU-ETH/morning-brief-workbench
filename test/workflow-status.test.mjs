import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS = path.join(ROOT, 'stages', 'workflow-status.mjs');

function run(project) {
  return JSON.parse(execFileSync('node', [STATUS, '--project', project, '--json'], {
    cwd: ROOT, encoding: 'utf8',
  }));
}

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morning-brief-status-'));
  fs.writeFileSync(path.join(dir, 'hyperframes.json'), '{}\n');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'gsap.min.js'), '// fixture\n');
  fs.mkdirSync(path.join(dir, 'template'));
  fs.writeFileSync(path.join(dir, 'template', 'layout.json'), '{}\n');
  return dir;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeDerived(project, rel, data, inputs) {
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  fs.writeFileSync(`${file}.provenance.json`, `${JSON.stringify({
    artifact: rel,
    generatedBy: 'workflow-status.test.mjs',
    inputs: inputs.map((input) => ({
      path: input,
      sha256: sha256(path.join(project, input)),
      bytes: fs.statSync(path.join(project, input)).size,
    })),
  }, null, 2)}\n`);
}

test('空白骨架的下一步是由 agent 從 docx 寫 script，不新增人工關卡', () => {
  const project = tempProject();
  const status = run(project);
  assert.equal(status.state, 'needs-script');
  assert.equal(status.owner, 'agent');
  assert.equal(status.humanGate.required, false);
});

test('缺專案骨架時先回到 init-project', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'morning-brief-status-'));
  const status = run(project);
  assert.equal(status.state, 'needs-initialization');
  assert.match(status.commands[0], /init-project\.mjs/);
});

test('既有黃金樣本會明確指出新截圖鏈尚未完成，不誤報成片完成', () => {
  const status = run(path.join(ROOT, 'fixtures', 'project-v4c'));
  assert.equal(status.state, 'needs-initialization');
  assert.match(status.blockers.join(' '), /專案骨架不完整/);
});

test('付費前 artifacts 與 gates 齊全時，只能停在唯一人工核准關卡', async () => {
  const project = tempProject();
  fs.copyFileSync(path.join(ROOT, 'fixtures', 'project-v4c', 'script.txt'), path.join(project, 'script.txt'));
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'project-v4c', 'segment-plan.json'), 'utf8'));
  writeDerived(project, 'segment-plan.json', plan, ['script.txt']);
  const slots = Object.fromEntries(plan.filter((s) => s.form === 'mg').map((s) => [s.id, {
    page: 'fixture', image: `assets/shots/${s.id}.png`, focus: { x: 1, y: 1, width: 1, height: 1 },
  }]));
  writeDerived(project, 'shot-plan.json', { mode: 'production', slots }, ['script.txt', 'segment-plan.json']);
  writeDerived(project, 'mg-plan.json', {
    slots: plan.filter((s) => s.form === 'mg').map((s) => ({ id: s.id, durationFrom: 'plan-estimate' })),
  }, ['script.txt', 'segment-plan.json', 'shot-plan.json']);
  fs.writeFileSync(path.join(project, 'gate-report.json'), `${JSON.stringify({
    counts: { passed: 12, skipped: 20 }, results: [],
  })}\n`);
  fs.writeFileSync(path.join(project, 'heygen-request.json'), '{}\n');
  // 檔案系統 mtime 解析度不同；確保 gate report 是最新 handoff。
  const now = new Date(Date.now() + 1000);
  fs.utimesSync(path.join(project, 'gate-report.json'), now, now);

  const status = run(project);
  assert.equal(status.state, 'awaiting-human-approval');
  assert.equal(status.owner, 'human');
  assert.equal(status.humanGate.required, true);
  assert.deepEqual(status.commands, []);
  assert.match(status.approvalCommand, /--i-have-user-approval/);
});

// ── init-project 骨架守衛 ────────────────────────────────────────────────────
// golden 樣式（0825 光環 V3＋0831 金居 v7 逐欄相同的 main.config）已收為新專案預設；
// 這條測試守住預設不被無聲改掉：改預設必須連這裡一起改，等於強制留下量測來源。

test('init-project 骨架帶 golden 樣式預設，編輯欄位刻意留空', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'morning-brief-init-')), 'p');
  execFileSync('node', [path.join(ROOT, 'stages', 'init-project.mjs'), '--project', dir], {
    cwd: ROOT, encoding: 'utf8',
  });
  const mc = JSON.parse(fs.readFileSync(path.join(dir, 'main.config.json'), 'utf8'));
  assert.deepEqual(mc, {
    intro: false,
    openTitle: { main: '', sub: '', preRollSec: 2.5, kicker: false, style: 'cover' },
    titleBoard: { mode: 'hook', accent: 'gold' },
    bgm: true,
    lead: 0.4,
    spotlight: 0.35,
    brandFrame: false,
  });
  const vc = JSON.parse(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8'));
  assert.equal(vc.provider, 'minimax');
  assert.equal(vc.speedDivisor, 1);
  assert.deepEqual(vc.speeds, { hook: 1.25, body: 1.15, close: 1.08 });
  assert.deepEqual(vc.pauses, []);   // 停頓是逐句編輯判斷，骨架不代填
  assert.equal(vc.numerals, 'chinese');
});
