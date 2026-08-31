const GREETING_FAMILY = /早安[^。？！]{0,6}親愛的投資人|早安[^。？！]{0,4}投資朋友|早安[^。？！]{0,8}投資人/u;

const n4 = (value) => Number(Number(value).toFixed(4));

/**
 * 開場結束的絕對秒數。物件模式有 pre-roll 時在 P 秒開始拉焦；P=0 與布林 true
 * 都沿用既有 holdSec，再加 focusSec。build-main 與 plan-mg 不得各算一份。
 */
export function openTitleEnd(cfg, layout) {
  const objectMode = cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg);
  if (cfg !== true && !objectMode) return 0;
  const holdSec = Number(layout?.openTitle?.holdSec);
  const focusSec = Number(layout?.openTitle?.focusSec);
  if (!(holdSec >= 0) || !(focusSec > 0)) {
    throw new TypeError('openTitle 需要 layout.openTitle.holdSec（>=0）與 focusSec（>0）');
  }
  const preRollSec = objectMode ? Number(cfg.preRollSec ?? 0) : 0;
  if (!Number.isFinite(preRollSec) || preRollSec < 0) {
    throw new TypeError(`openTitle.preRollSec 必須是 >=0 的有限秒數，收到 ${JSON.stringify(cfg.preRollSec)}`);
  }
  return n4((preRollSec > 0 ? preRollSec : holdSec) + focusSec);
}

/**
 * 計算每個素材格的實際前導。shots、openTitleEnd 與 greetingEnd 必須在同一條時間軸；
 * 呼叫端若有 pre-roll／intro，先把共同位移加上再傳入。
 */
export function resolveLeads({ shots, leadSec = 0, openTitleEnd = 0, greetingEnd = 0 }) {
  if (!Array.isArray(shots)) throw new TypeError('resolveLeads.shots 必須是陣列');
  for (const [name, value] of Object.entries({ leadSec, openTitleEnd, greetingEnd })) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`resolveLeads.${name} 必須是 >=0 的有限數字`);
    }
  }

  const out = new Map();
  let previousMgEnd = 0;
  for (const shot of shots) {
    const start = Number(shot?.start);
    const duration = Number(shot?.duration);
    if (shot?.id === undefined || !Number.isFinite(start) || start < 0
      || !Number.isFinite(duration) || duration <= 0) {
      throw new TypeError('resolveLeads.shots 每筆都需要 id、start>=0、duration>0');
    }
    if (out.has(shot.id)) throw new TypeError(`resolveLeads.shots 的 id 重複：${shot.id}`);

    const earliest = Math.max(0, openTitleEnd, greetingEnd, previousMgEnd);
    const room = Math.max(0, n4(start - earliest));
    const actualLead = leadSec > 0 ? n4(Math.min(leadSec, room)) : 0;
    out.set(shot.id, {
      actualLead,
      renderStart: actualLead > 0 ? n4(start - actualLead) : start,
      renderDuration: actualLead > 0 ? n4(duration + actualLead) : duration,
    });
    previousMgEnd = n4(start + duration);
  }
  return out;
}

/**
 * 從逐字時間找出真正的問候句。正規式只有這一份；gate、plan 與組裝器都呼叫本函式。
 */
export function greetingWindow(charTimes) {
  if (!Array.isArray(charTimes) || !charTimes.length) return null;

  const entries = [];
  let text = '';
  for (const item of charTimes) {
    const ch = String(item?.ch ?? item?.char ?? '');
    if (!ch) continue;
    entries.push({ item, offset: text.length, ch });
    text += ch;
  }
  const match = text.match(GREETING_FAMILY);
  if (!match) return null;

  const from = match.index;
  const to = from + match[0].length;
  const first = entries.find((entry) => entry.offset <= from && from < entry.offset + entry.ch.length);
  const last = entries.findLast((entry) => entry.offset < to);
  if (!first || !last || !Number.isFinite(first.item.start) || !Number.isFinite(last.item.end)) return null;
  return { start: first.item.start, end: last.item.end, text: match[0] };
}
