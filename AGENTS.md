# 給 agent 的入口

你在 `morning-brief-workbench`（晨報工作台）。**目標是在這個目錄底下一口氣做完一支台股晨報短影音**——
講稿、切段、動態圖卡、主播、字幕、組裝、渲染——中間只有一道人工關卡：核准付費的主播生成。

## 這裡做得到什麼

| 做得到 | 指令 |
|---|---|
| 檢查講稿是否合格 | `npm run lint:script <project>/script.txt` |
| 從講稿推導切段結構 | `npm run plan -- --project <dir> --write` |
| 挑 MG 版型、抽資料、產出 composition | `node stages/plan-mg.mjs --project <dir> --write` |
| 跑全部驗收門檻（目前 32 道，以 `contracts/acceptance.json` 為準） | `npm run gates -- --project <dir>` |
| 配音合成（MiniMax 音檔路線；小額付費，見付費一節） | `node stages/voice-minimax.mjs --project <dir> dryrun`，確認後 `synth` |
| 主播生成（**成本最高的付費步驟，見下方協定**） | `node stages/heygen.mjs --project <dir> dryrun` |
| 加速主播影片 | `npm run speedup -- --project <dir>` |
| ASR 逐字時間 | `npm run asr -- --project <dir>` |
| 對齊、字幕、組裝 | `stages/align-script.mjs` → `build-segment-ledger` → `build-caption-ledger` → `build-main` |
| 渲染素材格與成片 | `npm run render -- --project <dir> slots`，組裝後 `… final` |
| 自動化實機截圖（iOS Simulator＋deep link） | `node stages/capture-shots.mjs --project <dir> [--dryrun] [--as-of YYYY-MM-DD]` |

## 已裁定要做、但還沒做的

**2026-08-27 會議推翻了原本這一節的兩條「使用者裁定不做」。** 現在記的是差距，不是邊界：

- **docx → 講稿：由你（agent）自己做，刻意不寫成程式**（使用者 2026-08-28 裁定，這是 agent-first 工具）。
  會議定的成功場景是「輸入晨報（docx）後端到端產出 mp4」——所以 docx 是你的輸入：自己讀
  （`/opt/anaconda3/bin/python3 -c "import docx"` 可用），依 `ROLE.md` 寫成 `script.txt`，選型跟著 docx 標題走。
- **實機截圖取代動畫素材。** 會議裁定素材格全面改用 App 實機畫面，動畫素材（MG）全面取消。
  截圖鏈已上線（capture-shots → shot-plan → shot 版型；2026-08-31 起支援 `--as-of` 歷史日K）；
  `plan-mg.mjs`／`mg-templates.mjs` 的 MG 版型只剩「沒有 shot-plan 的格」的 fallback——那是過渡狀態，不是目標。
  對標物是 IG `cmchipk` 的「大盤小報」「三大法人」系列，逐秒拆解在 `docs/reference-reels.md`；
  **素材格「哪句配哪頁、框什麼」的標準在 `docs/screenshot-standard.md`**（含反面清單：哪些句子該押回主播）。
  **截圖不是換掉視覺層而已**：素材格的句子必須指向一個可截的 App 畫面，這會反過來約束講稿。

其餘沒提到的都在這裡。**如果你發現某個階段缺了，那是差距，不是邊界——回報它，不要繞路去
`marketing-video` 找。** 那是一條平行的實作，不是這條線的上游。

## 開一支新影片的順序

```bash
# 1. 建 project（骨架一鍵建：assets、template、hyperframes.json、目錄結構；檔名必須 canonical，不得帶版本後綴）
node stages/init-project.mjs --project projects/20260827-<主題>
$EDITOR projects/20260827-<主題>/script.txt

# 2. 講稿必須 0 error 才往下走
npm run lint:script projects/20260827-<主題>/script.txt

# 3. 推導切段。先不給 hint，看它產出什麼
npm run plan -- --project projects/20260827-<主題> --write

# 4. 不滿意就寫 plan-hints.json（哪幾句必須在主播臉上），重跑 3
#    {"presenter": ["那句話的一部分", "另一句"]}

# 5. 填 segment-plan.json 裡每個 mg 格的 responsibility（程式不代填，那是編輯意圖）
#    注意：這段文字也會餵給第 6 步的選頁——寫「K線」「營收」「量能」會影響開哪一頁（見 docs/screenshot-standard.md）

# 6. 實機截圖（自動）：每個素材格 → deep link 進模擬器裡的籌碼K線 → 找目標 → 截圖 → shot-plan.json
#    前提：iPhone 17 Pro 模擬器裝有 [internal-identifier-removed] 且已登入（見下方「截圖通道」）
node stages/capture-shots.mjs --project projects/20260827-<主題> --dryrun   # 先看每格解析到哪一頁
node stages/capture-shots.mjs --project projects/20260827-<主題>            # 正式；用過去的講稿測試時加 --test-mode
#    晨報引用「前一交易日收盤」，截圖時間晚於當日 09:00 就必須加 --as-of <該交易日>：
#    日K歷史選棒＋AX 驗日期與收盤（時間語意與幾何代價見 docs/screenshot-standard.md）
#    某格印「沒有 focus」＝那句話沒有可指的東西 → 寫進 plan-hints.json 的 presenter 押回主播，重跑 3

# 7. 產出素材格 composition（有 shot-plan 的格自動用 shot 版型，其餘才落到 MG 版型）
node stages/plan-mg.mjs --project projects/20260827-<主題> --write

# 7.5 填編輯意圖（程式不代填）：main.config.json 的 openTitle.main（建議 8 字，會走 4/4 斷行）
#     與 sub（骨架刻意留空，build-main 會擋空字串）；emphasis.json 清單卡
#     （每項必須加新資訊、不復述旁白——四條規則見 docs/editing-techniques.md）；
#     voice.json 的 pauses（骨架已帶兩支正式樣本共用的校準值，只有停頓要自己標）

# 8. 驗收
npm run gates -- --project projects/20260827-<主題>
```

### 截圖通道（capture-shots.mjs 依賴的機器狀態）

- 模擬器 **iPhone 17 Pro**（UDID `[device-udid-removed]`）裝有 `[internal-identifier-removed].app`（bundle `[internal-identifier-removed]`）。
  程式會自己開機、啟動 App；若停在登入頁且帳號已記住，會自己按「[internal-login-removed]」。帳號欄是空的就停下來——登入是人的事。
- `idb` 在 `~/.venvs/idb/bin/idb`（可用 `MB_IDB` 覆寫），`idb_companion` 由 Homebrew 裝。
- **`--test-mode`**：拿過去的講稿測試時用。App 頁首永遠是今天的數字，會跟講稿對不上；這個旗標讓
  `shot.captured-same-day` 記「略過（測試模式）」而不是「未通過」，**其餘 gate 照常**——找不到目標頁面還是會擋。
  **測試專案的目錄名必須以 `-test` 結尾**（例：`projects/20260826-yadian-test`），否則那道 gate 直接判未通過——
  讓每一條路徑都寫著「測試」，沒有人會把它當正式片發出去。正式出片不得帶這個旗標。

第 8 步在付費之前**只跑得到十來道**（講稿 5、plan 5、截圖 2，跑過 dryrun 再加 payload 那道）。其餘要主播影片與 ASR。

> 黃金樣本 `fixtures/project-v4c` 顯示「通過 22」，是因為它已經有 `asr/` 與 ledger。
> **不要拿那個數字當新專案的期待值。**

退出碼 0 在付費前只代表「該驗的都驗過了」，不代表這一支好。**略過不等於通過。**

### 核准之後：一路跑到成片，不要停

```bash
# 9. 配音（MiniMax 音檔路線；小額付費，每次合成約 US$0.05 量級）
node stages/voice-minimax.mjs --project <dir> dryrun   # 不花錢：驗 voice.json、分段與停頓
node stages/voice-minimax.mjs --project <dir> synth    # 付費：產出 voice/track.mp3
#     花掉的配音成本要在第 10 步的核准訊息裡一併列出

# 10. 主播生成（唯一人工關卡，協定見下一節）；有 voice/track.mp3 時自動走音檔路線
npm run heygen -- --project <dir> dryrun
#     ↑ 出示講稿＋payload＋成本，AskUserQuestion 取得同意
npm run heygen -- --project <dir> create --i-have-user-approval
npm run heygen -- --project <dir> poll

# 11. 加速（必須守 fps 判準；音檔路線語速已在合成端決定，這一步自動只複製不拉伸）
npm run speedup -- --project <dir>

# 12. ASR 與強制對齊
npm run asr -- --project <dir>
node stages/align-script.mjs --project <dir> --duration <加速後秒數>

# 13. 兩份 ledger
node stages/build-segment-ledger.mjs --project <dir> --duration <加速後秒數>
node stages/build-caption-ledger.mjs --project <dir>

# 14. 渲染素材格 → 組裝 → 渲染成片（build-main 要讀 renders/ 才能對出每格的檔名，所以先渲染格）
npm run render -- --project <dir> slots
node stages/build-main.mjs --project <dir>
npm run render -- --project <dir> final

# 15. 全量驗收（此時契約裡的每一道都跑得到）
npm run gates -- --project <dir>
```

**第 10 步之後不要再回來問。** 使用者已經在唯一的關卡點過頭了，中間的產物
（加速後的長度、ASR 的字數、切段的秒數）都不需要他決定——那些有 gate 在管。

某一步失敗就**當場修再繼續**，不要把失敗當成回報點停下來。gate 未通過也一樣：
看它說哪一道、為什麼，修掉重跑。**只有一種情況該停：修不動，而且你說得出卡在哪。**

### 完成之後要交付什麼

一則回覆，四樣：

1. **成片路徑**與長度、檔案大小
2. **全量 gate 報告** —— 契約裡每一道的狀態（目前 32 道＋主播 payload 那道），未通過與略過的逐條說明
3. **與黃金樣本的差異** —— 覆蓋率、片長、轉折數、字幕貼齊率，並排
4. **你自己看過之後的判斷** —— 哪裡可能不好。gate 管不到主播像不像真人、
   B-roll 好不好看、講稿有不有趣，那三件要你先講，不要等使用者發現

## 兩種「gate」不要混用

這份文件裡出現兩個不同的東西，講的時候要分清楚：

- **人工關卡**：整條線**只有一個**——核准付費的主播生成。其餘任何地方都不該停下來問。
- **驗收門檻**：`contracts/acceptance.json` 的 31 道，全自動，只有通過與未通過，
  **不會、也不該停下來問人**。

成片出來之後給使用者看，那不是關卡——**片子已經做完了，後面沒有不可逆的事。**
那是交付，不是請示。

## 唯一的付費關卡：協定不可省略

付費步驟有兩個，人工關卡只有一個。MiniMax 配音是小額付費（每次合成約 US$0.05 量級、
金鑰 `MINIMAX_API_KEY` 同樣在本 repo 的 `.env`），synth 前用 dryrun 自查、花費列進主播核准訊息即可。
主播生成才是整條線**成本最高且不可逆**的步驟。流程固定三步，順序不得調換：

**第一步：dryrun。不花錢。**

```bash
node stages/heygen.mjs --project <dir> dryrun
```

它會依契約組出 payload、估算成本、寫進 `heygen-request.json`。

**第二步：出示並取得明確同意。**

在**同一則回覆**裡把三樣東西一起給使用者看，順序固定：

1. **完整講稿**（照原文貼，不要只給摘要）
2. **payload** —— 把 dryrun 印出來的那個區塊**原樣貼上**。它已經幫你把
   `avatar_id`／`voice_id` 註了人名、把講稿折成一行摘要，所以整塊掃得完。
   不要自己重新 `JSON.stringify`，那會把整份講稿塞回去而讓區塊沒法讀。
3. **成本估算**

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

**金鑰**：從**本 repo 自己的** `.env` 讀（已 gitignore）。第一次跑：

```bash
cp .env.example .env    # 然後把 HEYGEN_API_KEY 填進去
```

也可以單次覆寫：`HEYGEN_API_KEY=xxx npm run heygen -- --project <dir> create ...`

**不要去 `marketing-video` 讀它的 `.env`。** 兩個 repo 刻意互不依賴，各自持有一份金鑰。
去對方那裡拿會把解耦破掉，而且下次那邊改路徑這邊就壞了。

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

**規則在 [`ROLE.md`](ROLE.md)，寫稿之前先讀。** 那不是格式清單，是七條有機制與否證條件的規則：
HOOK 前置、問候降位、台股美股合併並服務於論證、段落之間必須有債務關係、無轉折段落優先砍，
加上 2026-08-31 增補的「收尾必須回答 HOOK」與「轉折要給去向」。

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
