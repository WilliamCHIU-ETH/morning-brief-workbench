/**
 * 讀本 repo 自己的 .env。
 *
 * 刻意不用 dotenv 套件——這個 repo 的 node_modules 是空的，為了一個 15 行的
 * 解析器裝一個依賴不划算，而且 npm install 會變成跑起來的前置條件。
 *
 * 金鑰**不進版控**（.gitignore 有 .env）。workbench 與 marketing-video 是兩個
 * 互不依賴的實作，各自持有一份 .env——**不要去對方那裡讀金鑰**，那會把解耦破掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return { loaded: false, file };
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // 已經在環境裡的優先，讓一次性覆寫（HEYGEN_API_KEY=... npm run ...）仍然有效
    if (process.env[k] === undefined) { process.env[k] = v; n += 1; }
  }
  return { loaded: true, file, count: n };
}

/** 取必要金鑰；缺的時候給的是「怎麼補」，不是「找不到」。 */
export function requireEnv(name, hint) {
  loadEnv();
  const v = (process.env[name] || '').trim();
  if (v) return v;
  console.error(`缺少 ${name}。`);
  console.error(`本 repo 從自己的 .env 讀金鑰（已 gitignore）。補法：`);
  console.error(`  cp .env.example .env   然後把值填進去`);
  console.error(`或單次覆寫：  ${name}=xxx npm run <script> -- --project <dir>`);
  if (hint) console.error(hint);
  console.error('**不要去 marketing-video 讀它的 .env。** 兩個 repo 刻意互不依賴，各自持有一份。');
  process.exit(5);
}
