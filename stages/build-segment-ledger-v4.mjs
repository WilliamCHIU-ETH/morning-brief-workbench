// V3 切段：以講稿文字錨點 → script-char-times.json 的真實時間。
// 欄位依 SKILL.md「切段規則」：id / startSec / endSec / anchor / responsibility。
// 額外帶 form（mg｜presenter｜device），因為 V3 的重點是覆蓋率而非只有切點。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DURATION = Number(process.argv[2]);
const chars = JSON.parse(fs.readFileSync(path.join(root, 'asr-v4n/script-char-times.json'), 'utf8'));
const clean = chars.map((c) => c.ch).join('');

const PLAN = [
  ['01', 'presenter', '鼎元昨天鎖上漲停74.8元今天還能追嗎早安親愛的投資人',           'HOOK＋問候：問候是人講的品牌時刻，不得被圖表蓋掉'],
  ['02', 'mg',        '昨日台股只漲214點美股道瓊還重挫703點',                        '建立漲停與大盤不強的矛盾'],
  ['03', 'presenter', '大盤沒有特別強錢是選擇性地進去的那市場選了什麼市場買的是光通訊放量', '把矛盾收成判斷，丟出問題並自己回答'],
  ['04', 'mg',        'AI資料中心與CPO需求升溫鼎元的光通訊產品下半年進入放量階段',   '說明需求從哪裡來'],
  ['05', 'presenter', '基本面也接得上產品組合正從LED轉向光通訊',                      '轉向基本面，建立利多印象'],
  ['06', 'mg',        '公司規劃投入12億元擴產不過這裡有個時間差',                     '給出投入規模，並把時間差視覺化'],
  ['07', 'presenter', '擴產要蓋客戶要認證產品要真的出貨這三件都還在進行放量沒發生題材就只是題材', '揭露代價，全片最強的反轉'],
  ['08', 'mg',        '所以今天先看兩件事光通訊族群有沒有一起轉強鼎元的量能有沒有延續', '給出今天可驗證的兩個觀察點'],
  ['09', 'presenter', '只剩題材量能跟不上就先不要追價',                              '風險附具體行動'],
];

let cursor = 0;
const segments = PLAN.map(([id, form, anchor, responsibility]) => {
  const at = clean.indexOf(anchor, cursor);
  if (at < 0) throw new Error(`錨點找不到：${id} ${anchor.slice(0, 12)}…（cursor=${cursor}）`);
  if (at !== cursor) throw new Error(`錨點不連續：${id} 期望 ${cursor} 實得 ${at}`);
  const endIdx = at + anchor.length - 1;
  cursor = endIdx + 1;
  return { id, form, startSec: chars[at].start, endSec: chars[endIdx].end, anchor, responsibility };
});
// CTA 已從成片裁掉，講稿尾段不再覆蓋；只檢查切點連續
console.log(`覆蓋字元 ${cursor}/${clean.length}（尾段 ${clean.length-cursor} 字為已裁掉的 CTA）`);

// 相鄰格首尾接合：後一格起點 = 前一格終點，避免縫隙
for (let i = 1; i < segments.length; i++) segments[i].startSec = segments[i - 1].endSec;
segments[0].startSec = 0;
segments[segments.length - 1].endSec = DURATION;

segments.forEach((s) => { s.durationSec = +(s.endSec - s.startSec).toFixed(3); });

const total = DURATION;
const sum = (f) => segments.filter((s) => s.form === f).reduce((a, s) => a + (s.endSec - s.startSec), 0);
const cover = { mg: sum('mg'), presenter: sum('presenter'), device: sum('device') };
const out = { durationSec: total, visualForm: 'fullframe', coverage: {
  mgSec: +cover.mg.toFixed(2), deviceSec: +cover.device.toFixed(2), presenterSec: +cover.presenter.toFixed(2),
  materialPct: +(((cover.mg + cover.device) / total) * 100).toFixed(1),
  presenterPct: +((cover.presenter / total) * 100).toFixed(1),
}, segments };
fs.writeFileSync(path.join(root, 'segment-ledger.v4.json'), JSON.stringify(out, null, 2) + '\n');

console.log('id form      start    end     秒    責任');
for (const s of segments) {
  console.log(`${s.id} ${s.form.padEnd(9)} ${s.startSec.toFixed(2).padStart(6)} ${s.endSec.toFixed(2).padStart(6)} ${(s.endSec - s.startSec).toFixed(2).padStart(5)}  ${s.responsibility}`);
}
console.log('---');
console.log(JSON.stringify(out.coverage));
