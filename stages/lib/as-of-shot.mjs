const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const AX_DATE = /^(\d{4})\/(\d{2})\/(\d{2})$/u;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** 回傳 canonical YYYY-MM-DD；格式錯或不是實際存在的日期時回 null。 */
export function normalizeIsoDate(value) {
  const match = ISO_DATE.exec(String(value ?? ''));
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${yearText}-${monthText}-${dayText}`;
}

/** 把 App AX 的 YYYY/MM/DD 原文正規化成 YYYY-MM-DD；不合法時回 null。 */
export function axDateToIso(value) {
  const match = AX_DATE.exec(String(value ?? ''));
  if (!match) return null;
  return normalizeIsoDate(`${match[1]}-${match[2]}-${match[3]}`);
}

export function axDateMatchesDataAsOf(axDate, dataAsOf) {
  const normalizedData = normalizeIsoDate(dataAsOf);
  return normalizedData !== null && axDateToIso(axDate) === normalizedData;
}

/** iOS accessibility points → screenshot pixels。 */
export function pointsToPixels(points, pointScale, rounding = 'round') {
  if (!finite(points) || !finite(pointScale) || pointScale <= 0) {
    throw new TypeError(`points 與 pointScale 必須是有限數字且 scale > 0，收到 ${points}／${pointScale}`);
  }
  const round = { floor: Math.floor, round: Math.round, ceil: Math.ceil }[rounding];
  if (!round) throw new TypeError(`rounding 只能是 floor／round／ceil，收到 ${rounding}`);
  return round(points * pointScale);
}

/**
 * AX frame 轉成保守包住原框的像素 frame：左上向外 floor、右下向外 ceil。
 */
export function framePointsToPixels(frame, pointScale) {
  if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(finite)
      || frame.width < 0 || frame.height < 0) {
    throw new TypeError(`AX frame 不合法：${JSON.stringify(frame)}`);
  }
  const x = pointsToPixels(frame.x, pointScale, 'floor');
  const y = pointsToPixels(frame.y, pointScale, 'floor');
  const right = pointsToPixels(frame.x + frame.width, pointScale, 'ceil');
  const bottom = pointsToPixels(frame.y + frame.height, pointScale, 'ceil');
  return { x, y, w: right - x, h: bottom - y };
}

/** shot 舞台等比吃滿原圖寬度時，一個舞台高等於多少原圖像素。 */
export function sourceViewportHeightPx(imageWidthPx, stageWidthPx = 984, stageHeightPx = 1096) {
  if (![imageWidthPx, stageWidthPx, stageHeightPx].every(finite)
      || imageWidthPx <= 0 || stageWidthPx <= 0 || stageHeightPx <= 0) {
    throw new TypeError('imageWidthPx／stageWidthPx／stageHeightPx 必須是正數');
  }
  return stageHeightPx / (stageWidthPx / imageWidthPx);
}

/**
 * 求 cropTop 的整數可行帶。
 *
 * 條件：
 *  - cropTop >= stickyBottomPx，讓即時 sticky 頁首完整在窗外；
 *  - 每個 required frame（歷史日期框與 OHLC，或 revenue focus）都完整落在
 *    [cropTop, cropTop + viewportHeightPx]；
 *  - 視窗不超出原圖底部。
 */
export function computeCropTopBand({
  stickyBottomPx,
  requiredFramesPx,
  viewportHeightPx,
  imageHeightPx,
}) {
  if (![stickyBottomPx, viewportHeightPx, imageHeightPx].every(finite)
      || stickyBottomPx < 0 || viewportHeightPx <= 0 || imageHeightPx <= 0) {
    throw new TypeError('stickyBottomPx 必須 >= 0，viewportHeightPx／imageHeightPx 必須 > 0');
  }
  if (!Array.isArray(requiredFramesPx) || !requiredFramesPx.length) {
    throw new TypeError('requiredFramesPx 至少要有一個 frame');
  }
  for (const frame of requiredFramesPx) {
    if (!frame || ![frame.y, frame.h].every(finite) || frame.y < 0 || frame.h <= 0) {
      throw new TypeError(`required frame 不合法：${JSON.stringify(frame)}`);
    }
  }

  const requiredTopPx = Math.min(...requiredFramesPx.map((frame) => frame.y));
  const requiredBottomPx = Math.max(...requiredFramesPx.map((frame) => frame.y + frame.h));
  const minCropTopPx = Math.max(
    0,
    Math.ceil(stickyBottomPx),
    Math.ceil(requiredBottomPx - viewportHeightPx),
  );
  const maxCropTopPx = Math.min(
    Math.floor(requiredTopPx),
    Math.floor(imageHeightPx - viewportHeightPx),
  );
  const feasible = minCropTopPx <= maxCropTopPx;
  return {
    feasible,
    minCropTopPx,
    maxCropTopPx,
    cropTopPx: feasible ? minCropTopPx : null,
    requiredTopPx,
    requiredBottomPx,
    viewportHeightPx,
  };
}

export function asOfFileSuffix(asOf) {
  const normalized = normalizeIsoDate(asOf);
  if (!normalized) throw new TypeError(`asOf 不是有效的 YYYY-MM-DD：${asOf}`);
  return `${normalized.slice(5, 7)}${normalized.slice(8, 10)}`;
}
