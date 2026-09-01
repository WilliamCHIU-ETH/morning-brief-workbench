import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLeads } from '../stages/lib/lead.mjs';
import {
  computeVisualWindow,
  resolveBeatTransitions,
  resolveOrderedBeatTimes,
  shotBeatTweenSec,
} from '../stages/lib/rhythm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'project-v4c');
const PLAN_MG = path.join(ROOT, 'stages', 'plan-mg.mjs');
const BUILD_MAIN = path.join(ROOT, 'stages', 'build-main.mjs');
const RUN_GATES = path.join(ROOT, 'stages', 'run-gates.mjs');
const RENDER = path.join(ROOT, 'stages', 'render.mjs');
const REPO_LAYOUT = path.join(ROOT, 'template', 'layout.json');

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-layers-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(script, dir, extra = []) {
  return spawnSync('node', [script, '--project', dir, ...extra], { encoding: 'utf8' });
}

function cardOverride(firstAtText, secondAtText = '光通訊族群') {
  return {
    '08': {
      template: 'card',
      data: {
        title: '測試卡',
        items: [
          { label: '第一項', value: '1', atText: firstAtText },
          { label: '第二項', value: '2', atText: secondAtText },
        ],
      },
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeTinyPng(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));
}

function makeVideo(file, duration) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=16x16:r=1:d=${duration}`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ]);
}

function makeRendersForPlan(dir) {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'mg-plan.json'), 'utf8'));
  const slots = Array.isArray(plan) ? plan : plan.slots;
  fs.rmSync(path.join(dir, 'renders'), { recursive: true, force: true });
  for (const slot of slots) {
    const suffix = slot.template ? `-${slot.template}` : '';
    makeVideo(path.join(dir, 'renders', `${slot.id}${suffix}.mp4`), slot.durationSec + 0.1);
  }
  return slots;
}

function prepareBuildProject(t) {
  const dir = project(t);
  fs.copyFileSync(REPO_LAYOUT, path.join(dir, 'template', 'layout.json'));
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'segment-ledger.json'), 'utf8'));
  const slots = ledger.segments.filter((segment) => segment.form === 'mg').map((segment) => {
    makeVideo(path.join(dir, 'renders', `${segment.id}.mp4`), segment.durationSec + 0.1);
    return {
      id: segment.id,
      nominalSec: segment.durationSec,
      actualLead: 0,
      durationSec: segment.durationSec,
    };
  });
  writeJson(path.join(dir, 'mg-plan.json'), { slots });
  return { dir, ledger };
}

function at(dir, id, item = 0) {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'mg-plan.json'), 'utf8'));
  return plan.slots.find((slot) => slot.id === id).data.items[item].at;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('resolveLeads：lead=0 保持 nominal 起點與長度', () => {
  const hit = resolveLeads({ shots: [{ id: '02', start: 2, duration: 3 }], leadSec: 0 }).get('02');
  assert.deepEqual(hit, { actualLead: 0, renderStart: 2, renderDuration: 3 });
});

test('resolveLeads：問候窗夾限', () => {
  const hit = resolveLeads({
    shots: [{ id: '02', start: 5, duration: 3 }], leadSec: 1, greetingEnd: 4.8,
  }).get('02');
  assert.deepEqual(hit, { actualLead: 0.2, renderStart: 4.8, renderDuration: 3.2 });
});

test('resolveLeads：模糊開場夾限', () => {
  const hit = resolveLeads({
    shots: [{ id: '02', start: 2, duration: 3 }], leadSec: 1, openTitleEnd: 1.7,
  }).get('02');
  assert.deepEqual(hit, { actualLead: 0.3, renderStart: 1.7, renderDuration: 3.3 });
});

test('resolveLeads：前一個 mg 結束夾限', () => {
  const hits = resolveLeads({
    shots: [
      { id: '02', start: 1, duration: 2 },
      { id: '04', start: 3.2, duration: 1 },
    ],
    leadSec: 0.5,
  });
  assert.deepEqual(hits.get('04'), { actualLead: 0.2, renderStart: 3, renderDuration: 1.2 });
});

test('resolveLeads：room=0 不提前', () => {
  const hits = resolveLeads({
    shots: [
      { id: '02', start: 1, duration: 2 },
      { id: '04', start: 3, duration: 1 },
    ],
    leadSec: 0.5,
  });
  assert.deepEqual(hits.get('04'), { actualLead: 0, renderStart: 3, renderDuration: 1 });
});

test('同分句多拍：逐字時間相撞時仍照字序且至少間隔 0.8s', () => {
  const charTimes = [...'甲乙丙丁'].map((ch, index) => ({
    ch, start: index * 0.1, end: index * 0.1 + 0.08,
  }));
  const beats = resolveOrderedBeatTimes({
    charTimes,
    segment: { id: 'X', anchor: '甲乙丙丁', startSec: 0, endSec: 3 },
    anchors: ['甲', '乙'],
    minGapSec: 0.8,
  });
  assert.equal(beats[0].atSec, 0);
  assert.equal(beats[1].atSec, 0.8);
  assert.match(beats[1].timing, /最小拍距/);
});

test('P3 前導碰到前拍停留時向後夾，不擠壓 0.8s 可讀時間', () => {
  const beats = resolveBeatTransitions({
    beats: [
      { kind: 'focus', anchor: '甲', atSec: 1, endSec: 1.1, tweenSec: shotBeatTweenSec('focus') },
      { kind: 'focus2', anchor: '乙', atSec: 1.8, endSec: 1.9, tweenSec: shotBeatTweenSec('focus2') },
    ],
    windowEnterSec: 0.6,
    leadSec: 0.4,
    dwellMinSec: 0.8,
  });
  assert.equal(beats[0].transitionStartSec, 0.6);
  assert.equal(beats[0].arrivalSec, 0.9);
  assert.equal(beats[1].desiredTransitionStartSec, 1.4);
  assert.equal(beats[1].transitionStartSec, 1.7);
  assert.equal(Number((beats[1].transitionStartSec - beats[0].arrivalSec).toFixed(4)), 0.8);
  assert.match(beats[1].transitionTiming, /前拍到位後保留/);
});

test('P4 段界放不下末拍到位後停留＋淡出時 fail closed 並指路', () => {
  const beats = resolveBeatTransitions({
    beats: [{ kind: 'focus', anchor: '太晚', atSec: 2.5, endSec: 2.6, tweenSec: shotBeatTweenSec('focus') }],
    windowEnterSec: 2.1,
  });
  assert.throws(() => computeVisualWindow({
    segmentStartSec: 0,
    segmentEndSec: 3,
    beats,
  }), /放不下末拍.*停留.*淡出.*換錨、減拍.*plan-hints/s);
});

test('R1 超過 6s 只因涵蓋拍點切換與 P4 停留，會留下可稽核原因', () => {
  const beats = resolveBeatTransitions({
    beats: [
      { kind: 'focus', anchor: '甲', atSec: 1, endSec: 1.2, tweenSec: shotBeatTweenSec('focus') },
      { kind: 'focus2', anchor: '乙', atSec: 8, endSec: 8.2, tweenSec: shotBeatTweenSec('focus2') },
    ],
    windowEnterSec: 0.6,
  });
  const window = computeVisualWindow({
    segmentStartSec: 0,
    segmentEndSec: 10,
    beats,
    minSec: 2,
    maxSec: 6,
  });
  assert.ok(window.durationSec > 6);
  assert.match(window.overMaxReason, /涵蓋 2 個拍點切換.*到位停留/);
});

test('shot focusList 三拍端到端：N 個同頁框逐拍 tween、窗口與 gate 全部成立', (t) => {
  const dir = project(t);
  makeTinyPng(path.join(dir, 'assets', 'shot.png'));
  writeJson(path.join(dir, 'shot-plan.json'), {
    slots: {
      '02': {
        page: 'TWA00/kLine', image: 'assets/shot.png', cropTop: 0,
        // 同時留下舊欄位，確認 focusList 是取代而不是再追加兩拍。
        focus: { x: 0, y: 0, w: 1, h: 1 },
        focus2: { x: 0, y: 0, w: 1, h: 1 },
        focusList: [
          { x: 0, y: 0, w: 1, h: 1 },
          { x: 0, y: 0, w: 1, h: 1 },
          { x: 0, y: 0, w: 1, h: 1 },
        ],
        targets: [
          { target: '昨日', by: 'manual:first' },
          { target: '台股', by: 'manual:second' },
          { target: '214', by: 'manual:third' },
        ],
      },
    },
  });
  let result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'mg-plan.json'), 'utf8'));
  const slot = plan.slots.find((entry) => entry.id === '02');
  assert.deepEqual(slot.beats.map((beat) => [beat.kind, beat.focusIndex, beat.anchor]), [
    ['focus', 0, '昨日'],
    ['focus2', 1, '台股'],
    ['focus2', 2, '214'],
  ]);
  assert.deepEqual(slot.beats.map((beat) => [beat.transitionStartSec, beat.arrivalSec, beat.dwellSec]), [
    [5.52, 5.82, 0.8],
    [6.62, 7.22, 0.8],
    [8.02, 8.62, 0.8],
  ]);
  assert.deepEqual(slot.visualWindow, {
    enterSec: 5.52, exitSec: 9.72, durationSec: 4.2, fadeSec: 0.3,
  });
  assert.deepEqual(slot.claimCoverage, {
    claims: ['214'], coveredByBeat: ['214'], coveredBySkip: [],
  });
  const composition = fs.readFileSync(path.join(dir, 'compositions', '02-shot.html'), 'utf8');
  assert.equal((composition.match(/tl\.to\('#hl',\{x:/g) ?? []).length, 2);
  assert.match(composition, /tl\.to\('#hl'.*duration:0\.60.*1\.15\)/);
  assert.match(composition, /tl\.to\('#hl'.*duration:0\.60.*2\.55\)/);

  makeRendersForPlan(dir);
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /id="broll-02"[^>]*data-start="5\.52" data-duration="4\.2" data-media-start="0\.05"/);
  const gateResult = run(RUN_GATES, dir, ['--json']);
  const gateReport = JSON.parse(gateResult.stdout);
  const gate = gateReport.results.find((entry) => entry.id === 'shot.visual-window');
  assert.equal(gate.status, 'passed');
  assert.match(gate.measured, /02 4\.20s\/3拍.*主張 1\/1/);
});

test('shot 舊 focus/focus2 相容：targets 解析字時間、第二拍 tween、主片只掛視覺窗口', (t) => {
  const dir = project(t);
  const image = path.join(dir, 'assets', 'shot.png');
  makeTinyPng(image);
  writeJson(path.join(dir, 'shot-plan.json'), {
    slots: {
      '02': {
        page: 'TWA00/kLine', image: 'assets/shot.png', cropTop: 0,
        focus: { x: 0, y: 0, w: 1, h: 1 },
        focus2: { x: 0, y: 0, w: 1, h: 1 },
        targets: [
          { target: '214', by: 'script-number' },
          { target: '道瓊', by: 'script-claim' },
        ],
      },
    },
  });
  let result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'mg-plan.json'), 'utf8'));
  const slot = plan.slots.find((entry) => entry.id === '02');
  assert.equal(Object.prototype.hasOwnProperty.call(slot.data, 'focusList'), false);
  assert.deepEqual(slot.beats.map((beat) => beat.focusIndex), [0, 1]);
  assert.deepEqual(slot.beats.map((beat) => [beat.anchor, beat.atSec]), [['214', 7.12], ['道瓊', 8.52]]);
  assert.deepEqual(slot.beats.map((beat) => [beat.transitionStartSec, beat.arrivalSec, beat.dwellSec]), [
    [6.72, 7.02, 1.1],
    [8.12, 8.72, 0.94],
  ]);
  assert.deepEqual(slot.visualWindow, {
    enterSec: 6.72, exitSec: 9.96, durationSec: 3.24, fadeSec: 0.3,
  });
  const composition = fs.readFileSync(path.join(dir, 'compositions', '02-shot.html'), 'utf8');
  assert.match(composition, /#hl'.*duration:0\.30.*1\.25\)/);
  assert.match(composition, /tl\.to\('#hl'.*duration:0\.60.*2\.65\)/);

  makeRendersForPlan(dir);
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /id="broll-02"[^>]*data-start="6\.72" data-duration="3\.24" data-media-start="1\.25"/);
  assert.match(html, /#broll-02'.*opacity:0.*6\.7200/);

  let gateResult = run(RUN_GATES, dir, ['--json']);
  let gateReport = JSON.parse(gateResult.stdout);
  assert.equal(gateReport.results.find((gate) => gate.id === 'shot.visual-window').status, 'passed');

  const secondBeat = { ...slot.beats[1] };
  slot.beats[1].atSec = 7.2;
  slot.beats[1].endSec = 7.3;
  writeJson(path.join(dir, 'mg-plan.json'), plan);
  gateResult = run(RUN_GATES, dir, ['--json']);
  gateReport = JSON.parse(gateResult.stdout);
  assert.equal(gateReport.results.find((gate) => gate.id === 'shot.visual-window').status, 'failed');
  assert.match(gateReport.results.find((gate) => gate.id === 'shot.visual-window').measured, /相鄰拍點只隔/);
  slot.beats[1] = secondBeat;

  const unclampedTransition = { ...slot.beats[1] };
  slot.beats[1].transitionStartSec = slot.beats[0].arrivalSec + 0.2;
  slot.beats[1].arrivalSec = slot.beats[1].transitionStartSec + slot.beats[1].tweenSec;
  writeJson(path.join(dir, 'mg-plan.json'), plan);
  gateResult = run(RUN_GATES, dir, ['--json']);
  gateReport = JSON.parse(gateResult.stdout);
  assert.equal(gateReport.results.find((gate) => gate.id === 'shot.visual-window').status, 'failed');
  assert.match(gateReport.results.find((gate) => gate.id === 'shot.visual-window').measured, /不得擠壓前拍|切下一拍/);
  slot.beats[1] = unclampedTransition;

  const readableWindow = { ...slot.visualWindow };
  slot.visualWindow.exitSec -= 0.2;
  slot.visualWindow.durationSec = Number((slot.visualWindow.exitSec - slot.visualWindow.enterSec).toFixed(2));
  writeJson(path.join(dir, 'mg-plan.json'), plan);
  gateResult = run(RUN_GATES, dir, ['--json']);
  gateReport = JSON.parse(gateResult.stdout);
  assert.equal(gateReport.results.find((gate) => gate.id === 'shot.visual-window').status, 'failed');
  assert.match(gateReport.results.find((gate) => gate.id === 'shot.visual-window').measured, /末拍到位後只停留/);
  slot.visualWindow = readableWindow;

  slot.beats[1].anchor = '不在句內';
  writeJson(path.join(dir, 'mg-plan.json'), plan);
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /拍點文字錨「不在句內」不在該格句子內/);

  slot.beats[1].anchor = '道瓊';
  slot.visualWindow.enterSec = 5;
  slot.visualWindow.durationSec = Number((slot.visualWindow.exitSec - 5).toFixed(2));
  writeJson(path.join(dir, 'mg-plan.json'), plan);
  gateResult = run(RUN_GATES, dir, ['--json']);
  gateReport = JSON.parse(gateResult.stdout);
  assert.equal(gateReport.results.find((gate) => gate.id === 'shot.visual-window').status, 'failed');
  assert.match(gateReport.results.find((gate) => gate.id === 'shot.visual-window').measured, /超出段界/);
});

test('shot 數字主張不得靜默丟拍；skippedClaims 可放行，移除後 gate 變紅', (t) => {
  const dir = project(t);
  makeTinyPng(path.join(dir, 'assets', 'shot.png'));
  const shot = {
    page: 'TWA00/kLine', image: 'assets/shot.png', cropTop: 0,
    focus: { x: 0, y: 0, w: 1, h: 1 },
    targets: [
      { target: '214', by: 'script-number' },
      { target: '703', by: null },
    ],
  };
  writeJson(path.join(dir, 'shot-plan.json'), { slots: { '02': shot } });
  let result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /703.*這是主張靜默丟拍.*寫 skip 原因或補拍/s);

  shot.skippedClaims = [{ target: '703', reason: '這張 K 線頁沒有第二個可框欄位' }];
  writeJson(path.join(dir, 'shot-plan.json'), { slots: { '02': shot } });
  result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'mg-plan.json'), 'utf8'));
  const slot = plan.slots.find((entry) => entry.id === '02');
  assert.deepEqual(slot.claimCoverage, {
    claims: ['214', '703'], coveredByBeat: ['214'], coveredBySkip: ['703'],
  });
  let gateResult = run(RUN_GATES, dir, ['--json']);
  let gateReport = JSON.parse(gateResult.stdout);
  assert.equal(gateReport.results.find((gate) => gate.id === 'shot.visual-window').status, 'passed');

  delete slot.data.skippedClaims;
  writeJson(path.join(dir, 'mg-plan.json'), plan);
  gateResult = run(RUN_GATES, dir, ['--json']);
  gateReport = JSON.parse(gateResult.stdout);
  const gate = gateReport.results.find((entry) => entry.id === 'shot.visual-window');
  assert.equal(gate.status, 'failed');
  assert.match(gate.measured, /703.*主張靜默丟拍.*寫 skip 原因或補拍/s);
});

test('shot second 提前跨頁，second.focus2 完全到位後仍保留 P4 停留', (t) => {
  const dir = project(t);
  makeTinyPng(path.join(dir, 'assets', 'first.png'));
  makeTinyPng(path.join(dir, 'assets', 'second.png'));
  writeJson(path.join(dir, 'shot-plan.json'), {
    slots: {
      '02': {
        page: 'first', image: 'assets/first.png', cropTop: 0,
        focus: { x: 0, y: 0, w: 1, h: 1 },
        targets: [
          { target: '214', by: 'manual:first' },
          { target: '點美股', by: 'manual:second' },
        ],
        second: {
          page: 'second', image: 'assets/second.png', cropTop: 0,
          focus: { x: 0, y: 0, w: 1, h: 1 },
          focus2: { x: 0, y: 0, w: 1, h: 1 },
        },
      },
    },
  });
  const result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'mg-plan.json'), 'utf8'));
  const slot = plan.slots.find((entry) => entry.id === '02');
  const secondBeat = slot.beats.find((beat) => beat.kind === 'second');
  assert.deepEqual(
    [secondBeat.transitionStartSec, secondBeat.tweenSec, secondBeat.arrivalSec, secondBeat.dwellSec],
    [7.82, 1.6, 9.42, 0.8],
  );
  const composition = fs.readFileSync(path.join(dir, 'compositions', '02-shot.html'), 'utf8');
  assert.match(composition, /tl\.to\('#shot',\{autoAlpha:0,duration:0\.30[^\n]+2\.35\)/);
  assert.match(composition, /tl\.to\('#shot2',\{autoAlpha:1,duration:0\.30[^\n]+2\.35\)/);
  assert.match(composition, /tl\.to\('#hl2'.*duration:0\.50[^\n]+3\.45\)/);

  const gateResult = run(RUN_GATES, dir, ['--json']);
  const gateReport = JSON.parse(gateResult.stdout);
  assert.equal(gateReport.results.find((gate) => gate.id === 'shot.visual-window').status, 'passed');
});

test('shot target 不在該格句子時 fail closed 並指向重截／改 responsibility', (t) => {
  const dir = project(t);
  makeTinyPng(path.join(dir, 'assets', 'shot.png'));
  writeJson(path.join(dir, 'shot-plan.json'), {
    slots: {
      '02': {
        page: 'TWA00/kLine', image: 'assets/shot.png', cropTop: 0,
        focus: { x: 0, y: 0, w: 1, h: 1 },
        targets: [{ target: '不存在', by: 'manual' }],
      },
    },
  });
  const result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不在該格句子/);
  assert.match(result.stderr, /responsibility.*plan-hints/s);
});

test('resolveCard：atText 落在下一段會拒絕', (t) => {
  const dir = project(t);
  writeJson(path.join(dir, 'mg-overrides.json'), cardOverride('只剩題材'));
  const result = run(PLAN_MG, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /命中 0 次|nominal 素材格/);
});

test('resolveCard：同段 atText 命中兩次會拒絕並列秒數', (t) => {
  const dir = project(t);
  writeJson(path.join(dir, 'mg-overrides.json'), cardOverride('有沒有'));
  const result = run(PLAN_MG, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /命中 2 次/);
  assert.match(result.stderr, /42\.28.*44\.6/);
});

test('resolveCard 正常換算 at，override 優先於 shot 且進 provenance', (t) => {
  const dir = project(t);
  writeJson(path.join(dir, 'mg-overrides.json'), cardOverride('今天先看'));
  writeJson(path.join(dir, 'shot-plan.json'), {
    slots: { '08': { page: 'fake', image: 'assets/fake.png' } },
  });
  const result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'mg-plan.json'), 'utf8'));
  assert.equal(plan.slots.find((slot) => slot.id === '08').template, 'card');
  assert.equal(at(dir, '08'), 0.43);
  const composition = fs.readFileSync(path.join(dir, 'compositions', '08-card.html'), 'utf8');
  assert.doesNotMatch(composition, /autoAlpha:\.45/);
  assert.match(composition, /#k-r1'.*autoAlpha:1.*0\.43/);
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'mg-plan.json.provenance.json'), 'utf8'));
  assert.ok(sidecar.inputs.some((input) => input.path === 'mg-overrides.json'));
});

test('emphasis list 同字幕內仍依逐字時間逐項進場，已講項降灰', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'emphasis.json'), [{
    type: 'list',
    title: '逐項進場',
    items: [
      { text: '第一', match: '只剩題材' },
      { text: '第二', match: '量能跟不上' },
    ],
    untilMatch: '就先不要追價',
  }]);
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /#emphasis-list-1-item-1'.*45\.8000/);
  assert.match(html, /#emphasis-list-1-item-2'.*46\.3800/);
  assert.match(html, /#emphasis-list-1-item-1'.*opacity:0\.5.*46\.3800/);
});

test('emphasis list item 時間反向會拒絕', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'emphasis.json'), [{
    type: 'list',
    title: '反向',
    items: [
      { text: '晚', match: '鼎元的量能有沒有延續' },
      { text: '早', match: '所以今天先看兩件事' },
    ],
    untilMatch: '只剩題材',
  }]);
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /item 順序反了/);
});

test('emphasis 退場超過 durationSec 會拒絕', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'emphasis.json'), [{
    type: 'pop', text: '太晚', match: '就先不要追價', holdSec: 2,
  }]);
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /退場時間.*超過 durationSec/);
});

test('titleBoard:null 與省略產出相同 index.html', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'main.config.json'), {});
  let result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const omitted = fs.readFileSync(path.join(dir, 'index.html'));
  writeJson(path.join(dir, 'main.config.json'), { titleBoard: null });
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'index.html')), omitted);
});

test('build-main 遇到 render 短於 renderDuration 會拒絕', (t) => {
  const { dir } = prepareBuildProject(t);
  makeVideo(path.join(dir, 'renders', '02.mp4'), 1);
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /短於需要的.*render.*slots/s);
});

test('lead 端到端：plan 寫入逐格加長，build-main 拒絕被竄改的 actualLead', (t) => {
  const dir = project(t);
  writeJson(path.join(dir, 'main.config.json'), { lead: 0.4 });
  let result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 0, result.stderr);
  const planFile = path.join(dir, 'mg-plan.json');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  for (const slot of plan.slots) {
    assert.ok(Math.abs(slot.durationSec - (slot.nominalSec + slot.actualLead)) < 1e-9);
  }
  makeRendersForPlan(dir);
  plan.slots[0].actualLead = Number((plan.slots[0].actualLead + 0.2).toFixed(2));
  writeJson(planFile, plan);
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /前導與 build-main 不同/);
});

test('mg-overrides 改動後 build-main 與 render slots 都拒絕過期 mg-plan', (t) => {
  const dir = project(t);
  writeJson(path.join(dir, 'mg-overrides.json'), cardOverride('今天先看'));
  let result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 0, result.stderr);
  makeRendersForPlan(dir);
  const overridesFile = path.join(dir, 'mg-overrides.json');
  const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
  overrides['08'].data.title = '已改文案';
  writeJson(overridesFile, overrides);

  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mg-plan\.json 已過期/);
  writeJson(path.join(dir, 'hyperframes.json'), {});
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'gsap.min.js'), '/* test stub */\n');
  result = run(RENDER, dir, ['slots']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mg-plan\.json 已過期/);
});

test('emphasis list 順序正確但 item 晚於 untilMatch 仍拒絕', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'emphasis.json'), [{
    type: 'list',
    title: '越界',
    items: [
      { text: '先', match: '所以今天先看兩件事' },
      { text: '後', match: '只剩題材' },
    ],
    untilMatch: '鼎元的量能有沒有延續',
  }]);
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /必須早於 untilMatch/);
});

test('emphasis list 收合時間超過片長會拒絕', (t) => {
  const { dir } = prepareBuildProject(t);
  const layoutFile = path.join(dir, 'template', 'layout.json');
  const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
  layout.emphasis.list.outSec = 2;
  writeJson(layoutFile, layout);
  writeJson(path.join(dir, 'emphasis.json'), [{
    type: 'list',
    title: '太晚收合',
    items: [
      { text: '第一', match: '所以今天先看兩件事' },
      { text: '第二', match: '鼎元的量能有沒有延續' },
    ],
    untilMatch: '就先不要追價',
  }]);
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /退場時間.*超過 durationSec/);
});

test('字幕 duration 與 end−start 差 0.01s 會拒絕', (t) => {
  const { dir } = prepareBuildProject(t);
  const file = path.join(dir, 'caption-ledger.json');
  const captions = JSON.parse(fs.readFileSync(file, 'utf8'));
  captions[0].duration = Number((captions[0].duration + 0.01).toFixed(4));
  writeJson(file, captions);
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /差距必須 <=0\.002s/);
});

test('lead 未開時不讀壞掉的 charTimes', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'main.config.json'), { lead: 0 });
  fs.writeFileSync(path.join(dir, 'asr', 'script-char-times.json'), '{壞 JSON');
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
});

test('openTitle:true 保留舊行為且 index.html 位元不變', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'main.config.json'), { openTitle: true });
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  // 439c8e3 把畫布由 30fps conform 成主播原生 25fps；index 只差 data-fps，舊 hash 已失效。
  assert.equal(sha256(path.join(dir, 'index.html')),
    'd62c1a882cb6d807cb198afa94d28e14f97ea89501feb033a686dca88d1ce8dc');
});

test('openTitle 物件模式自動折行，陣列可明寫斷行', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'main.config.json'), {
    openTitle: { main: '光環漲停創新高！', sub: '大盤跌461點，今天還能追嗎？' },
  });
  let result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /id="open-title-main-line-1"[^>]*>光環漲停<\/div>/);
  assert.match(html, /id="open-title-main-line-2"[^>]*>創新高！<\/div>/);
  assert.match(html, /id="open-title-sub"[^>]*>大盤跌461點，今天還能追嗎？<\/div>/);
  assert.doesNotMatch(html, /id="open-title-kicker"/);

  writeJson(path.join(dir, 'main.config.json'), {
    openTitle: { main: ['明寫第一行', '明寫第二行'] },
  });
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /id="open-title-main-line-1"[^>]*>明寫第一行<\/div>/);
  assert.match(html, /id="open-title-main-line-2"[^>]*>明寫第二行<\/div>/);
});

test('openTitle 物件模式拒絕三行與缺少 main', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'main.config.json'), {
    openTitle: { main: ['第一行', '第二行', '第三行'] },
  });
  let result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /只能明寫 1～2 行/);

  writeJson(path.join(dir, 'main.config.json'), { openTitle: { sub: '沒有主標' } });
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /openTitle\.main 是空的/);
});

test('openTitle preRoll 平移正文、延長片長並產生第一幀海報', (t) => {
  const { dir, ledger } = prepareBuildProject(t);
  makeVideo(path.join(dir, 'avatar', 'speeded.mp4'), 1);
  writeJson(path.join(dir, 'main.config.json'), {
    openTitle: { main: '靜默開場', sub: '副標', preRollSec: 2.5 },
  });
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const captions = JSON.parse(fs.readFileSync(path.join(dir, 'caption-ledger.json'), 'utf8'));
  for (const caption of captions) {
    const start = Number((caption.start + 2.5).toFixed(4));
    assert.match(html, new RegExp(`id="caption-${caption.id}"[^>]*data-start="${start}"`));
  }
  assert.match(html, /id="avatar"[^>]*data-start="2\.5"/);
  assert.match(html, /id="avatar-poster"[^>]*data-start="0" data-duration="2\.5"/);
  assert.match(html, /tl\.set\('#avatar'.*3\.0000\)/);
  assert.match(html, new RegExp(`id="root"[^>]*data-duration="${ledger.durationSec + 2.5}"`));
  assert.ok(fs.statSync(path.join(dir, 'assets', 'avatar-poster.jpg')).size > 0);
  const summary = JSON.parse(result.stdout.trim());
  assert.equal(summary.openTitle, 3);
  assert.equal(summary.durationSec, ledger.durationSec + 2.5);
});

test('強調字退場命中前導窗時，淡出在 renderStart 結束', (t) => {
  const dir = project(t);
  fs.copyFileSync(REPO_LAYOUT, path.join(dir, 'template', 'layout.json'));
  writeJson(path.join(dir, 'main.config.json'), { lead: 0.4 });
  let result = run(PLAN_MG, dir, ['--write']);
  assert.equal(result.status, 0, result.stderr);
  const slots = makeRendersForPlan(dir);
  const slot = slots.find((item) => item.id === '04');
  assert.equal(slot.actualLead, 0.4);
  writeJson(path.join(dir, 'emphasis.json'), [{
    type: 'list',
    title: '先收合',
    items: [{ text: '市場選擇', match: '大盤沒有特別強' }],
    untilMatch: 'AI資料中心與CPO需求升溫',
  }]);
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const renderStart = 16.98 - slot.actualLead;
  const fadeAt = renderStart - 0.2;
  assert.match(html, new RegExp(`tl\\.to\\('#emphasis-list-1'.*${fadeAt.toFixed(4).replace('.', '\\.')}`));
});

test('強調字顯示區間壓到素材格超過容許前導會拒絕', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'emphasis.json'), [{
    type: 'list',
    title: '壓住素材',
    items: [{ text: '素材內出現', match: 'AI資料中心與CPO需求升溫' }],
    untilMatch: '基本面也接得上',
  }]);
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /壓住素材.*素材格 04.*重疊/s);
});

test('openTitle.style 省略與 plain 維持現況且逐位元相同', (t) => {
  const { dir } = prepareBuildProject(t);
  const openTitle = { main: '光環漲停創新高！', sub: '大盤跌461點，今天還能追嗎？' };
  writeJson(path.join(dir, 'main.config.json'), { openTitle });
  let result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const omitted = fs.readFileSync(path.join(dir, 'index.html'));
  // 同上：25fps conform 已在本任務開始前落地，更新 stale golden hash，不改 plain 等價斷言。
  assert.equal(sha256(path.join(dir, 'index.html')),
    'b51f47b6cb2ef41b6a32d2d248ed3d97d8262616abf01b87d9976139e2d0ae07');
  writeJson(path.join(dir, 'main.config.json'), { openTitle: { ...openTitle, style: 'plain' } });
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'index.html')), omitted);
});

test('openTitle.style=cover 使用金橘描邊，進場 tween 只動 opacity／scale', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'main.config.json'), {
    openTitle: { main: '封面主標', sub: '深色副標', style: 'cover' },
  });
  const result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /-webkit-text-stroke:10px #5A2E00/);
  assert.match(html, /-webkit-background-clip:text;background-clip:text/);
  assert.match(html, /background:rgba\(43,21,0,\.82\)/);
  const entryTweens = html.match(/tl\.(?:set|to)\('#open-title-(?:main|sub)'[^\n]+/g) ?? [];
  assert.equal(entryTweens.length, 4);
  for (const tween of entryTweens) {
    assert.doesNotMatch(tween, /(?:^|[,;{])(?:x|y|transform):/);
    assert.match(tween, /opacity|scale/);
  }
});

test('titleBoard gold 物件模式只追加 accent 樣式，未知 accent 拒絕', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'main.config.json'), { titleBoard: 'hook' });
  let result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const plain = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

  writeJson(path.join(dir, 'main.config.json'), {
    titleBoard: { mode: 'hook', accent: 'gold' },
  });
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  const accented = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const normalized = accented.replace(
    'border:2px solid #FF9A1F;border-left:8px solid #FFC83D',
    'border:2px solid #1E4E9C',
  );
  assert.equal(normalized, plain);

  writeJson(path.join(dir, 'main.config.json'), {
    titleBoard: { mode: 'hook', accent: 'neon' },
  });
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /titleBoard\.accent.*只接受 "gold"/);
});

test('brandFrame warm 使用 amber，true 維持舊藍，未知字串拒絕', (t) => {
  const { dir } = prepareBuildProject(t);
  writeJson(path.join(dir, 'main.config.json'), { brandFrame: true });
  let result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /#brandframe-bottom[^}]+rgba\(9,39,90,0\.75\)/);

  writeJson(path.join(dir, 'main.config.json'), { brandFrame: 'warm' });
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 0, result.stderr);
  html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /#brandframe-bottom[^}]+rgba\(255,154,31,0\.75\)/);

  writeJson(path.join(dir, 'main.config.json'), { brandFrame: 'purple' });
  result = run(BUILD_MAIN, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /brandFrame 只能是 boolean 或 "warm"/);
});
