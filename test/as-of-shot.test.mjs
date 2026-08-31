import test from 'node:test';
import assert from 'node:assert/strict';
import {
  axDateMatchesDataAsOf,
  axDateToIso,
  computeCropTopBand,
  framePointsToPixels,
  normalizeIsoDate,
  pointsToPixels,
  sourceViewportHeightPx,
} from '../stages/lib/as-of-shot.mjs';

test('as-of 日期只接受實際存在的 canonical YYYY-MM-DD', () => {
  assert.equal(normalizeIsoDate('2026-08-28'), '2026-08-28');
  assert.equal(normalizeIsoDate('2024-02-29'), '2024-02-29');
  for (const bad of ['2026/08/28', '26-08-28', '2026-02-29', '2026-13-01', '2026-00-10', '2026-08-32']) {
    assert.equal(normalizeIsoDate(bad), null, bad);
  }
});

test('AX YYYY/MM/DD 會正規化後與 dataAsOf 精確比對', () => {
  assert.equal(axDateToIso('2026/08/28'), '2026-08-28');
  assert.equal(axDateMatchesDataAsOf('2026/08/28', '2026-08-28'), true);
  assert.equal(axDateMatchesDataAsOf('2026/08/29', '2026-08-28'), false);
  assert.equal(axDateMatchesDataAsOf('2026/02/29', '2026-02-28'), false);
});

test('points→px 使用實機 3x scale 並支援保守進位', () => {
  assert.equal(pointsToPixels(86, 3), 258);
  assert.equal(pointsToPixels(56.3333333333, 3, 'floor'), 168);
  assert.equal(pointsToPixels(56.3333333333, 3, 'ceil'), 169);
});

test('AX frame 轉像素時向外包住小數邊界', () => {
  assert.deepEqual(
    framePointsToPixels({ x: 8.1, y: 284.1, width: 36.2, height: 15.1 }, 3),
    { x: 24, y: 852, w: 109, h: 46 },
  );
});

test('1206px 寬截圖在 984×1096 舞台的可見窗約 1343px', () => {
  const height = sourceViewportHeightPx(1206);
  assert.ok(Math.abs(height - 1343.26) < 0.01, String(height));
});

test('cropTop 可行帶同時排除 sticky 並保留日期框與 OHLC', () => {
  const band = computeCropTopBand({
    stickyBottomPx: 648.1,
    requiredFramesPx: [
      { x: 20, y: 820, w: 260, h: 42 },
      { x: 24, y: 853, w: 790, h: 45 },
    ],
    viewportHeightPx: sourceViewportHeightPx(1206),
    imageHeightPx: 2622,
  });
  assert.equal(band.feasible, true);
  assert.equal(band.cropTopPx, 649);
  assert.ok(band.cropTopPx >= 648.1);
  assert.ok(band.cropTopPx <= 820);
  assert.ok(band.cropTopPx + band.viewportHeightPx >= 898);
});

test('sticky 下緣高過日期框時 cropTop 無解', () => {
  const band = computeCropTopBand({
    stickyBottomPx: 900,
    requiredFramesPx: [{ x: 20, y: 820, w: 260, h: 42 }],
    viewportHeightPx: 1343,
    imageHeightPx: 2622,
  });
  assert.equal(band.feasible, false);
  assert.equal(band.cropTopPx, null);
  assert.ok(band.minCropTopPx > band.maxCropTopPx);
});
