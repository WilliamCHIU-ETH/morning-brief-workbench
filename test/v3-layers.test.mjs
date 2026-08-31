import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLeads } from '../stages/lib/lead.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'project-v4c');
const PLAN_MG = path.join(ROOT, 'stages', 'plan-mg.mjs');
const BUILD_MAIN = path.join(ROOT, 'stages', 'build-main.mjs');
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
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'mg-plan.json.provenance.json'), 'utf8'));
  assert.ok(sidecar.inputs.some((input) => input.path === 'mg-overrides.json'));
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
  assert.equal(sha256(path.join(dir, 'index.html')),
    '5a862e0ade7169ecbe7df42688c418d4f8cf90a42bb82f11c6f71efe8775d689');
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
  assert.equal(sha256(path.join(dir, 'index.html')),
    '5b43fa2069f33660e9e01b8a3ebaefddf3e8482986574a48b0670befa5957587');
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
