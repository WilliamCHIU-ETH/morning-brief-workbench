# 剪輯技法目錄（從真人剪的片反推，給產線用）

這份檔案回答三件事：**剪輯師手上有哪些招、我們是從哪支片學的、那支片長什麼樣子。**
它不是復刻手冊——目標是復刻思路，不是逐格重做。每一招都寫成「觀眾感受到什麼 → 對標怎麼用 →
我們用什麼原語做 → 目前狀態」。狀態欄由迭代的 intent（`docs/intents/`）回寫。

原始素材（mp4、逐秒定格、whisper 轉錄）放 `docs/reference-reels/local/<reel-id>/`，**不進版控**（.gitignore）。
規則層在這裡與 `docs/reference-reels.md`（大盤小報／三大法人的逐秒拆解）。

## 參考影片索引

| reel | 帳號／日期 | 類型 | 長度 | 我們從它學什麼 | 本機素材 |
|---|---|---|---|---|---|
| DcdUck3IEmy | cmchipk 0825 | 大盤小報 | 74.6s | 素材＝App 截圖＋黃框跟旁白走 | `docs/reference-reels/0825-dapan-xiaobao.jpg` |
| DcdbYgnIAha | cmchipk 0825 | 三大法人 | 61.0s | 法人數字用設計資料卡，不用 App 頁 | `docs/reference-reels/0825-sanda-faren.jpg` |
| Dcat_FjIAi0 | cmchipk 0824 | 大盤小報 | 79.0s | 頁面最小集合、同頁不連放 | `docs/reference-reels/0824-dapan-xiaobao.jpg` |
| **Db7CHk2pope** | cmchipk 0812 | 題材片（人形機器人） | 56.1s | **後製感：層跟旁白呼吸** | `docs/reference-reels/local/Db7CHk2pope/`（reel.mp4、sheet.jpg 每秒一格、keyframes.jpg、whisper.srt） |

Db7CHk2pope 是使用者 2026-08-30 指定的「有剪輯手感」範本。

## Db7CHk2pope 的結構（量出來的）

- **6 個硬剪點**：4.8／7.8／15.3／19.7／29.3／34.7 秒，全部是「主播 ↔ 插入畫面」的進出。
- **主播段零跳剪、零推鏡、構圖全程不變**：坐姿、木桌、大麥克風入鏡、灰格紋棚牆。主播佔 71%。
- **全程有底樂**（沒有任何 ≥0.4s 低於 −35dB 的靜音）。
- **字幕**：小字深色白邊、約 85% 高、每條約 2.3s（與我們 V2 的 2.5s 相同——字幕節奏不是差異來源）。
- **每一格都有**：右上白框常駐大標「特斯拉Optimus V3量產倒數！台廠受惠名單一次看」、左上品牌章、上下橘色光暈邊框。

| 秒 | 畫面 | 用到的招 |
|---|---|---|
| 0–2 | 主播本人打模糊，疊大標（黃底強調「量產倒數！」），拉焦回主播開講 | on-shot title、rack focus |
| 3–4 | 主播 | — |
| 5–7 | 資料卡開始長：標題「口頭時間表 → 白紙黑字採購指引」淡入 → 馬斯克圓照＋藥丸 → 第一格「7–8月 口頭試產」 | build、cut-away |
| 8–14 | 主播 | cut-back |
| 15–19 | **同一張卡回來**長第二格「9月 週產1000台」：先灰，唸到數字時轉橘框，第一格同時降灰 | callback、lead、focus-dim |
| 20–28 | 主播 | — |
| 29–34 | 九檔清單打模糊當 teaser，疊「點擊連結看更多」 | redaction blur、CTA |
| 35–46 | 主播 | — |
| 47 | 胸前彈出貼紙字「(點擊連結解鎖個股)」 | emphasis pop |
| 48–56 | 主播收尾 | — |

一句話：**主播是一條不動的底，「有人剪過」的感覺全部來自疊在上面的層在跟旁白呼吸——先出、亮起、降灰、回來。**

## 技法目錄

狀態：未試／草稿中／keep／drop／做不出來（附原因）。

| # | 技法（EN／中） | 觀眾感受到什麼 | 對標用法 | 我們的原語（HyperFrames＝HTML/CSS/GSAP） | 狀態 |
|---|---|---|---|---|---|
| 1 | A-roll / B-roll、cut-away／cut-back | 講事實時看證據，講判斷時看人 | 6 個剪點全是這個 | planner 已做（素材格＝cut-away） | keep（既有） |
| 2 | Lead the picture（畫面前導） | 畫面比聲音早半步，像剪輯師知道下一句 | 卡片在唸到數字前約 0.5s 先灰灰地出現，唸到時亮 | 素材格視覺起點提前 0.3–0.5s；黃框亮起對齊字時間 | 草稿中（V3，intents/2026-08-30-editorial-hand.md §7） |
| 3 | Build / Reveal（漸進建構） | 資訊一拍進一個，跟得上 | 卡片元素逐個進場 | GSAP timeline，關鍵幀對齊 ASR 逐字時間 | 草稿中（V3，intents/2026-08-30-editorial-hand.md §7） |
| 4 | Focus-dim（亮一格、暗其餘） | 眼睛只落在正在講的那格 | 講過的格降灰、正在講的橘框 | opacity／filter 切換 | 草稿中（V3，intents/2026-08-30-editorial-hand.md §7） |
| 5 | Callback（回訪同一張卡） | 敘事有記憶，不是一格一張圖 | 5s 的卡在 15s 回來長第二格 | 同一 composition 帶狀態掛兩格；planner 需「card thread」概念 | 未試 |
| 6 | Persistent title strap（常駐標題條、chyron、bug） | 任何一秒滑進來都知道在講什麼 | 右上白框大標、左上品牌章，含插入格 | 標題板改放 HOOK，全片常駐 | 草稿中（V3，intents/2026-08-30-editorial-hand.md §7） |
| 7 | On-shot title over defocus（模糊主播疊大標＋rack focus） | 開場不是另一張卡，是同一個人「對焦」進來 | 0–2s | avatar 層 CSS blur → 0，大標淡出 | 草稿中（V3，intents/2026-08-30-editorial-hand.md §7） |
| 8 | Emphasis pop（貼紙字、callout） | 關鍵詞被「指」出來 | 47s 胸前彈字 | GSAP scale-in 藥丸；哪個詞彈＝編輯判斷（agent 寫） | 草稿中（V3，intents/2026-08-30-editorial-hand.md §7） |
| 9 | Spotlight（黃框外壓暗） | 框住的東西更亮 | 對標用橘框＋其餘降灰 | `box-shadow: 0 0 0 4000px rgba(0,0,0,.35)` 在框元素上 | 草稿中（V3，intents/2026-08-30-editorial-hand.md §7） |
| 10 | Redaction blur（模糊當 teaser） | 好奇缺口 | 29–34s 名單打模糊 | CSS blur；晨報無 CTA 不用，但可做「模糊背景＋清晰頁首」堆疊 | 不適用（記錄） |
| 11 | Brand frame＋grade（統一色系、光暈邊框） | 每一格都是同一支片 | 上下橘色光暈，卡、標、貼紙同色系 | CSS 漸層疊圖；濾鏡壓在主播影片上有畫質風險 | 草稿中（V3，intents/2026-08-30-editorial-hand.md §7） |
| 12 | Music bed＋SFX（底樂、音效） | 「有人在後面做」的最便宜證據 | 全程底樂；彈出處大概有音效（未以耳驗證） | `layout.bgm` 早就有、V2 沒掛；SFX 要授權素材 | 草稿中（V3，intents/2026-08-30-editorial-hand.md §7） |
| 13 | Voice prosody（人聲韻律） | 像人在講，不像在唸 | 長句、口語接頭、真人語調 | TTS 參數解不了音色與口音；克隆源與真人配音是候選 | 做不出來（現階段；克隆聲與系統聲皆試過，見 intent §7） |
| 14 | Spoken sentence structure（口語句構） | 「AI 味」有一半在句子 | 「我們先看盤面」「今天答案一好一壞」 | ROLE.md 補長句與接頭規則 | 未試（V4） |
| 15 | Presenter depth（棚、道具、手勢跟內容） | 人是活的 | 坐姿桌麥、手勢隨語意 | avatar_iv 的 motion_prompt 是全片一句、背景烙在照片裡 | 做不出來（現階段） |

## 怎麼用這份檔案

- 開新迭代：從表裡挑要試的招，抄進該次 intent 的 Plan。
- 迭代結束：把 keep／drop／做不出來回寫到「狀態」欄，附 intent 檔名。
- 新看到一支值得學的片：先加進索引、量結構（剪點、主播佔比、底樂、字幕節奏），再往表裡加招。
  量法：`ffmpeg -vf "select='gt(scene,0.25)',showinfo"` 抓剪點；`silencedetect=noise=-35dB:d=0.4` 看底樂；`fps=1,tile=7x8` 出每秒定格。
