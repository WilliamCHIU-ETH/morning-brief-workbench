#!/usr/bin/env node
/**
 * MiniMax 分段配音。
 *
 *   node stages/voice-minimax.mjs --project <dir> dryrun
 *   node stages/voice-minimax.mjs --project <dir> synth
 *   node stages/voice-minimax.mjs --project <dir> adopt --track <file.mp3> [--parts <dir>]
 *
 * dryrun 只整理送出的逐段文字、語速與估計計費字數；synth 才會呼叫 API；
 * adopt 採用使用者已核准的既有音軌，不發網路請求。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveProject, sha256File, writeJson } from './lib/project.mjs';
import { requireEnv } from './lib/env.mjs';
import { checkAudioCleanMatchesScript } from './lib/heygen-audio.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { BREAK_RE, getBodyAfterVoice, cleanBodyWithIndex } = require(path.join(here, 'script-utils.js'));
const acceptance = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/acceptance.json'), 'utf8'));

export const MINIMAX_ENDPOINT = 'https://api.minimax.io/v1/t2a_v2';
export const VOICE_JSON_EXAMPLE = {
  provider: 'minimax',
  model: 'speech-2.8-hd',
  voiceId: 'moss_audio_3a75102e-54db-11f1-981b-8a143315d498',
  speeds: { hook: 1.25, body: 1.15, close: 1.08 },
  speedDivisor: 1.1,
  gapSec: 0.45,
  pauses: [
    { before: '今天還能追嗎', sec: 0.2 },
    { after: '早安親愛的投資人。', sec: 0.5 },
    { before: '沒量先不追', sec: 0.5 },
  ],
  rewrites: [{ from: '早安，親愛的投資人', to: '早安親愛的投資人' }],
  numerals: 'chinese',
  pronunciation: ['跌/(die2)'],
};

export class VoiceRouteError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const cleanChars = (text) => cleanBodyWithIndex(String(text)).map((c) => c.char).join('');

/**
 * 以既有 cleanBodyWithIndex 決定哪些字屬於正文，再把原本的全形標點補回 TTS 文字。
 * 這樣不會另造一套 marker／註解清理規則，卻仍保留問句與停頓所需的標點。
 */
export function cleanParagraphForSpeech(paragraph) {
  const chars = cleanBodyWithIndex(paragraph);
  if (!chars.length) return '';
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const current = chars[i];
    out += current.char;
    if (!current.breakAfter) continue;
    const end = chars[i + 1]?.origIdx ?? paragraph.length;
    const between = paragraph.slice(current.origIdx + 1, end);
    const punctuation = [...between].find((ch) => ch !== '\n' && BREAK_RE.test(ch));
    if (punctuation) out += punctuation;
  }
  return out;
}

export function extractCleanParagraphs(scriptRaw) {
  const body = getBodyAfterVoice(scriptRaw);
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => cleanParagraphForSpeech(paragraph))
    .filter((paragraph) => cleanChars(paragraph).length > 0);
}

const DIGITS = '零一二三四五六七八九';
const SMALL_UNITS = ['', '十', '百', '千'];
const BIG_UNITS = ['', '萬', '億', '兆', '京'];

function fourDigitsToChinese(value) {
  const digits = String(value).padStart(4, '0').split('').map(Number);
  let out = '';
  let pendingZero = false;
  for (let i = 0; i < digits.length; i++) {
    const digit = digits[i];
    const position = 3 - i;
    if (digit === 0) {
      if (out && digits.slice(i + 1).some((n) => n !== 0)) pendingZero = true;
      continue;
    }
    if (pendingZero) { out += '零'; pendingZero = false; }
    out += `${DIGITS[digit]}${SMALL_UNITS[position]}`;
  }
  return out;
}

export function integerToChinese(input) {
  let digits = String(input).replace(/,/g, '').replace(/^\+/, '');
  const negative = digits.startsWith('-');
  if (negative) digits = digits.slice(1);
  digits = digits.replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(digits)) throw new VoiceRouteError(`不是可轉換的整數：${input}`);
  if (/^0+$/.test(digits)) return '零';

  const groups = [];
  for (let end = digits.length; end > 0; end -= 4) {
    groups.unshift(Number(digits.slice(Math.max(0, end - 4), end)));
  }
  if (groups.length > BIG_UNITS.length) {
    return `${negative ? '負' : ''}${digits.split('').map((d) => DIGITS[Number(d)]).join('')}`;
  }

  let out = '';
  let pendingZero = false;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const unitIndex = groups.length - 1 - i;
    if (group === 0) {
      if (out && groups.slice(i + 1).some((n) => n !== 0)) pendingZero = true;
      continue;
    }
    if (out && (pendingZero || group < 1000)) out += '零';
    out += `${fourDigitsToChinese(group)}${BIG_UNITS[unitIndex]}`;
    pendingZero = false;
  }
  out = out.replace(/^一十/, '十');
  return `${negative ? '負' : ''}${out}`;
}

function numberToChinese(token) {
  const normalized = token.replace(/,/g, '');
  const [integer, decimal] = normalized.split('.');
  const whole = integerToChinese(integer);
  if (decimal === undefined) return whole;
  return `${whole}點${decimal.split('').map((d) => DIGITS[Number(d)]).join('')}`;
}

/** 阿拉伯數字通用轉中文；百分比先處理，避免把 7% 變成「七%」。 */
export function convertNumeralsToChinese(text) {
  const number = /[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
  return String(text)
    .replace(new RegExp(`(${number.source})\\s*%`, 'g'), (_, value) => `百分之${numberToChinese(value)}`)
    .replace(number, (value) => numberToChinese(value));
}

export function applyRewrites(text, rewrites = []) {
  let out = String(text);
  for (const [i, rewrite] of rewrites.entries()) {
    if (!rewrite || typeof rewrite.from !== 'string' || !rewrite.from || typeof rewrite.to !== 'string') {
      throw new VoiceRouteError(`voice.json rewrites[${i}] 必須有非空 from 與字串 to。`);
    }
    out = out.split(rewrite.from).join(rewrite.to);
  }
  return out;
}

function occurrenceIndexes(text, target) {
  const found = [];
  let cursor = 0;
  while (cursor <= text.length - target.length) {
    const at = text.indexOf(target, cursor);
    if (at < 0) break;
    found.push(at);
    cursor = at + Math.max(1, target.length);
  }
  return found;
}

/** pauses 先對無標記 clean 文字做全軌唯一性檢查，再由後往前插入，避免 index 漂移。 */
export function applyPauses(texts, pauses = []) {
  const insertions = texts.map(() => []);
  for (const [i, pause] of pauses.entries()) {
    const modes = ['before', 'after'].filter((key) => typeof pause?.[key] === 'string');
    if (modes.length !== 1 || !pause[modes[0]]) {
      throw new VoiceRouteError(`voice.json pauses[${i}] 必須且只能有 before／after 其中一個非空目標。`);
    }
    const sec = Number(pause.sec);
    if (!Number.isFinite(sec) || sec <= 0) {
      throw new VoiceRouteError(`voice.json pauses[${i}].sec 必須是大於 0 的秒數。`);
    }
    const mode = modes[0];
    const target = pause[mode];
    const matches = [];
    texts.forEach((text, segmentIndex) => {
      occurrenceIndexes(text, target).forEach((at) => matches.push({ segmentIndex, at }));
    });
    if (matches.length !== 1) {
      const why = matches.length === 0 ? '找不到' : `命中 ${matches.length} 次`;
      throw new VoiceRouteError(`pause ${mode}「${target}」在 clean 文字中${why}；目標必須全軌唯一。`);
    }
    const match = matches[0];
    const at = mode === 'before' ? match.at : match.at + target.length;
    insertions[match.segmentIndex].push({ at, marker: `<#${String(sec)}#>` });
  }
  return texts.map((text, i) => {
    let out = text;
    for (const insertion of insertions[i].sort((a, b) => b.at - a.at)) {
      out = `${out.slice(0, insertion.at)}${insertion.marker}${out.slice(insertion.at)}`;
    }
    return out;
  });
}

export function estimateBillableCharacters(text) {
  const han = String(text).match(/\p{Script=Han}/gu)?.length ?? 0;
  const markerChars = [...String(text).matchAll(/<#\d+(?:\.\d+)?#>/g)]
    .reduce((sum, match) => sum + match[0].length, 0);
  return han + markerChars;
}

function speedFactorThreshold() {
  return acceptance.gates.find((gate) => gate.id === 'video.speed-factor')?.threshold ?? {};
}

function expectedSpeedDivisor({ audioRoute = false } = {}) {
  const threshold = speedFactorThreshold();
  const field = audioRoute ? 'audioRouteExpected' : 'expected';
  const expected = Number(threshold[field]);
  if (!Number.isFinite(expected) || expected <= 0) {
    throw new VoiceRouteError(`contracts/acceptance.json 的 video.speed-factor.${field} 必須是大於 0 的數字。`);
  }
  return { expected, field };
}

export function validateVoiceConfig(config, { audioRoute = false } = {}) {
  if (config?.provider !== 'minimax') throw new VoiceRouteError('voice.json provider 必須是「minimax」。');
  if (typeof config.model !== 'string' || !config.model) throw new VoiceRouteError('voice.json 缺 model。');
  if (typeof config.voiceId !== 'string' || !config.voiceId) throw new VoiceRouteError('voice.json 缺 voiceId。');
  const { expected, field } = expectedSpeedDivisor({ audioRoute });
  if (Number(config.speedDivisor) !== expected) {
    const reason = audioRoute
      ? '音檔路線的語速已在合成端決定，speedup 只複製、不再拉伸；兩邊都必須是音檔路線倍率。'
      : '配音先除、speedup 再乘必須是同一倍率，否則成片語速會偏離編輯設定。';
    throw new VoiceRouteError(
      `voice.json speedDivisor=${JSON.stringify(config.speedDivisor)}，但 contracts/acceptance.json 的 ` +
      `video.speed-factor.${field}=${JSON.stringify(expected)}（${audioRoute ? '音檔路線' : '文字路線'}）。${reason}`);
  }
  for (const kind of ['hook', 'body', 'close']) {
    if (!Number.isFinite(Number(config.speeds?.[kind])) || Number(config.speeds[kind]) <= 0) {
      throw new VoiceRouteError(`voice.json speeds.${kind} 必須是大於 0 的數字。`);
    }
  }
  if (!Number.isFinite(Number(config.gapSec)) || Number(config.gapSec) < 0) {
    throw new VoiceRouteError('voice.json gapSec 必須是大於等於 0 的秒數。');
  }
  if (config.numerals !== 'chinese') throw new VoiceRouteError('voice.json numerals 目前必須是「chinese」。');
  if (!Array.isArray(config.rewrites) || !Array.isArray(config.pauses) || !Array.isArray(config.pronunciation)) {
    throw new VoiceRouteError('voice.json rewrites／pauses／pronunciation 必須是陣列。');
  }
  return config;
}

export function buildVoicePlan(scriptRaw, config, { audioRoute = false } = {}) {
  validateVoiceConfig(config, { audioRoute });
  const cleanOriginals = extractCleanParagraphs(scriptRaw);
  if (!cleanOriginals.length) throw new VoiceRouteError('script.txt 正文清理後沒有可配音段落。');

  const normalized = cleanOriginals.map((text) => {
    const rewritten = applyRewrites(text, config.rewrites);
    return config.numerals === 'chinese' ? convertNumeralsToChinese(rewritten) : rewritten;
  });
  const withPauses = applyPauses(normalized, config.pauses);
  const last = cleanOriginals.length - 1;
  const segments = cleanOriginals.map((cleanOriginal, index) => {
    const kind = index === 0 ? 'hook' : index === last ? 'close' : 'body';
    const speed = Math.round((Number(config.speeds[kind]) / Number(config.speedDivisor)) * 1000) / 1000;
    return {
      index: index + 1,
      kind,
      cleanOriginal,
      text: withPauses[index],
      speed,
      estimatedUsageCharacters: estimateBillableCharacters(withPauses[index]),
    };
  });
  return {
    provider: config.provider,
    model: config.model,
    voiceId: config.voiceId,
    speedDivisor: Number(config.speedDivisor),
    gapSec: Number(config.gapSec),
    pronunciation: config.pronunciation,
    segments,
    estimatedUsageCharacters: segments.reduce((sum, segment) => sum + segment.estimatedUsageCharacters, 0),
  };
}

export function readVoicePlan(P, { audioRoute = fs.existsSync(P.path('voiceTrack')) } = {}) {
  const voiceFile = P.path('voice');
  if (!fs.existsSync(voiceFile)) {
    throw new VoiceRouteError(
      `缺 ${P.rel('voice')}。這是專案層的編輯設定；請先建立，例如：\n` +
      `${JSON.stringify(VOICE_JSON_EXAMPLE, null, 2)}`);
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(voiceFile, 'utf8')); }
  catch (error) { throw new VoiceRouteError(`${P.rel('voice')} 不是有效 JSON：${error.message}`); }
  const scriptRaw = fs.readFileSync(P.path('script'), 'utf8');
  return { config, plan: buildVoicePlan(scriptRaw, config, { audioRoute }) };
}

function printDryrun(P, plan) {
  console.log('── MiniMax 配音 dryrun ────────────────────────────────');
  for (const segment of plan.segments) {
    console.log(`段 ${String(segment.index).padStart(2, '0')} ${segment.kind}　speed=${segment.speed}　估計計費 ${segment.estimatedUsageCharacters} 字元`);
    console.log(segment.text);
  }
  console.log(`合計估計計費 ${plan.estimatedUsageCharacters} 字元`);
  console.log(`輸出（synth 才會寫）：${P.rel('voiceTrack')}`);
  console.log('**這一步沒有發送網路請求。**');
}

async function requestSpeech(segment, plan, key, fetchImpl) {
  const requestBody = {
    model: plan.model,
    text: segment.text,
    stream: false,
    language_boost: 'Chinese',
    voice_setting: { voice_id: plan.voiceId, vol: 1, pitch: 0, speed: segment.speed },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    pronunciation_dict: { tone: plan.pronunciation },
  };
  const response = await fetchImpl(MINIMAX_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const data = await response.json().catch(() => null);
  const audio = data?.data?.audio;
  if (!response.ok || typeof audio !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(audio)) {
    const detail = JSON.stringify(data?.base_resp ?? data ?? {}).slice(0, 300);
    throw new VoiceRouteError(`MiniMax T2A 第 ${segment.index} 段失敗（HTTP ${response.status}）：${detail}`);
  }
  return {
    buffer: Buffer.from(audio, 'hex'),
    audio_length: Number(data?.extra_info?.audio_length ?? 0),
    usage_characters: Number(data?.extra_info?.usage_characters ?? 0),
  };
}

function probeDuration(file) {
  const value = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' }).trim();
  const duration = Number(value);
  if (!Number.isFinite(duration)) throw new VoiceRouteError(`ffprobe 無法取得音檔長度：${file}`);
  return duration;
}

async function synthesize(P, plan, fetchImpl) {
  const key = requireEnv('MINIMAX_API_KEY');
  const partsDir = path.join(P.root, 'voice', 'parts');
  // 一旦開始重建就先移除舊成品；中途失敗時不能讓 HeyGen 誤拿上一版音軌。
  fs.rmSync(P.path('voiceTrack'), { force: true });
  fs.rmSync(P.path('voiceTrackMeta'), { force: true });
  fs.rmSync(P.sidecar('voiceTrackMeta'), { force: true });
  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.mkdirSync(partsDir, { recursive: true });

  const results = [];
  for (const segment of plan.segments) {
    const result = await requestSpeech(segment, plan, key, fetchImpl);
    const filename = `${String(segment.index).padStart(2, '0')}_speed${segment.speed}.mp3`;
    const file = path.join(partsDir, filename);
    fs.writeFileSync(file, result.buffer);
    results.push({ ...segment, ...result, filename, file });
    console.log(`段 ${segment.index}: ${result.audio_length} ms，計費 ${result.usage_characters} 字元 → voice/parts/${filename}`);
  }

  const wav = path.join(P.root, 'voice', '.track.tmp.wav');
  const track = P.path('voiceTrack');
  const inputs = results.flatMap((result) => ['-i', result.file]);
  const chain = results.map((_, i) => `[${i}:a]apad=pad_dur=${plan.gapSec}[a${i}]`).join(';')
    + ';' + results.map((_, i) => `[a${i}]`).join('') + `concat=n=${results.length}:v=0:a=1[out]`;
  try {
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', ...inputs,
      '-filter_complex', chain, '-map', '[out]',
      '-ar', '32000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
    ]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-b:a', '128k', track]);
  } finally {
    fs.rmSync(wav, { force: true });
  }

  const durationSec = probeDuration(track);
  const sha256 = sha256File(track);
  const metadata = {
    provider: plan.provider,
    model: plan.model,
    voiceId: plan.voiceId,
    speedDivisor: plan.speedDivisor,
    gapSec: plan.gapSec,
    segments: results.map((result) => ({
      index: result.index,
      kind: result.kind,
      cleanOriginal: result.cleanOriginal,
      text: result.text,
      speed: result.speed,
      file: `voice/parts/${result.filename}`,
      audio_length: result.audio_length,
      usage_characters: result.usage_characters,
    })),
    totals: {
      audio_length: results.reduce((sum, result) => sum + result.audio_length, 0),
      usage_characters: results.reduce((sum, result) => sum + result.usage_characters, 0),
      durationSec,
    },
    track: { path: P.rel('voiceTrack'), sha256, durationSec },
    sha256,
  };
  writeJson(P, 'voiceTrackMeta', metadata, {
    inputs: ['script', 'voice'],
    generatedBy: 'stages/voice-minimax.mjs synth',
  });
  console.log(`完成 ${P.rel('voiceTrack')}：${durationSec.toFixed(3)} 秒，sha256 ${sha256.slice(0, 12)}…`);
  return metadata;
}

function optionValue(argv, name, { required = false } = {}) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (required) throw new VoiceRouteError(`adopt 缺 ${name}。`, 2);
    return null;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new VoiceRouteError(`${name} 後面必須有路徑。`, 2);
  return value;
}

function mismatchExcerpt(expected, actual, radius = 30) {
  const want = [...expected];
  const got = [...actual];
  let at = 0;
  while (at < want.length && at < got.length && want[at] === got[at]) at++;
  const show = (chars) => {
    const before = chars.slice(Math.max(0, at - radius), at).join('');
    const hit = chars[at] ?? '<結尾>';
    const after = chars.slice(at + (at < chars.length ? 1 : 0), at + radius + 1).join('');
    return `${before}【${hit}】${after}`;
  };
  return `第 ${at + 1} 字附近（前後各 ${radius} 字）：\n  script.txt：${show(want)}\n  track.json：${show(got)}`;
}

function listFilesRecursive(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  walk(dir);
  return files;
}

function adoptTrack(P, plan, trackArg, partsArg) {
  const sourceTrack = path.resolve(trackArg);
  const destinationTrack = P.path('voiceTrack');
  if (!fs.existsSync(sourceTrack) || !fs.statSync(sourceTrack).isFile()) {
    throw new VoiceRouteError(`--track 不是可讀檔案：${sourceTrack}`);
  }
  if (sourceTrack === path.resolve(destinationTrack)) {
    throw new VoiceRouteError('--track 不得直接指向專案的 voice/track.mp3；請提供核准音檔的來源檔。');
  }

  const sourceParts = partsArg ? path.resolve(partsArg) : null;
  if (sourceParts && (!fs.existsSync(sourceParts) || !fs.statSync(sourceParts).isDirectory())) {
    throw new VoiceRouteError(`--parts 不是可讀目錄：${sourceParts}`);
  }
  const voiceDir = path.dirname(destinationTrack);
  fs.mkdirSync(voiceDir, { recursive: true });
  const token = `${process.pid}-${Date.now()}`;
  const temporaryTrack = path.join(voiceDir, `.track-adopt-${token}.mp3`);
  const temporaryParts = path.join(voiceDir, `.parts-adopt-${token}`);

  try {
    fs.copyFileSync(sourceTrack, temporaryTrack);
    if (sourceParts) fs.cpSync(sourceParts, temporaryParts, { recursive: true });

    let partDurations = null;
    if (sourceParts) {
      const indexed = new Map();
      for (const file of listFilesRecursive(temporaryParts)) {
        const match = path.basename(file).match(/^(\d+)_.*\.(?:mp3|wav|m4a|aac|flac|ogg)$/iu);
        if (!match) continue;
        const index = Number(match[1]);
        const matches = indexed.get(index) ?? [];
        matches.push(file);
        indexed.set(index, matches);
      }
      partDurations = plan.segments.map((segment) => {
        const matches = indexed.get(segment.index) ?? [];
        if (matches.length !== 1) {
          throw new VoiceRouteError(
            `--parts 的第 ${segment.index} 段必須恰有一個「${String(segment.index).padStart(2, '0')}_*.音檔」，實得 ${matches.length} 個。`);
        }
        return probeDuration(matches[0]);
      });
    }

    const durationSec = probeDuration(temporaryTrack);
    const sha256 = sha256File(temporaryTrack);
    const metadata = {
      provider: plan.provider,
      model: plan.model,
      voiceId: plan.voiceId,
      adoptedFrom: sourceTrack,
      segments: plan.segments.map((segment, index) => ({
        index: segment.index,
        role: segment.kind,
        speed: segment.speed,
        cleanOriginal: segment.cleanOriginal,
        text: segment.text,
        ...(partDurations ? { durationSec: partDurations[index] } : {}),
      })),
      track: {
        durationSec,
        sha256,
        bytes: fs.statSync(temporaryTrack).size,
      },
    };

    const scriptRaw = fs.readFileSync(P.path('script'), 'utf8');
    const cleanCheck = checkAudioCleanMatchesScript(scriptRaw, metadata);
    if (!cleanCheck.ok) {
      throw new VoiceRouteError(
        `拒絕採用：track.json 的 cleanOriginal 與 script.txt 正文不符。\n` +
        mismatchExcerpt(cleanCheck.expected, cleanCheck.actual));
    }

    fs.rmSync(destinationTrack, { force: true });
    fs.rmSync(P.path('voiceTrackMeta'), { force: true });
    fs.rmSync(P.sidecar('voiceTrackMeta'), { force: true });
    fs.rmSync(path.join(voiceDir, 'parts'), { recursive: true, force: true });
    fs.renameSync(temporaryTrack, destinationTrack);
    if (sourceParts) fs.renameSync(temporaryParts, path.join(voiceDir, 'parts'));
    writeJson(P, 'voiceTrackMeta', metadata, {
      inputs: ['script', 'voice'],
      generatedBy: 'stages/voice-minimax.mjs adopt',
    });

    console.log('── MiniMax 音軌 adopt ─────────────────────────────────');
    console.log(`總長：${durationSec.toFixed(3)} 秒`);
    console.log(`SHA-256：${sha256.slice(0, 12)}`);
    for (const segment of metadata.segments) {
      const duration = segment.durationSec === undefined ? '' : `　${segment.durationSec.toFixed(3)} 秒`;
      console.log(`段 ${String(segment.index).padStart(2, '0')} ${segment.role}　speed=${segment.speed}${duration}`);
    }
    console.log(`已採用 ${sourceTrack} → ${P.rel('voiceTrack')}`);
    console.log('**這一步沒有花錢。**');
    return metadata;
  } finally {
    fs.rmSync(temporaryTrack, { force: true });
    fs.rmSync(temporaryParts, { recursive: true, force: true });
  }
}

export async function runVoiceMinimax(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
  let P;
  try { P = resolveProject(argv); }
  catch (error) {
    throw new VoiceRouteError(
      `${error.message}\n用法：node stages/voice-minimax.mjs --project <dir> dryrun|synth|adopt ` +
      '[--track <file.mp3>] [--parts <dir>]', 2);
  }
  const cmd = argv.find((arg) => ['dryrun', 'synth', 'adopt'].includes(arg)) ?? 'dryrun';
  // synth 與 adopt 都在產出／採用 voice/track.mp3，執行完專案就在音檔路線上，
  // 所以它們自己必須用 audioRouteExpected 檢查，不能等 track.mp3 出現才算。
  // dryrun 維持看 fs.existsSync：沒有音檔的專案還沒選定路線，這是刻意設計，
  // 由 test/voice-route.test.mjs「speedDivisor 文字路線取 expected…」那條守著。
  // 2026-08-31 實測：少了 synth 這一項，第一次 synth 被當文字路線、逼 speedDivisor=1.1，
  // 整軌出來 76.8s；而 speedup.mjs 這時已看得到 track.mp3、永遠取 factor 1.0，
  // 那個 1.1 沒有任何階段補得回來。改正後同一份講稿 58.6s。
  const audioRoute = cmd === 'adopt' || cmd === 'synth' || fs.existsSync(P.path('voiceTrack'));
  const { plan } = readVoicePlan(P, { audioRoute });
  if (cmd === 'dryrun') {
    printDryrun(P, plan);
    return plan;
  }
  if (cmd === 'adopt') {
    return adoptTrack(
      P,
      plan,
      optionValue(argv, '--track', { required: true }),
      optionValue(argv, '--parts'),
    );
  }
  if (typeof fetchImpl !== 'function') throw new VoiceRouteError('目前環境沒有可用的 fetch。');
  return synthesize(P, plan, fetchImpl);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { await runVoiceMinimax(); }
  catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = error?.exitCode ?? 1;
  }
}
