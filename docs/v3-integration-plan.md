# v3.2 參考檔功能總結與 v3 整合計劃

- 參考檔：`zz_requests/Guitaristic_Academy_System_v3.2_santize.html`（**只留本地，已加入 .gitignore，不進 GitHub**）
- 版本控制：`v2-dev` 凍結於 tag `v2.0`（commit f71883c）；本文所述整合全部在 `v3-dev` 分支進行。
- 進度：Stage 1 出席與繳費 ✅（e384569）／Stage 2 數據分析 ✅（83ba068）／Stage 3 歷史記錄與撤銷 ✅（03873b9）／Stage 4 導師與收費設定 ✅（1d938b9）／Stage 5 發送中心 × 繳費整合 ✅（878f621 + 本 commit）
- 目標：把參考檔的「出席與繳費」「數據分析」「歷史記錄／撤銷」「導師與收費設定」整合進 v2 架構——**移植的是函數與資料流，不是殼**；凡 v2 已有更完整實作的（狀態機、課節模型、費率連動）沿用 v2。

---

## 1. 參考檔（v3.2）功能總結

單檔 SPA（3,312 行）：Tailwind + FontAwesome + Chart.js 4.4.1；全部狀態在記憶體，localStorage 鍵：
`guitaristic_students_v7`／`guitaristic_payments_v1`／`guitaristic_history_v1`／`guitaristic_settings_v1`／`guitaristic_tutors_v1`／`guitaristic_rate_overrides_v1`。
七個頁籤：全校時間表、單一學生、學生資料庫、**出席與繳費**、**數據分析**、**歷史記錄**、**導師與收費設定**。共 99 個函數，按模組整理如下（★＝本次要整合；✓＝v2 已有等價或更完整實作；✗＝v2 刻意裁掉）。

### 1.1 導師與收費設定 ★
| 函數 | 作用 |
|---|---|
| `tutorsList` / `TUTOR_TIER_MAP` / `rebuildTutorTierMap` | 導師名單 `[{name, tier}]`，tier＝資深導師／普通導師；名單→查價等級的對照表 |
| `saveTutorsList` | 存 `guitaristic_tutors_v1` |
| `populateTutorSelects` | 把所有「導師」下拉（排課表單、學生弹窗）換成名單內容，保留目前選值；小組課用固定佔位「Guitaristic Academy」 |
| `renderTutorManagementList` | 設定頁每位導師一行：名稱＋等級下拉（即改即存）＋刪除 |
| `addTutor` | 名稱必填、重名拒絕；先 `pushHistory` 再新增、存檔、重建對照、刷新下拉 |
| `updateTutorTier` | 改等級（快照＋存檔＋重建對照） |
| `deleteTutor` | 仍有學生使用時特別警示；刪除不改動學生記錄上的導師名 |
| `RATE_TABLE` + `saveRateOverrides` / `loadRateOverrides` | 費率表可在頁面上改價：以 `tier|program|level|classType|duration` 為鍵存覆寫值，載入時套回 |
| `renderRateTableEditor` / `handleRateTableEdit` | 按「導師等級＋課程」篩出費率列，每列一個數字輸入框，改動即 `pushHistory`＋存覆寫 |
| `getRateTablePrograms/Levels/ClassTypes/Durations` | 連動下拉的選項來源 |
| `lookupRateByTier` / `lookupRate` | 精確查價；`lookupRate` 由導師名→等級再查 |
| `backfillStudent` | 舊資料補欄：type 長標籤化、`tier`（由導師對照）、`rate`（**查價後寫死在學生記錄**；查不到用估算公式） |
| `populateModalLevelOptions` / `ClassTypeOptions` / `DurationOptions` / `updateModalRateFromTable` | 學生弹窗連動下拉＋自動帶價（與 v2 `lib/rates.js` 同義） |

v2 現況：費率表、連動下拉、每堂學費唯讀、`tutorLevel` 欄位——**已完成**（commit f71883c）。差異：參考檔把價格寫死在學生記錄（「修改費率不影響已登記學生」），v2 每次按組合查表（改費率全域生效）。v3 決定：**沿用 v2 查表方式**，但費率覆寫與導師名單要補上。

### 1.2 出席與繳費 ★
| 函數 | 作用 |
|---|---|
| `markAttendance(index, isPresent)` | 每堂 `attended` 三態切換 true／false／null（同鍵再按取消） |
| `computeRegularLessonCount` | 本月常規星期出現次數（4 或 5）＝計費堂數（**政策：學費按常規堂數收，不因請假／補堂增減**） |
| `getPaymentSummaryForMonth` | 每生：堂數、缺席數（attended===false）、每堂價、應收＝堂數×價、已收＝該月繳費紀錄合計、餘額、狀態 paid／partial／unpaid |
| `renderPaymentTable` | 月份＋搜尋（ID／名／導師）；KPI 應收／已收／未收／缺席；桌面表格＋手機卡片；每行「登記繳費」「學費通知」 |
| `openPaymentModal` / `submitPayment` | 金額（預設餘額）、日期、付款方式（現金／FPS／銀行轉帳／其他）、備註 → `paymentLedger.push({id, studentId, month, amount, date, method, note})`，先 `pushHistory` |
| `copyFeeNoticeMessage` | 學費單訊息（與 v2 學費訊息同格式）＋ **FPS 轉數快 ID**＋「24 小時內通知不設補堂」＋**學員守則連結** |
| `academySettings` / `updateAcademySettings` | `{fpsId, infoUrl}`，在繳費頁的摺疊區編輯，存 `guitaristic_settings_v1` |

v2 現況：出席是完整狀態機（已上課／請假 L·SL·TL／缺席／補堂鏈／小組聯動），**比參考檔完整，沿用**；學費訊息按報讀項目分段已完成。**缺**：繳費紀錄、繳費頁、FPS／守則連結設定與訊息尾段。
（參考檔內的 FPS ID 與網址屬機構資料，**不抄進倉庫**；設定預設留空由用戶自填。）

### 1.3 數據分析 ★
| 函數 | 作用 |
|---|---|
| `refreshAnalytics` | 無課表時顯示空狀態；billable＝非請假堂；收入 Σ 學生單價；導師工時 Σ 時長／60；缺席率／出席率（只算已標記者）；各導師堂數與收入；狀態分佈 NORMAL／MAKEUP／LEAVE／ABSENT |
| `renderAnalyticsCharts` | Chart.js：導師堂數（長條）、導師收入（長條）、狀態分佈（甜甜圈）；重畫前 `destroy()`；`Chart` 未載入（離線）時靜默略過 |

只看「目前生成的那個月」。v2 完全沒有此頁。

### 1.4 歷史記錄與撤銷 ★
| 函數 | 作用 |
|---|---|
| `pushHistory(description)` | **在每個會改資料的操作之前**拍快照：`{id, timestamp, description, studentDatabase, masterScheduleEvents, paymentLedger}`（JSON 字串），`unshift` 到 `actionHistory`，上限 25 筆，存 localStorage，刷新列表 |
| `undoLastAction` | 取最新一筆套回（無紀錄則提示） |
| `restoreSnapshot(id)` | 確認後先 `pushHistory('還原前自動備份…')` 再套回——還原本身可再撤銷 |
| `applySnapshot` | 解析→補欄→復原 Date 物件→存檔→全部重繪 |
| `clearHistory` / `renderHistoryList` | 清空（confirm）；列表每筆「還原至此」 |

拍快照的 14 個呼叫點：新增／改等級／刪除導師、改費率、更新時間設定、請假／調堂／確認補堂、刪除／編輯／新增學生、匯入 JSON、恢復預設、記錄繳費。**沒有**覆蓋：標記出席、生成課表、設定變更。v2 完全沒有此功能。

### 1.5 其餘模組（不在本次範圍）
- 全校時間表／單一學生／學生資料庫／ICS 導出／JSON 備份還原：v2 已有更完整版本 ✓（單一學生頁與週曆 v2 已裁掉 ✗）。
- `printMasterSchedule`（列印清單）、`copyWhatsAppSummary`（整月課表 WhatsApp 摘要）：v2 沒有，屬低優先加分項，可在 v3 後段補。

---

## 2. v3 整合計劃（四段，每段一個 commit、一次瀏覽器驗收）

### Stage 1 — 繳費記錄與學費單發送 UI（本次先做）
**資料模型**（單一事實來源：發送中心的 `TUITION:<學生>:<月>` 條目，在 `lib/sendlog.js` 擴充欄位）：

| 手工表格欄 | 條目欄位 | 說明 |
|---|---|---|
| $/LSN | `items[].rate` | 每個報讀項目一個單價（個別課／小組各自），已有 |
| LSN | `count`（各項目 `items[].count`） | 當月堂數，已有 |
| Total Amount | `amount` | 應收；可手改（`amountEdited`），已有 |
| Check? | `checked` | 已核對金額（人工複核） |
| Send? | `status === 'SENT'` | ＝發送中心的已發送，勾選即「手動已發」，同一狀態兩邊同步 |
| Paid | `paid` + `paidAmount` | 勾選＝已繳，預設整額、今天；金額可改以記部分繳交 |
| Payment Method (1/2/3) | `payMethod`（'1'／'2'／'3'） | 三個代號的名稱在設定頁可改，預設 1＝現金、2＝轉數快 FPS、3＝銀行轉帳 |
| Payment Date | `payDate` | 日期 |
| Receipt | `receipt` | 已發收據 |

**UI**：新頁籤「**出席與繳費**」（表格式，對應手工表）：
- 頂列：月份、導師篩選、搜尋；KPI：應收／已收／未收／本月缺席堂數。
- 每位學生一行：學生 ｜ 導師 ｜ $/LSN ｜ 堂數 ｜ 出席／請假／缺席 ｜ 應收 ｜ ☐核對 ｜ ☐已發送（旁有 WhatsApp／複製）｜ ☐已繳 ｜ 付款方式▾ ｜ 付款日期 ｜ ☐收據 ｜ 學費單預覽。
- 勾「已繳」自動填今天與整額；未生成課表的學生顯示「未生成」並可跳到總課表。
- 學費訊息尾段：設定頁填了 FPS ID／學員守則連結才會出現對應句子，並加「如需更改上課時間請盡早通知，24 小時內通知不設補堂」。
- 發送中心的學費卡片保留，卡片上多一行繳費狀態徽章。

### Stage 2 — 數據分析
- 月份選擇（預設總課表月份）；資料來源 `lessonsByMonth` + `rateForLesson` + `GACPayroll.tutorSessions`。
- KPI：本月收入（可計費堂 Σ 每堂價，與薪酬同口徑）、導師節數與工時（小組一節算一次）、出席率／缺席率（只算已有結果的堂）、已收學費（來自 Stage 1）。
- 圖：各導師節數、各導師收入、狀態分佈；Chart.js 由 cdnjs 載入，離線時退回文字長條。
- 純計算放 `lib/analytics.js` 可單元測試。

### Stage 3 — 歷史記錄與撤銷
- `lib/history.js`：`push(list, snapshot, cap)`、`take()`、`restore()`；快照＝`{students, groups, lessonsByMonth, sendLog, tutors, rateOverrides}` JSON 字串（不含 GCal token）。
- 呼叫點比參考檔更完整：學生／小組新增修改刪除、生成、每個狀態變更（含批量確認、全組操作、手動模式）、排補堂／改期／取消、繳費勾選、群發建立／刪除、清月／清場／還原、同步 GCal 套用、導師／費率修改。
- 頁籤「歷史記錄」＋頁首「撤銷上一步」按鈕；還原前自動備份；上限 20 筆並顯示佔用大小。

### Stage 4 — 導師與收費設定
- 導師名單 `gac_tutors_v2 [{name, tier}]`：設定頁新增／改等級／刪除（使用中警示）；學生弹窗、小組弹窗、總課表篩選的導師下拉都由名單產生；選導師時「導師級別」自動帶入其等級（仍可個別覆寫）。
- 費率覆寫 `gac_rate_overrides_v2`：設定頁按等級＋課程列表改價，載入時套回 `rateTable`；備份／還原包含兩者。

### Stage 5 — 發送中心 × 繳費整合（用戶提問「發送中心可不可以和繳費結合」後的方案 A＋B）
- **A. 學費卡片走完整個流程**（878f621）：待發送卡片「核對」勾選；已發送卡片折疊式繳費小表單（已繳／實收／方式／日期／收據，未繳清預設展開、已繳清收起→「修改繳費」）；已發送欄標題「N 筆學費未繳清」；「類別」多「學費 · 未繳清／已繳清」。資料仍是同一條 `TUITION` 條目，繳費表不變。
- **B. 繳費狀態反向驅動發送隊列**（本 commit）：兩個派生條目類型，每次渲染 `syncDerived` 幂等同步——
  - `PAY_REMIND:<生>:<月>` 催繳：學費單 SENT 滿 `remindDays`（預設 7，用戶指定「自動、一週」）且未繳清 → 建 TODO；繳清／移回待發／略過／自動關閉 → TODO 刪除，SENT 保留且不建第二筆（要再催就「移回待發」）。
  - `RECEIPT:<生>:<月>` 收款確認：繳清即建（不要求學費單已發）；`markSent` 回寫學費條目 `receipt=true`；取消已繳 → TODO 刪除。
  - 「不用發」＝`dismissDerived`：刪條目＋學費條目 `remindSkipped`／`receiptSkipped`；學費單 `markUnsent` 重置前者、`setPayment({paid:false})` 重置後者。
  - 訊息不快照：`fillTemplate(模板, paymentVars(學費條目))`，佔位符 {name} {month} {amount} {paid} {outstanding} {method} {date} {payinfo} {fps}；模板與開關在設定 `remindAuto/remindDays/remindMsg/receiptAuto/receiptMsg`。
  - 未做（可後續）：同一月第二次催繳、逾期天數 KPI。

### Stage 6 — 設定頁模組化／訊息模板／導師日曆（用戶 2026-09-22 需求 2、3）
- 設定頁改為八個可收合模組（`toggleSettingsModule`／`applySettingsModules`，狀態只存本機 `gac_settings_open`）。
- 訊息模板全部進設定（`TPL_FIELDS` id→設定鍵；預設在 `DEFAULT_SETTINGS`；`msgTpl(key)`＋`GACSendlog.fillTemplate`）：學費單三段、請假、補堂、改期、催繳、收款確認。
- 新條目類型 `MOVE_CONFIRM`（`ensureMoveEntry`）：補堂改期（舊時間已通知過才建）與 GCal 時間變更套用。
- 導師名單多 `calendarEmbed`／`calendarId`；總課表「Google 日曆」視圖（`tutorEmbedUrl` 組 embed 網址＋dates 定位）。
