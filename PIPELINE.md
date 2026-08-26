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

## 開著的分岔（會改變 harness 形狀）

**V4c 的主播影片是 HeyGen 網頁 Studio 生成的，不是 API。**
手勢收斂（手部動作 −18%）來自 Avatar IV 的 motion prompt，該欄位目前只確認存在於
網頁的 Avatar → Motion Engine → Avatar IV → Advanced Settings。

- 若 API v2 有等效欄位 → harness 可一鍵到成片。
- 若沒有 → 第 3 階段是人工關：harness 產出講稿與生成參數 → 人到網頁生成 → 影片丟回 → 之後全自動。

**未驗證之前不要假設可以全自動。** 另外 Studio 的語速比 API 快 10.6%，
`晨報講稿時長換算表.md` 是以 API 路徑校準的，走 Studio 必須重新校準。

## 已知的不穩定來源

1. **版本後綴漂移。** `comp-shell-916.mjs` 讀死 `segment-ledger.json`，而 V4 的檔名是
   `segment-ledger.v4.json`。今天因此靜默讀到 V1 的 12 格表，MG 長度全錯
   （2.93／2.57／5.53／3.33s）。harness 必須把 ledger 路徑參數化，不得用檔名區分版本。
2. **fps 未設。** `app/run.js` 加速時沒設 `-r`，輸出留在輸入 fps。
   25×1.2=30 時丟掉 16.6% 的格。規則：**輸出 fps ≥ 輸入 fps × 速度倍率**。
3. **借來的素材。** `data/assets/台股晨報/` 曾是 `data/assets/焦點股日報/` 的逐位元組複製
   （四個檔 SHA-256 相同），因此烙印著「盤後日報」、頂欄 386px 蓋住主播頭 91px、
   對坐姿主播用站姿 motion prompt。**根因是沿用未經重新驗證的前提。**
4. **手寫 9 格表。** segment ledger 的 anchor 與 responsibility 是針對這一份講稿手寫的。
   換講稿就要重寫，且沒有機制保證仍然 P/M 交替。
