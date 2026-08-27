# 給 agent 的入口

你在 `morning-brief-harness`。**目標是在這個目錄底下一口氣做完一支台股晨報短影音**——
講稿、切段、動態圖卡、主播、字幕、組裝、渲染——中間只有一道人工關卡：核准付費的主播生成。

## 這裡做得到什麼

| 做得到 | 指令 |
|---|---|
| 檢查講稿是否合格 | `npm run lint:script <project>/script.txt` |
| 從講稿推導切段結構 | `npm run plan -- --project <dir> --write` |
| 挑 MG 版型、抽資料、產出 composition | `node stages/plan-mg.mjs --project <dir> --write` |
| 跑 28 道驗收門檻 | `npm run gates -- --project <dir>` |
| 主播生成（**唯一付費步驟，見下方協定**） | `node stages/heygen.mjs --project <dir> dryrun` |
| 加速主播影片 | `npm run speedup -- --project <dir>` |
| ASR 逐字時間 | `npm run asr -- --project <dir>` |
| 對齊、字幕、組裝 | `stages/align-script.mjs` → `build-segment-ledger` → `build-caption-ledger` → `build-main` |
| 渲染 MG 與成片 | `npm run render -- --project <dir> all` |

## 這裡不做什麼

這兩件是**使用者裁定不做**，不是還沒做：

- **docx → 講稿的選型。** 沒有解析器，也沒有「個股／族群／時事」的挑選規則。講稿是你寫的。
- **實機截圖（Simulator）。** 一行程式都沒有，而且現行講稿沒有它的落點
  （提到 App 功能的句子是 0 句）。

其餘沒提到的都在這裡。**如果你發現某個階段缺了，那是差距，不是邊界——回報它，不要繞路去
`marketing-video` 找。** 那是一條平行的實作，不是這條線的上游。

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

第 7 步在付費之前**只跑得到 10 道**（講稿 5、plan 5）。其餘 18 道需要主播影片與 ASR。

> 黃金樣本 `fixtures/project-v4c` 顯示「通過 22」，是因為它已經有 `asr/` 與 ledger。
> **不要拿那個數字當新專案的期待值。**

退出碼 0 在付費前只代表「該驗的都驗過了」，不代表這一支好。**略過不等於通過。**

## 唯一的付費關卡：協定不可省略

主播生成是整條線**唯一不可逆且有成本**的步驟。流程固定三步，順序不得調換：

**第一步：dryrun。不花錢。**

```bash
node stages/heygen.mjs --project <dir> dryrun
```

它會依契約組出 payload、估算成本、寫進 `heygen-request.json`。

**第二步：出示並取得明確同意。**

把三樣東西一起給使用者看：**完整講稿、payload、成本估算**。
然後**用 `AskUserQuestion` 工具問**，不要用散文在回合結尾問。

理由：散文問句會讓使用者以為你還在做事；`AskUserQuestion` 會跳出選項讓他直接點，
而這是全流程唯一需要他決定的地方，值得一個明確的介面。

問題就兩個選項：核准送出／不核准（並說明要改什麼）。

**第三步：只有拿到明確同意才執行。**

```bash
node stages/heygen.mjs --project <dir> create --i-have-user-approval
node stages/heygen.mjs --project <dir> poll
```

`create` 自己有三道鎖：旗標必須明寫、payload 必須逐欄符合契約、
付費前的 gate 必須全過。**但那三道鎖擋的是意外，不是你的判斷。
使用者沒點頭就帶上那個旗標，是你違反協定，不是程式漏擋。**

金鑰從環境變數 `HEYGEN_API_KEY` 讀，不在 repo 裡。

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

## 怎麼寫一支好講稿

**規則在 [`ROLE.md`](ROLE.md)，寫稿之前先讀。** 那不是格式清單，是五條有機制與否證條件的規則：
HOOK 前置、問候降位、台股美股合併並服務於論證、段落之間必須有債務關係、無轉折段落優先砍。

最重要的一個概念是**轉折的操作型定義**：段落 N+1 必須使觀眾改變對段落 N 的判斷。
只是補充新事實不算。V1／V2 的中段轉折數是 **0**，那就是外部 audit 說「平鋪直述」的結構成因。

**lint 通過不等於講稿好。** lint 擋的是形式（禁用寫法、破折號、價格當進出場依據、
指涉不明的時間詞），張力要你自己用轉折定義掃一遍。

上游還有一份給文字晨報用的規則在 `marketing-video/晨報腳本_ROLE.md`，
本 repo 的 ROLE.md 在五個地方刻意偏離它，偏離處都寫了理由。**衝突時以本 repo 的為準。**

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
- **不要讀 `marketing-video`。** 那是一條**平行等價**的實作，不是這條線的上游或依賴。
  兩邊刻意不互相引用；要交流是把好東西**抄**過來，而那是使用者的決定，不是你的。
