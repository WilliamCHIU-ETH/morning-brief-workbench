const n4 = (value) => Number(Number(value).toFixed(4));
const EPS = 1e-6;

function indexedCharTimes(charTimes) {
  if (!Array.isArray(charTimes) || !charTimes.length) {
    throw new TypeError('charTimes 必須是非空陣列');
  }
  const entries = [];
  let text = '';
  for (const item of charTimes) {
    const ch = String(item?.ch ?? item?.char ?? '');
    if (!ch) continue;
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new TypeError(`charTimes 有無效時間：${JSON.stringify(item)}`);
    }
    entries.push({ item, ch, offset: text.length, start, end });
    text += ch;
  }
  if (!entries.length) throw new TypeError('charTimes 沒有可用字元');
  return { entries, text };
}

function entryAt(entries, offset, end = false) {
  if (end) return entries.findLast((entry) => entry.offset < offset);
  return entries.find((entry) => entry.offset <= offset && offset < entry.offset + entry.ch.length);
}

/**
 * 以真正的逐字時間解析文字錨。回傳所有命中，讓呼叫端自行決定唯一性政策。
 */
export function textTimeMatches(charTimes, anchor, { fromSec = -Infinity, toSec = Infinity } = {}) {
  if (typeof anchor !== 'string' || !anchor.length) return [];
  const { entries, text } = indexedCharTimes(charTimes);
  const matches = [];
  for (let from = 0; from <= text.length;) {
    const offset = text.indexOf(anchor, from);
    if (offset < 0) break;
    const first = entryAt(entries, offset);
    const last = entryAt(entries, offset + anchor.length, true);
    if (first && last && first.start >= fromSec - EPS && last.end <= toSec + EPS) {
      matches.push({
        anchor,
        offset,
        startSec: n4(first.start),
        endSec: n4(last.end),
      });
    }
    from = offset + 1;
  }
  return matches;
}

/**
 * 將 shot-plan 的拍點文字錨限定在單一 ledger 段內，依句中字序解析時間。
 *
 * ASR token 有時會讓相鄰字共用同一時間。若兩拍因此過近，保留文字順序並把
 * 拍點拉開到 minGapSec；若段長連這個間隔都放不下就 fail closed。
 */
export function resolveOrderedBeatTimes({ charTimes, segment, anchors, minGapSec = 0.8 }) {
  if (!segment || typeof segment.anchor !== 'string' || !segment.anchor.length) {
    throw new TypeError('segment 需要非空 anchor');
  }
  if (!Array.isArray(anchors) || !anchors.length) throw new TypeError('anchors 必須是非空陣列');
  if (!(Number.isFinite(minGapSec) && minGapSec >= 0)) throw new TypeError('minGapSec 必須是 >=0 的有限秒數');

  const segmentHits = textTimeMatches(charTimes, segment.anchor, {
    fromSec: Number(segment.startSec) - 0.75,
    toSec: Number(segment.endSec) + 0.75,
  });
  if (segmentHits.length !== 1) {
    throw new Error(`段 ${segment.id} 的 anchor 在逐字時間命中 ${segmentHits.length} 次；無法限定拍點。`);
  }

  const { entries } = indexedCharTimes(charTimes);
  const segmentOffset = segmentHits[0].offset;
  const raw = [];
  let cursor = 0;
  for (const [index, value] of anchors.entries()) {
    const anchor = String(value ?? '');
    if (!anchor) throw new Error(`第 ${index + 1} 個拍點文字錨是空的。`);
    const local = segment.anchor.indexOf(anchor, cursor);
    if (local < 0) {
      const anywhere = segment.anchor.indexOf(anchor);
      if (anywhere >= 0) {
        throw new Error(`拍點文字錨「${anchor}」雖在段內，但順序早於前一拍；targets 必須照旁白字序排列。`);
      }
      throw new Error(`拍點文字錨「${anchor}」不在該格句子「${segment.anchor}」內。`);
    }
    const first = entryAt(entries, segmentOffset + local);
    const last = entryAt(entries, segmentOffset + local + anchor.length, true);
    if (!first || !last) throw new Error(`拍點文字錨「${anchor}」找得到文字，但逐字時間沒有涵蓋完整範圍。`);
    raw.push({
      anchor,
      charOffset: local,
      rawAtSec: n4(first.start),
      rawEndSec: n4(last.end),
    });
    cursor = local + anchor.length;
  }

  const starts = raw.map((beat) => beat.rawAtSec);
  for (let index = 1; index < starts.length; index++) {
    starts[index] = Math.max(starts[index], starts[index - 1] + minGapSec);
  }
  const overflow = starts.at(-1) - Number(segment.endSec);
  if (overflow > EPS) {
    for (let index = 0; index < starts.length; index++) starts[index] -= overflow;
    for (let index = starts.length - 2; index >= 0; index--) {
      starts[index] = Math.min(starts[index], starts[index + 1] - minGapSec);
    }
  }
  if (starts[0] < Number(segment.startSec) - EPS) {
    throw new Error(`格 ${segment.id} 的 ${anchors.length} 個拍點無法在 ${Number(segment.endSec - segment.startSec).toFixed(2)}s 內維持 ${minGapSec}s 間隔。`);
  }

  return raw.map((beat, index) => {
    const atSec = n4(starts[index]);
    const shifted = atSec - beat.rawAtSec;
    return {
      ...beat,
      atSec,
      endSec: n4(Math.min(Number(segment.endSec), beat.rawEndSec + shifted)),
      timing: Math.abs(shifted) > EPS ? `char-time＋${minGapSec}s 最小拍距` : 'char-time',
    };
  });
}

/** R1：第一拍前 leadSec 進、末拍講完後 tailSec 退；段界、下界與目標上界在此統一。 */
export function computeVisualWindow({
  segmentStartSec,
  segmentEndSec,
  beats,
  leadSec = 0.4,
  tailSec = 1,
  minSec = 2,
  maxSec = 6,
  fadeSec = 0.3,
}) {
  const start = Number(segmentStartSec);
  const end = Number(segmentEndSec);
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
    throw new TypeError('視覺窗口需要合法的 segmentStartSec／segmentEndSec');
  }
  if (!Array.isArray(beats) || !beats.length) throw new TypeError('視覺窗口至少需要一個拍點');
  for (const [name, value] of Object.entries({ leadSec, tailSec, minSec, maxSec, fadeSec })) {
    if (!(Number.isFinite(value) && value >= 0)) throw new TypeError(`${name} 必須是 >=0 的有限秒數`);
  }
  if (!(maxSec >= minSec && minSec > 0)) throw new TypeError('視覺窗口需要 0 < minSec <= maxSec');

  const firstBeat = Math.min(...beats.map((beat) => Number(beat.atSec)));
  const lastBeat = Math.max(...beats.map((beat) => Number(beat.endSec)));
  if (!(Number.isFinite(firstBeat) && Number.isFinite(lastBeat) && lastBeat >= firstBeat)) {
    throw new TypeError('拍點缺 atSec／endSec');
  }

  let enter = Math.max(start, firstBeat - leadSec);
  let exit = Math.min(end, lastBeat + tailSec);

  // 下界：先左右平均補，再把受段界擋住的餘量補到另一側。
  if (exit - enter < minSec - EPS) {
    let deficit = minSec - (exit - enter);
    const left = Math.min(enter - start, deficit / 2);
    enter -= left;
    deficit -= left;
    const right = Math.min(end - exit, deficit);
    exit += right;
    deficit -= right;
    const leftAgain = Math.min(enter - start, deficit);
    enter -= leftAgain;
    deficit -= leftAgain;
    if (deficit > EPS) {
      throw new Error(`段長 ${(end - start).toFixed(2)}s，放不下視覺窗口下界 ${minSec}s。`);
    }
  }

  const requiredSpan = lastBeat - firstBeat;
  let overMaxReason = null;
  if (exit - enter > maxSec + EPS) {
    if (requiredSpan > maxSec + EPS) {
      overMaxReason = `涵蓋 ${beats.length} 個拍點需 ${requiredSpan.toFixed(2)}s（大於 ${maxSec}s 目標上界）`;
    } else {
      // 拍點本身放得進 maxSec 時，只裁 padding，不裁拍點。
      const low = Math.max(start, lastBeat - maxSec);
      const high = Math.min(firstBeat, end - maxSec);
      enter = Math.max(low, Math.min(high, firstBeat - leadSec));
      exit = enter + maxSec;
    }
  }

  enter = n4(enter);
  exit = n4(exit);
  return {
    enterSec: enter,
    exitSec: exit,
    durationSec: n4(exit - enter),
    fadeSec: n4(Math.min(fadeSec, (exit - enter) / 4)),
    ...(overMaxReason ? { overMaxReason } : {}),
  };
}
