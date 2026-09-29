# 2026-09 開發紀錄（邏輯面）

分支 `v3-dev`，commits `1a698d6` → `c54b793`（共 16 個）。只記邏輯與資料流，UI 細節不記。
測試：單元 119 項（`node --test "tests/*.test.js"`）＋無頭冒煙 `node tests/smoke/smoke.js`（兩種存放模式各跑一遍：預設與 `GAC_SMOKE_FILE_MODE=1`）。所有改動都另外用無頭 Chrome（CDP）在真實 DOM 上驗過。

## 1. 資料存放：每個資料夾各自一份（`c933944`、`c54b793`）

**問題**：資料存瀏覽器 localStorage，按「網址」分區。兩個資料夾都是 `http://127.0.0.1:5500`，瀏覽器視為同一站，資料互相蓋。

**做法**：由 `serve.cmd`／`serve.command` 啟動時，資料改存**本資料夾的 `local-state.json`**（gitignored）。

- `serve.js`（Node）與 `serve.py`（Python，給沒有 Node 的 Mac）行為相同：
  - 送出 `index.html` 時在 `<script src="data.js">` 之前注入 `window.__GAC_FILE_STATE={…}`（狀態檔內容，`<` 跳脫成 `<`）與 `window.__GAC_FILE_STORE={file,folder}`。
  - `GET /__state` 回狀態；`PUT /__state`（或 POST）收整份 JSON 物件，先寫 `.tmp` 再 `rename`；非物件／壞 JSON 回 400 且不動原檔；壞掉的狀態檔以空狀態啟動、檔案不動。
  - 所有回應 `Cache-Control: no-store`（改完程式不會混用舊 JS）。
  - `serve.js` 匯出 `createServer(root)`（root 會 `path.resolve`），`require.main === module` 時才 listen。
- `lib/storage.js`：
  - `pickStorage(win)`：有注入 → `createFileBackedStorage`（掛在 `win.__GAC_FILE_STORAGE`）；否則回 `win.localStorage`。
  - `createFileBackedStorage(initial, save, {delay=250})`：記憶體 Map，介面同 localStorage（`getItem/setItem/removeItem/key/length`）。`setItem/removeItem` → `dirty=true` 並重設 250ms 計時器；`flush()`：無 dirty 不寫、寫回中再改動（`changedWhileSaving`）→ 寫完再寫一次；**失敗不自動重試**（否則無限循環），保留 `dirty`，下次改動或 flush 再寫；`lastError`／`onError`／`hasPending()`。
  - `fileSaver(win)`：`PUT /__state`，本文 < 60KB 加 `keepalive`。
- `state.js` 頂部：`const gacStorage = GACStorage.pickStorage(window)`（全域，在 payroll-advanced.js 之前就緒）。`gacStore = GACStorage.createStore(gacStorage)`。
- 走 `gacStorage` 的 key：學生／小組／課表／發送紀錄／設定／撤銷快照／導師／費率覆寫／`gac_adjustments`／`gac_payroll_archives`／`gac_tutor_share_pct`。**仍在 localStorage**（UI 偏好）：`gac_batch_open`、`gac_settings_open`、`gac_dark_mode`。
- 啟動流程（`window.onload`）：檔案模式且狀態為空 → `offerLocalStorageMigration()`：localStorage 有 `gac_students_v2` 或 `gac_lessons_v2` 就問一次，確定則複製所有 `gac_` 資料 key 進檔案存放、`flush()` 後 `location.reload()`。`installFileStoreHooks()`：`pagehide`／`visibilitychange=hidden` 時 `flush()`；寫回失敗 alert 一次。
- 用 VS Code Live Server 開：沒有注入 → 退回 localStorage，行為與從前相同。
- 冒煙的檔案模式：`GAC_SMOKE_FILE_MODE=1` 把 `fakeStorage` 的資料 key 轉到檔案存放的 Map，最後驗證全部落地且原 Map 只剩偏好 key。

**啟動器**：
- `serve.cmd`：node.exe 用絕對路徑（可複製到別的資料夾跑），`serve.js` 仍按 cmd 所在資料夾。
- `serve.command`（Mac）：先 `lsof` 查 5500，被佔用就列出程式，按 Enter kill 後再起；有 node 用 `serve.js`，否則 `python3 serve.py`；結束後視窗留著。`.gitattributes` 把 `*.command`／`*.py`／`*.sh` 固定 LF。
- `index.html` 最前面掛 `error` 監聽：同源腳本拋錯 → 頂部紅條（檔名、行號、提示強制重新整理），不再靜默沒反應。Mac 的 `Errno 48`（埠被佔用）→ 瀏覽器連到舊伺服器、混用快取舊 JS，正是這個症狀。

**限制**：兩個資料夾不能同時佔 5500；換資料夾要先關另一個。`_merged_true`（真實資料的資料夾）要同步這些檔案並**重啟 serve.cmd** 才生效。

## 2. 名單來源與切換（`15b2c5a`、`5db2fa7`）

- 頁面平時只讀存放層；`data.js` 只在第一次（存放層空）才用。換了 data.js 要按設定 → 危險區「從 data.js 重新載入名單」。
- `applyRoster(src, label)`（app.js）：學生／小組／導師整套換成 `src`；`src.tutors` 空 → `GACStorage.tutorsFromRoster(students, groups)`（按 `tutor` 去重、`tutorLevel === '資深導師'` 才資深）；先 `pushHistory` 可撤銷；課表／發送紀錄／設定不動。
- 導師日曆 ID 備忘：`appSettings.tutorCalendarMemo = {name: calendarId}`，切換前把目前名單的 ID 併入，新名單按名字回填 → 演示 ↔ 真實來回切換不用重填。
- `demo_data.js`：演示名單，變數 `demoStudents`／`demoGroups`／`demoTutors`（與 `data.js` 的 `default*` 不衝突，兩檔同時載入）；「還原演示名單」= `applyRoster(demo…)`。
- 使用者的真實 `data.js`：只有 `defaultStudents`（無 `tutorLevel`、無 `defaultGroups`／`defaultTutors`；舊 `groupCourses` 結構不認、先不管小組）；驗過可直接載入。真實 data.js 不進 git（`git update-index --skip-worktree data.js`）。

## 3. 只上小組的學生（`a284034`）

- 學生表單 `modalHasSlot`（有常規私教課）。不勾 → 儲存為 `weekday:null, time:'', tutor:'', tutorLevel:'', program:'', level:'', type:'', duration:null`，並清掉 `effectiveMonth/futureWeekday/futureTime`；**不查費率表**（學費按所屬小組計）。勾了才驗星期／時間與 `GACRates.findRate`。
- `hasIndividualSlot(s)` 仍是唯一判斷；星期下拉的「無個別課」空選項已移除。
- 導師篩選（生成勾選區、群發名單、總課表學生下拉）把只上小組的學生按 `groupsOfStudent(id).some(g => g.tutor === t)` 歸到小組導師名下。
- 展示層：只上小組者不顯示「改時間／升班」與快速編輯（沒有個別時段可改）。

## 4. 總課表篩選邏輯（`249c1d0`、`fb5e50b`、`a13073f`）

- 上方「篩選導師」（生成用）→ `onBatchTutorChange()` 單向同步下方 `schedTutorFilter`，走 `onScheduleFilterChange('tutor')`。
- `onScheduleFilterChange(changed)`：`'tutor'` → `rebuildScheduleFilters()`；`'student'` → `scheduleFilterTutorOf(key)`（學生自己的 `tutor`；只上小組者看所屬小組導師是否唯一；`G:id` 取小組導師）設定導師下拉再重建；不帶參數只重繪（既有呼叫點不變）。
- `rebuildScheduleFilters()`：學生下拉只列 `s.tutor === t` 或所屬小組導師是 `t` 的學生、`t` 的小組班；原選項不在新清單 → `ALL`；末尾 `rebuildWeekSelect()`。
- `lessonMatchesScheduleFilters(l, f)` 優先序改為：**選了學生／小組班就只看它，導師不再限制**（該生在別的導師的小組課也看得到）；未選學生才按導師。批量確認出席同一規則。
- 月曆一週一列：`onlyOne`（選了學生／小組班）時整週沒課的列不畫，附「已略過 n 個…星期」；沒課 → 提示本月沒有課堂。
- `rebuildWeekSelect()`：有篩選時週次下拉只列該範圍內有課的週；編號不變（第 1 週藏起來第 5 週仍叫第 5 週）；原選的週不在了回 `ALL`。

## 5. Google Calendar 同步邏輯（本輪前段：`1a698d6`、`8f9e59b`、`16414af`、`62ba958`）

- 每位導師一本日曆：`gcalCalendarForTutor/ForCell`、`gcalCalendarTargets()`（預設＋各導師去重）、`gcalCalendarsToRead()`；推送／刪除／清場都按課的導師分日曆（`gcalPushAcross`／`gcalDeleteAcross`／`gcalListAllCalendars`，事件帶 `_calendarId`）。課堂記 `gcalCalId`、`gcalEventId`、`gcalEid`、`gcalAdded`。
- 事件在錯的日曆 → 計劃 `relocations` → `client.move(eventId, dest)`。
- 一鍵推送：`gcalPushLesson(lessonId)`（有 id 就 PATCH，404/410 改 insert；無 id 走 `importCells`）、`gcalPushStatus(lessonId)`。
- 狀態碼：`STATUS_CODES=['A','L','SL','TL','MU','NS']`；`A`＝出席。**Calendar 狀態留空＝沒有資訊，兩邊都不改**；本地 `A` 對 Calendar 非空且不同 → `conflict:true`（⚠️ 狀態衝突組，預設不勾，兩個方向都算）；`statusPatchPayload('A')` 寫「狀態：A」、location 清空（補堂保留 MU）。
- 內容配對（`reconcileByContent`）：配對用全部課堂（跨導師，`allCells`），只有「Calendar 沒有這堂」的刪除判斷用導師範圍；已按 id 配到的事件（`diff.matchedEventIds`）不再進內容配對。`listWindow` 帶 `timeZone=<瀏覽器時區>`。
- 待補堂池：`poolMakeupDraft(lesson)` 產生補堂草稿（`isMakeup`、`originLessonId` 指向最初常規課、`status:'SCHEDULED'`）；「複製標題」= `GACSchedule.lessonTitle(draft)`、「複製內容」= `GACGcal.describeLesson(draft)`（含 狀態：MU）；手動建的事件同步時在「➕ 手動新建」選「作為補堂 ←」收編，並記下事件 id／日曆／eid。
- WhatsApp 連結統一 `https://wa.me/<phone>?text=…`。

## 6. 測試基礎

- 單元測試 `tests/*.test.js`（Node 內建 test runner）。新增：`roster.test.js`（tutorsFromRoster）、`demo-data.test.js`（demo_data.js 與 data.js 同載不衝突、結構完整；vm 另一 realm 的陣列要 JSON 轉一次再 deepStrictEqual）、`file-store.test.js`（檔案後備存放的合併／失敗／並發語意、`pickStorage`、`fileSaver`、`serve.js` 的 `/__state` 與注入）。
- 冒煙 `tests/smoke/smoke.js`（本輪從暫存區搬進倉庫）：stub DOM（`getEl` 建立持久元素，checkbox 狀態跨段落殘留要自己設；`querySelectorAll` 走 `__qsaHook`；日期釘在 2026-09-15；`confirm/prompt/fetch/open/clipboard` 可覆寫；非同步尾段串 `__icsSyncTail → __muMoveTail → __statusSyncTail → __tutorCalTail → __asyncTail → __fileModeTail`）。沙盒預設月曆視圖，`onWeekSelectChange()` 不重繪清單，要直接 `renderMasterScheduleList()`。
- 真實 DOM 驗證：用 `chrome.exe --headless=new --remote-debugging-port` ＋ Node 內建 WebSocket 走 CDP（`Runtime.evaluate`、`Page.javascriptDialogOpening`）；serve.py 用 miniconda 的 python 測。
- 改檔方式：Node 補丁腳本（精確錨點、CRLF 保留、MISSING／AMBIGUOUS 檢查）；Bash heredoc 太長會 ENAMETOOLONG、反斜線會被吃，大腳本用 Write 工具寫。

## 7. 未做／待確認

- Mac 端 `serve.command` 的查埠／kill 流程只做了語法檢查，未在 Mac 實機跑。
- 曾提議但未做：設定頁「從 Google 帳號選日曆」（按名字選）；「➕ 手動新建」在只有一個候選請假時自動預選；待補堂池加「同步 GCal」鍵。
- 舊 `groupCourses` 結構的小組不轉換（使用者決定之後在系統手動建）。
- 脫敏約束：倉庫不得出現真實學生／導師／電話／電郵／機構資料；使用者的 OAuth Client ID、真實日曆 ID、真實 `data.js`、`local-state.json` 一律不進 git；`zz_requests/` 只在本機。
