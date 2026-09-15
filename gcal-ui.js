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
    ['gcalImportBtn', 'gcalReconcileBtn'].forEach(id => {
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
    if (!confirm(`將檢查 ${monthKey} 的 ${lessons.length} 堂課：\n已存在於 Google Calendar 的跳過（絕不覆蓋），缺失的才新增。\n繼續？`)) return;
    setGcalBusy(true);
    ensureGcalToken()
        .then(token => GACGcal.importLessons(gcalClient(token), lessons,
            { titleFn: GACSchedule.lessonTitle, timeZone: gcalTimeZone() }))
        .then(r => {
            persistLessons();
            renderAll();
            let msg = `Google Calendar 導入完成：\n• 新增 ${r.inserted.length} 件\n• 跳過 ${r.skipped.length} 件（已存在，未覆蓋）`;
            if (r.failed.length) {
                msg += `\n• 失敗 ${r.failed.length} 件，首個錯誤：\n  ${r.failed[0].error}`;
            }
            alert((r.failed.length ? '⚠️ ' : '✅ ') + msg);
        })
        .catch(e => alert('⚠️ 導入未執行：' + ((e && e.message) || e) + '\n本地資料未受影響。'))
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

function gcalDiffRow(chkId, text, extraHtml) {
    return `<label class="flex items-start gap-2 p-2 border border-slate-200 rounded-lg text-xs cursor-pointer hover:bg-slate-50">
        <input type="checkbox" id="${chkId}" class="mt-0.5 w-4 h-4 accent-sky-600">
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
        parts.push(`<div class="p-2 bg-sky-50 border border-sky-200 rounded-lg text-sky-800 text-xs">對帳範圍：${monthKey}（前後各 7 天）。共 ${total} 項差異，<b>預設全不勾</b>——勾選要套用到本地的項目後按「套用」。</div>`);
    }
    if (d.timeChanges.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🕒 時間變更（GCal 上被挪動）</div>');
        d.timeChanges.forEach((c, i) => {
            parts.push(gcalDiffRow('gdT_' + i,
                `<b>${c.lesson.studentName}</b>（${c.lesson.studentId}）${c.lesson.date} ${c.lesson.time} → <b>${c.date} ${c.time}</b>`));
        });
    }
    if (d.deletions.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🗑️ 事件已在 GCal 刪除（勾選＝本地標記請假・事假；不勾＝忽略，可再按「導入」在 GCal 重建）</div>');
        d.deletions.forEach((del, i) => {
            parts.push(gcalDiffRow('gdD_' + i,
                `<b>${del.lesson.studentName}</b>（${del.lesson.studentId}）${del.lesson.date} ${del.lesson.time}（目前狀態：${del.lesson.status}）`));
        });
    }
    if (d.statusChanges.length) {
        parts.push('<div class="text-xs font-bold text-slate-700 mt-2">🏷️ 狀態碼變更（GCal 事件 location/標題含 L/SL/TL/NS）</div>');
        d.statusChanges.forEach((s, i) => {
            const toLabel = s.to.status === 'NOSHOW' ? 'NS 缺席' : getLeaveText(s.to.leaveType);
            parts.push(gcalDiffRow('gdS_' + i,
                `<b>${s.lesson.studentName}</b>（${s.lesson.studentId}）${s.lesson.date} ${s.lesson.time}：${s.lesson.status} → <b>${toLabel}</b>`));
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
