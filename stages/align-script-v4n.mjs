// Forced alignment: script.v3-final-b.txt (truth) x ASR char timings -> scriptCharTimes.json
// 與 app/scripts/correct-subtitles.js 同法（Needleman-Wunsch 全域對齊），
// 但只寫進本 project，不碰 app/src。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getBodyAfterVoice, cleanBodyWithIndex } =
  require('/Users/chiu/Developer/marketing-video/app/scripts/script-utils.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DURATION = Number(process.argv[2]);
if (!Number.isFinite(DURATION)) throw new Error('usage: align-script.mjs <durationSec>');

const raw = fs.readFileSync(path.join(root, 'script/script.v4-nocta.txt'), 'utf8');
const scriptChars = cleanBodyWithIndex(getBodyAfterVoice(raw)); // [{ch, origIdx}]
const S = scriptChars.map((c) => c.char);

const asr = JSON.parse(fs.readFileSync(path.join(root, 'asr-v4n/subtitles.raw.json'), 'utf8'));
const isContent = (ch) => /[\p{L}\p{N}]/u.test(ch);
const A = [];
for (const seg of asr.segments) {
  for (const w of (seg.words || [])) {
    for (const ch of [...String(w.word)]) {
      if (isContent(ch)) A.push({ ch, start: w.start, end: Math.max(w.end, w.start) });
    }
  }
}

// Needleman-Wunsch
const n = S.length, m = A.length;
const GAP = -1, MATCH = 2, MISS = -1;
const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
const bt = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1=diag 2=up(script gap) 3=left(asr gap)
for (let i = 1; i <= n; i++) { dp[i][0] = i * GAP; bt[i][0] = 2; }
for (let j = 1; j <= m; j++) { dp[0][j] = j * GAP; bt[0][j] = 3; }
for (let i = 1; i <= n; i++) {
  for (let j = 1; j <= m; j++) {
    const d = dp[i - 1][j - 1] + (S[i - 1] === A[j - 1].ch ? MATCH : MISS);
    const u = dp[i - 1][j] + GAP;
    const l = dp[i][j - 1] + GAP;
    let best = d, dir = 1;
    if (u > best) { best = u; dir = 2; }
    if (l > best) { best = l; dir = 3; }
    dp[i][j] = best; bt[i][j] = dir;
  }
}
const times = new Array(n).fill(null);
let i = n, j = m, matched = 0;
while (i > 0 || j > 0) {
  const dir = i === 0 ? 3 : j === 0 ? 2 : bt[i][j];
  if (dir === 1) { times[i - 1] = { start: A[j - 1].start, end: A[j - 1].end }; if (S[i-1]===A[j-1].ch) matched++; i--; j--; }
  else if (dir === 2) { i--; }
  else { j--; }
}
// interpolate script chars that got no ASR anchor
for (let k = 0; k < n; k++) {
  if (times[k]) continue;
  let p = k - 1; while (p >= 0 && !times[p]) p--;
  let q = k + 1; while (q < n && !times[q]) q++;
  const lo = p >= 0 ? times[p].end : 0;
  const hi = q < n ? times[q].start : DURATION;
  const span = Math.max(hi - lo, 0.01);
  const gapCount = (q < n ? q : n) - (p >= 0 ? p + 1 : 0);
  const idx = k - (p >= 0 ? p + 1 : 0);
  times[k] = { start: lo + (span * idx) / gapCount, end: lo + (span * (idx + 1)) / gapCount, interpolated: true };
}
// enforce monotonic
for (let k = 1; k < n; k++) if (times[k].start < times[k - 1].start) times[k].start = times[k - 1].start;

const out = scriptChars.map((c, k) => ({
  i: k, ch: c.char, origIdx: c.origIdx, breakAfter: Boolean(c.breakAfter),
  start: Number(times[k].start.toFixed(3)),
  end: Number(times[k].end.toFixed(3)),
  ...(times[k].interpolated ? { interpolated: true } : {}),
}));
fs.writeFileSync(path.join(root, 'asr-v4n/script-char-times.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({
  scriptChars: n, asrChars: m, exactMatches: matched,
  matchRate: Number((matched / n).toFixed(4)),
  interpolated: out.filter((x) => x.interpolated).length,
  firstCharStart: out[0].start, lastCharEnd: out.at(-1).end, videoDuration: DURATION,
}, null, 2));
