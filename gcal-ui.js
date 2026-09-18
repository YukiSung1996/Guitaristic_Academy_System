// gcal-ui.js — Google Calendar 同步的瀏覽器膠水層（Phase 2）
// OAuth：Google Identity Services（GIS）取 access token，僅存記憶體；API 呼叫走 lib/gcal.js 的 REST client。
// 前置：設定頁填 gcalClientId；頁面須經 http(s) 開啟（GIS 不支援 file://，可用 VS Code Live Server）。

let gcalToken = null;   // { accessToken, expiresAt }，僅存記憶體，刷新即失效

function gcalPreflight() {
    if (!appSettings.gcalClientId) {
        alert('請先在「設定」頁籤填寫 Google OAuth Client ID。\n\n（GCP Console → APIs & Services → Credentials 建立 OAuth client：\n類型 Web application，Authorized JavaScript origins 加入你開啟本頁的網址，\n並啟用 Google Calendar API）');
        switchTab('settingsTab');
        return false;
    }
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
        alert('Google 授權不支援以 file:// 開啟的頁面。\n請用本地伺服器開啟（如 VS Code Live Server：http://127.0.0.1:5500/…），\n並把該網址加入 OAuth client 的 Authorized JavaScript origins。');
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
        fetchFn: (u, o) => fetch(u, o),
        token: token,
        calendarId: (appSettings.gcalCalendarId || 'primary')
    });
}

function gcalTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}

function setGcalBusy(busy) {
    ['gcalImportBtn', 'gcalReconcileBtn', 'gcalCleanupBtn'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = busy;
    });
}

// ===== 導入：check-then-insert（絕不 update；重複導入只會 skip）=====
function importGcalMonth() {
    if (!gcalPreflight()) return;
    const monthKey = currentMonthKey();
    const lessons = lessonsByMonth[monthKey] || [];
    if (!lessons.length) { alert('目前月份沒有課堂可導入。'); return; }
    const opts = { titleFn: GACSchedule.lessonTitle, timeZone: gcalTimeZone() };
    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            // 導入前檢測：GCal 上已生成的事件若與本地不一致（本地改過/重新生成過），
            // 導入絕不 update 也不刪 → 先警告，指引「清理 GCal」刪除後重新導入。
            const client = gcalClient(token);
            const w = GACGcal.syncWindow(monthKey);
            return client.listWindow(w.timeMin, w.timeMax).then(events => ({ client, events }));
        })
        .then(({ client, events }) => {
            const monthEvents = events.filter(ev => {
                if (!ev || ev.status === 'cancelled' || !GACGcal.eventLessonId(ev)) return false;
                const local = GACGcal.eventStartToLocal(ev);
                return !!local && local.date.slice(0, 7) === monthKey;
            });
            const pre = GACGcal.importPrecheck(GACLessonState.allLessons(lessonsByMonth), monthEvents, opts);
            let ask;
            if (pre.stale.length || pre.orphans.length) {
                const kinds = [...new Set(pre.stale.flatMap(s => s.reasons))].join('／');
                ask = `⚠️ 檢測：${monthKey} 在 Google Calendar 已有 ${pre.existing.length} 件本系統導入的事件，其中：\n` +
                    (pre.stale.length ? `• ${pre.stale.length} 件與本地不一致（${kinds}）——GCal 上是舊版本\n` : '') +
                    (pre.orphans.length ? `• ${pre.orphans.length} 件已無對應課堂——本地改動／重新生成後的殘留\n` : '') +
                    '\n導入只會為缺失的課新增，絕不更新、絕不刪除既有事件。\n' +
                    '要讓 GCal 與本地一致：請先按「清理 GCal (API)」刪除，再重新導入。\n\n仍要繼續導入（僅新增缺失的課）？';
            } else {
                ask = `將檢查 ${monthKey} 的 ${lessons.length} 堂課` +
                    (pre.existing.length ? `（GCal 已有 ${pre.existing.length} 件、與本地一致，將跳過）` : '') +
                    '：\n已存在於 Google Calendar 的跳過（絕不覆蓋），缺失的才新增。\n繼續？';
            }
            if (!confirm(ask)) return null;
            return GACGcal.importLessons(client, lessons, opts);
        })
        .then(r => {
            if (!r) return; // 使用者取消
            persistLessons();
            renderAll();
            let msg = `Google Calendar 導入完成：\n• 新增 ${r.inserted.length} 件\n• 跳過 ${r.skipped.length} 件（已存在，未覆蓋）`;
            if (r.failed.length) {
                msg += `\n• 失敗 ${r.failed.length} 件，首個錯誤：\n  ${r.failed[0].error}`;
            }
            msg += `\n\nℹ️ 之後在 Google Calendar 上挪動／刪除／改狀態碼，按「同步對帳」即可拉回本地（以 Calendar 為準、預設全勾）。`;
            alert((r.failed.length ? '⚠️ ' : '✅ ') + msg);
        })
        .catch(e => alert('⚠️ 導入未執行：' + ((e && e.message) || e) + '\n本地資料未受影響。'))
        .finally(() => setGcalBusy(false));
}

// ===== 清理：批量刪除本系統導入的事件（僅帶 gacLessonId 標籤者；可按導師/學生篩選）=====
let gcalCleanupItems = null; // [{eventId, lessonId, studentId, studentName, tutor, date, time, hasLocal}]

function openGcalCleanup() {
    if (!gcalPreflight()) return;
    const monthKey = currentMonthKey();
    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            const w = GACGcal.syncWindow(monthKey);
            return gcalClient(token).listWindow(w.timeMin, w.timeMax);
        })
        .then(events => {
            const knownIds = studentDatabase.map(s => s.id);
            gcalCleanupItems = [];
            events.forEach(ev => {
                if (!ev || ev.status === 'cancelled') return;
                const lessonId = GACGcal.eventLessonId(ev);
                if (!lessonId) return; // 無系統標籤＝手動事件，絕不列入
                const local = GACGcal.eventStartToLocal(ev);
                if (!local || local.date.slice(0, 7) !== monthKey) return; // 只清本月（按牆鐘日期）
                const lesson = GACLessonState.findLesson(lessonsByMonth, lessonId);
                gcalCleanupItems.push({
                    eventId: ev.id, lessonId: lessonId,
                    studentId: lesson ? lesson.studentId
                        : (GACGcal.matchStudentPrefix(ev.summary, knownIds) || '?'),
                    studentName: lesson ? lesson.studentName : (ev.summary || '(無標題)'),
                    tutor: lesson ? (lesson.tutor || '') : '',
                    date: local.date, time: local.time || '',
                    hasLocal: !!lesson
                });
            });
            gcalCleanupItems.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
            if (!gcalCleanupItems.length) {
                alert(`${monthKey} 在 Google Calendar 上沒有本系統導入的事件。\n（手動建立的事件不在清理範圍內）`);
                return;
            }
            renderGcalCleanupModal(monthKey);
        })
        .catch(e => alert('⚠️ 讀取失敗：' + ((e && e.message) || e) + '\n未刪除任何事件。'))
        .finally(() => setGcalBusy(false));
}

function renderGcalCleanupModal(monthKey) {
    const head = document.getElementById('gcalCleanupHead');
    if (!head || !gcalCleanupItems) return;
    const tutors = [...new Set(gcalCleanupItems.map(i => i.tutor).filter(Boolean))].sort();
    const nameById = {};
    gcalCleanupItems.forEach(i => { if (!nameById[i.studentId]) nameById[i.studentId] = i.studentName; });
    const stuIds = Object.keys(nameById).sort();
    head.innerHTML = `
        <div class="p-2 bg-rose-50 border border-rose-200 rounded-lg text-rose-800">
            範圍：${monthKey}。只列出<b>本系統導入</b>（帶系統標籤）的事件，你手動建立的事件不會出現、也不會被刪除。
            共 ${gcalCleanupItems.length} 件，符合篩選 <b><span id="gclCount">0</span></b> 件。
            刪除後可在 Google Calendar 垃圾桶還原；本地課表不受影響，隨時可重新導入。
        </div>
        <div class="flex gap-2">
            <select id="gclFilterTutor" onchange="renderGcalCleanupList()" class="flex-1 px-2 py-1.5 border border-slate-300 rounded-lg text-xs bg-white">
                <option value="*">全部導師</option>
                ${tutors.map(t => `<option value="${t}">${t}</option>`).join('')}
            </select>
            <select id="gclFilterStudent" onchange="renderGcalCleanupList()" class="flex-1 px-2 py-1.5 border border-slate-300 rounded-lg text-xs bg-white">
                <option value="*">全部學生</option>
                ${stuIds.map(id => `<option value="${id}">${id} ${nameById[id]}</option>`).join('')}
            </select>
        </div>`;
    renderGcalCleanupList();
    document.getElementById('gcalCleanupModal').classList.remove('hidden');
}

function renderGcalCleanupList() {
    const body = document.getElementById('gcalCleanupBody');
    if (!body || !gcalCleanupItems) return;
    const ftEl = document.getElementById('gclFilterTutor');
    const fsEl = document.getElementById('gclFilterStudent');
    const ft = ftEl ? ftEl.value : '*';
    const fs = fsEl ? fsEl.value : '*';
    const rows = [];
    gcalCleanupItems.forEach((it, idx) => {
        if (ft !== '*' && it.tutor !== ft) return;
        if (fs !== '*' && it.studentId !== fs) return;
        rows.push(`<label class="flex items-center gap-2 p-2 border border-slate-200 rounded-lg text-xs cursor-pointer hover:bg-rose-50">
            <input type="checkbox" data-idx="${idx}" checked class="w-4 h-4 accent-rose-600">
            <span class="flex-1">${it.date} ${it.time}　<b>${it.studentName}</b>（${it.studentId}）　導師：${it.tutor || '—'}${it.hasLocal ? '' : '　<span class="text-amber-600 font-semibold">本地已無此課</span>'}</span>
        </label>`);
    });
    body.innerHTML = rows.length ? rows.join('')
        : '<div class="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-500">此篩選下沒有本系統導入的事件。</div>';
    const cnt = document.getElementById('gclCount');
    if (cnt) cnt.textContent = rows.length;
}

function gcalCleanupSetAll(checked) {
    document.querySelectorAll('#gcalCleanupBody input[type="checkbox"]')
        .forEach(cb => { cb.checked = checked; });
}

function closeGcalCleanupModal() {
    const m = document.getElementById('gcalCleanupModal');
    if (m) m.classList.add('hidden');
    gcalCleanupItems = null;
}

function applyGcalCleanup() {
    if (!gcalCleanupItems) return;
    const chosen = [];
    document.querySelectorAll('#gcalCleanupBody input[type="checkbox"]').forEach(cb => {
        if (cb.checked) chosen.push(gcalCleanupItems[Number(cb.dataset.idx)]);
    });
    if (!chosen.length) { alert('沒有勾選任何事件。'); return; }
    if (!confirm(`將從 Google Calendar 刪除 ${chosen.length} 件本系統導入的事件。\n（僅限帶系統標籤者，不會動到你手動建立的事件）\n刪除後可在 Google Calendar 的垃圾桶還原。\n本地課表不受影響，之後可隨時再按「導入」重建。\n\n確定刪除？`)) return;
    setGcalBusy(true);
    ensureGcalToken()
        .then(token => GACGcal.deleteEvents(gcalClient(token), chosen))
        .then(r => {
            // 清掉本地回填的 gcalEventId，否則「同步對帳」會把這些課誤判成「GCal 已刪除→提議請假」
            r.deleted.concat(r.gone).forEach(it => {
                const lesson = GACLessonState.findLesson(lessonsByMonth, it.lessonId);
                if (lesson) lesson.gcalEventId = null;
            });
            persistLessons();
            renderAll();
            closeGcalCleanupModal();
            let msg = `已刪除 ${r.deleted.length} 件（GCal 垃圾桶可還原）`;
            if (r.gone.length) msg += `\n• ${r.gone.length} 件本已不存在`;
            if (r.failed.length) msg += `\n• 失敗 ${r.failed.length} 件，首個錯誤：\n  ${r.failed[0].error}`;
            msg += `\n\n本地課表未受影響（本地才是主資料）。\n要把事件放回 Google Calendar → 按「導入 GCal (API)」即可全部重建；\n「生成」只管本地課表，與 GCal 無關。`;
            alert((r.failed.length ? '⚠️ ' : '✅ ') + msg);
        })
        .catch(e => alert('⚠️ 刪除未執行：' + ((e && e.message) || e)))
        .finally(() => setGcalBusy(false));
}

// ===== 同步對帳：拉事件 → 純 diff → 逐條勾選套用（預設全不勾）=====
let gcalDiff = null;

function openGcalReconcile() {
    if (!gcalPreflight()) return;
    const monthKey = currentMonthKey();
    setGcalBusy(true);
    ensureGcalToken()
        .then(token => {
            const w = GACGcal.syncWindow(monthKey);
            return gcalClient(token).listWindow(w.timeMin, w.timeMax);
        })
        .then(events => {
            const w = GACGcal.syncWindow(monthKey);
            const lo = w.timeMin.slice(0, 10), hi = w.timeMax.slice(0, 10);
            const localLessons = GACLessonState.allLessons(lessonsByMonth)
                .filter(l => l.date >= lo && l.date <= hi);
            gcalDiff = GACGcal.reconcile(localLessons, events, studentDatabase.map(s => s.id));
            renderGcalDiffModal(monthKey);
        })
        .catch(e => alert('⚠️ 對帳未執行：' + ((e && e.message) || e) + '\n本地資料未受影響。'))
        .finally(() => setGcalBusy(false));
}

function gcalDiffRow(chkId, text, extraHtml, checked) {
    return `<label class="flex items-start gap-2 p-2 border border-slate-200 rounded-lg text-xs cursor-pointer hover:bg-slate-50">
        <input type="checkbox" id="${chkId}"${checked ? ' checked' : ''} class="mt-0.5 w-4 h-4 accent-sky-600">
        <span class="flex-1">${text}${extraHtml || ''}</span>
    </label>`;
}

function renderGcalDiffModal(monthKey) {
    const body = document.getElementById('gcalDiffBody');
    if (!body || !gcalDiff) return;
    const d = gcalDiff;
    const parts = [];
    const total = d.timeChanges.length + d.deletions.length + d.statusChanges.length + d.manualNew.length;
    if (!total) {
        parts.push('<div class="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs font-semibold">✅ Google Calendar 與本地課表完全一致，沒有差異。</div>');
    } else {
        parts.push(`<div class="p-2 bg-sky-50 border border-sky-200 rounded-lg text-sky-800 text-xs">對帳範圍：${monthKey}（前後各 7 天）。共 ${total} 項差異，<b>以 Google Calendar 為準、預設全勾</b>——直接按「套用」即以 Calendar 更新本地；個別不想跟 Calendar 的項目請取消勾選。（手動新建的事件需先選擇收編方式，預設不勾。）</div>`);
    }
    if (d.timeChanges.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🕒 時間變更（GCal 上被挪動）</div>');
        d.timeChanges.forEach((c, i) => {
            parts.push(gcalDiffRow('gdT_' + i,
                `<b>${c.lesson.studentName}</b>（${c.lesson.studentId}）${c.lesson.date} ${c.lesson.time} → <b>${c.date} ${c.time}</b>`, '', true));
        });
    }
    if (d.deletions.length) {
        // 防呆：大量刪除多半是「清場」而非逐堂取消——若照套用會整批標請假、灌爆待補堂池。
        // 此情況預設不勾並警告；逐堂取消（少量）才預設全勾跟隨 Calendar。
        const massDelete = d.deletions.length >= 5;
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🗑️ 事件已在 GCal 刪除（勾選＝跟隨 Calendar：本地標記請假・事假；取消勾選＝保留本地，可再按「導入」在 GCal 重建）</div>');
        if (massDelete) {
            parts.push(`<div class="p-2 bg-amber-50 border border-amber-300 rounded-lg text-amber-900 text-xs">⚠️ 一次偵測到 ${d.deletions.length} 件刪除——看起來像批量清場而非逐堂取消，<b>已預設不勾</b>（套用會把這些課全部標成請假、湧入待補堂池）。若你是想清場重來，請改用「設定 → 全部清場」或「清理 GCal」；真的是逐堂取消才自行勾選。</div>`);
        }
        d.deletions.forEach((del, i) => {
            parts.push(gcalDiffRow('gdD_' + i,
                `<b>${del.lesson.studentName}</b>（${del.lesson.studentId}）${del.lesson.date} ${del.lesson.time}（目前狀態：${del.lesson.status}）`, '', !massDelete));
        });
    }
    if (d.statusChanges.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🏷️ 狀態碼變更（GCal 事件 location/標題含 L/SL/TL/NS）</div>');
        d.statusChanges.forEach((s, i) => {
            const toLabel = s.to.status === 'NOSHOW' ? 'NS 缺席' : getLeaveText(s.to.leaveType);
            parts.push(gcalDiffRow('gdS_' + i,
                `<b>${s.lesson.studentName}</b>（${s.lesson.studentId}）${s.lesson.date} ${s.lesson.time}：${s.lesson.status} → <b>${toLabel}</b>`, '', true));
        });
    }
    if (d.manualNew.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">➕ GCal 手動新建、可歸屬學生的事件（勾選＝收編進本地課表）</div>');
        d.manualNew.forEach((m, i) => {
            if (!m.time) {
                parts.push(`<div class="p-2 border border-slate-200 rounded-lg text-xs text-slate-400">「${m.event.summary}」${m.date || ''}（全日事件無時間，無法收編，請在 GCal 補上時間）</div>`);
                return;
            }
            const pendings = GACLessonState.allLessons(lessonsByMonth)
                .filter(l => l.studentId === m.studentId && l.status === 'LEAVE' && !l.makeupLessonId);
            const opts = pendings.map(p =>
                `<option value="MU:${p.lessonId}">作為補堂 ←（${p.date} ${getLeaveText(p.leaveType)}）</option>`).join('') +
                '<option value="EXTRA">獨立加課（不掛任何請假）</option>';
            parts.push(gcalDiffRow('gdM_' + i,
                `<b>${m.studentId}</b>「${m.event.summary}」${m.date} ${m.time}`,
                `<select id="gdMsel_${i}" onclick="event.preventDefault()" class="block mt-1 px-2 py-1 border border-slate-300 rounded-lg text-xs bg-white">${opts}</select>`));
        });
    }
    body.innerHTML = parts.join('');
    document.getElementById('gcalDiffModal').classList.remove('hidden');
}

function closeGcalDiffModal() {
    const m = document.getElementById('gcalDiffModal');
    if (m) m.classList.add('hidden');
}

function gcalChk(id) {
    const el = document.getElementById(id);
    return !!(el && el.checked);
}

function applyGcalDiff() {
    if (!gcalDiff) return;
    const done = [];
    const errs = [];
    const nowIso = new Date().toISOString();

    gcalDiff.timeChanges.forEach((c, i) => {
        if (!gcalChk('gdT_' + i)) return;
        const r = GACLessonState.moveLessonDateTime(lessonsByMonth, c.lesson.lessonId, c.date, c.time);
        if (r.ok) done.push(`時間：${c.lesson.studentName} → ${c.date} ${c.time}`);
        else errs.push(`${c.lesson.studentName}：${r.error}`);
    });

    gcalDiff.deletions.forEach((del, i) => {
        if (!gcalChk('gdD_' + i)) return;
        const r = GACLessonState.markStatus(lessonsByMonth, del.lesson.lessonId, 'LEAVE', { leaveType: 'L' });
        if (r.ok) {
            GACSendlog.ensureLessonEntry(sendLog, 'LEAVE_CONFIRM', r.lesson, nowIso);
            done.push(`請假：${del.lesson.studentName} ${del.lesson.date}`);
        } else errs.push(`${del.lesson.studentName} ${del.lesson.date}：${r.error}`);
    });

    gcalDiff.statusChanges.forEach((s, i) => {
        if (!gcalChk('gdS_' + i)) return;
        const r = s.to.status === 'NOSHOW'
            ? GACLessonState.markStatus(lessonsByMonth, s.lesson.lessonId, 'NOSHOW')
            : GACLessonState.markStatus(lessonsByMonth, s.lesson.lessonId, 'LEAVE', { leaveType: s.to.leaveType });
        if (r.ok) {
            if (s.to.status === 'LEAVE') GACSendlog.ensureLessonEntry(sendLog, 'LEAVE_CONFIRM', r.lesson, nowIso);
            done.push(`狀態：${s.lesson.studentName} ${s.lesson.date} → ${s.to.status}${s.to.leaveType ? '/' + s.to.leaveType : ''}`);
        } else errs.push(`${s.lesson.studentName} ${s.lesson.date}：${r.error}`);
    });

    gcalDiff.manualNew.forEach((m, i) => {
        if (!gcalChk('gdM_' + i) || !m.time) return;
        const sel = document.getElementById('gdMsel_' + i);
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
            // TODO(跟老闆確認)：收編後的手動事件沒有 gacLessonId 標籤，之後按「導入」會為此課重建一個
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

    if (!done.length && !errs.length) { alert('沒有勾選任何項目。'); return; }
    persistLessons();
    renderAll();
    closeGcalDiffModal();
    gcalDiff = null;
    let msg = done.length ? `✅ 已套用 ${done.length} 項：\n` + done.join('\n') : '沒有成功套用的項目。';
    if (errs.length) msg += `\n\n⚠️ ${errs.length} 項未能套用：\n` + errs.join('\n');
    alert(msg);
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
                const lessonId = GACGcal.eventLessonId(ev);
                if (!lessonId) return; // 無標籤＝手動事件，絕不刪
                const local = GACGcal.eventStartToLocal(ev);
                const inMonth = !!local && local.date.slice(0, 7) === monthKey;
                if (inMonth || goneIds[lessonId]) items.push({ eventId: ev.id, lessonId: lessonId });
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
                `\n• 發送中心 ${monthKey} 條目已清\n\n現在可重新「生成」→「導入 GCal (API)」。`;
            if (r.failed.length) msg = `⚠️ GCal 有 ${r.failed.length} 件刪除失敗（首個錯誤：${r.failed[0].error}），其餘已完成：\n\n` + msg;
            alert(msg);
        })
        .catch(e => {
            if (confirm(`⚠️ GCal 清理未完成：${(e && e.message) || e}\n\n仍要清空「本地」的 ${monthKey} 嗎？\n（Google Calendar 上的事件會留著，之後可用「清理 GCal」再刪）`)) {
                const res = wipeMonthLocal();
                alert(`✅ 已清空本地 ${monthKey}（刪 ${res.removed.length} 堂；GCal 未清理）。`);
            }
        })
        .finally(() => setGcalBusy(false));
}

// ===== 全部清場重來（設定頁危險區）：測試點亂後從零開始 =====
// GCal 側：掃今天前後各一年，刪除「所有」帶 gacLessonId 標籤的事件（不限單月——月度「清理 GCal」
//          會漏掉散落在其他月份的補堂殘留；手動事件一樣絕不刪，垃圾桶可還原）。
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
                    const lessonId = GACGcal.eventLessonId(ev);
                    if (lessonId) items.push({ eventId: ev.id, lessonId: lessonId });
                });
                if (!items.length) return { deleted: [], gone: [], failed: [] };
                return GACGcal.deleteEvents(client, items);
            });
        })
        .then(r => {
            wipeLocal();
            let msg = `✅ 清場完成：\n• GCal 刪除 ${r.deleted.length} 件（垃圾桶可還原）` +
                (r.gone.length ? `、另 ${r.gone.length} 件本已不存在` : '') +
                '\n• 本地課表與發送紀錄已清空（學生名單保留）\n\n現在可以重新：「生成」→「導入 GCal (API)」。';
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
