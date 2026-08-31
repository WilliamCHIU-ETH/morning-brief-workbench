import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha256File } from './project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex } = require(path.join(here, '..', 'script-utils.js'));

const clean = (text) => cleanBodyWithIndex(String(text)).map((entry) => entry.char).join('');

function metadataSegments(trackMeta) {
  if (!Array.isArray(trackMeta?.segments) || trackMeta.segments.length === 0) {
    throw new Error('voice/track.json 缺 segments，無法核對合成輸入與 script.txt。');
  }
  return trackMeta.segments;
}

/** 檢查 track.json 每段 clean 原文串接後，確實等於目前 script.txt 正文。 */
export function checkAudioCleanMatchesScript(scriptRaw, trackMeta) {
  const expected = clean(getBodyAfterVoice(scriptRaw));
  const actual = metadataSegments(trackMeta)
    .map((segment) => clean(segment.cleanOriginal ?? segment.clean ?? ''))
    .join('');
  return {
    ok: actual === expected,
    expectedLength: expected.length,
    actualLength: actual.length,
    expected,
    actual,
  };
}

/** 檢查磁碟上實際要上傳的 track.mp3，與 track.json 記錄的 SHA-256 相同。 */
export function checkAudioShaMatchesTrack(audioFile, trackMeta) {
  if (!fs.existsSync(audioFile)) throw new Error(`缺音檔：${audioFile}`);
  const expected = trackMeta?.track?.sha256 ?? trackMeta?.sha256;
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) {
    throw new Error('voice/track.json 缺有效的 track.mp3 sha256。');
  }
  const actual = sha256File(audioFile);
  return { ok: actual === expected.toLowerCase(), expected: expected.toLowerCase(), actual };
}

export function summarizeSynthesisInput(trackMeta) {
  const segments = metadataSegments(trackMeta);
  const texts = segments.map((segment) => String(segment.text ?? '').trim()).filter(Boolean);
  if (!texts.length) throw new Error('voice/track.json segments 沒有合成輸入 text。');
  const compact = (text) => text.replace(/\s+/g, ' ');
  return `${compact(texts[0])}…${compact(texts[texts.length - 1])}`;
}

function getAt(object, dotted) {
  return String(dotted).split('.').reduce((value, key) => value?.[key], object);
}

function compareObject(expected, actual, prefix, differences) {
  for (const [key, value] of Object.entries(expected ?? {})) {
    const field = prefix ? `${prefix}.${key}` : key;
    const got = actual?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      compareObject(value, got, field, differences);
    } else if (JSON.stringify(got) !== JSON.stringify(value)) {
      differences.push(`${field}：送 ${JSON.stringify(got)}，契約 ${JSON.stringify(value)}`);
    }
  }
}

/**
 * 比對 HeyGen payload 的共同鎖定欄位；音檔路線只容許規格列出的三項差異。
 * audioRoute 若另帶 payload／locked／required／forbiddenFields，也一併按契約驗。
 */
export function payloadContractDifferences(payload, lock, { audioRoute = false, allowPendingAsset = false } = {}) {
  const differences = [];
  const omitted = new Set(audioRoute ? ['script', 'voice_id', 'voice_settings'] : []);
  const commonPayload = Object.fromEntries(
    Object.entries(lock.payload ?? {}).filter(([field]) => !omitted.has(field)),
  );
  compareObject(commonPayload, payload, '', differences);
  for (const item of lock.locked ?? []) {
    if (audioRoute && omitted.has(String(item.field).split('.')[0])) continue;
    const got = getAt(payload, item.field);
    if (JSON.stringify(got) !== JSON.stringify(item.value)) {
      differences.push(`${item.field}：送 ${JSON.stringify(got)}，鎖定值 ${JSON.stringify(item.value)}`);
    }
  }

  if (!audioRoute) return differences;
  if (!lock.audioRoute) {
    differences.push('契約尚未定義音檔路線的量法');
    return differences;
  }
  for (const field of omitted) {
    if (Object.hasOwn(payload, field)) differences.push(`音檔路線不得有 ${field}`);
  }
  if (typeof payload.audio_asset_id !== 'string' || !payload.audio_asset_id
      || (!allowPendingAsset && payload.audio_asset_id === '<待上傳>')) {
    differences.push('音檔路線缺有效 audio_asset_id');
  }

  // 保留向前相容：支援 payload 直接列值，也支援 expected／required／forbidden 規則寫法。
  const payloadRules = lock.audioRoute.payload && typeof lock.audioRoute.payload === 'object'
    ? lock.audioRoute.payload : {};
  const controlFields = new Set(['expected', 'values', 'required', 'requiredFields', 'forbidden', 'forbiddenFields']);
  const expectedSource = payloadRules.expected ?? payloadRules.values ?? Object.fromEntries(
    Object.entries(payloadRules).filter(([field]) => !controlFields.has(field)),
  );
  const { audio_asset_id: _dynamicAssetId, ...expectedPayload } = expectedSource;
  compareObject(expectedPayload, payload, '', differences);
  for (const item of lock.audioRoute.locked ?? []) {
    if (item.field === 'audio_asset_id' && String(item.value).includes('<')) continue;
    const got = getAt(payload, item.field);
    if (JSON.stringify(got) !== JSON.stringify(item.value)) {
      differences.push(`${item.field}：送 ${JSON.stringify(got)}，音檔路線鎖定值 ${JSON.stringify(item.value)}`);
    }
  }
  const required = lock.audioRoute.required ?? lock.audioRoute.requiredFields
    ?? payloadRules.required ?? payloadRules.requiredFields ?? [];
  for (const field of required) {
    if (getAt(payload, field) === undefined) differences.push(`音檔路線缺契約必填欄位 ${field}`);
  }
  const forbidden = lock.audioRoute.forbiddenFields ?? lock.audioRoute.forbidden
    ?? payloadRules.forbiddenFields ?? payloadRules.forbidden ?? [];
  for (const field of forbidden) {
    if (getAt(payload, field) !== undefined) differences.push(`音檔路線含契約禁止欄位 ${field}`);
  }
  return differences;
}
