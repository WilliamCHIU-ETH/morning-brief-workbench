import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  applyPauses,
  buildVoicePlan,
  convertNumeralsToChinese,
  runVoiceMinimax,
  VOICE_JSON_EXAMPLE,
} from '../stages/voice-minimax.mjs';
import { checkAudioCleanMatchesScript } from '../stages/lib/heygen-audio.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const VOICE = path.join(ROOT, 'stages', 'voice-minimax.mjs');
const HEYGEN = path.join(ROOT, 'stages', 'heygen.mjs');
const SPEEDUP = path.join(ROOT, 'stages', 'speedup.mjs');
const GATES = path.join(ROOT, 'stages', 'run-gates.mjs');

function tempDir(prefix = 'voice-route-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function scriptOf(paragraphs) {
  return `===\n08/25 台股晨報\n測試音檔路線\n===\n${paragraphs.join('\n\n')}\n`;
}

function config(overrides = {}) {
  const value = structuredClone(VOICE_JSON_EXAMPLE);
  value.rewrites = [];
  value.pauses = [];
  return { ...value, ...overrides };
}

function makeProject({ paragraphs, voice = config() }) {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'script.txt'), scriptOf(paragraphs));
  fs.writeFileSync(path.join(dir, 'voice.json'), `${JSON.stringify(voice, null, 2)}\n`);
  return dir;
}

function networkThrowEnv(dir) {
  const stub = path.join(dir, 'fetch-throws.mjs');
  fs.writeFileSync(stub, "globalThis.fetch = () => { throw new Error('NETWORK_CALLED'); };\n");
  const existing = process.env.NODE_OPTIONS?.trim();
  return {
    ...process.env,
    NODE_OPTIONS: [existing, `--import=${pathToFileURL(stub).href}`].filter(Boolean).join(' '),
  };
}

function makeAudio(file, durationSec = 0.2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono',
    '-t', String(durationSec), '-b:a', '128k', file,
  ]);
  return file;
}

function makeVideo(file, durationSec = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=160x284:r=25:d=${durationSec}`,
    '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono',
    '-t', String(durationSec), '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ]);
  return file;
}

function addTrack(dir, paragraphs) {
  const voiceDir = path.join(dir, 'voice');
  fs.mkdirSync(voiceDir, { recursive: true });
  const track = makeAudio(path.join(voiceDir, 'track.mp3'));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(track)).digest('hex');
  const metadata = {
    segments: paragraphs.map((cleanOriginal, index) => ({
      index: index + 1,
      cleanOriginal,
      text: cleanOriginal,
      speed: 1,
      audio_length: 100,
      usage_characters: cleanOriginal.length,
    })),
    track: { path: 'voice/track.mp3', sha256, durationSec: 0.2 },
    sha256,
  };
  fs.writeFileSync(path.join(voiceDir, 'track.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return { track, sha256 };
}

function run(script, args, options = {}) {
  return spawnSync('node', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });
}

test('voice speeds 依 hook/body/close 除以 acceptance speed divisor 並四捨五入', () => {
  const plan = buildVoicePlan(scriptOf(['第一段？', '第二段。', '第三段。']), config());
  assert.deepEqual(plan.segments.map(({ kind, speed }) => ({ kind, speed })), [
    { kind: 'hook', speed: 1.136 },
    { kind: 'body', speed: 1.045 },
    { kind: 'close', speed: 0.982 },
  ]);
});

test('voice speedDivisor 與契約不一致時 CLI exit 1', () => {
  const dir = makeProject({
    paragraphs: ['第一段？', '第二段。', '第三段。'],
    voice: config({ speedDivisor: 1.2 }),
  });
  const result = run(VOICE, ['--project', dir, 'dryrun']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /配音先除、speedup 再乘必須是同一倍率/);
});

test('speedDivisor 文字路線取 expected，音檔路線取 audioRouteExpected', () => {
  const script = scriptOf(['第一段？', '第二段。', '第三段。']);
  const audioPlan = buildVoicePlan(script, config({ speedDivisor: 1 }), { audioRoute: true });
  assert.deepEqual(audioPlan.segments.map((segment) => segment.speed), [1.25, 1.15, 1.08]);
  assert.throws(
    () => buildVoicePlan(script, config({ speedDivisor: 1 }), { audioRoute: false }),
    /video\.speed-factor\.expected=1\.1.*文字路線/);
  assert.throws(
    () => buildVoicePlan(script, config({ speedDivisor: 1.1 }), { audioRoute: true }),
    /video\.speed-factor\.audioRouteExpected=1.*音檔路線/);

  const dir = makeProject({
    paragraphs: ['第一段？', '第二段。', '第三段。'],
    voice: config({ speedDivisor: 1 }),
  });
  assert.equal(run(VOICE, ['--project', dir, 'dryrun']).status, 1);
  makeAudio(path.join(dir, 'voice', 'track.mp3'));
  assert.equal(run(VOICE, ['--project', dir, 'dryrun']).status, 0);
});

test('文字依 rewrites → numerals → pauses 順序處理', () => {
  const voice = config({
    rewrites: [{ from: '早安，親愛的投資人', to: '早安親愛的投資人' }],
    pauses: [
      { before: '今天還能追嗎', sec: 0.2 },
      { after: '早安親愛的投資人。', sec: 0.5 },
    ],
  });
  const plan = buildVoicePlan(scriptOf([
    '大盤收44,762點，今天還能追嗎？',
    '早安，親愛的投資人。環球晶大漲7%，七月以前寫成7月。',
    '最後一段。',
  ]), voice);
  assert.equal(plan.segments[0].text, '大盤收四萬四千七百六十二點，<#0.2#>今天還能追嗎？');
  assert.equal(
    plan.segments[1].text,
    '早安親愛的投資人。<#0.5#>環球晶大漲百分之七，七月以前寫成七月。');
  assert.equal(convertNumeralsToChinese('12,345.6元、10%、2026年'), '一萬二千三百四十五點六元、百分之十、二千零二十六年');
});

test('pause 目標找不到時拒絕', () => {
  assert.throws(
    () => applyPauses(['只有一句'], [{ before: '不存在', sec: 0.2 }]),
    /找不到.*全軌唯一/);
});

test('pause 目標命中多次時拒絕', () => {
  assert.throws(
    () => applyPauses(['重複目標', '又一個重複目標'], [{ after: '重複目標', sec: 0.2 }]),
    /命中 2 次.*全軌唯一/);
});

test('voice dryrun 使用會 throw 的 fetch stub 仍成功，未發網路請求', async () => {
  const dir = makeProject({ paragraphs: ['第一段？', '第二段。', '第三段。'] });
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(' '));
  try {
    const plan = await runVoiceMinimax(
      ['--project', dir, 'dryrun'],
      { fetchImpl: () => { throw new Error('NETWORK_CALLED'); } },
    );
    assert.equal(plan.segments.length, 3);
  } finally {
    console.log = originalLog;
  }
  assert.match(output.join('\n'), /這一步沒有發送網路請求/);
  assert.equal(fs.existsSync(path.join(dir, 'voice', 'track.mp3')), false);
});

test('voice adopt 不發網路請求，複製核准音軌並寫 metadata/sidecar', async () => {
  const paragraphs = ['第一段能追嗎？', '中間一段。', '最後不追。'];
  const dir = makeProject({ paragraphs, voice: config({ speedDivisor: 1 }) });
  const approved = makeAudio(path.join(dir, 'approved.mp3'), 0.35);
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(' '));
  let metadata;
  try {
    metadata = await runVoiceMinimax(
      ['--project', dir, 'adopt', '--track', approved],
      { fetchImpl: () => { throw new Error('NETWORK_CALLED'); } },
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(fs.readFileSync(path.join(dir, 'voice', 'track.mp3')).equals(fs.readFileSync(approved)), true);
  assert.equal(metadata.adoptedFrom, path.resolve(approved));
  assert.equal(metadata.track.bytes, fs.statSync(approved).size);
  assert.match(metadata.track.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(metadata.segments.map(({ role, speed }) => ({ role, speed })), [
    { role: 'hook', speed: 1.25 },
    { role: 'body', speed: 1.15 },
    { role: 'close', speed: 1.08 },
  ]);
  assert.match(output.join('\n'), /這一步沒有花錢/);
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, 'voice', 'track.json.provenance.json'), 'utf8'));
  assert.deepEqual(provenance.inputs.map((input) => input.path), ['script.txt', 'voice.json']);
});

test('voice adopt 量每段 parts；cleanOriginal 對稿，稿子變更後 fail-closed', async () => {
  const paragraphs = ['第一段能追嗎？', '中間一段。', '最後不追。'];
  const dir = makeProject({ paragraphs, voice: config({ speedDivisor: 1 }) });
  const approved = makeAudio(path.join(dir, 'approved.mp3'), 0.6);
  const parts = path.join(dir, 'approved-parts');
  makeAudio(path.join(parts, '01_speed1.25.mp3'), 0.11);
  makeAudio(path.join(parts, '02_speed1.15.mp3'), 0.12);
  makeAudio(path.join(parts, '03_speed1.08.mp3'), 0.13);
  fs.writeFileSync(path.join(parts, 'notes.txt'), '保留檔名');
  const originalLog = console.log;
  console.log = () => {};
  try {
    await runVoiceMinimax(
      ['--project', dir, 'adopt', '--track', approved, '--parts', parts],
      { fetchImpl: () => { throw new Error('NETWORK_CALLED'); } },
    );
  } finally {
    console.log = originalLog;
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'voice', 'track.json'), 'utf8'));
  const check = checkAudioCleanMatchesScript(fs.readFileSync(path.join(dir, 'script.txt'), 'utf8'), metadata);
  assert.equal(check.ok, true);
  assert.equal(metadata.segments.every((segment) => segment.durationSec > 0), true);
  assert.equal(fs.readFileSync(path.join(dir, 'voice', 'parts', 'notes.txt'), 'utf8'), '保留檔名');

  fs.writeFileSync(path.join(dir, 'script.txt'), scriptOf(['第一段已改？', '中間一段。', '最後不追。']));
  assert.equal(checkAudioCleanMatchesScript(
    fs.readFileSync(path.join(dir, 'script.txt'), 'utf8'), metadata).ok, false);
  const stale = run(HEYGEN, ['--project', dir, 'dryrun']);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /track\.json 已過期.*script\.txt（已變更）/s);
});

test('voice synth 用 MiniMax 假回應產出 parts、先接 WAV 再轉 track.mp3 與 sidecar', async () => {
  // synth 本身就在產出 voice/track.mp3，所以一律是音檔路線 → speedDivisor 必須是
  // contracts 的 audioRouteExpected（1），不是文字路線的 expected（1.1）。
  // 2026-08-31 之前這裡用預設的 1.1，斷言的是被 1.1 除過的 [1.136, 1.045, 0.982]，
  // 那是 audioRoute 靠 fs.existsSync(track.mp3) 判斷所造成的誤判：第一次 synth 音檔還
  // 不存在就被當成文字路線，配音因此慢 1.1 倍（實測整軌 76.8s，改正後 58.6s）。
  // 決定性理由：speedup.mjs 用同樣方式判路線，而它執行時 track.mp3 一定存在，永遠取
  // factor 1.0——配音除 1.1、加速乘 1.0，那個 1.1 沒有任何階段補得回來。
  const dir = makeProject({ paragraphs: ['第一段？', '第二段。', '第三段。'], voice: config({ speedDivisor: 1 }) });
  const sample = path.join(dir, 'sample.mp3');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono',
    '-t', '0.08', '-b:a', '128k', sample,
  ]);
  const audio = fs.readFileSync(sample).toString('hex');
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: { audio },
        extra_info: { audio_length: 80, usage_characters: 12 },
      }),
    };
  };
  const originalKey = process.env.MINIMAX_API_KEY;
  const originalLog = console.log;
  process.env.MINIMAX_API_KEY = 'unit-test-placeholder';
  console.log = () => {};
  try {
    await runVoiceMinimax(['--project', dir, 'synth'], { fetchImpl: fakeFetch });
  } finally {
    console.log = originalLog;
    if (originalKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = originalKey;
  }
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.body.voice_setting.speed), [1.25, 1.15, 1.08]);
  assert.equal(requests.every((request) => request.url === 'https://api.minimax.io/v1/t2a_v2'), true);
  assert.equal(fs.existsSync(path.join(dir, 'voice', 'parts', '01_speed1.25.mp3')), true);
  assert.equal(fs.existsSync(path.join(dir, 'voice', 'track.mp3')), true);
  assert.equal(fs.existsSync(path.join(dir, 'voice', '.track.tmp.wav')), false);
  const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'voice', 'track.json'), 'utf8'));
  assert.equal(metadata.segments.length, 3);
  assert.equal(metadata.totals.audio_length, 240);
  assert.equal(metadata.totals.usage_characters, 36);
  assert.match(metadata.track.sha256, /^[0-9a-f]{64}$/);
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, 'voice', 'track.json.provenance.json'), 'utf8'));
  assert.deepEqual(provenance.inputs.map((input) => input.path), ['script.txt', 'voice.json']);
});

test('heygen audio dryrun 不發網路，payload 僅用 audio_asset_id 並記 audioTrack', () => {
  const paragraphs = ['第一段能追嗎？', '中間一段。', '最後不追。'];
  const dir = makeProject({ paragraphs });
  const { sha256 } = addTrack(dir, paragraphs);
  const result = run(HEYGEN, ['--project', dir, 'dryrun'], { env: networkThrowEnv(dir) });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /NETWORK_CALLED/);
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'heygen-request.json'), 'utf8'));
  assert.equal(Object.hasOwn(request, 'script'), false);
  assert.equal(Object.hasOwn(request, 'voice_id'), false);
  assert.equal(Object.hasOwn(request, 'voice_settings'), false);
  assert.equal(request.audio_asset_id, '<待上傳>');
  assert.deepEqual(request.audioTrack.path, 'voice/track.mp3');
  assert.equal(request.audioTrack.sha256, sha256);
  assert.match(result.stdout, new RegExp(`音檔 SHA-256：${sha256.slice(0, 12)}`));
  assert.match(result.stdout, /合成輸入：第一段能追嗎？…最後不追。/);
});

test('HeyGen 音檔 payload 通過契約後，付費前 gates 仍在網路請求前擋住', () => {
  const paragraphs = ['第一段能追嗎？', '中間一段。', '最後不追。'];
  const dir = makeProject({ paragraphs });
  addTrack(dir, paragraphs);
  const env = networkThrowEnv(dir);
  const dryrun = run(HEYGEN, ['--project', dir, 'dryrun'], { env });
  assert.equal(dryrun.status, 0, dryrun.stderr);
  const create = run(HEYGEN, ['--project', dir, 'create', '--i-have-user-approval'], { env });
  assert.equal(create.status, 4);
  assert.match(create.stderr, /付費前的 gate 沒有全部通過/);
  assert.doesNotMatch(create.stderr, /NETWORK_CALLED/);
});

test('HeyGen 音檔上傳假回應失敗時，不送出 videos 生成請求', () => {
  const paragraphs = ['第一段能追嗎？', '中間一段。', '最後不追。'];
  const dir = makeProject({ paragraphs });
  addTrack(dir, paragraphs);
  const dryrun = run(HEYGEN, ['--project', dir, 'dryrun']);
  assert.equal(dryrun.status, 0, dryrun.stderr);

  const sandbox = tempDir('heygen-audio-fake-');
  const files = [
    'stages/heygen.mjs',
    'stages/script-utils.js',
    'stages/lib/project.mjs',
    'stages/lib/env.mjs',
    'stages/lib/heygen-audio.mjs',
    'contracts/acceptance.json',
    'contracts/avatar-generation.json',
  ];
  for (const file of files) {
    const target = path.join(sandbox, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), target);
  }
  const contractFile = path.join(sandbox, 'contracts', 'avatar-generation.json');
  const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
  contract.audioRoute = {};
  fs.writeFileSync(contractFile, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(path.join(sandbox, 'stages', 'run-gates.mjs'), '#!/usr/bin/env node\nprocess.exit(0);\n');

  const callsFile = path.join(sandbox, 'calls.txt');
  const fetchStub = path.join(sandbox, 'fetch-stub.mjs');
  fs.writeFileSync(fetchStub, [
    "import fs from 'node:fs';",
    `const callsFile = ${JSON.stringify(callsFile)};`,
    'globalThis.fetch = async (url) => {',
    "  fs.appendFileSync(callsFile, `${url}\\n`);",
    "  return { ok: false, status: 503, json: async () => ({ error: 'fake upload failure' }) };",
    '};',
    '',
  ].join('\n'));
  const result = run(
    path.join(sandbox, 'stages', 'heygen.mjs'),
    ['--project', dir, 'create', '--i-have-user-approval'],
    {
      env: {
        ...process.env,
        HEYGEN_API_KEY: 'unit-test-placeholder',
        NODE_OPTIONS: `--import=${pathToFileURL(fetchStub).href}`,
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /音檔上傳失敗/);
  assert.deepEqual(fs.readFileSync(callsFile, 'utf8').trim().split('\n'), [
    'https://api.heygen.com/v3/assets',
  ]);
});

test('speedup 音檔路線逐位元複製，speed-factor gate 兩條路線各取正確期望值', () => {
  const paragraphs = ['第一段能追嗎？', '中間一段。', '最後不追。'];

  const audioDir = makeProject({ paragraphs, voice: config({ speedDivisor: 1 }) });
  makeVideo(path.join(audioDir, 'avatar', 'raw.mp4'), 1);
  makeAudio(path.join(audioDir, 'voice', 'track.mp3'));
  const audioSpeedup = run(SPEEDUP, ['--project', audioDir]);
  assert.equal(audioSpeedup.status, 0, audioSpeedup.stderr);
  assert.match(audioSpeedup.stdout, /音檔路線：語速在合成端決定，這一步只複製不拉伸/);
  assert.deepEqual(
    fs.readFileSync(path.join(audioDir, 'avatar', 'speeded.mp4')),
    fs.readFileSync(path.join(audioDir, 'avatar', 'raw.mp4')),
  );
  run(GATES, ['--project', audioDir, '--json']);
  const audioGate = JSON.parse(fs.readFileSync(path.join(audioDir, 'gate-report.json'), 'utf8'))
    .results.find((result) => result.id === 'video.speed-factor');
  assert.equal(audioGate.status, 'passed');
  assert.match(audioGate.measured, /^音檔路線：1\.000（設定 1 /);

  const textDir = makeProject({ paragraphs });
  makeVideo(path.join(textDir, 'avatar', 'raw.mp4'), 3);
  const textSpeedup = run(SPEEDUP, ['--project', textDir]);
  assert.equal(textSpeedup.status, 0, textSpeedup.stderr);
  assert.match(textSpeedup.stdout, /倍率 1\.1/);
  assert.doesNotMatch(textSpeedup.stdout, /音檔路線/);
  run(GATES, ['--project', textDir, '--json']);
  const textGate = JSON.parse(fs.readFileSync(path.join(textDir, 'gate-report.json'), 'utf8'))
    .results.find((result) => result.id === 'video.speed-factor');
  assert.equal(textGate.status, 'passed');
  assert.match(textGate.measured, /^文字路線：1\.\d{3}（設定 1\.1 /);
});

test('沒有 voice/ 的 fixture，heygen dryrun stdout 與 request 逐位元等於 HEAD', () => {
  const sandbox = tempDir('heygen-head-');
  const project = path.join(sandbox, 'project');
  fs.cpSync(path.join(ROOT, 'fixtures', 'project-v4c'), project, { recursive: true });

  const headRoot = path.join(sandbox, 'head');
  const files = [
    'stages/heygen.mjs',
    'stages/script-utils.js',
    'stages/lib/project.mjs',
    'stages/lib/env.mjs',
    'stages/lib/heygen-audio.mjs',
    'contracts/acceptance.json',
    'contracts/avatar-generation.json',
  ];
  for (const file of files) {
    const target = path.join(headRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const contents = execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT });
    fs.writeFileSync(target, contents);
  }

  const args = ['--project', project, 'dryrun'];
  const head = run(path.join(headRoot, 'stages', 'heygen.mjs'), args);
  assert.equal(head.status, 0, head.stderr);
  const headRequest = fs.readFileSync(path.join(project, 'heygen-request.json'));
  const current = run(HEYGEN, args);
  assert.equal(current.status, 0, current.stderr);
  const currentRequest = fs.readFileSync(path.join(project, 'heygen-request.json'));
  assert.equal(current.stdout, head.stdout);
  assert.deepEqual(currentRequest, headRequest);
});
