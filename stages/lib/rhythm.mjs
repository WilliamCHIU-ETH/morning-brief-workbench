const n4 = (value) => Number(Number(value).toFixed(4));
const EPS = 1e-6;

// 必須和 shot-template 的實際 GSAP 動畫一致；gate 也從這裡推導「完全到位」時間，
// 不相信 mg-plan 自報一個較短的 tweenSec 來灌出假的可讀停留。
export const SHOT_BEAT_TIMING = Object.freeze({
  focusSec: 0.3,
  focus2Sec: 0.6,
  secondSec: 0.3,
  secondFocus2DelaySec: 0.8,
  secondFocus2Sec: 0.5,
});

export function shotBeatTweenSec(kind, { secondFocus2 = false } = {}) {
  if (kind === 'focus') return SHOT_BEAT_TIMING.focusSec;
  if (kind === 'focus2') return SHOT_BEAT_TIMING.focus2Sec;
  if (kind === 'second') {
    return secondFocus2
      ? SHOT_BEAT_TIMING.secondSec + SHOT_BEAT_TIMING.secondFocus2DelaySec
        + SHOT_BEAT_TIMING.secondFocus2Sec
      : SHOT_BEAT_TIMING.secondSec;
  }
  throw new TypeError(`未知 shot 拍點 kind：${JSON.stringify(kind)}`);
}

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

/**
 * P3：每拍在主張錨前 leadSec 起手；若非首拍會吃掉前拍 dwell，前拍停留優先，
 * 把切換夾到「前拍到位＋dwellMinSec」之後。首拍也沿用窗口既有的 0.4s 前導，
 * 讓黃框在主張詞前開始 scale-in，而不是等唸到才動。
 */
export function resolveBeatTransitions({
  beats,
  windowEnterSec,
  leadSec = 0.4,
  dwellMinSec = 0.8,
}) {
  const enter = Number(windowEnterSec);
  if (!Array.isArray(beats) || !beats.length) throw new TypeError('拍點切換至少需要一個拍點');
  for (const [name, value] of Object.entries({ windowEnterSec: enter, leadSec, dwellMinSec })) {
    if (!(Number.isFinite(value) && value >= 0)) throw new TypeError(`${name} 必須是 >=0 的有限秒數`);
  }

  let previousArrival = null;
  return beats.map((beat, index) => {
    const at = Number(beat.atSec);
    const tweenSec = Number(beat.tweenSec);
    if (!(Number.isFinite(at) && Number.isFinite(tweenSec) && tweenSec >= 0)) {
      throw new TypeError(`第 ${index + 1} 拍缺合法 atSec／tweenSec`);
    }
    const desired = Math.max(enter, at - leadSec);
    const dwellFloor = previousArrival === null ? -Infinity : previousArrival + dwellMinSec;
    const transitionStartSec = n4(Math.max(desired, dwellFloor));
    const arrivalSec = n4(transitionStartSec + tweenSec);
    const clamped = transitionStartSec - desired > EPS;
    previousArrival = arrivalSec;
    return {
      ...beat,
      tweenSec: n4(tweenSec),
      desiredTransitionStartSec: n4(desired),
      transitionStartSec,
      arrivalSec,
      transitionTiming: clamped
        ? `lead ${leadSec}s；前拍到位後保留 ${dwellMinSec}s` : `lead ${leadSec}s`,
    };
  });
}

/**
 * R1＋P4：第一拍前 leadSec 進、末拍講完後 tailSec 退；每拍到位後至少可讀
 * dwellMinSec。2–6s padding 必須先讓位給停留，段界仍放不下就 fail closed。
 */
export function computeVisualWindow({
  segmentStartSec,
  segmentEndSec,
  beats,
  leadSec = 0.4,
  tailSec = 1,
  minSec = 2,
  maxSec = 6,
  fadeSec = 0.3,
  dwellMinSec = 0.8,
}) {
  const start = Number(segmentStartSec);
  const end = Number(segmentEndSec);
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
    throw new TypeError('視覺窗口需要合法的 segmentStartSec／segmentEndSec');
  }
  if (!Array.isArray(beats) || !beats.length) throw new TypeError('視覺窗口至少需要一個拍點');
  for (const [name, value] of Object.entries({ leadSec, tailSec, minSec, maxSec, fadeSec, dwellMinSec })) {
    if (!(Number.isFinite(value) && value >= 0)) throw new TypeError(`${name} 必須是 >=0 的有限秒數`);
  }
  if (!(maxSec >= minSec && minSec > 0)) throw new TypeError('視覺窗口需要 0 < minSec <= maxSec');

  const firstBeat = Math.min(...beats.map((beat) => Number(beat.atSec)));
  const lastBeat = Math.max(...beats.map((beat) => Number(beat.endSec)));
  const firstTransition = Math.min(...beats.map((beat) => Number(beat.transitionStartSec)));
  const lastArrival = Math.max(...beats.map((beat) => Number(beat.arrivalSec)));
  if (!(Number.isFinite(firstBeat) && Number.isFinite(lastBeat) && lastBeat >= firstBeat
    && Number.isFinite(firstTransition) && Number.isFinite(lastArrival))) {
    throw new TypeError('拍點缺 atSec／endSec／transitionStartSec／arrivalSec');
  }
  for (let index = 0; index < beats.length; index++) {
    const beat = beats[index];
    const transition = Number(beat.transitionStartSec);
    const arrival = Number(beat.arrivalSec);
    if (!(transition >= start - EPS && arrival >= transition - EPS && arrival <= end + EPS)) {
      throw new Error(`拍點「${beat.anchor ?? index + 1}」的切換無法完整放進段界 ${start.toFixed(2)}–${end.toFixed(2)}s；請換錨、減拍，或用 plan-hints.json 押回主播。`);
    }
    if (index > 0) {
      const previous = beats[index - 1];
      const dwell = transition - Number(previous.arrivalSec);
      if (dwell < dwellMinSec - EPS) {
        throw new Error(`拍點「${previous.anchor ?? index}」到位後只停留 ${dwell.toFixed(2)}s；至少要 ${dwellMinSec}s。請換錨、減拍，或用 plan-hints.json 押回主播。`);
      }
    }
  }

  const p4Exit = lastArrival + dwellMinSec + fadeSec;
  if (p4Exit > end + EPS) {
    const last = beats.at(-1);
    throw new Error(`段界到 ${end.toFixed(2)}s，放不下末拍「${last.anchor ?? '?'}」在 ${lastArrival.toFixed(2)}s 到位後 ${dwellMinSec}s 停留＋${fadeSec}s 淡出；請換錨、減拍，或用 plan-hints.json 押回主播。`);
  }

  let enter = Math.max(start, firstBeat - leadSec);
  let exit = Math.min(end, Math.max(lastBeat + tailSec, p4Exit));

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
      throw new Error(`段長 ${(end - start).toFixed(2)}s，放不下視覺窗口下界 ${minSec}s；請換錨、減拍，或用 plan-hints.json 押回主播。`);
    }
  }

  // 上界：先裁第一拍 lead／末拍 tail 等 padding；真正不可裁的是拍點切換、完整發聲、
  // 末拍到位後 dwell 與 fade。只有這個必要跨度本身 > maxSec 才准許例外。
  const requiredStart = Math.max(start, firstTransition);
  const requiredEnd = Math.min(end, Math.max(lastBeat, p4Exit));
  const requiredSpan = requiredEnd - requiredStart;
  let overMaxReason = null;
  if (exit - enter > maxSec + EPS) {
    if (requiredSpan > maxSec + EPS) {
      enter = requiredStart;
      exit = requiredEnd;
      overMaxReason = `涵蓋 ${beats.length} 個拍點切換、完整發聲與 ${dwellMinSec}s 到位停留需 ${requiredSpan.toFixed(2)}s（大於 ${maxSec}s 目標上界）`;
    } else {
      const low = Math.max(start, requiredEnd - maxSec);
      const high = Math.min(requiredStart, end - maxSec);
      enter = Math.max(low, Math.min(high, firstBeat - leadSec));
      exit = enter + maxSec;
    }
  }

  enter = n4(enter);
  exit = n4(exit);
  const actualFade = n4(Math.min(fadeSec, (exit - enter) / 4));
  const fadeStart = exit - actualFade;
  const lastDwell = fadeStart - lastArrival;
  if (lastDwell < dwellMinSec - EPS) {
    throw new Error(`末拍「${beats.at(-1).anchor ?? '?'}」到位後只停留 ${lastDwell.toFixed(2)}s 就淡出；至少要 ${dwellMinSec}s。請換錨、減拍，或用 plan-hints.json 押回主播。`);
  }
  return {
    enterSec: enter,
    exitSec: exit,
    durationSec: n4(exit - enter),
    fadeSec: actualFade,
    ...(overMaxReason ? { overMaxReason } : {}),
  };
}
