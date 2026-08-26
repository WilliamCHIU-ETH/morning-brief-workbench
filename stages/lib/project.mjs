/**
 * 專案路徑解析與 artifact provenance。
 *
 * 兩條規則，都是為了消滅 2026-08-26 那個 class 的錯誤：
 *
 * 1. **版本用目錄分，不用檔名後綴。** 每個 project 目錄只放一個 revision 的 artifact，
 *    檔名一律 canonical（segment-ledger.json，不是 segment-ledger.v4.json）。
 *    當天的實例：comp-shell 讀死 `segment-ledger.json`，而 V4 的 writer 寫的是
 *    `segment-ledger.v4.json`，於是它靜默讀到還留在原地的 V1 12 格表，MG 長度全錯
 *    （2.93／2.57／5.53／3.33s）。專案裡當時同時存在 8 個 segment-ledger 變體。
 *
 * 2. **每個 artifact 的輸入 SHA-256 寫在 sidecar，下游驗證。** canonical 檔名只解決
 *    「讀錯檔」，不解決「讀到過期的對檔」——例如講稿改了但 ledger 沒重建。
 *
 * provenance 一律走 sidecar（`<artifact>.provenance.json`），不塞進 artifact 本體，
 * 因為 segment-ledger 與 caption-ledger 的 schema 有下游 validator 在看。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CANONICAL = {
  script: 'script.txt',
  segmentPlan: 'segment-plan.json',
  avatarRaw: 'avatar/raw.mp4',
  avatarSpeeded: 'avatar/speeded.mp4',
  asrRaw: 'asr/subtitles.raw.json',
  charTimes: 'asr/script-char-times.json',
  segmentLedger: 'segment-ledger.json',
  assemblyLedger: 'segment-ledger-assembly.json',
  captionLedger: 'caption-ledger.json',
  layout: 'template/layout.json',
  mainConfig: 'main.config.json',
  brollProvenance: 'broll/broll-provenance.json',
  gateReport: 'gate-report.json',
};

const SUFFIX_RE = /\.(v\d+[a-z]?)([-.])/;

export function resolveProject(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--project');
  const raw = i >= 0 ? argv[i + 1] : process.env.MB_PROJECT;
  if (!raw) throw new Error('缺少 --project <dir>（或環境變數 MB_PROJECT）');
  const root = path.resolve(raw);
  if (!fs.existsSync(root)) throw new Error(`project 目錄不存在：${root}`);
  const suffixed = fs.readdirSync(root).filter((f) => SUFFIX_RE.test(f));
  if (suffixed.length) {
    throw new Error(
      `project 目錄裡有帶版本後綴的檔案，違反「版本用目錄分」：\n  ${suffixed.join('\n  ')}\n` +
      '每個 project 目錄只放一個 revision。');
  }
  return {
    root,
    path: (key) => path.join(root, CANONICAL[key] ?? key),
    rel: (key) => CANONICAL[key] ?? key,
    sidecar: (key) => path.join(root, `${CANONICAL[key] ?? key}.provenance.json`),
  };
}

export const sha256File = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 讀 JSON artifact，若有 sidecar 就驗新鮮度。 */
export function readJson(P, key, { verify = true } = {}) {
  const file = P.path(key);
  if (!fs.existsSync(file)) throw new Error(`缺少 artifact：${P.rel(key)}`);
  if (verify) requireFresh(P, key);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 驗證 artifact 宣告的輸入還是同一份；沒有 sidecar 就跳過（例如人工維護的檔）。 */
export function requireFresh(P, key) {
  const side = P.sidecar(key);
  if (!fs.existsSync(side)) return { checked: false, reason: 'no-sidecar' };
  const prov = JSON.parse(fs.readFileSync(side, 'utf8'));
  const stale = [];
  for (const inp of prov.inputs ?? []) {
    const f = path.join(P.root, inp.path);
    if (!fs.existsSync(f)) { stale.push(`${inp.path}（已消失）`); continue; }
    if (sha256File(f) !== inp.sha256) stale.push(`${inp.path}（已變更）`);
  }
  if (stale.length) {
    throw new Error(
      `${P.rel(key)} 已過期，輸入變了但沒有重建：\n  ${stale.join('\n  ')}\n` +
      `重跑 ${prov.generatedBy ?? '產生它的那一階段'}。`);
  }
  return { checked: true, inputs: prov.inputs.length };
}

/** 寫 JSON artifact（物件或陣列都可），provenance 進 sidecar。 */
export function writeJson(P, key, data, { inputs = [], generatedBy } = {}) {
  const file = P.path(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  fs.writeFileSync(P.sidecar(key), `${JSON.stringify({
    artifact: P.rel(key),
    generatedBy: generatedBy ?? path.basename(process.argv[1] ?? 'unknown'),
    inputs: inputs.map((k) => {
      const rel = P.rel(k);
      const f = path.join(P.root, rel);
      if (!fs.existsSync(f)) throw new Error(`宣告的輸入不存在：${rel}`);
      return { path: rel, sha256: sha256File(f), bytes: fs.statSync(f).size };
    }),
  }, null, 2)}\n`);
  return file;
}
