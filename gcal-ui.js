// gcal-ui.js — Google Calendar 同步的瀏覽器膠水層（Phase 2）
// OAuth：Google Identity Services（GIS）取 access token，僅存記憶體；API 呼叫走 lib/gcal.js 的 REST client。
// 前置：設定頁填 gcalClientId；頁面須經 http(s) 開啟（GIS 不支援 file://，可用 serve.cmd 或 VS Code Live Server）。
// 唯讀模式（設定 gcalWrite=false）：只申請唯讀 scope，同步面板只拉回 Calendar 的改動（按內容配對），不推送不刪除；
// 另有「匯入 ICS」：不用 OAuth，上傳日曆匯出檔（lib/ics.js 解析）走同一個比對面板。

let gcalToken = null;   // { accessToken, expiresAt }，僅存記憶體，刷新即失效

function gcalPreflight() {
    if (!appSettings.gcalClientId) {
        alert('請先在「設定」頁籤填寫 Google OAuth Client ID。\n\n（GCP Console → APIs & Services → Credentials 建立 OAuth client：\n類型 Web application，Authorized JavaScript origins 加入你開啟本頁的網址，\n並啟用 Google Calendar API）');
        switchTab('settingsTab');
        openSettingsModule('gcal');
        return false;
    }
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
        alert('Google 授權不支援以 file:// 開啟的頁面。\n請用本地伺服器開啟（雙擊 serve.cmd，或 VS Code Live Server：http://127.0.0.1:5500/…），\n並把該網址加入 OAuth client 的 Authorized JavaScript origins。');
        return false;
    }
    return true;
}

// 惰性載入 GIS：離線／被攔截時明確報錯，本地功能不受影響（D7）
function loadGisScript() {
    return new Promise((resolve, reject) => {
        if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) { resolve(); return; }
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = () => {
            if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) resolve();
            else reject(new Error('Google 登入元件載入異常'));
        };
        s.onerror = () => reject(new Error('無法載入 Google 登入元件（網路不通或被攔截）'));
        document.body.appendChild(s);
        setTimeout(() => reject(new Error('載入 Google 登入元件逾時')), 15000);
    });
}

// 寫入授權開關（設定 → Google Calendar）：關閉＝只申請唯讀 scope、同步不推送不刪除、清場只清本地
function gcalWriteEnabled() { return !appSettings || appSettings.gcalWrite !== false; }

const GCAL_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GCAL_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
function gcalScope() {
    return gcalWriteEnabled() ? GCAL_WRITE_SCOPE : GCAL_READ_SCOPE;
}

// 總課表按鈕標示目前模式（載入與儲存設定時呼叫）
function applyGcalModeUi() {
    const on = gcalWriteEnabled();
    const label = document.getElementById('gcalSyncBtnLabel');
    if (label) label.textContent = on ? '同步 GCal' : '同步 GCal（唯讀）';
    const btn = document.getElementById('gcalSyncBtn');
    if (btn) {
        btn.title = on
            ? '一次過比對本地與 Google Calendar（本月前後各 7 天）：缺的推送、GCal 上的改動拉回（Calendar 為準）、殘留清掉、手動事件收編——面板逐項勾選後執行。需在設定頁填 Client ID 並經 http 開啟'
            : '唯讀模式：只讀取 Google Calendar（唯讀授權），把 Calendar 上的改動拉回本地（按學生 ID／姓名、小組名稱配對）；不推送、不刪除。設定 → Google Calendar 可開啟寫入授權；不想用 OAuth 可改用「匯入 ICS」';
    }
}

// scopeOverride：只有「強制清空（debug）」用——唯讀設定下這一次臨時要寫入授權
function ensureGcalToken(scopeOverride) {
    const scope = scopeOverride || gcalScope();
    if (gcalToken && gcalToken.scope === scope && Date.now() < gcalToken.expiresAt - 60000) {
        return Promise.resolve(gcalToken.accessToken);
    }
    return loadGisScript().then(() => new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
            client_id: appSettings.gcalClientId,
            scope: scope,
            callback: (resp) => {
                if (resp && resp.access_token) {
                    gcalToken = {
                        accessToken: resp.access_token,
                        scope: scope,
                        expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000
                    };
                    resolve(gcalToken.accessToken);
                } else {
                    reject(new Error((resp && resp.error) || 'Google 授權被拒絕'));
                }
            },
            error_callback: (err) => reject(new Error((err && err.type) || 'Google 授權視窗被關閉'))
        });
        client.requestAccessToken();
    }));
}

// calendarId 省略＝設定的預設日曆；導師日曆（設定 → Google Calendar → 導師日曆的日曆 ID）讀取時逐一傳入
function gcalClient(token, calendarId) {
    return GACGcal.createRestClient({
        // 每個請求 30 秒逾時：網路卡住時明確報錯，而不是永遠沒動靜
        fetchFn: (u, o) => {
            const init = Object.assign({}, o);
            try {
                if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(30000);
            } catch (e) { /* 舊瀏覽器不支援就算了 */ }
            return fetch(u, init);
        },
        token: token,
        calendarId: GACGcal.normalizeCalendarId(calendarId || appSettings.gcalCalendarId) || 'primary'
    });
}

// 要讀取的日曆：有填日曆 ID 的導師各一個（事件標 _tutor，按導師配對）；都沒填 → 預設日曆一個
// 讀某本日曆失敗時，錯誤要說清楚是哪一本；404 幾乎都是 ID 打錯或授權的 Google 帳號沒被分享這本日曆
function gcalCalendarErrorText(label, e) {
    const msg = (e && e.message) || String(e);
    let hint = '';
    if (/\b404\b/.test(msg)) {
        hint = '\n→ 404＝找不到這本日曆。多半是：(1)「導師日曆 ID」打錯——要用 Google 日曆 → 設定 → 該日曆 → 整合日曆 → 日曆 ID（形如 xxx@group.calendar.google.com），不是網址、不是日曆名稱；' +
            '(2) 授權時登入的 Google 帳號沒有這本日曆的權限——先在 Google 日曆把它分享給該帳號（或用日曆擁有者的帳號授權）。';
    } else if (/\b403\b/.test(msg)) {
        hint = '\n→ 403＝沒有權限：這個 Google 帳號看不到或不能改這本日曆，或 Cloud 專案未啟用 Google Calendar API。';
    }
    return `讀取${label}失敗：${msg}${hint}`;
}

function gcalDefaultCalendarId() { return GACGcal.normalizeCalendarId(appSettings.gcalCalendarId) || 'primary'; }
// 這位導師的課放哪本日曆：填了導師日曆 ID → 那本；沒填（或不在名單）→ 預設日曆。推送、一鍵推、搬事件都以此為準
function gcalCalendarForTutor(tutorName) {
    const t = (typeof tutorsList !== 'undefined' ? tutorsList : []).find(x => x && x.name === tutorName);
    const id = t ? GACGcal.normalizeCalendarId(t.calendarId) : '';
    return id || gcalDefaultCalendarId();
}
function gcalCalendarForCell(cell) { return gcalCalendarForTutor(cell && cell.lessons && cell.lessons[0] ? cell.lessons[0].tutor : ''); }
// 給人看的日曆名：「導師 B 的日曆」／「預設日曆」
function gcalCalendarLabel(calendarId) {
    const t = (typeof tutorsList !== 'undefined' ? tutorsList : []).find(x => x && GACGcal.normalizeCalendarId(x.calendarId) === calendarId);
    if (t) return `導師 ${t.name} 的日曆`;
    return calendarId === gcalDefaultCalendarId() ? '預設日曆' : `日曆 ${calendarId}`;
}
// 本系統會碰到的全部日曆（預設＋每位導師填了的；去重）：清空本月／全部清場／強制清空逐本掃
function gcalCalendarTargets() {
    const seen = {};
    const list = [];
    const add = (id, label) => { if (id && !seen[id]) { seen[id] = true; list.push({ id, label }); } };
    const def = gcalDefaultCalendarId();
    add(def, `預設日曆（${def}）`);
    (typeof tutorsList !== 'undefined' ? tutorsList : []).forEach(t => {
        const id = t ? GACGcal.normalizeCalendarId(t.calendarId) : '';
        if (id) add(id, `${t.name}（${id}）`);
    });
    return list;
}
// 要讀的日曆：有填日曆 ID 的導師各一本（事件標 _tutor，按導師配對）；還有導師沒填 ID（他們的課在預設日曆）或都沒填 → 也讀預設日曆
function gcalCalendarsToRead() {
    const tutors = (typeof tutorsList !== 'undefined' ? tutorsList : []).filter(Boolean);
    const withId = tutors.filter(t => GACGcal.normalizeCalendarId(t.calendarId));
    const list = withId.map(t => ({ tutor: t.name, calendarId: GACGcal.normalizeCalendarId(t.calendarId) }));
    const names = (typeof allTutorNames === 'function') ? allTutorNames() : tutors.map(t => t.name);
    const someWithout = names.some(n => !withId.some(t => t.name === n));
    const def = gcalDefaultCalendarId();
    if ((!list.length || someWithout) && !list.some(c => c.calendarId === def)) list.push({ tutor: null, calendarId: def });
    return list;
}
// 逐本日曆（預設＋每位導師的）列出視窗內的事件，每件標上 _calendarId（刪的時候要知道在哪一本）
function gcalListAllCalendars(token, timeMin, timeMax) {
    let chain = Promise.resolve([]);
    gcalCalendarTargets().forEach(t => {
        chain = chain.then(acc => gcalClient(token, t.id).listWindow(timeMin, timeMax)
            .catch(e => { throw new Error(gcalCalendarErrorText(t.label, e)); })
            .then(evs => acc.concat((evs || []).map(ev => Object.assign(ev, { _calendarId: t.id })))));
    });
    return chain;
}
// 逐件在它所在的那本日曆刪（items: {eventId, lessonId, calendarId}；沒標日曆 → 預設）；結果合併
function gcalDeleteAcross(token, items, onEach) {
    const byCal = new Map();
    (items || []).forEach(it => { const id = it.calendarId || gcalDefaultCalendarId(); if (!byCal.has(id)) byCal.set(id, []); byCal.get(id).push(it); });
    const merged = { ok: true, deleted: [], gone: [], failed: [] };
    let chain = Promise.resolve();
    byCal.forEach((list, id) => {
        chain = chain.then(() => GACGcal.deleteEvents(gcalClient(token, id), list, onEach)).then(r => {
            merged.ok = merged.ok && r.ok;
            merged.deleted = merged.deleted.concat(r.deleted); merged.gone = merged.gone.concat(r.gone); merged.failed = merged.failed.concat(r.failed);
        });
    });
    return chain.then(() => merged);
}
// 每節推到該導師的日曆（check-then-insert 也在那一本查重）；成員記下所在日曆 gcalCalId；結果合併並按日曆分列
function gcalPushAcross(token, cells, opts) {
    const byCal = new Map();
    (cells || []).forEach(c => { const id = gcalCalendarForCell(c); if (!byCal.has(id)) byCal.set(id, []); byCal.get(id).push(c); });
    const merged = { ok: true, inserted: [], skipped: [], failed: [], perCalendar: [] };
    let chain = Promise.resolve();
    byCal.forEach((list, id) => {
        chain = chain.then(() => GACGcal.importCells(gcalClient(token, id), list, opts)).then(r => {
            list.forEach(c => c.lessons.forEach(l => { if (l.gcalEventId) l.gcalCalId = id; }));
            merged.ok = merged.ok && r.ok;
            merged.inserted = merged.inserted.concat(r.inserted); merged.skipped = merged.skipped.concat(r.skipped); merged.failed = merged.failed.concat(r.failed);
            merged.perCalendar.push({ calendarId: id, label: gcalCalendarLabel(id), inserted: r.inserted.length, skipped: r.skipped.length, failed: r.failed.length });
        });
    });
    return chain.then(() => merged);
}

// 設定頁「測試」：用目前授權的帳號試讀某位導師的日曆（只取 1 件）。404／403 直接把原因寫出來
function testTutorCalendar(name) {
    const t = (typeof tutorsList !== 'undefined' ? tutorsList : []).find(x => x.name === name);
    const id = t ? GACGcal.normalizeCalendarId(t.calendarId) : '';
    if (!id) { alert(`${name} 尚未填日曆 ID。`); return; }
    if (!appSettings.gcalClientId) { alert('先填 Google OAuth Client ID（並儲存設定）才能測試讀取。'); return; }
    const label = `導師 ${name} 的日曆（${id}）`;
    ensureGcalToken()
        .then(token => gcalClient(token, id).probe())
        .then(r => alert(`✅ 讀得到${label}。${r.sample ? '' : '（這本日曆目前沒有事件）'}`))
        .catch(e => alert('❌ ' + gcalCalendarErrorText(label, e)));
}

function monthLastDay(monthKey) {
    const p = String(monthKey).split('-').map(Number);
    return monthKey + '-' + String(new Date(p[0], p[1], 0).getDate()).padStart(2, '0');
}

// 只有「知道這本日曆屬於哪位導師」時，才敢判斷「Calendar 上沒有這堂」＝這堂被取消。
// 否則（多位導師、卻讀的是一本不知屬誰的日曆）整批課會被誤判成請假，寧可少報。
function canDetectMissing(tutor) {
    if (tutor) return true;
    const names = (typeof allTutorNames === 'function') ? allTutorNames() : [];
    return names.length <= 1; // 全校只有一位導師 → 那本日曆必然是他的
}

// 按內容對帳的選項：學生／小組名單、導師範圍、已配對課節、「Calendar 沒有」只看本月
function contentOpts(tutor, skipKeys, monthKey) {
    return {
        students: studentDatabase.map(s => ({ id: s.id, name: s.name })),
        groups: groupClasses.map(g => ({ id: g.id, name: g.name })),
        tutor: tutor || null,
        skipCellKeys: skipKeys || {},
        detectMissing: canDetectMissing(tutor),
        deleteFrom: monthKey + '-01',
        deleteTo: monthLastDay(monthKey)
    };
}

// .ics 的日曆名稱（X-WR-CALNAME）裡有導師名字 → 自動認定這是誰的日曆（最長匹配優先）
function detectIcsTutor(cal) {
    const hay = String((cal && cal.name) || '').toLowerCase();
    if (!hay) return '';
    let best = '';
    ((typeof allTutorNames === 'function') ? allTutorNames() : []).forEach(n => {
        const name = String(n || '').trim();
        if (name.length >= 2 && hay.indexOf(name.toLowerCase()) !== -1 && name.length > best.length) best = name;
    });
    return best;
}

function gcalTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}

function setGcalBusy(busy) {
    ['gcalSyncBtn'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = busy;
    });
}

// ===== 同步 GCal：單一入口。一次授權、一次抓取，兩邊差異分組列在同一面板勾選執行 =====
// 分組（預設勾選＝執行後兩邊一致，GCal 上的改動以 Calendar 為準）：
//   ⬆️ 推送     本地有、GCal 缺 → 新增事件（check-then-insert，絕不覆蓋既有）
//   🕒 時間變更  GCal 上被挪動 → 更新本地（id 不變跨月移桶）
//   🏷️ 狀態碼   GCal location/標題含 L/SL/TL/NS → 更新本地狀態
//   🗑️ 已刪除   本地曾導入但事件已不在 → 本地標請假（≥5 件視為批量清場，防呆不勾）
//   🧹 殘留     標籤對不上任何本地課（本地改動/重新生成後的舊事件）→ 從 GCal 刪除
//   ➕ 手動新建 GCal 手動建立、可歸屬學生 → 收編為補堂或獨立加課（需逐條選擇，預設不勾）
//   🔁 本地改期  本地改了時間、Calendar 仍是舊時間 → PATCH 原事件（唯讀：列「請到 Calendar 改」）
//   📤 寫回狀態  本地標了請假／缺席、Calendar 沒填或不同 → PATCH 地點欄＋說明欄「狀態：」一行（唯讀：列「請到 Calendar 填」）
// 「兩邊都有資訊、又不一樣」（時間：本地改了、Calendar 也被拖到第三個時間；狀態：本地 L、Calendar SL）
// 以哪邊為準看設定 appSettings.gcalConflict（'gcal' 預設｜'local'）；只有一邊改了的一律跟那一邊。
let gcalSyncPlan = null;
let gcalSyncBusy = false; // 執行中：背景／Esc 不關面板（app.js MODAL_CLOSERS 讀取）

function openGcalSync() {
    if (!gcalPreflight()) return;
    const monthKey = currentMonthKey();
    const opts = { titleFn: GACSchedule.lessonTitle, timeZone: gcalTimeZone() };
    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            const w = GACGcal.syncWindow(monthKey);
            // 導師日曆逐一讀（事件標 _tutor）；都沒填 → 預設日曆
            let chain = Promise.resolve([]);
            gcalCalendarsToRead().forEach(c => {
                const label = `${c.tutor ? '導師 ' + c.tutor + ' 的' : '預設'}日曆（${c.calendarId}）`;
                chain = chain.then(acc => gcalClient(token, c.calendarId).listWindow(w.timeMin, w.timeMax)
                    .catch(e => { throw new Error(gcalCalendarErrorText(label, e)); })
                    .then(evs => acc.concat((evs || []).map(ev => Object.assign(ev, { _tutor: c.tutor, _calendarId: c.calendarId })))));
            });
            return chain;
        })
        .then(events => {
            const w = GACGcal.syncWindow(monthKey);
            const lo = w.timeMin.slice(0, 10), hi = w.timeMax.slice(0, 10);
            const windowLessons = GACLessonState.allLessons(lessonsByMonth)
                .filter(l => l.date >= lo && l.date <= hi);
            const writeOn = gcalWriteEnabled();
            const rule = appSettings.gcalConflict === 'local' ? 'local' : 'gcal';
            // 本地改期過的課 ↔ Calendar 上原本那個事件（看全部課：補堂可能搬到別的月份）。
            // 寫入模式：列進「改 GCal 事件」（PATCH 原事件，不另建）；唯讀：列進「請到 Calendar 改」。
            // 已在新 key／新時間的 → 記號清掉；唯讀下 Calendar 已是新時間（只差標籤）也算好了，記下事件 id 以後靠 id 認
            const lm = GACGcal.planLocalMoves(GACLessonState.allLessons(lessonsByMonth), events);
            const settleNow = lm.settled.concat(writeOn ? [] : lm.moves.filter(m => m.tagOnly));
            // 兩邊都改了時間：本系統為準 → 當改期處理（PATCH／請到 Calendar 改）；Calendar 為準 → 交給「時間變更」拉回
            const conflictMoves = rule === 'local' ? lm.conflicts.map(c => Object.assign({}, c, { from: c.at, tagOnly: false, conflict: true })) : [];
            const relinks = lm.moves.filter(m => writeOn || !m.tagOnly).concat(conflictMoves);
            const settleLessons = s => s.lessons.forEach(l => { delete l.gcalMovedFrom; l.gcalAdded = true; if (s.event && s.event.id) l.gcalEventId = s.event.id; });
            settleNow.forEach(settleLessons);
            const moveKeys = new Set(relinks.map(m => m.cell.key));
            const moveEvIds = new Set(relinks.map(m => m.event.id));
            const diff = GACGcal.reconcile(windowLessons, events, studentDatabase.map(s => s.id));
            // 本地改期的節：Calendar 仍在舊時間是「待改 Calendar」，不是「Calendar 改了時間」，也不是「Calendar 刪了」
            diff.timeChanges = diff.timeChanges.filter(c => !moveKeys.has(c.cell.key));
            diff.deletions = diff.deletions.filter(d => !moveKeys.has(d.cell.key));
            diff.manualNew = diff.manualNew.filter(m => !moveEvIds.has(m.event.id));
            // 殘留：本月帶標籤事件（牆鐘月份）中，key 對不上任何本地課節者（跨月補堂也算本地課；
            // 小組課改成一節一事件後，舊的逐人事件也會在此現身，勾選即清）
            const monthEvents = events.filter(ev => {
                if (!ev || ev.status === 'cancelled' || !GACGcal.eventCellKey(ev)) return false;
                const local = GACGcal.eventStartToLocal(ev);
                return !!local && local.date.slice(0, 7) === monthKey;
            });
            const pre = GACGcal.importPrecheck(GACLessonState.allLessons(lessonsByMonth), monthEvents, opts);
            // 靠事件 id 認回的、要改期的，都不是殘留
            pre.orphans = pre.orphans.filter(ev => !moveEvIds.has(ev.id) && !diff.matchedEventIds[ev.id]);
            // 推送候選：本月課節中 GCal（視窗內）沒有對應事件者（一節一事件：小組一個）。
            // 「已刪除」組的課節排除在外——同一節不能同時「標請假」又「重推」；不勾刪除的下次同步可再推。
            const evByKey = {};
            events.forEach(ev => {
                if (!ev || ev.status === 'cancelled') return;
                const key = GACGcal.eventCellKey(ev);
                if (key) evByKey[key] = ev;
            });
            const delKeys = new Set(diff.deletions.map(d => d.cell.key));
            // 本月的課＋視窗內（前後 7 天）別的月份的補堂：從待補堂池排到下個月初的補堂也推得到
            const toPush = GACSchedule.groupByCell(windowLessons.filter(l => l.date.slice(0, 7) === monthKey || l.isMakeup))
                .filter(c => !evByKey[c.key] && !diff.matchedKeys[c.key] && !moveKeys.has(c.key) && !delKeys.has(c.key));
            let timeChanges = diff.timeChanges, deletions = diff.deletions, manualNew = diff.manualNew;
            let unmatched = 0, missingOff = false, staleMoves = writeOn ? [] : relinks.slice();
            // 已配對的課節 ↔ 事件（狀態雙向用；要改期的節不算——改期的 PATCH 已含狀態）
            let pairs = diff.pairs.filter(pr => !moveKeys.has(pr.cell.key));
            if (!writeOn) {
                // 唯讀模式：本系統沒寫過標籤 → 無標籤事件按內容（學生 ID／姓名、小組名稱）配對；有標籤的仍按標籤。
                // 已由標籤配對／判定刪除的課節不再進內容配對（避免同一節兩行）。
                const skip = {};
                events.forEach(ev => { const k = ev && GACGcal.eventCellKey(ev); if (k) skip[k] = true; });
                diff.deletions.forEach(d => { skip[d.cell.key] = true; });
                Object.keys(diff.matchedKeys).forEach(k => { skip[k] = true; });
                moveKeys.forEach(k => { skip[k] = true; });
                const byTutor = new Map();
                events.forEach(ev => {
                    if (ev && ev.id && diff.matchedEventIds[ev.id]) return;   // 已靠事件 id 認回某一節的，不再進內容配對（否則會被當成手動新建）
                    const t = (ev && ev._tutor) || '';
                    if (!byTutor.has(t)) byTutor.set(t, []);
                    byTutor.get(t).push(ev);
                });
                manualNew = [];
                byTutor.forEach((evs, tutor) => {
                    if (!canDetectMissing(tutor || null)) missingOff = true;
                    const r = GACGcal.reconcileByContent(windowLessons, evs, contentOpts(tutor || null, skip, monthKey));
                    if (rule === 'local') {
                        // 本系統為準：本地改期過的節，Calendar 時間又不同＝兩邊都改了 → 列「請到 Calendar 改」而不是拉回
                        const movedCell = c => c.cell.lessons.some(l => l.gcalMovedFrom);
                        timeChanges = timeChanges.concat(r.timeChanges.filter(c => !movedCell(c)));
                        staleMoves = staleMoves.concat(r.timeChanges.filter(movedCell).map(c =>
                            ({ cell: c.cell, lessons: c.lessons, lesson: c.lesson, event: c.event, from: { date: c.date, time: c.time }, duplicate: false, conflict: true })));
                    } else timeChanges = timeChanges.concat(r.timeChanges);
                    pairs = pairs.concat(r.pairs.filter(pr => !moveKeys.has(pr.cell.key)));
                    deletions = deletions.concat(r.deletions);
                    manualNew = manualNew.concat(r.manualNew);
                    unmatched += r.unmatched.length;
                    staleMoves = staleMoves.concat(r.staleMoves);
                    r.settled.forEach(settleLessons);
                    settleNow.push.apply(settleNow, r.settled);
                });
            }
            // 每節記下 Calendar 上那個事件的 eid（課卡按鈕打開編輯頁用）與 Calendar 目前的碼（本地標了請假而 Calendar 沒填 → 課卡提示）
            pairs.forEach(pr => {
                const eid = GACGcal.eidFromLink(pr.event.htmlLink), code = GACGcal.calStatusCode(pr.event) || '';
                pr.cell.lessons.forEach(l => {
                    if (eid) l.gcalEid = eid;
                    l.gcalCode = code;
                    if (pr.event._calendarId) l.gcalCalId = pr.event._calendarId;
                    if (writeOn && pr.event.id && !l.gcalEventId) l.gcalEventId = pr.event.id;   // 標籤配對到的就是它，記下來一鍵推時直接 PATCH
                });
            });
            // 放錯日曆：帶標籤配對上了、但事件不在該導師的日曆（例如以前推送只到預設日曆）→ 搬到導師的日曆（events.move，id 與內容不變）
            const relocations = [];
            if (writeOn) {
                const seenEv = {};
                const consider = (cell, ev) => {
                    if (!cell || !ev || !ev.id || !ev._calendarId || seenEv[ev.id]) return;
                    const to = gcalCalendarForCell(cell);
                    if (to === ev._calendarId) return;
                    seenEv[ev.id] = true;
                    relocations.push({ cell: cell, lessons: cell.lessons, lesson: cell.lessons[0], event: ev, from: ev._calendarId, to: to });
                };
                pairs.forEach(pr => consider(pr.cell, pr.event));
                relinks.forEach(m => consider(m.cell, m.event));
            }
            // 狀態雙向：Calendar 的碼 → 本地（statusChanges）；本地的狀態 → Calendar（寫入：PATCH 一項勾選；唯讀：請到 Calendar 填）
            const st = GACGcal.planStatusSync(pairs, rule);
            const statusChanges = st.toLocal;
            if (settleNow.length || pairs.length) persistLessons();   // 只是中繼資料（改期記號／事件 id、eid、碼），課堂本身沒變
            gcalSyncPlan = {
                rule: rule,
                pushStatus: writeOn ? st.toGcal : [],
                fillStatus: writeOn ? [] : st.toGcal,
                monthKey: monthKey,
                source: 'gcal', readOnly: !writeOn, contentMode: !writeOn, unmatched: unmatched, missingOff: missingOff,
                calendars: gcalCalendarsToRead().length, perTutor: gcalCalendarsToRead().filter(c => c.tutor).map(c => c.tutor),
                defaultToo: gcalCalendarsToRead().some(c => !c.tutor),
                toPush: writeOn ? toPush : [],
                moves: writeOn ? relinks : [],
                relocations: relocations,
                staleMoves: staleMoves,
                timeChanges: timeChanges,
                statusChanges: statusChanges,
                deletions: deletions,
                orphans: writeOn ? pre.orphans : [],
                manualNew: manualNew
            };
            renderGcalSyncModal();
        })
        .catch(e => alert('⚠️ 同步未執行：' + ((e && e.message) || e) + '\n本地與 GCal 均未改動。'))
        .finally(() => setGcalBusy(false));
}

// 差異列的主體文字：小組節顯示「👥 program 小組 ×n：成員…」，一對一顯示學生
function gcalCellLabel(item) {
    const members = item.lessons || (item.cell && item.cell.lessons) || (item.lesson ? [item.lesson] : []);
    const rep = members[0];
    if (!rep) return '';
    const isGroup = (item.cell && item.cell.isGroup) || (members.length > 1);
    if (isGroup) {
        return `👥 <b>${rep.program} ${rep.level} 小組 ×${members.length}</b>：${members.map(l => l.studentName).join('、')}`;
    }
    return `<b>${rep.studentName}</b>（${rep.studentId}）`;
}

// 事件的編輯頁：由 htmlLink 的 eid 組出 calendar.google.com/calendar/r/eventedit/<eid>（沒有 eid 就退回 htmlLink）
function gcalEventEditUrl(ev) {
    const eid = GACGcal.eidFromLink(ev && ev.htmlLink);
    return eid ? 'https://calendar.google.com/calendar/r/eventedit/' + eid : ((ev && ev.htmlLink) || '');
}

function gcalSyncRow(chkId, text, extraHtml, checked) {
    return `<label class="flex items-start gap-2 p-2 border border-slate-200 rounded-lg text-xs cursor-pointer hover:bg-slate-50">
        <input type="checkbox" id="${chkId}"${checked ? ' checked' : ''} class="mt-0.5 w-4 h-4 accent-indigo-600">
        <span class="flex-1">${text}${extraHtml || ''}</span>
    </label>`;
}

function renderGcalSyncModal() {
    const body = document.getElementById('gcalSyncBody');
    if (!body || !gcalSyncPlan) return;
    const p = gcalSyncPlan;
    const parts = [];
    const total = p.toPush.length + p.timeChanges.length + p.statusChanges.length +
        p.deletions.length + p.orphans.length + p.manualNew.length + (p.moves || []).length + (p.staleMoves || []).length +
        (p.pushStatus || []).length + (p.fillStatus || []).length + (p.relocations || []).length;
    const ruleName = p.rule === 'local' ? '本系統' : 'Calendar';
    gcalSyncFooterMode(total ? 'act' : 'ack');
    const title = document.getElementById('gcalSyncTitle');
    if (title) {
        title.innerHTML = p.source === 'ics'
            ? '<i class="fa-solid fa-file-import text-indigo-500 mr-1"></i>匯入 ICS 比對（唯讀）'
            : '<i class="fa-solid fa-rotate text-indigo-500 mr-1"></i>同步 Google Calendar' + (p.readOnly ? '（唯讀）' : '');
    }
    if (p.source === 'ics') {
        const whose = p.tutor
            ? `（${escapeHtml(p.tutor)} 的日曆${p.tutorAuto ? '，由日曆名稱自動辨認' : ''}，只比對該導師的課）`
            : '（未指定導師）';
        parts.push(`<div class="p-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-xs">📄 來源：ICS 檔案${p.calName ? '「' + escapeHtml(p.calName) + '」' : ''}${whose}，視窗內 ${p.eventCount} 個事件。唯讀比對，只會更新本地。${p.unmatched ? ` 另有 ${p.unmatched} 個事件無法歸屬學生／小組（略過）。` : ''}</div>`);
    } else if (p.readOnly) {
        const who = (p.perTutor && p.perTutor.length)
            ? `已按導師分別讀取：${p.perTutor.map(escapeHtml).join('、')}（各自的日曆 ID），比對時只比該導師的課。${p.defaultToo ? '沒填日曆 ID 的導師在預設日曆比對。' : ''}`
            : '目前讀的是「預設日曆 ID」那一本；在設定填上每位導師的日曆 ID，就會分別讀取並按導師比對。';
        parts.push(`<div class="p-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-xs">🔒 唯讀模式：只拉取 Calendar 上的改動，不推送、不刪除（設定 → Google Calendar 可開啟寫入授權）。${who}${p.unmatched ? ` 另有 ${p.unmatched} 個事件無法歸屬學生／小組（略過）。` : ''}</div>`);
    }
    if (p.missingOff) {
        parts.push('<div class="p-2 bg-amber-50 border border-amber-300 rounded-lg text-amber-900 text-xs">⚠️ 不確定這本日曆屬於哪位導師（未填導師日曆 ID），因此<b>不判斷「Calendar 上沒有這堂」</b>——以免把其他導師的課整批誤判成取消。要用這項檢查，請在設定填上該導師的日曆 ID，或匯入 ICS 時選好導師。</div>');
    }
    if (p.contentMode && total) {
        parts.push('<div class="text-[11px] text-slate-500">按內容配對：事件標題以學生 ID 開頭或含學生姓名／小組名稱；同一學生（小組）同一天＝同一節。改到別的日子的課會同時出現在「Calendar 沒有」與「手動新建」，勾選＝請假＋補堂。</div>');
    }
    if (!total) {
        parts.push('<div class="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs font-semibold">✅ 本地與 Google Calendar 完全一致，沒有需要同步的項目。</div>');
    } else {
        parts.push(`<div class="p-2 bg-indigo-50 border border-indigo-200 rounded-lg text-indigo-800 text-xs">範圍：${p.monthKey}（前後各 7 天）。共 ${total} 項差異——<b>預設勾選＝執行後兩邊一致</b>（只有一邊改了的跟那一邊；兩邊都改了時以 ${ruleName} 為準——設定 → Google Calendar 可改）。個別不想動的項目取消勾選即可。</div>`);
    }
    if (p.toPush.length) {
        const multiCal = gcalCalendarTargets().length > 1;   // 不止一本日曆 → 每行寫明推到誰的
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">⬆️ 推送：本地有、GCal 沒有（一節一個事件；小組全組一個；推到該導師的日曆。絕不覆蓋既有）</div>');
        p.toPush.forEach((c, i) => {
            const rep = c.lessons[0];
            parts.push(gcalSyncRow('gsP_' + i,
                `${gcalCellLabel(c)} ${rep.date} ${rep.time}${rep.isMakeup ? '（補堂）' : ''}${!c.isGroup && rep.status === 'LEAVE' ? '（請假紀錄）' : ''}${multiCal ? ' → ' + escapeHtml(gcalCalendarLabel(gcalCalendarForCell(c))) : ''}`, '', true));
        });
    }
    if ((p.moves || []).length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🔁 本地改期 → 改 GCal 上原本那個事件（不另建新事件；補堂改期後會接回同一個事件）</div>');
        p.moves.forEach((m, i) => {
            const rep = m.lesson;
            parts.push(gcalSyncRow('gsV_' + i, m.tagOnly
                ? `${gcalCellLabel(m)} ${rep.date} ${rep.time}${rep.isMakeup ? '（補堂）' : ''}：Calendar 上已是這個時間，只更新事件內容與標籤`
                : `${gcalCellLabel(m)}${rep.isMakeup ? '（補堂）' : ''} GCal ${m.from.date || ''} ${m.from.time || ''} → <b>${rep.date} ${rep.time}</b>`, '', true));
        });
    }
    if ((p.relocations || []).length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">📦 搬到導師的日曆：事件在別本日曆（例如以前推送只到預設日曆）→ 搬到該導師的日曆（事件 id 與內容不變）</div>');
        p.relocations.forEach((m, i) => {
            const rep = m.lesson;
            parts.push(gcalSyncRow('gsR_' + i,
                `${gcalCellLabel(m)} ${rep.date} ${rep.time}${rep.isMakeup ? '（補堂）' : ''}：${escapeHtml(gcalCalendarLabel(m.from))} → <b>${escapeHtml(gcalCalendarLabel(m.to))}</b>`, '', true));
        });
    }
    if ((p.staleMoves || []).length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">📌 本地已改期、Calendar 上還是舊時間（唯讀模式不會替你改）→ 請在 Calendar 打開該事件，把時間改成新時間；改好後再同步就會消失</div>');
        p.staleMoves.forEach(m => {
            const rep = m.lesson;
            const url = gcalEventEditUrl(m.event);
            const link = url ? ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="text-indigo-600 underline">在 Calendar 打開（編輯）</a>` : '';
            parts.push(`<div class="p-2 border border-amber-200 bg-amber-50 rounded-lg text-xs text-amber-900">${gcalCellLabel(m)}${rep.isMakeup ? '（補堂）' : ''}：Calendar ${m.from.date || ''} ${m.from.time || ''} → 應為 <b>${rep.date} ${rep.time}</b>` +
                (m.duplicate ? '（新時間已有事件 → 舊時間這個是重複的，請在 Calendar 刪除）' : '') +
                (m.conflict ? '（Calendar 上也被改過；設定為本系統為準 → 請把 Calendar 改成本地的時間）' : '') + link + '</div>');
        });
    }
    if ((p.pushStatus || []).length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">📤 寫回狀態到 GCal（本地標了請假／缺席，Calendar 沒填或不同 → 改該事件的地點欄與說明欄「狀態：」一行，其他內容保留）</div>');
        p.pushStatus.forEach((s, i) => {
            const have = GACGcal.calStatusCode(s.event) || '';
            parts.push(gcalSyncRow('gsW_' + i,
                `${gcalCellLabel(s)} ${s.lesson.date} ${s.lesson.time}：Calendar「狀態：${have}」 → <b>狀態：${s.code || '（清空）'}</b>`, '', true));
        });
    }
    if ((p.fillStatus || []).length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">📝 本地標了請假／缺席，Calendar 上還沒有（唯讀模式不會替你寫）→ 在 Calendar 打開該事件，說明欄「狀態：」填上；填好再同步就會消失</div>');
        p.fillStatus.forEach(s => {
            const url = gcalEventEditUrl(s.event);
            const link = url ? ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="text-indigo-600 underline">在 Calendar 打開（編輯）</a>` : '';
            parts.push(`<div class="p-2 border border-amber-200 bg-amber-50 rounded-lg text-xs text-amber-900">${gcalCellLabel(s)} ${s.lesson.date} ${s.lesson.time}：請填 <b>狀態：${s.code || '（清空）'}</b>${link}</div>`);
        });
    }
    if (p.timeChanges.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🕒 時間變更（GCal 上被挪動 → 更新本地；小組全體成員一併）</div>');
        p.timeChanges.forEach((c, i) => {
            parts.push(gcalSyncRow('gsT_' + i,
                `${gcalCellLabel(c)} ${c.lesson.date} ${c.lesson.time} → <b>${c.date} ${c.time}</b>`, '', true));
        });
    }
    if (p.statusChanges.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🏷️ 狀態碼變更（GCal 事件 location/標題含 L/SL/TL/NS → 更新本地；小組全體成員一併）</div>');
        p.statusChanges.forEach((s, i) => {
            const toLabel = s.to.status === 'NOSHOW' ? 'NS 缺席' : getLeaveText(s.to.leaveType);
            parts.push(gcalSyncRow('gsS_' + i,
                `${gcalCellLabel(s)} ${s.lesson.date} ${s.lesson.time}：${s.lesson.status} → <b>${toLabel}</b>`, '', true));
        });
    }
    if (p.deletions.length) {
        // 防呆：大量刪除多半是「清場」而非逐堂取消——照套用會整批標請假、灌爆待補堂池。
        const massDelete = p.deletions.length >= 5;
        parts.push(p.contentMode
            ? '<div class="text-xs font-bold text-slate-700 mt-2">🗑️ Calendar 上沒有這堂（該學生／小組當天沒有事件；只列仍為「已排課」的節、只看本月）→ 勾選＝本地標記請假（一對一事假 L、小組導師假 TL）</div>'
            : '<div class="text-xs font-bold text-slate-700 mt-2">🗑️ 事件已在 GCal 刪除（勾選＝跟隨 Calendar：本地標記請假・事假；取消勾選＝保留本地，下次同步可重推）</div>');
        if (massDelete) {
            parts.push(`<div class="p-2 bg-amber-50 border border-amber-300 rounded-lg text-amber-900 text-xs">⚠️ 一次偵測到 ${p.deletions.length} 件刪除——看起來像批量清場而非逐堂取消，<b>已預設不勾</b>（套用會把這些課全部標成請假、湧入待補堂池）。想清場重來請改用「設定 → 清空本月／全部清場」；真的是逐堂取消才自行勾選。</div>`);
        }
        p.deletions.forEach((del, i) => {
            const isGroup = del.cell && del.cell.isGroup;
            parts.push(gcalSyncRow('gsD_' + i,
                `${gcalCellLabel(del)} ${del.lesson.date} ${del.lesson.time}（目前狀態：${del.lesson.status}${isGroup ? '；勾選＝全組標導師假 TL' : ''}）`, '', !massDelete));
        });
    }
    if (p.orphans.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🧹 GCal 殘留：標籤對不上任何本地課（本地改動／重新生成後的舊事件）→ 勾選＝從 GCal 刪除（垃圾桶可還原）</div>');
        p.orphans.forEach((ev, i) => {
            const local = GACGcal.eventStartToLocal(ev) || {};
            parts.push(gcalSyncRow('gsO_' + i,
                `${local.date || ''} ${local.time || ''}　「${ev.summary || '(無標題)'}」`, '', true));
        });
    }
    if (p.manualNew.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">➕ GCal 手動新建、可歸屬學生的事件（勾選＝收編進本地課表）</div>');
        p.manualNew.forEach((m, i) => {
            if (!m.time) {
                parts.push(`<div class="p-2 border border-slate-200 rounded-lg text-xs text-slate-400">「${m.event.summary}」${m.date || ''}（全日事件無時間，無法收編，請在 GCal 補上時間）</div>`);
                return;
            }
            const pendings = GACLessonState.allLessons(lessonsByMonth)
                .filter(l => l.studentId === m.studentId && l.status === 'LEAVE' && !l.makeupLessonId);
            const opts = pendings.map(pd =>
                `<option value="MU:${pd.lessonId}">作為補堂 ←（${pd.date} ${getLeaveText(pd.leaveType)}）</option>`).join('') +
                '<option value="EXTRA">獨立加課（不掛任何請假）</option>';
            parts.push(gcalSyncRow('gsM_' + i,
                `<b>${m.studentId}</b>「${m.event.summary}」${m.date} ${m.time}`,
                `<select id="gsMsel_${i}" onclick="event.preventDefault()" class="block mt-1 px-2 py-1 border border-slate-300 rounded-lg text-xs bg-white">${opts}</select>`));
        });
    }
    body.innerHTML = parts.join('');
    document.getElementById('gcalSyncModal').classList.remove('hidden');
}

function gcalSyncSetAll(checked) {
    document.querySelectorAll('#gcalSyncBody input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
}

// 頁腳模式：'act'＝全選/全不選/取消/執行（有差異待處理）；'ack'＝只有「確認」（零差異或已執行完）
function gcalSyncFooterMode(mode) {
    const act = document.getElementById('gcalSyncActions');
    const ack = document.getElementById('gcalSyncAck');
    if (act) act.classList.toggle('hidden', mode !== 'act');
    if (ack) ack.classList.toggle('hidden', mode !== 'ack');
}

// 執行結果直接顯示在面板內（不再彈 alert），頁腳只剩「確認」
function showGcalSyncResult(done, errs, pushRes, delRes) {
    const lines = [];
    if (done.length) lines.push(`<div><b>本地更新 ${done.length} 項</b><ul class="list-disc pl-5 mt-0.5">${done.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul></div>`);
    if (pushRes) {
        const per = (pushRes.perCalendar || []).filter(c => c.inserted).map(c => `${escapeHtml(c.label)} ${c.inserted}`).join('、');
        lines.push(`<div><b>推送 GCal</b>：新增 ${pushRes.inserted.length} 件${per ? '（' + per + '）' : ''}、跳過 ${pushRes.skipped.length} 件（已存在，未覆蓋）</div>`);
        if (pushRes.failed.length) errs.push(`推送失敗 ${pushRes.failed.length} 件：${pushRes.failed[0].error}`);
    }
    if (delRes) {
        lines.push(`<div><b>刪除 GCal 殘留</b>：${delRes.deleted.length} 件（垃圾桶可還原）` +
            (delRes.gone.length ? `、${delRes.gone.length} 件本已不存在` : '') + '</div>');
        if (delRes.failed.length) errs.push(`刪除失敗 ${delRes.failed.length} 件：${delRes.failed[0].error}`);
    }
    const ok = !errs.length;
    const body = document.getElementById('gcalSyncBody');
    if (body) {
        body.innerHTML =
            `<div class="p-3 ${ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-300 text-amber-900'} border rounded-lg text-xs space-y-2">` +
            `<div class="font-bold">${ok ? '✅ 同步完成' : '⚠️ 同步完成，但有項目未能執行'}</div>` +
            (lines.length ? lines.join('') : '<div>沒有執行任何項目。</div>') +
            (errs.length ? `<div class="pt-1 border-t border-amber-200"><b>${errs.length} 項未能完成：</b><ul class="list-disc pl-5 mt-0.5">${errs.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : '') +
            '</div>';
    }
    gcalSyncFooterMode('ack');
    ['gcalSyncApplyBtn', 'gcalSyncCancelBtn'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = false;
    });
    gcalSyncPlan = null; // 已執行，計劃作廢（再開面板會重新計算）
    gcalSyncBusy = false;
}

// 執行中的面板狀態：正文換成進度條文字、面板按鈕鎖定（防重複點擊）
function gcalSyncShowBusy(text) {
    gcalSyncBusy = true;
    const body = document.getElementById('gcalSyncBody');
    if (body) body.innerHTML = `<div class="p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-indigo-800 text-xs font-semibold">${text}</div>`;
    ['gcalSyncApplyBtn', 'gcalSyncCancelBtn'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = true;
    });
}

function closeGcalSyncModal() {
    gcalSyncBusy = false;
    const m = document.getElementById('gcalSyncModal');
    if (m) m.classList.add('hidden');
    ['gcalSyncApplyBtn', 'gcalSyncCancelBtn'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = false;
    });
    gcalSyncPlan = null;
}

function gcalChk(id) {
    const el = document.getElementById(id);
    return !!(el && el.checked);
}

// 外層 try/catch：任何程式錯誤都彈窗回報，不再靜默沒動靜（遠端部分另有自己的 .catch）
function applyGcalSync() {
    try {
        applyGcalSyncInner();
    } catch (e) {
        alert('⚠️ 執行失敗（程式錯誤）：' + ((e && e.message) || e) + '\n請把此訊息回報。');
    }
}

function applyGcalSyncInner() {
    if (!gcalSyncPlan) return;
    const p = gcalSyncPlan;
    const done = [];
    const errs = [];
    const nowIso = new Date().toISOString();
    pushHistory('同步 GCal：套用勾選項目'); // 本地側變更前拍快照（遠端 GCal 變更不在快照內）

    // —— 本地側（同步執行，逐項套用；小組節對全體成員生效）——
    const membersOf = (item) => item.lessons || (item.cell && item.cell.lessons) || [item.lesson];

    p.timeChanges.forEach((c, i) => {
        if (!gcalChk('gsT_' + i)) return;
        membersOf(c).forEach(l => {
            const from = { date: l.date, time: l.time }; // 改期前（l 與課堂同一物件，移動後會變）
            const r = GACLessonState.moveLessonDateTime(lessonsByMonth, l.lessonId, c.date, c.time);
            if (r.ok) {
                if (c.event && c.event.id) r.lesson.gcalEventId = c.event.id;   // 小組改時間後 key 換了，之後靠 id 認回
                delete r.lesson.gcalMovedFrom;                                    // 以 Calendar 為準：本地改期作廢
                GACSendlog.ensureMoveEntry(sendLog, r.lesson, from, nowIso); // 改期通知（發送中心）
                done.push(`時間：${l.studentName} → ${c.date} ${c.time}`);
            } else errs.push(`${l.studentName}：${r.error}`);
        });
    });

    p.deletions.forEach((del, i) => {
        if (!gcalChk('gsD_' + i)) return;
        // 小組事件被刪＝整堂取消 → 導師假 TL；一對一 → 事假 L
        const leaveType = (del.cell && del.cell.isGroup) ? 'TL' : 'L';
        membersOf(del).forEach(l => {
            const r = GACLessonState.markStatus(lessonsByMonth, l.lessonId, 'LEAVE', { leaveType });
            if (r.ok) {
                r.lesson.gcalEventId = null; // 事件已不在，清掉回填，之後不再重複提示
                GACSendlog.ensureLessonEntry(sendLog, 'LEAVE_CONFIRM', r.lesson, nowIso);
                done.push(`請假(${leaveType})：${l.studentName} ${l.date}`);
            } else errs.push(`${l.studentName} ${l.date}：${r.error}`);
        });
    });

    p.statusChanges.forEach((s, i) => {
        if (!gcalChk('gsS_' + i)) return;
        membersOf(s).forEach(l => {
            if (l.status === s.to.status && (s.to.status !== 'LEAVE' || (l.leaveType || '') === s.to.leaveType)) return; // 已一致的成員略過
            const r = s.to.status === 'NOSHOW'
                ? GACLessonState.markStatus(lessonsByMonth, l.lessonId, 'NOSHOW')
                : GACLessonState.markStatus(lessonsByMonth, l.lessonId, 'LEAVE', { leaveType: s.to.leaveType });
            if (r.ok) {
                if (s.to.status === 'LEAVE') GACSendlog.ensureLessonEntry(sendLog, 'LEAVE_CONFIRM', r.lesson, nowIso);
                done.push(`狀態：${l.studentName} ${l.date} → ${s.to.status}${s.to.leaveType ? '/' + s.to.leaveType : ''}`);
            } else errs.push(`${l.studentName} ${l.date}：${r.error}`);
        });
    });

    p.manualNew.forEach((m, i) => {
        if (!gcalChk('gsM_' + i) || !m.time) return;
        const sel = document.getElementById('gsMsel_' + i);
        const choice = (sel && sel.value) || 'EXTRA';
        if (choice.indexOf('MU:') === 0) {
            const originId = choice.slice(3);
            const r = GACLessonState.scheduleMakeup(lessonsByMonth, originId, { date: m.date, time: m.time });
            if (r.ok) {
                r.makeup.gcalEventId = m.event.id || null;
                GACSendlog.ensureLessonEntry(sendLog, 'MAKEUP_CONFIRM', r.makeup, nowIso);
                done.push(`補堂：${m.studentId} ${m.date} ${m.time}`);
            } else errs.push(`${m.studentId} ${m.date}：${r.error}`);
        } else {
            const stu = studentDatabase.find(s => s.id === m.studentId);
            if (!stu) { errs.push(`${m.studentId}：找不到學生資料`); return; }
            // 獨立加課：isMakeup=true 讓生成 merge 永不清理；-XT 後綴避免與常規課 id 空間衝突。
            // TODO(跟老闆確認)：收編後的手動事件沒有 gacLessonId 標籤，之後推送會為此課重建一個
            // 新事件（造成 GCal 重複）；如需避免可改為 events.patch 補打標籤（那是一次 update）。
            const lessonId = m.studentId + '-' + GACSchedule.compactDateTime(m.date, m.time) + '-XT';
            if (GACLessonState.findLesson(lessonsByMonth, lessonId)) {
                errs.push(`${m.studentId} ${m.date} ${m.time}：已收編過（${lessonId}）`);
                return;
            }
            const monthKey = m.date.slice(0, 7);
            const extra = {
                lessonId: lessonId,
                studentId: stu.id, studentName: stu.name, tutor: stu.tutor,
                phone: stu.phone || '', email: stu.email || '',
                program: stu.program || '', level: stu.level || '', classType: stu.type || '',
                date: m.date, time: m.time, duration: Number(stu.duration) || 45,
                lessonNum: 0, totalRegular: 0,
                monthRef: m.date.slice(5, 7) + '/' + m.date.slice(0, 4),
                status: 'SCHEDULED', leaveType: '',
                isMakeup: true, originLessonId: null, makeupLessonId: null,
                gcalEventId: m.event.id || null, isExtra: true
            };
            if (!lessonsByMonth[monthKey]) lessonsByMonth[monthKey] = [];
            lessonsByMonth[monthKey].push(extra);
            done.push(`加課：${m.studentId} ${m.date} ${m.time}`);
        }
    });

    // —— 遠端側（有勾選才需要 token）——
    const pushCells = p.toPush.filter((c, i) => gcalChk('gsP_' + i));
    const delOrphans = p.orphans
        .filter((ev, i) => gcalChk('gsO_' + i))
        .map(ev => ({ eventId: ev.id, lessonId: GACGcal.eventCellKey(ev), calendarId: ev._calendarId }));
    const moveItems = (p.moves || []).filter((m, i) => gcalChk('gsV_' + i));
    const statusItems = (p.pushStatus || []).filter((s, i) => gcalChk('gsW_' + i));
    const relocItems = (p.relocations || []).filter((m, i) => gcalChk('gsR_' + i));

    if (!pushCells.length && !delOrphans.length && !moveItems.length && !statusItems.length && !relocItems.length) {
        if (!done.length && !errs.length) { alert('沒有勾選任何項目。'); return; }
        persistLessons();
        renderAll();
        showGcalSyncResult(done, errs, null, null);
        return;
    }

    // 進度顯示：推送每堂 1–2 個請求、逐件執行，整月可能需時十多秒——沒有進度會像「沒動靜」
    const totalRemote = moveItems.length + statusItems.length + relocItems.length + delOrphans.length + pushCells.length;
    let processedRemote = 0;
    const jobs = [];
    if (delOrphans.length) jobs.push(`刪除殘留 ${delOrphans.length} 件`);
    if (pushCells.length) jobs.push(`推送 ${pushCells.length} 節`);
    if (moveItems.length) jobs.push(`改期 ${moveItems.length} 件`);
    if (statusItems.length) jobs.push(`寫回狀態 ${statusItems.length} 件`);
    if (relocItems.length) jobs.push(`搬日曆 ${relocItems.length} 件`);
    const busyText = () => `⏳ 執行中（${processedRemote}/${totalRemote}）…` + jobs.join('、') + '。每件需 1–2 個請求，請稍候，不要關閉此視窗。';
    const bump = () => { processedRemote++; gcalSyncShowBusy(busyText()); };
    gcalSyncShowBusy(busyText());

    const opts = { titleFn: GACSchedule.lessonTitle, timeZone: gcalTimeZone(), onEach: bump };
    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            // 先改期（PATCH 原事件，在它所在的那本日曆）、寫回狀態、搬日曆，再刪殘留、推送（各到該導師的日曆）
            let seq = Promise.resolve();
            moveItems.forEach(m => {
                const rep = m.lesson;
                seq = seq.then(() => gcalClient(token, m.event._calendarId)
                    .patch(m.event.id, GACGcal.movePatchPayload(m.cell, opts))
                    .then(ev => {
                        m.lessons.forEach(l => { l.gcalEventId = (ev && ev.id) || m.event.id; delete l.gcalMovedFrom; if (m.event._calendarId) l.gcalCalId = m.event._calendarId; });
                        done.push(`改 GCal 事件：${rep.studentName}${m.lessons.length > 1 ? ' 等 ' + m.lessons.length + ' 人' : ''} → ${rep.date} ${rep.time}`);
                    })
                    .catch(e => errs.push(`改 GCal 事件失敗（${rep.studentName} ${rep.date} ${rep.time}）：${(e && e.message) || e}`))
                    .then(bump));
            });
            // 寫回狀態：PATCH 只送地點欄與說明欄（「狀態：」一行換掉，其他保留）
            statusItems.forEach(s => {
                const rep = s.lesson;
                seq = seq.then(() => gcalClient(token, s.event._calendarId)
                    .patch(s.event.id, GACGcal.statusPatchPayload(s.cell, s.code, s.event))
                    .then(() => {
                        s.lessons.forEach(l => { l.gcalCode = s.code; });
                        done.push(`寫回狀態：${rep.studentName}${s.lessons.length > 1 ? ' 等 ' + s.lessons.length + ' 人' : ''} ${rep.date} ${rep.time} → 狀態：${s.code || '（清空）'}`);
                    })
                    .catch(e => errs.push(`寫回狀態失敗（${rep.studentName} ${rep.date} ${rep.time}）：${(e && e.message) || e}`))
                    .then(bump));
            });
            // 搬到導師的日曆：events.move（id 不變）；本地記下新的所在日曆
            relocItems.forEach(m => {
                const rep = m.lesson;
                seq = seq.then(() => gcalClient(token, m.from).move(m.event.id, m.to)
                    .then(ev => {
                        m.lessons.forEach(l => { l.gcalCalId = m.to; l.gcalEventId = (ev && ev.id) || m.event.id; });
                        done.push(`搬到${gcalCalendarLabel(m.to)}：${rep.studentName}${m.lessons.length > 1 ? ' 等 ' + m.lessons.length + ' 人' : ''} ${rep.date} ${rep.time}`);
                    })
                    .catch(e => errs.push(`搬日曆失敗（${rep.studentName} ${rep.date} ${rep.time}）：${(e && e.message) || e}`))
                    .then(bump));
            });
            return seq
                .then(() => (delOrphans.length ? gcalDeleteAcross(token, delOrphans, bump) : Promise.resolve(null)))
                .then(delRes => (pushCells.length ? gcalPushAcross(token, pushCells, opts) : Promise.resolve(null))
                    .then(pushRes => ({ delRes: delRes, pushRes: pushRes })));
        })
        .then(({ delRes, pushRes }) => {
            // 推送成功的節：Calendar 上已是新的事件，改期記號清掉
            pushCells.forEach(c => {
                const cc = GACGcal.cellStatusCode(c), code = ['L', 'SL', 'TL', 'NS'].indexOf(cc) !== -1 ? cc : '';
                c.lessons.forEach(l => { if (l.gcalEventId) { delete l.gcalMovedFrom; l.gcalCode = code; } });
            });
            persistLessons();
            renderAll();
            showGcalSyncResult(done, errs, pushRes, delRes);
        })
        .catch(e => {
            // 本地側已套用的變更如實保存並回報；遠端可重按「同步 GCal」重試（差異會重新計算）
            persistLessons();
            renderAll();
            errs.push('遠端操作未完成：' + ((e && e.message) || e) + '——可再按「同步 GCal」重試（差異會重新計算）');
            showGcalSyncResult(done, errs, null, null);
        })
        .finally(() => setGcalBusy(false));
}

// ===== 課卡／彈窗上的「同步到 Google Calendar」：只推這一節，不開面板（寫入模式）=====
// 改期／排補堂後彈窗問「同步到 Google Calendar 嗎？」，按下即推：
//   有事件 id（推送過／同步配對過）→ PATCH 那個事件改到新時間（在它所在的日曆；404＝已被刪 → 改為新建）；
//   沒有 → 在導師的日曆 check-then-insert（同標籤已有事件就不重建；改期過的話把那個既有事件改到新時間）。
function gcalCellOf(lessonId) {
    return GACSchedule.groupByCell(GACLessonState.allLessons(lessonsByMonth)).find(c => c.lessons.some(l => l.lessonId === lessonId)) || null;
}
function gcalCellCode(cell) {
    const c = GACGcal.cellStatusCode(cell);
    return ['L', 'SL', 'TL', 'NS'].indexOf(c) !== -1 ? c : '';
}
function gcalPushLesson(lessonId) {
    if (!gcalPreflight()) return;
    if (!gcalWriteEnabled()) { alert('目前是唯讀模式，不能推送。設定 → Google Calendar 開「授權寫入」，或用課卡上的「加進 GCal」／「改 GCal 舊事件」自己在 Calendar 操作。'); return; }
    const cell = gcalCellOf(lessonId);
    if (!cell) { alert('⚠️ 找不到課堂 ' + lessonId); return; }
    const rep = cell.lessons[0], mf = rep.gcalMovedFrom;
    if (!rep.gcalEventId && mf && mf.inCal && !confirm(`Calendar 上可能已有這堂舊時間（${mf.date} ${mf.time}）的事件（之前按「加進 GCal」建的、沒有標籤）。\n現在推送會另建一個新事件，舊的請自行在 Calendar 刪除。\n\n仍要推送？`)) return;
    const opts = { titleFn: GACSchedule.lessonTitle, timeZone: gcalTimeZone() };
    const dest = gcalCalendarForCell(cell);
    const who = `${rep.studentName}${cell.lessons.length > 1 ? ' 等 ' + cell.lessons.length + ' 人' : ''} ${rep.date} ${rep.time}`;
    const code = gcalCellCode(cell);
    const settle = (evId, calId, ev) => {
        const eid = GACGcal.eidFromLink(ev && ev.htmlLink);
        cell.lessons.forEach(l => { if (evId) l.gcalEventId = evId; delete l.gcalMovedFrom; l.gcalAdded = true; l.gcalCalId = calId; l.gcalCode = code; if (eid) l.gcalEid = eid; });
        persistLessons();
        renderAll();
    };
    const gone = e => /\b(404|410)\b/.test((e && e.message) || '');
    setGcalBusy(true);
    showToast('⏳ 正在同步到 Google Calendar…', 8000);
    ensureGcalToken()
        .then(token => {
            const patchAt = (calId, evId) => gcalClient(token, calId).patch(evId, GACGcal.movePatchPayload(cell, opts))
                .then(ev => { settle((ev && ev.id) || evId, calId, ev); return `✅ 已改 Google Calendar 上的事件：${who}`; });
            const insertAt = () => GACGcal.importCells(gcalClient(token, dest), [cell], opts).then(r => {
                if (r.failed.length) throw new Error(r.failed[0].error);
                if (r.skipped.length && mf) return patchAt(dest, r.skipped[0].eventId);   // 同標籤的事件已在（舊時間）→ 改它，不另建
                settle(null, dest, null);
                return r.inserted.length ? `✅ 已推送到${gcalCalendarLabel(dest)}：${who}` : `ℹ️ ${gcalCalendarLabel(dest)}已有這堂（沒有重複建立）：${who}`;
            });
            if (!rep.gcalEventId) return insertAt();
            return patchAt(rep.gcalCalId || dest, rep.gcalEventId)
                .catch(e => {
                    if (!gone(e)) throw e;
                    cell.lessons.forEach(l => { l.gcalEventId = null; });   // 原事件已不在 Calendar → 當作沒推過
                    return insertAt().then(msg => msg + '（原事件已不在 Calendar，改為新建）');
                });
        })
        .then(msg => showToast(msg, 6000))
        .catch(e => alert('⚠️ 同步到 Google Calendar 失敗：' + ((e && e.message) || e) + '\n本地已改好，可稍後再按「同步 GCal」。'))
        .finally(() => setGcalBusy(false));
}
// 課卡／請假彈窗上的「寫回 GCal 狀態」：本地標了請假／缺席（或還原），直接改 Calendar 上那個事件的地點欄與說明欄「狀態：」一行
//（先 GET 拿說明欄，只換那一行，其他內容保留）。唯讀模式 → 打開該事件的編輯頁請導師自己填
function gcalPushStatus(lessonId) {
    if (!gcalPreflight()) return;
    if (!gcalWriteEnabled()) { openGcalEvent(lessonId); return; }
    const cell = gcalCellOf(lessonId);
    if (!cell) return;
    const rep = cell.lessons[0];
    if (!rep.gcalEventId) { alert('這堂還沒有對應的 Calendar 事件（沒推送過、也沒同步配對過）：請先按「同步 GCal」，配對後再寫回狀態。'); return; }
    if (GACGcal.cellStatusCode(cell) === 'MIXED') { alert('小組成員的狀態不一致，而 Calendar 上整組只有一個事件、一個「狀態：」：請用「同步 GCal」面板處理。'); return; }
    const code = gcalCellCode(cell);
    const who = `${rep.studentName}${cell.lessons.length > 1 ? ' 等 ' + cell.lessons.length + ' 人' : ''} ${rep.date} ${rep.time}`;
    setGcalBusy(true);
    showToast('⏳ 正在寫回 Google Calendar…', 8000);
    ensureGcalToken()
        .then(token => {
            const client = gcalClient(token, rep.gcalCalId || gcalCalendarForCell(cell));
            return client.get(rep.gcalEventId).then(ev => client.patch(rep.gcalEventId, GACGcal.statusPatchPayload(cell, code, ev)));
        })
        .then(() => {
            cell.lessons.forEach(l => { l.gcalCode = code; });
            persistLessons();
            renderAll();
            showToast(`✅ 已寫回 Google Calendar：${who} → 狀態：${code || '（清空）'}`, 6000);
        })
        .catch(e => alert('⚠️ 寫回 Google Calendar 失敗：' + ((e && e.message) || e) + '\n本地已改好，可稍後再按「同步 GCal」。'))
        .finally(() => setGcalBusy(false));
}

// ===== 清空本月（設定頁危險區）：只清「總課表目前檢視的月份」，其他月份不動 =====
// GCal 側：刪該月（按牆鐘日期）所有帶標籤事件＋被刪課堂掛連的跨月補堂事件（手動事件絕不刪）。
// 本地側：GACLessonState.clearMonth 級聯刪整月＋跨月補堂鏈；該月發送紀錄（含 SENT）與
//         引用被刪課堂的條目一併清（GACSendlog.purgeMonth）。學生／設定／薪酬保留。
function clearCurrentMonthData() {
    const monthKey = currentMonthKey();
    if (!monthKey) return;
    const count = (lessonsByMonth[monthKey] || []).length;
    // 唯讀／未設定 GCal：Calendar 一定不動，確認框直說，免得清完才發現 Calendar 上的事件還在
    const gcalOff = !appSettings.gcalClientId || !gcalWriteEnabled();
    const gcalStep = gcalOff
        ? (gcalWriteEnabled()
            ? '1) Google Calendar：不動（未設定 GCal）\n'
            : '1) Google Calendar：不動（唯讀模式，未授權寫入）。Calendar 上的事件要清請自行到 Google Calendar 刪除\n')
        : `1) Google Calendar：刪除 ${monthKey} 所有由本系統導入（帶標籤）的事件，連同其跨月補堂事件\n` +
          '   （GCal 垃圾桶可還原；本系統導出的 .ics 匯入的事件也認得、一併刪；你手動建立的事件絕不刪）\n';
    if (!confirm(`🧹 清空本月（${monthKey}）——將執行：\n` + gcalStep +
        `2) 本地：刪除 ${monthKey} 全部 ${count} 堂課（含已出席／請假，級聯刪除掛連的跨月補堂）——不可還原！\n` +
        `3) 發送中心：清掉歸屬 ${monthKey} 的全部條目（含已發送）\n\n` +
        '其他月份、學生名單、設定與薪酬資料不受影響。建議先按「全量備份 (JSON)」。\n\n確定清空本月？')) return;

    pushHistory(`清空本月：${monthKey}`);
    const wipeMonthLocal = () => {
        const res = GACLessonState.clearMonth(lessonsByMonth, monthKey);
        GACSendlog.purgeMonth(sendLog, monthKey, res.removed.map(l => l.lessonId));
        persistLessons(); // 內含 syncSendlog + 落盤
        rebuildMonthContext();
        renderAll();
        return res;
    };

    // 未設定 GCal／唯讀模式 → 只清本地
    if (gcalOff) {
        const res = wipeMonthLocal();
        alert(`✅ 已清空本地 ${monthKey}：刪 ${res.removed.length} 堂（含跨月補堂）` +
            (res.unlinked.length ? `、${res.unlinked.length} 堂其他月份的請假回到待補池` : '') +
            (gcalWriteEnabled() ? '。\n（未設定 GCal，Google Calendar 未動。）' : '。\n（唯讀模式：未授權寫入，Google Calendar 未動。）'));
        return;
    }

    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            const now = Date.now();
            return gcalListAllCalendars(token, new Date(now - 366 * 86400000).toISOString(),
                new Date(now + 366 * 86400000).toISOString()).then(events => ({ token, events }));
        })
        .then(({ token, events }) => {
            const res = wipeMonthLocal();
            const goneIds = {};
            res.removed.forEach(l => { goneIds[l.lessonId] = true; });
            const items = [];
            (events || []).forEach(ev => {
                if (!ev || ev.status === 'cancelled') return;
                const key = GACGcal.eventCellKey(ev);
                if (!key) return; // 無標籤＝手動事件，絕不刪
                const local = GACGcal.eventStartToLocal(ev);
                const inMonth = !!local && local.date.slice(0, 7) === monthKey;
                const linked = GACGcal.eventLessonIds(ev).some(id => goneIds[id]); // 小組事件：任一成員被刪即算
                if (inMonth || linked) items.push({ eventId: ev.id, lessonId: key, calendarId: ev._calendarId });
            });
            return (items.length
                ? gcalDeleteAcross(token, items)
                : Promise.resolve({ deleted: [], gone: [], failed: [] }))
                .then(r => ({ r, res }));
        })
        .then(({ r, res }) => {
            let msg = `✅ 已清空 ${monthKey}：\n• GCal 刪除 ${r.deleted.length} 件（垃圾桶可還原）` +
                (r.gone.length ? `、另 ${r.gone.length} 件本已不存在` : '') +
                `\n• 本地刪 ${res.removed.length} 堂（含跨月補堂）` +
                (res.unlinked.length ? `\n• ${res.unlinked.length} 堂其他月份的請假回到待補池（其補堂在本次被刪）` : '') +
                `\n• 發送中心 ${monthKey} 條目已清\n\n現在可重新「生成」→「同步 GCal」推送。`;
            if (r.failed.length) msg = `⚠️ GCal 有 ${r.failed.length} 件刪除失敗（首個錯誤：${r.failed[0].error}），其餘已完成：\n\n` + msg;
            alert(msg);
        })
        .catch(e => {
            if (confirm(`⚠️ GCal 清理未完成：${(e && e.message) || e}\n\n仍要清空「本地」的 ${monthKey} 嗎？\n（Google Calendar 上的事件會留著，之後可按「同步 GCal」在殘留組刪除）`)) {
                const res = wipeMonthLocal();
                alert(`✅ 已清空本地 ${monthKey}（刪 ${res.removed.length} 堂；GCal 未清理）。`);
            }
        })
        .finally(() => setGcalBusy(false));
}

// ===== 全部清場重來（設定頁危險區）：測試點亂後從零開始 =====
// GCal 側：掃今天前後各一年，刪除「所有」帶 gacLessonId 標籤的事件（不限單月；手動事件一樣
//          絕不刪，垃圾桶可還原）。
// 本地側：清空全部課堂（所有月份）與發送紀錄。學生名單與設定保留。
// 清場後仍留在本機的東西，講清楚免得以為沒清乾淨
function resetKeptNote() {
    const n = (typeof actionHistory !== 'undefined') ? actionHistory.length : 0;
    return '清場後仍保留：學生名單、小組班、導師名單、費率與設定' +
        (n ? `，以及 ${n} 筆歷史快照（快照裡仍有剛清掉的課表，可按「撤銷」救回；稍後會問是否一併清空）` : '');
}

// 清場／清月之後：問要不要連歷史快照一起清掉（清了才算真正離開這部電腦，但也無法再撤銷）
function offerClearHistoryAfterWipe() {
    if (typeof actionHistory === 'undefined' || !actionHistory.length) return 0;
    const size = (typeof GACHistory !== 'undefined') ? GACHistory.formatSize(GACHistory.totalSize(actionHistory)) : '';
    if (!confirm(`是否一併清空 ${actionHistory.length} 筆歷史快照（${size}）？\n\n` +
        '快照裡仍保存著剛清掉的課表與發送紀錄。\n' +
        '確定＝一併清空：資料真正離開這部電腦，但這次清場將無法「撤銷」。\n' +
        '取消＝保留快照：按「撤銷」隨時可以把剛清掉的資料救回來。')) return 0;
    return (typeof clearHistorySilently === 'function') ? clearHistorySilently() : 0;
}

// 本地全清（全部清場與強制清空共用）：全部月份的課堂、發送紀錄、高級薪酬的調整項與封存。
// 學生名單、小組、導師名單、費率與設定保留（拆帳％與深色模式屬設定）。
function wipeAllLocalData() {
    lessonsByMonth = {};
    Object.keys(sendLog).forEach(k => delete sendLog[k]);
    gacStore.saveLessons(lessonsByMonth);
    persistSendlog();
    if (typeof advancedPayrollState !== 'undefined') {
        advancedPayrollState.summary = null;
        advancedPayrollState.adjustments = [];
        advancedPayrollState.archives = [];
        try {
            localStorage.removeItem('gac_adjustments');
            localStorage.removeItem('gac_payroll_archives');
        } catch (e) { /* 忽略 */ }
        if (typeof advancedRenderAdjustments === 'function') advancedRenderAdjustments();
        if (typeof advancedRenderArchives === 'function') advancedRenderArchives();
        if (typeof advancedRefresh === 'function') advancedRefresh();
    }
    rebuildMonthContext();
    renderAll();
}

// ===== 強制清空 Calendar＋本地（debug 用）=====
// 與「全部清場」的差別：清場只刪本系統帶標籤的事件；這個把日曆視窗內「所有」事件都刪——
// 匯入 .ics 建立的、手動建立的、私人約會，一律刪（GCal 垃圾桶 30 天內可還原）。本地跟全部清場一樣整個清空。
// 只在寫入模式可用；要打 DELETE 才執行。
function forceWipeTargets() { return gcalCalendarTargets(); }

// 唯讀設定下也能用：這一次臨時申請寫入授權（Google 會彈授權視窗），做完即丟棄，「授權寫入」開關不動——免得開了忘記關
function forceWipeCalendarEvents() {
    if (!appSettings.gcalClientId) {
        alert('強制清空 Calendar 需要先在 設定 → Google Calendar 填好 OAuth Client ID。');
        return;
    }
    const tempWrite = !gcalWriteEnabled();
    const targets = forceWipeTargets();
    const now = Date.now();
    const timeMin = new Date(now - 366 * 86400000).toISOString();
    const timeMax = new Date(now + 366 * 86400000).toISOString();
    if (!confirm('🧨 強制清空 Calendar（debug 用）——將刪除以下日曆在今天前後一年內的「所有」事件，不論是否由本系統建立：\n' +
        targets.map(t => '• ' + t.label).join('\n') +
        '\n\n匯入 .ics 的、手動建立的、私人約會，全部一起刪（GCal 垃圾桶 30 天內可還原）。\n' +
        '本地也一併清空：全部月份的課堂、發送紀錄、薪酬調整與封存——不可還原！\n' +
        resetKeptNote() + '。\n建議先按頂部「全量備份 (JSON)」保存現狀。' +
        (tempWrite ? '\n\n目前是唯讀模式：這次會臨時申請寫入授權（Google 會彈出授權視窗），只用於這次清空；設定仍保持唯讀，做完即丟棄這個授權。' : '') +
        '\n\n確定要繼續？')) return;
    const typed = prompt('最後確認：請輸入 DELETE（大寫）才會執行。');
    if (typed !== 'DELETE') { alert('已取消（未輸入 DELETE）。'); return; }

    setGcalBusy(true);
    ensureGcalToken(GCAL_WRITE_SCOPE)
        .then(token => {
            // 逐本日曆：列出視窗內所有事件 → 全刪（不看標籤）
            let chain = Promise.resolve([]);
            targets.forEach(t => {
                chain = chain.then(acc => {
                    const client = gcalClient(token, t.id);
                    // 這本讀不到（404＝ID 不對／帳號沒被分享）→ 記下來繼續下一本，別讓一本壞的擋住其他的
                    return client.listWindow(timeMin, timeMax)
                        .then(events => {
                            const items = (events || [])
                                .filter(ev => ev && ev.id && ev.status !== 'cancelled')
                                .map(ev => ({ eventId: ev.id, lessonId: GACGcal.eventCellKey(ev) || '' }));
                            if (!items.length) return acc.concat([{ label: t.label, deleted: 0, gone: 0, failed: 0 }]);
                            return GACGcal.deleteEvents(client, items)
                                .then(r => acc.concat([{ label: t.label, deleted: r.deleted.length, gone: r.gone.length, failed: r.failed.length }]));
                        })
                        .catch(e => acc.concat([{ label: t.label, deleted: 0, gone: 0, failed: 0, error: gcalCalendarErrorText(t.label, e) }]));
                });
            });
            return chain;
        })
        .then(results => {
            const broken = results.filter(r => r.error);
            if (broken.length && !confirm(`⚠️ 有 ${broken.length} 本日曆讀不到，沒有清：\n\n` + broken.map(r => r.error).join('\n\n') +
                '\n\n其餘日曆已清。仍要清空「本地」課表與發送紀錄嗎？')) {
                alert('已清的日曆：\n' + results.filter(r => !r.error).map(r => `• ${r.label}：刪 ${r.deleted} 件`).join('\n') + '\n\n本地未動。修好日曆 ID 後可再按一次。');
                return;
            }
            pushHistory('強制清空 Calendar＋本地');
            wipeAllLocalData();
            const cleared = offerClearHistoryAfterWipe();
            alert('🧨 強制清空完成：\n' +
                results.map(r => r.error ? `• ❌ ${r.error}` : `• ${r.label}：刪 ${r.deleted} 件` + (r.gone ? `、${r.gone} 件本已不存在` : '') + (r.failed ? `、${r.failed} 件失敗` : '')).join('\n') +
                '\n• 本地課表、發送紀錄、薪酬調整與封存已清空（學生名單、小組、導師與設定保留）' +
                (cleared ? `\n• 歷史快照已一併清空 ${cleared} 筆（無法撤銷）` : '\n• 歷史快照保留，可按「撤銷」救回本地資料') +
                '\n\nGCal 垃圾桶 30 天內可還原。現在可以重新「生成」。');
        })
        .catch(err => alert('強制清空失敗：' + ((err && err.message) || err)))
        .then(() => {
            if (tempWrite) gcalToken = null;   // 臨時的寫入授權用完即丟；之後同步照唯讀重新授權
            setGcalBusy(false);
        });
}

function resetAllScheduleData() {
    const months = Object.keys(lessonsByMonth).sort();
    if (!confirm('🧨 全部清場重來——將執行：\n' +
        (gcalWriteEnabled()
            ? '1) Google Calendar：刪除今天前後一年內、所有由本系統導入（帶標籤）的事件\n   （GCal 垃圾桶可還原；你手動建立的事件絕不刪）\n'
            : '1) Google Calendar：唯讀模式，一律不動（事件全部留著；之後同步時它們會以「手動新建」出現，不想要就別勾）\n') +
        `2) 本地：清空全部課堂（${months.length ? months.join('、') : '目前無資料'}）與發送紀錄——不可還原！\n\n` +
        resetKeptNote() + '。\n建議先按頂部「全量備份 (JSON)」保存現狀。\n\n確定清場？')) return;

    pushHistory('全部清場');
    const wipeLocal = wipeAllLocalData;

    // 未設定 GCal／唯讀模式 → 只清本地（不用走授權）
    if (!appSettings.gcalClientId || !gcalWriteEnabled()) {
        wipeLocal();
        const cleared = offerClearHistoryAfterWipe();
        alert('✅ 已清空本地課表與發送紀錄' +
            (gcalWriteEnabled() ? '（未設定 GCal，Google Calendar 未動）' : '（唯讀模式：未授權寫入，Google Calendar 未動）') + '。\n' +
            (cleared ? `已一併清空 ${cleared} 筆歷史快照（無法撤銷）。\n` : '歷史快照保留，可按「撤銷」救回剛清掉的資料。\n') +
            '學生名單、小組、導師與設定保留，可重新「生成」。\n' +
            '⚠️ Google Calendar 上的事件全部還在：下次同步它們會以「手動新建」列出，不想收編就別勾選。');
        return;
    }

    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            const now = Date.now();
            const timeMin = new Date(now - 366 * 86400000).toISOString();
            const timeMax = new Date(now + 366 * 86400000).toISOString();
            return gcalListAllCalendars(token, timeMin, timeMax).then(events => {
                const items = [];
                (events || []).forEach(ev => {
                    if (!ev || ev.status === 'cancelled') return;
                    const key = GACGcal.eventCellKey(ev);
                    if (key) items.push({ eventId: ev.id, lessonId: key, calendarId: ev._calendarId });
                });
                if (!items.length) return { deleted: [], gone: [], failed: [] };
                return gcalDeleteAcross(token, items);
            });
        })
        .then(r => {
            wipeLocal();
            const cleared = offerClearHistoryAfterWipe();
            let msg = `✅ 清場完成：\n• GCal 刪除 ${r.deleted.length} 件（垃圾桶可還原）` +
                (r.gone.length ? `、另 ${r.gone.length} 件本已不存在` : '') +
                '\n• 本地課表與發送紀錄已清空（學生名單、小組、導師與設定保留）' +
                (cleared ? `\n• 歷史快照已一併清空 ${cleared} 筆（無法撤銷）` : '\n• 歷史快照保留，可按「撤銷」救回') +
                '\n\n現在可以重新：「生成」→「同步 GCal」推送。';
            if (r.failed.length) {
                msg = `⚠️ GCal 有 ${r.failed.length} 件刪除失敗（首個錯誤：${r.failed[0].error}），其餘已完成：\n\n` + msg;
            }
            alert(msg);
        })
        .catch(e => {
            if (confirm(`⚠️ GCal 清理未完成：${(e && e.message) || e}\n\n仍要清空「本地」課表與發送紀錄嗎？\n（Google Calendar 上的事件會留著，之後可再清）`)) {
                wipeLocal();
                const cleared = offerClearHistoryAfterWipe();
                alert('✅ 已清空本地課表與發送紀錄（GCal 未清理）。' + (cleared ? `\n歷史快照已一併清空 ${cleared} 筆。` : ''));
            }
        })
        .finally(() => setGcalBusy(false));
}

// ===== 匯入 ICS（唯讀來源，不用 OAuth）：Google 日曆匯出的 .ics → lib/ics.js 解析 → 與本地按內容比對 → 同一個面板勾選套用（只改本地）=====
// 用法：每月先「生成」本地課表，再上傳該導師日曆的 .ics 作基準比對；之後的改動再上傳一次即只見差異。
function openIcsImport() {
    const sel = document.getElementById('icsTutor');
    if (sel) {
        const names = (typeof allTutorNames === 'function') ? allTutorNames() : [];
        sel.innerHTML = '<option value="">不按導師篩選（整個檔案對全部課堂）</option>' +
            names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)} 的日曆</option>`).join('');
    }
    const info = document.getElementById('icsMonthInfo');
    if (info) info.textContent = `比對範圍：${currentMonthKey()}（前後各 7 天；「Calendar 沒有」只看本月）`;
    const inp = document.getElementById('icsFileInput');
    if (inp) inp.value = '';
    document.getElementById('icsImportModal').classList.remove('hidden');
    markModalOpened('icsImportModal');
}

function closeIcsImportModal() {
    const m = document.getElementById('icsImportModal');
    if (m) m.classList.add('hidden');
}

function handleIcsFile(evt) {
    const file = evt && evt.target && evt.target.files && evt.target.files[0];
    if (!file) return;
    const tutor = (document.getElementById('icsTutor') || {}).value || '';
    const reader = new FileReader();
    reader.onload = () => {
        try { icsImportFromText(String(reader.result || ''), tutor); }
        catch (e) { alert('⚠️ ICS 解析失敗：' + ((e && e.message) || e)); }
    };
    reader.onerror = () => alert('⚠️ 無法讀取檔案。');
    reader.readAsText(file);
}

// 文字 → 事件（視窗＝本月前後 7 天）→ 按內容對帳 → 面板。timeZone 可注入（測試）；預設瀏覽器時區。回傳計劃或 null
function icsImportFromText(text, tutorName, timeZone) {
    const cal = GACIcs.parse(text);
    if (!cal.events.length) { alert('檔案裡沒有任何事件（VEVENT），請確認是 Google 日曆匯出的 .ics。'); return null; }
    let tutor = tutorName || '';
    let tutorAuto = false;
    if (!tutor) { const guess = detectIcsTutor(cal); if (guess) { tutor = guess; tutorAuto = true; } }
    const monthKey = currentMonthKey();
    const w = GACGcal.syncWindow(monthKey);
    const lo = w.timeMin.slice(0, 10), hi = w.timeMax.slice(0, 10);
    const events = GACIcs.toEvents(cal, { timeZone: timeZone || gcalTimeZone(), from: lo, to: hi });
    const windowLessons = GACLessonState.allLessons(lessonsByMonth).filter(l => l.date >= lo && l.date <= hi);
    const diff = GACGcal.reconcileByContent(windowLessons, events, contentOpts(tutor || null, {}, monthKey));
    gcalSyncPlan = {
        monthKey: monthKey, source: 'ics', calName: cal.name || '', tutor: tutor, tutorAuto: tutorAuto,
        readOnly: true, contentMode: true, missingOff: !canDetectMissing(tutor || null),
        eventCount: events.filter(e => e.status !== 'cancelled').length, unmatched: diff.unmatched.length,
        toPush: [], orphans: [],
        timeChanges: diff.timeChanges, statusChanges: diff.statusChanges, deletions: diff.deletions, manualNew: diff.manualNew
    };
    closeIcsImportModal();
    renderGcalSyncModal();
    return gcalSyncPlan;
}
