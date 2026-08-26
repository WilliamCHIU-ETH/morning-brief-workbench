# 產線階段與穩定性缺口

## 核心判斷

**重跑同一串指令不會得到 V4c 品質。**
V4c 是六個版本、四輪人工 audit 的結果；機器時間約 8 分鐘，其餘全在 audit 迴圈。
被人眼抓到的是：頂欄壓住主播的頭、標題板傾斜且與 B-roll 同色、主播的手一直上下擺、
字幕以句號結尾、B-roll 早於語音、第一格素材蓋掉問候。

因此 harness 的目標不是「把步驟串起來」，而是
**把 V4c 量到的數字寫成 gate，讓不到水準的那一支被機器擋下來。**
門檻見 `contracts/acceptance.json`。

## 階段

| # | 階段 | 決定性 | 現況 |
|---|---|---|---|
| 1 | 講稿撰寫 | 人 | 規則在 `晨報腳本_ROLE.md`，全部是散文，靠人工 audit |
| 2 | 講稿 lint | 程式（待寫） | **缺口**：字數／hook 位置／無 CTA／時間詞重複／小數點／價格點位都可機檢 |
| 3 | 主播影片生成 | 付費＋可能人工 | **見下方分岔**。V4c 走網頁 Studio，不是 API |
| 4 | 加速（1.1×） | 程式 | `setpts`／`atempo` ＋ `-r 30`。必須守 fps gate |
| 5 | ASR | 程式 | `whisper-cli -ml 1 -ojf` → `normalize-whispercpp.js` |
| 6 | 強制對齊 | 程式 | `align-script-v4n.mjs`，Needleman-Wunsch，逐字時間 |
| 7 | segment ledger | 程式＋人 | `build-segment-ledger-v4.mjs`。**anchor 與 responsibility 目前是手寫 9 格表** |
| 8 | caption ledger | 程式 | `build-caption-ledger-v4.mjs`。語意停頓貼齊、短字幕合併、去尾標點、長字幕降字級 |
| 9 | B-roll prompt | 人 | 兩階段契約：散文 200–300 字、5 行；生成只讀 `prompt.txt` |
| 10 | MG 生成與 check | 程式 | `npx --yes hyperframes@0.8.3`，每格 0 error |
| 11 | 主場景組裝 | 程式 | `build-main-v4.mjs` ＋ `comp-shell-916-v4.mjs` |
| 12 | 定格 QA | 程式＋人 | `qa-frames.sh`。prompt 為真，畫面不符就重生成 |
| 13 | 成片渲染 | 程式 | |

## 分岔已解（2026-08-27 驗證）

**API 有 motion_prompt,不需要走網頁 Studio。** 而且 V3 那次已經送過這個欄位。

`POST /v3/videos`,`engine.type = avatar_iv`,支援 `motion_prompt`（自然語言）
與 `expressiveness`（high／medium／low,**預設 low**）。鎖定參數見 `contracts/avatar-generation.json`。

V3 手一直擺是兩個參數同時錯:

| 欄位 | V3 送的 | 該送的 | 問題 |
|---|---|---|---|
| `motion_prompt` | 站姿自然,雙手在胸前或身側做出適度自然的手勢,配合語氣比劃… | `Seated with hands resting on the desk, barely move.` | 對坐姿主播下站姿指令,而且明確要求手勢 |
| `expressiveness` | `medium` | `low` | API 預設就是 low,我們主動調高 |

官方的寫法規則:`[身體部位] + [動作] + [情緒／強度]`,**不超過兩個短句**,一次一個手勢;
靜止的關鍵詞是 `no hand gestures`／`hands still`／`barely move`／`less expressive`。
V4c 用的那句正好是兩個短句並命中兩個關鍵詞。

**附帶發現:語速不必用 ffmpeg。** v3 有 `voice_settings.speed`（0.5–2.0）,
`app/run.js:645` 已經記著「調語速不必再靠 ffmpeg 硬壓」,但 V3 是手寫 payload 沒帶,
V4 走 Studio 也沒帶。在生成端改速就沒有重複格（ffmpeg 1.1× 會複製 8.3% 的格）、
沒有二次編碼、也沒有 Studio 與 API 的 10.6% 偏差。
**代價是每秒字數要重新量**——TTS 改速是重新合成而非時間拉伸,換算表不可直接套用。

## 已修：版本後綴與過期 artifact

**規則：版本用目錄分，不用檔名後綴。** 一個 project 目錄只放一個 revision，
檔名一律 canonical（`segment-ledger.json`，不是 `segment-ledger.v4.json`）。
`stages/lib/project.mjs` 的 `resolveProject()` 會掃描目錄，發現任何 `.vN` 檔名就拒絕執行。

當天的實例：`comp-shell` 讀死 `segment-ledger.json`，而 V4 的 writer 寫的是
`segment-ledger.v4.json`，於是它靜默讀到還留在原地的 V1 12 格表，MG 長度全錯
（2.93／2.57／5.53／3.33s）。專案裡當時同時存在 **8 個 segment-ledger、4 個
caption-ledger、4 個 asr 目錄**。

canonical 檔名只解決「讀錯檔」，不解決「讀到過期的對檔」（講稿改了但 ledger 沒重建），
所以每個產出的 artifact 都有一份 sidecar `<artifact>.provenance.json`，記錄它每個輸入的
SHA-256；下游讀取時驗證，不符就爆掉並指名要重跑哪一階段。

各階段一律吃 `--project <dir>`，不再從 `__dirname/..` 猜專案位置。

## Gate runner

```bash
npm run gates -- --project <dir>
```

跑 `contracts/acceptance.json` 的 16 道 gate，寫出 `gate-report.json`，有 failed 就 exit 1。

三個原則：

- **不靜默通過。** 缺 artifact 的 gate 是 `skipped` 並寫明缺什麼，不算 pass。
- **門檻只在 `acceptance.json` 定義一次。** runner 只實作量測。
- **量測定義寫進報告。** 例如 `caption.snap-to-cuts` 的定義是「內部 B-roll 切點中有字幕邊界
  落在 ±0.02s 內的比率」，方向刻意是「每次場景切換都要有字幕跟著換」。
  V4c 以此定義是 8/8 = 1.000；先前紀錄的 17/18 = 0.944 是另一種數法，兩者不可互換。

講稿層的四道 gate 委派給 `lint-script.mjs`，不重複實作規則。

### 反例覆蓋

`fixtures/` 有三個真實 fixture，測試斷言的是「當天人眼抓到的缺陷，現在機器抓得到」：

| fixture | 結果 |
|---|---|
| `project-v4c` | 12 passed、0 failed、3 skipped、2 manual |
| `project-v2-noform` | ledger 那五道 **error**——缺 `form` 欄位就量不出覆蓋率，不能給出好看的數字 |
| `project-v2-allmg` | 覆蓋率 0.969、交替 M×12、連續素材 58.66s、字幕尾標點 25 條、貼齊 0/11，全部 failed |

建 fixture 時抓到 runner 自己兩個 bug：缺 `form` 時 undefined 被當成 presenter
（覆蓋率算出 0 而完美通過）；零個 presenter 格時 `Math.min([])` 回 `Infinity` 而通過。
兩者都已修並有測試鎖住。

## 仍然開著的不穩定來源


1. **fps 未設。** `app/run.js` 加速時沒設 `-r`，輸出留在輸入 fps。
   25×1.2=30 時丟掉 16.6% 的格。規則：**輸出 fps ≥ 輸入 fps × 速度倍率**。
2. **借來的素材。** `data/assets/台股晨報/` 曾是 `data/assets/焦點股日報/` 的逐位元組複製
   （四個檔 SHA-256 相同），因此烙印著「盤後日報」、頂欄 386px 蓋住主播頭 91px、
   對坐姿主播用站姿 motion prompt。**根因是沿用未經重新驗證的前提。**
3. **手寫 9 格表。** segment ledger 的 anchor 與 responsibility 是針對這一份講稿手寫的。
   換講稿就要重寫，且沒有機制保證仍然 P/M 交替。
