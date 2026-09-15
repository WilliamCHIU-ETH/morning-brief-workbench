# 重新接手

2026-09-16 封存本機工作目錄。GitHub 是唯一來源，`master` = tag `v2026.09.16-archived`。

**這個 repo 是公開的。** 往這裡推任何東西之前，先確認內容可以公開——封存時做過一次完整檢查，別讓它白做。

## 封存時做了什麼

素材格畫面原本由 `stages/capture-shots.mjs` 操作一支需要登入的行情 App 自動擷取。這個 stage 於 2026-09-15 退役。它與它依賴的識別資訊、對照資料都不屬於可公開的內容，因此連同相關的內部工作紀錄一起留在 repo 之外。

以下內容**刻意不在這個 repo 裡**，也沒有進入 git 歷史：

| 內容 | 為什麼不發布 |
| --- | --- |
| `stages/capture-shots.mjs` 的原始實作 | 依賴非公開的 App 識別資訊與登入流程 |
| `stages/data/` 下的兩份對照資料 | 非公開來源；唯一的使用者是已退役的 capture stage |
| `docs/intents/`（5 份迭代紀錄） | 內含審閱回饋原話、成本量測、本機路徑 |
| `docs/reference-reels.md` 與 `docs/reference-reels/` | 對標影片的逐秒拆解與定格、逐字稿；影片有版權，拆解屬工作過程紀錄 |

`docs/editing-techniques.md`、`docs/screenshot-standard.md` 保留了所有判斷與規則，只把證據來源改成中性描述。`ROLE.md`、`contracts/acceptance.json`、`template/layout.json` 裡指向 `docs/reference-reels.md` 的引用沒有改——那些檔案在封存前就已經公開、引用也早就存在，動它們只會製造無意義的 diff。

現況：`capture-shots.mjs` 是一個會拒絕執行並以 78 結束的 stub。**素材改由使用者提供且確認授權**，放進 `projects/<專案>/assets/`，再自行填 `shot-plan.json`。

## 重新開工

```bash
git clone https://github.com/WilliamCHIU-ETH/morning-brief-workbench.git
cd morning-brief-workbench
npm install --no-package-lock && npm run demo   # 需要 Node 24；demo 不連網、不呼叫付費 API
npm test                                        # 99 個測試
```

沒有任何 npm 依賴。實際出片另需：

- `ffmpeg` / `ffprobe`（渲染與量測）
- `whisper-cli`（`brew install whisper-cpp`），再跑 `npm run setup:whisper` 下載 57MB 模型到 `.cache/`
- `.env`：從 `.env.example` 複製，填 `HEYGEN_API_KEY`（主播生成）與 `MINIMAX_API_KEY`（配音）。**兩把金鑰都隨本機刪除，要用得回各家後台重新產生。** 只跑 demo 與測試不需要。

`npm run status -- --project <dir>` 會依 artifact 狀態告訴你下一步該跑哪支。

## 封存時的狀態

| | |
| --- | --- |
| 測試 | 99 個，全過 |
| 黃金樣本 | `fixtures/project-v4c`（2026-08-26 實際出片那支，48.6 秒） |
| 攻擊樣本 | `fixtures/attacks/` 12 個 |
| 未驗證 | **退役後沒有重新跑過完整產製流程。** 組裝、字幕、渲染的程式都在，但「從 docx 到成片」這條路在沒有自動截圖的情況下沒有端到端驗收過 |

## 沒有留下來的東西

本機的 `projects/`（12 個專案、5.1G、含 129 支 mp4 與 HeyGen 主播影片）與 `output/`（結案報告與其建置產物）在封存時全部刪除，沒有備份。成片若還需要，要重跑產線並重新付費生成主播與配音。
