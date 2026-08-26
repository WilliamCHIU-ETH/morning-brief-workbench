# morning-brief-harness

台股晨報 9:16 短影音的產線 harness。**單一輸入型別、單一輸出型別。**

- 輸入：台股晨報（當日晨報文字／docx ＋ 目標個股代號）
- 輸出：成片 `.mp4`（1080×1920、30fps）
- 品質基準：`PROD-0821-DINGYUAN-V4c`（2026-08-26）

## 為什麼獨立成一個 repo

`marketing-video/app` 目前在 `seams` 分支重構中（另一個 session 持有，`run.js`／`.gitignore`／`AGENTS.md` 有未提交修改）。
在那裡動會撞車。

這裡從第一天就 `git init`，不重複 `marketing-video/CLAUDE.md` 記過的地雷：
**未納版控的目錄（PROD-003、EXP-008、EXP-009、CHECK-01-CORLEO）隨時會消失**，
所以 harness 不 symlink 借用任何外部 `node_modules`，字型也自帶（`assets/fonts/`，
`marketing-video` 的 `public/NotoSansTC-*.ttf` 被 `.git/info/exclude` 排除，乾淨 clone 會缺字型）。

## 這裡的東西從哪來

| 路徑 | 來源 | 狀態 |
|---|---|---|
| `stages/*-v4*.mjs` | `project-20260825-120500-dingyuan-0821/scripts/` | V4c 實際用的版本，尚未去版本後綴 |
| `stages/script-utils.js`、`normalize-whispercpp.js` | `app/scripts/` | canonical 祖本，未改動 |
| `template/layout.json` | 專案 template | 含 V4c 的 brandWash／程式畫開場卡／titleBoard |
| `reference/` | 專案根 | V4c 的 segment／caption ledger 與定版講稿，當回歸基準 |
| `contracts/acceptance.json` | 本 repo 新寫 | 16 道自動 gate，門檻取自 V4c 實測 |

`app/` 那邊該回推的東西記在 `marketing-video/HANDOFF-app-2026-08-26.md`，
與這個 repo 是兩條路：**harness 先跑通，再決定哪些回推。**
