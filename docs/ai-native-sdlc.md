# AI-native SDLC 在晨報工作台的落地

## 結論

本 repo 不需要照搬 `intent.md → spec.md → plan.md` 的檔名；現有的
`script.txt → segment-plan.json → shot-plan.json → ledgers → final.mp4 → gate-report.json`
已經是更貼近晨報產品的 artifact chain。要補的是交接自動化、來源唯一性與回饋閉環。

## 六階段對照

| AI-native SDLC | 本 repo 的 canonical artifact | 控制 | 人的判斷 |
|---|---|---|---|
| Plan | 上游 docx、`script.txt` | `ROLE.md`、`lint:script` | 來源內容與主題本身 |
| Design | `segment-plan.json`、`shot-plan.json` | screenshot standard、provenance | agent 編輯判斷；找不到可指畫面就押回主播 |
| Build | compositions、avatar、ledgers、`index.html` | canonical filenames、input SHA-256 | 無固定人工交接 |
| Test | `gate-report.json`、attack fixtures | acceptance contract、回歸測試 | agent 看畫面與成片，補 deterministic gate 管不到的判斷 |
| Deploy | `outputs/final.mp4` | 付費前鎖、全量 gate | **唯一人工關卡：核准付費主播生成** |
| Maintain | `ROLE.md`、contracts、attack fixtures | 事故回寫成否證條件或回歸測試 | 判斷缺陷是內容假說、可機檢事故，或單次偏好 |

證據邊界：`projects/` 目前被 gitignore，所以 provenance 能證明同一個本機 project 內的輸入血緣，
但還不是文章所說的 durable git audit trail。不要因此把 mp4 全塞進 git；若未來需要跨機稽核，
應另做只含 artifact hash、stage result、approval reference 與 final path 的輕量 run manifest。

## 這次新增的 handoff

```bash
npm run status -- --project <dir>
npm run status -- --project <dir> --json
```

它不執行階段、不呼叫網路、不花錢，只從 canonical artifacts 回答：

- 現在在哪一階段；
- 哪些證據已存在且 provenance 新鮮；
- 下一個最小動作與指令；
- 是否正停在唯一付費人工關卡；
- 哪些 gate 或 artifact 阻塞繼續前進。

JSON 是 agent 與後續自動 runner 的穩定 handoff。人工核准狀態不寫成可偽造的檔案；
`heygen.mjs create --i-have-user-approval` 仍只可在使用者於當前互動明確核准後執行。

## 不照搬文章的地方

- 不為每支影片增加三份通用 markdown；那會複製已有 artifact 的內容，增加 drift。
- 不把每個階段都變成人工簽核；控制由 gate、provenance 與 hooks 承擔，人的注意力只留給付費決定與最後主觀品質判斷。
- 不因為可以平行就開多 agent；同一支影片的 artifact 前後相依，平行寫同一 project 只會增加碰撞。

## 回饋如何閉環

1. 可重現、可機檢的逃逸缺陷：先加 attack fixture，再加 gate，測試鎖住「由哪一道擋」。
2. 講稿或編輯品質假說：寫回 `ROLE.md`，附機制、預測與否證條件，不冒充成效證據。
3. 單次視覺偏好：只修該 project；重複出現後才升格為共用規則。
4. App、供應商或環境事故：保留原始錯誤與修復證據；不要調低 acceptance threshold 讓輸出通過。

## 下一個值得做的切片

在 status 經過真實新專案驗證後，才把「非付費、無需 GUI 判斷」的連續階段包成 resumable runner。
成功判準不是少打幾行指令，而是新專案從任一中斷點恢復時，下一步判斷正確且不重做已驗證的付費產物。
