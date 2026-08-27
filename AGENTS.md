# 給 agent 的入口

你在 `morning-brief-harness`。**這裡是台股晨報短影音的驗收與生成 harness，不是完整產線。**

## 這裡做得到什麼

| 做得到 | 指令 |
|---|---|
| 檢查講稿是否合格 | `npm run lint:script <project>/script.txt` |
| 從講稿推導切段結構 | `npm run plan -- --project <dir> --write` |
| 挑 MG 版型、抽資料、產出 composition | `node stages/plan-mg.mjs --project <dir> --write` |
| 跑 28 道驗收門檻 | `npm run gates -- --project <dir>` |
| 對齊、字幕、組裝（**需要主播影片**） | `stages/align-script.mjs` → `build-segment-ledger` → `build-caption-ledger` → `build-main` |

## 這裡做不到什麼

**不要試，會白費時間：**

- **docx → 講稿。** 沒有解析器，沒有選型規則。講稿是你寫的。
- **HeyGen 主播生成。** 沒有金鑰、沒有呼叫程式。付費授權必須由使用者在
  `marketing-video/app` 那邊執行，不在這裡。
- **ffmpeg 加速、最終渲染、產出 mp4。** 同上。
- **實機截圖（Simulator）。** 一行程式都沒有，而且現行講稿沒有它的落點。

所以你能做的是**付費之前的那一半**：講稿 → 切段 → 版面 → 驗收。那也是價值最高的一半，
因為 2026-08-26 那六個版本的迭代成本幾乎全花在這裡。

## 開一支新影片的順序

```bash
# 1. 建 project 目錄。檔名必須 canonical，不得帶版本後綴（.v1/.v4 會被拒絕執行）
mkdir -p projects/20260827-<主題>
$EDITOR projects/20260827-<主題>/script.txt

# 2. 講稿必須 0 error 才往下走
npm run lint:script projects/20260827-<主題>/script.txt

# 3. 推導切段。先不給 hint，看它產出什麼
npm run plan -- --project projects/20260827-<主題> --write

# 4. 不滿意就寫 plan-hints.json（哪幾句必須在主播臉上），重跑 3
#    {"presenter": ["那句話的一部分", "另一句"]}

# 5. 填 segment-plan.json 裡每個 mg 格的 responsibility（程式不代填，那是編輯意圖）

# 6. 產出 MG composition
node stages/plan-mg.mjs --project projects/20260827-<主題> --write

# 7. 驗收
npm run gates -- --project projects/20260827-<主題>
```

第 7 步在付費之前跑得到 22 道；另外 6 道需要主播影片與 ASR，那時才驗得了。

## 講稿的格式

```
===
MM/DD 台股晨報
<第二行自由，通常寫主題>
===
<第一句必須是問句，這是 HOOK>

早安，親愛的投資人。<昨日台股與昨晚美股，一句>

<其餘段落，段落之間空一行>
```

lint 會檢查標題第一行必須是 `MM/DD 台股晨報`。
**上游 docx 的標題常寫「籌碼K晨報」——那是舊名，照抄會被擋，不是 bug。**

字數目標 200–260 clean 字（對應片長 42–55 秒）。字數怎麼算以
`stages/script-utils.js` 的 `cleanBodyWithIndex` 為準，不要自己數。

## 規格層不在這個 repo

講稿的寫作規則（角色設定、三種腳本類型、禁用寫法、資訊正確性）在
`marketing-video/晨報腳本_ROLE.md`；字數與片長換算在 `marketing-video/晨報講稿時長換算表.md`。
**本 repo 只有它們之中可機檢的部分**（見 `stages/lint-script.mjs`）。

lint 通過不等於講稿好。它擋的是形式錯誤，不是內容平淡。

## 錯誤訊息怎麼讀

錯誤訊息刻意寫成「這是什麼、為什麼不行、下一步做什麼」。幾個常見的：

- `project 目錄裡有帶版本後綴的檔案` → 版本用目錄分，不用檔名後綴。刪掉或改名。
- `segment-plan.json 已過期，輸入變了但沒有重建` → 講稿改過了，重跑 `plan-segments.mjs`。
- `plan-hints.json 的 presenter「X」比對到 2 個分句` → hint 寫得更精確。
- `只規劃出 N 個素材格（下界 3）` → 講稿太短或硬性主播分句佔比太高。**改講稿，不要改門檻。**
- gate 顯示 `略過` 而不是 `通過` → 該階段還沒到。**略過不算通過**，退出碼會反映。

## 不要做的事

- **不要改 `contracts/acceptance.json` 的門檻來讓自己的產出通過。** 每一道門檻都附了它是被
  什麼事故逼出來的；改門檻等於把那次事故放回來。真的該改就先說明新的量測來源。
- **不要在 `fixtures/` 底下工作。** 那是黃金樣本與 12 個攻擊樣本，測試靠它們。
- **不要進 `marketing-video/app`。** 那邊由別的 session 持有。
