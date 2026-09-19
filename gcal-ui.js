// gcal-ui.js — Google Calendar 同步的瀏覽器膠水層（Phase 2）
// OAuth：Google Identity Services（GIS）取 access token，僅存記憶體；API 呼叫走 lib/gcal.js 的 REST client。
// 前置：設定頁填 gcalClientId；頁面須經 http(s) 開啟（GIS 不支援 file://，可用 serve.cmd 或 VS Code Live Server）。

let gcalToken = null;   // { accessToken, expiresAt }，僅存記憶體，刷新即失效

function gcalPreflight() {
    if (!appSettings.gcalClientId) {
        alert('請先在「設定」頁籤填寫 Google OAuth Client ID。\n\n（GCP Console → APIs & Services → Credentials 建立 OAuth client：\n類型 Web application，Authorized JavaScript origins 加入你開啟本頁的網址，\n並啟用 Google Calendar API）');
        switchTab('settingsTab');
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

function ensureGcalToken() {
    if (gcalToken && Date.now() < gcalToken.expiresAt - 60000) {
        return Promise.resolve(gcalToken.accessToken);
    }
    return loadGisScript().then(() => new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
            client_id: appSettings.gcalClientId,
            scope: 'https://www.googleapis.com/auth/calendar.events',
            callback: (resp) => {
                if (resp && resp.access_token) {
                    gcalToken = {
                        accessToken: resp.access_token,
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

function gcalClient(token) {
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
        calendarId: (appSettings.gcalCalendarId || 'primary')
    });
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
            return gcalClient(token).listWindow(w.timeMin, w.timeMax);
        })
        .then(events => {
            const w = GACGcal.syncWindow(monthKey);
            const lo = w.timeMin.slice(0, 10), hi = w.timeMax.slice(0, 10);
            const windowLessons = GACLessonState.allLessons(lessonsByMonth)
                .filter(l => l.date >= lo && l.date <= hi);
            const diff = GACGcal.reconcile(windowLessons, events, studentDatabase.map(s => s.id));
            // 殘留：本月帶標籤事件（牆鐘月份）中，key 對不上任何本地課節者（跨月補堂也算本地課；
            // 小組課改成一節一事件後，舊的逐人事件也會在此現身，勾選即清）
            const monthEvents = events.filter(ev => {
                if (!ev || ev.status === 'cancelled' || !GACGcal.eventCellKey(ev)) return false;
                const local = GACGcal.eventStartToLocal(ev);
                return !!local && local.date.slice(0, 7) === monthKey;
            });
            const pre = GACGcal.importPrecheck(GACLessonState.allLessons(lessonsByMonth), monthEvents, opts);
            // 推送候選：本月課節中 GCal（視窗內）沒有對應事件者（一節一事件：小組一個）。
            // 「已刪除」組的課節排除在外——同一節不能同時「標請假」又「重推」；不勾刪除的下次同步可再推。
            const evByKey = {};
            events.forEach(ev => {
                if (!ev || ev.status === 'cancelled') return;
                const key = GACGcal.eventCellKey(ev);
                if (key) evByKey[key] = ev;
            });
            const delKeys = new Set(diff.deletions.map(d => d.cell.key));
            const toPush = GACSchedule.groupByCell(lessonsByMonth[monthKey] || [])
                .filter(c => !evByKey[c.key] && !delKeys.has(c.key));
            gcalSyncPlan = {
                monthKey: monthKey,
                toPush: toPush,
                timeChanges: diff.timeChanges,
                statusChanges: diff.statusChanges,
                deletions: diff.deletions,
                orphans: pre.orphans,
                manualNew: diff.manualNew
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
        p.deletions.length + p.orphans.length + p.manualNew.length;
    gcalSyncFooterMode(total ? 'act' : 'ack');
    if (!total) {
        parts.push('<div class="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs font-semibold">✅ 本地與 Google Calendar 完全一致，沒有需要同步的項目。</div>');
    } else {
        parts.push(`<div class="p-2 bg-indigo-50 border border-indigo-200 rounded-lg text-indigo-800 text-xs">範圍：${p.monthKey}（前後各 7 天）。共 ${total} 項差異——<b>預設勾選＝執行後兩邊一致</b>（GCal 上的改動以 Calendar 為準）。個別不想動的項目取消勾選即可。</div>`);
    }
    if (p.toPush.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">⬆️ 推送：本地有、GCal 沒有（一節一個事件；小組全組一個。絕不覆蓋既有）</div>');
        p.toPush.forEach((c, i) => {
            const rep = c.lessons[0];
            parts.push(gcalSyncRow('gsP_' + i,
                `${gcalCellLabel(c)} ${rep.date} ${rep.time}${rep.isMakeup ? '（補堂）' : ''}${!c.isGroup && rep.status === 'LEAVE' ? '（請假紀錄）' : ''}`, '', true));
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
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🗑️ 事件已在 GCal 刪除（勾選＝跟隨 Calendar：本地標記請假・事假；取消勾選＝保留本地，下次同步可重推）</div>');
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
        lines.push(`<div><b>推送 GCal</b>：新增 ${pushRes.inserted.length} 件、跳過 ${pushRes.skipped.length} 件（已存在，未覆蓋）</div>`);
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

    // —— 本地側（同步執行，逐項套用；小組節對全體成員生效）——
    const membersOf = (item) => item.lessons || (item.cell && item.cell.lessons) || [item.lesson];

    p.timeChanges.forEach((c, i) => {
        if (!gcalChk('gsT_' + i)) return;
        membersOf(c).forEach(l => {
            const r = GACLessonState.moveLessonDateTime(lessonsByMonth, l.lessonId, c.date, c.time);
            if (r.ok) done.push(`時間：${l.studentName} → ${c.date} ${c.time}`);
            else errs.push(`${l.studentName}：${r.error}`);
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
        .map(ev => ({ eventId: ev.id, lessonId: GACGcal.eventCellKey(ev) }));

    if (!pushCells.length && !delOrphans.length) {
        if (!done.length && !errs.length) { alert('沒有勾選任何項目。'); return; }
        persistLessons();
        renderAll();
        showGcalSyncResult(done, errs, null, null);
        return;
    }

    // 進度顯示：推送每堂 1–2 個請求、逐件執行，整月可能需時十多秒——沒有進度會像「沒動靜」
    const totalRemote = delOrphans.length + pushCells.length;
    let processedRemote = 0;
    const busyText = () => `⏳ 執行中（${processedRemote}/${totalRemote}）…` +
        (delOrphans.length ? `刪除殘留 ${delOrphans.length} 件` : '') +
        (delOrphans.length && pushCells.length ? '、' : '') +
        (pushCells.length ? `推送 ${pushCells.length} 節` : '') +
        '。每件需 1–2 個請求，請稍候，不要關閉此視窗。';
    const bump = () => { processedRemote++; gcalSyncShowBusy(busyText()); };
    gcalSyncShowBusy(busyText());

    const opts = { titleFn: GACSchedule.lessonTitle, timeZone: gcalTimeZone(), onEach: bump };
    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            const client = gcalClient(token);
            return (delOrphans.length ? GACGcal.deleteEvents(client, delOrphans, bump) : Promise.resolve(null))
                .then(delRes => (pushCells.length ? GACGcal.importCells(client, pushCells, opts) : Promise.resolve(null))
                    .then(pushRes => ({ delRes: delRes, pushRes: pushRes })));
        })
        .then(({ delRes, pushRes }) => {
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

// ===== 清空本月（設定頁危險區）：只清「總課表目前檢視的月份」，其他月份不動 =====
// GCal 側：刪該月（按牆鐘日期）所有帶標籤事件＋被刪課堂掛連的跨月補堂事件（手動事件絕不刪）。
// 本地側：GACLessonState.clearMonth 級聯刪整月＋跨月補堂鏈；該月發送紀錄（含 SENT）與
//         引用被刪課堂的條目一併清（GACSendlog.purgeMonth）。學生／設定／薪酬保留。
function clearCurrentMonthData() {
    const monthKey = currentMonthKey();
    if (!monthKey) return;
    const count = (lessonsByMonth[monthKey] || []).length;
    if (!confirm(`🧹 清空本月（${monthKey}）——將執行：\n` +
        `1) Google Calendar：刪除 ${monthKey} 所有由本系統導入（帶標籤）的事件，連同其跨月補堂事件\n` +
        '   （GCal 垃圾桶可還原；你手動建立的事件絕不刪）\n' +
        `2) 本地：刪除 ${monthKey} 全部 ${count} 堂課（含已出席／請假，級聯刪除掛連的跨月補堂）——不可還原！\n` +
        `3) 發送中心：清掉歸屬 ${monthKey} 的全部條目（含已發送）\n\n` +
        '其他月份、學生名單、設定與薪酬資料不受影響。建議先按「全量備份 (JSON)」。\n\n確定清空本月？')) return;

    const wipeMonthLocal = () => {
        const res = GACLessonState.clearMonth(lessonsByMonth, monthKey);
        GACSendlog.purgeMonth(sendLog, monthKey, res.removed.map(l => l.lessonId));
        persistLessons(); // 內含 syncSendlog + 落盤
        rebuildMonthContext();
        renderAll();
        return res;
    };

    // 未設定 GCal → 只清本地
    if (!appSettings.gcalClientId) {
        const res = wipeMonthLocal();
        alert(`✅ 已清空本地 ${monthKey}：刪 ${res.removed.length} 堂（含跨月補堂）` +
            (res.unlinked.length ? `、${res.unlinked.length} 堂其他月份的請假回到待補池` : '') +
            '。\n（未設定 GCal，Google Calendar 未動。）');
        return;
    }

    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            const client = gcalClient(token);
            const now = Date.now();
            return client.listWindow(new Date(now - 366 * 86400000).toISOString(),
                new Date(now + 366 * 86400000).toISOString()).then(events => ({ client, events }));
        })
        .then(({ client, events }) => {
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
                if (inMonth || linked) items.push({ eventId: ev.id, lessonId: key });
            });
            return (items.length
                ? GACGcal.deleteEvents(client, items)
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
function resetAllScheduleData() {
    const months = Object.keys(lessonsByMonth).sort();
    if (!confirm('🧨 全部清場重來——將執行：\n' +
        '1) Google Calendar：刪除今天前後一年內、所有由本系統導入（帶標籤）的事件\n' +
        '   （GCal 垃圾桶可還原；你手動建立的事件絕不刪）\n' +
        `2) 本地：清空全部課堂（${months.length ? months.join('、') : '目前無資料'}）與發送紀錄——不可還原！\n\n` +
        '學生名單與設定會保留。建議先按頂部「全量備份 (JSON)」保存現狀。\n\n確定清場？')) return;

    const wipeLocal = () => {
        lessonsByMonth = {};
        Object.keys(sendLog).forEach(k => delete sendLog[k]);
        gacStore.saveLessons(lessonsByMonth);
        persistSendlog();
        // 高級薪酬一併歸零：匯入的行、調整項、封存糧單（拆帳％與深色模式屬設定，保留）
        if (typeof advancedPayrollState !== 'undefined') {
            advancedPayrollState.rows = [];
            advancedPayrollState.adjustments = [];
            advancedPayrollState.archives = [];
            try {
                localStorage.removeItem('gac_adjustments');
                localStorage.removeItem('gac_payroll_archives');
            } catch (e) { /* 忽略 */ }
            if (typeof advancedRenderRows === 'function') advancedRenderRows();
            if (typeof advancedRenderAdjustments === 'function') advancedRenderAdjustments();
            if (typeof advancedRenderArchives === 'function') advancedRenderArchives();
            if (typeof advancedCalculate === 'function') advancedCalculate();
        }
        rebuildMonthContext();
        renderAll();
    };

    // 未設定 GCal → 只清本地（不用走授權）
    if (!appSettings.gcalClientId) {
        wipeLocal();
        alert('✅ 已清空本地課表與發送紀錄（未設定 GCal，Google Calendar 未動）。\n學生名單保留，可重新「生成」。');
        return;
    }

    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            const client = gcalClient(token);
            const now = Date.now();
            const timeMin = new Date(now - 366 * 86400000).toISOString();
            const timeMax = new Date(now + 366 * 86400000).toISOString();
            return client.listWindow(timeMin, timeMax).then(events => {
                const items = [];
                (events || []).forEach(ev => {
                    if (!ev || ev.status === 'cancelled') return;
                    const key = GACGcal.eventCellKey(ev);
                    if (key) items.push({ eventId: ev.id, lessonId: key });
                });
                if (!items.length) return { deleted: [], gone: [], failed: [] };
                return GACGcal.deleteEvents(client, items);
            });
        })
        .then(r => {
            wipeLocal();
            let msg = `✅ 清場完成：\n• GCal 刪除 ${r.deleted.length} 件（垃圾桶可還原）` +
                (r.gone.length ? `、另 ${r.gone.length} 件本已不存在` : '') +
                '\n• 本地課表與發送紀錄已清空（學生名單保留）\n\n現在可以重新：「生成」→「同步 GCal」推送。';
            if (r.failed.length) {
                msg = `⚠️ GCal 有 ${r.failed.length} 件刪除失敗（首個錯誤：${r.failed[0].error}），其餘已完成：\n\n` + msg;
            }
            alert(msg);
        })
        .catch(e => {
            if (confirm(`⚠️ GCal 清理未完成：${(e && e.message) || e}\n\n仍要清空「本地」課表與發送紀錄嗎？\n（Google Calendar 上的事件會留著，之後可再清）`)) {
                wipeLocal();
                alert('✅ 已清空本地課表與發送紀錄（GCal 未清理）。');
            }
        })
        .finally(() => setGcalBusy(false));
}
