// lib/gcal.js — Google Calendar 同步純函數庫（無 DOM 依賴；傳輸層可注入以便測試）
// 職責：lesson→事件 payload、事件解析（時間/狀態碼/學生歸屬）、check-then-insert 導入（絕不 update）、
//       同步對帳 diff（純函數，套用與否由 UI 逐條勾選決定）。
// 契約（見 spec 決策 C）——「一節一個事件」：
//   一對一：summary = lessonTitle "S001 Student 001([1/5] 09/2026)"（studentId 前綴是匹配錨點）、
//           extendedProperties.private.gacLessonId = lessonId
//   小組課：同時段全體成員一個事件，summary = "Music Theory Grade 5 小組 ×5 (09/2026)"、
//           description 列成員，private.gacCellKey = 課節 key、private.gacLessonIds = 成員 lessonId 逗號串
//   location = 狀態碼 L/SL/TL/MU/NS（小組：全員同碼才寫）
// 事件的「課節 key」= gacCellKey || gacLessonId（一對一的 key 就是 lessonId，舊事件相容）。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./schedule.js'));
    } else {
        root.GACGcal = factory(root.GACSchedule);
    }
}(typeof self !== 'undefined' ? self : this, function (GACSchedule) {
    'use strict';

    // A＝出席（已上課）。留空＝沒資訊：同步不當成任何狀態（出席在系統批量確認即可，不寫回；留空與 A 視為同一回事）
    var STATUS_CODES = ['A', 'L', 'SL', 'TL', 'MU', 'NS'];

    // 日曆 ID 常被從網址複製過來：embed 連結的 src=xxx%40group.calendar.google.com、分享連結的 cid=（base64）、
    // 或整條網址。統一整理成 Google API 要的 ID（xxx@group.calendar.google.com）；認不出就原樣（trim）交回。
    // 貼了 %40 的 ID 如果直接再 encodeURIComponent 會變 %2540 → Google 回 404「找不到日曆」。
    function normalizeCalendarId(raw) {
        var s = String(raw || '').trim();
        if (!s) return '';
        var m = /[?&]src=([^&#]+)/.exec(s);
        if (m) {
            s = m[1];
        } else {
            var c = /[?&]cid=([^&#]+)/.exec(s);
            if (c) {
                try {
                    var b = c[1].replace(/-/g, '+').replace(/_/g, '/');
                    while (b.length % 4) b += '=';
                    var decoded = (typeof atob === 'function') ? atob(b) : Buffer.from(b, 'base64').toString('utf8');
                    if (decoded.indexOf('@') !== -1) s = decoded;
                } catch (e) { /* 不是 base64 就算了 */ }
            }
        }
        if (/%[0-9A-Fa-f]{2}/.test(s)) { try { s = decodeURIComponent(s); } catch (e) { /* 留原樣 */ } }
        return s.trim();
    }
    // 說明欄「狀態：」也接受中文（導師直接打字）；補堂只是標記不是狀態
    var WORD_CODES = { '導師請假': 'TL', '導師假': 'TL', '請假': 'L', '事假': 'L', '病假': 'SL', '缺席': 'NS', '補堂': 'MU', '出席': 'A', '已上課': 'A', '已上课': 'A', '上課': 'A' };
    var STATUS_HINT = '（出席留空或填 A；請假填 L、病假 SL、導師請假 TL、缺席 NS。系統同步時讀這一行）';

    // 補堂課的原課：「2026-09-16（三）15:00」；不是補堂／無原課 → ''
    var WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];
    function originDateTime(lesson) {
        var o = GACSchedule.originSlot(lesson);
        if (!o) return '';
        var d = o.date.split('-').map(Number);
        return o.date + '（' + WEEKDAY_ZH[new Date(Date.UTC(d[0], d[1] - 1, d[2])).getUTCDay()] + '）' + o.time;
    }
    function originLine(lesson) {
        var o = lesson && lesson.isMakeup ? originDateTime(lesson) : '';
        return o ? '↩ 補的是：' + o + ' 請假的那一堂' + (lesson.lessonNum ? '（' + lesson.monthRef + ' 第 ' + lesson.lessonNum + ' 節）' : '') : '';
    }

    // 事件說明欄（推送、匯出 .ics、「加進 GCal」共用）：第一行寫清楚是什麼課，導師一行，
    // 「狀態：」一行讓人知道填哪裡（同步時讀），最後一行是填法提示。只寫導師，不寫學生聯絡方式。
    function describeLesson(lesson) {
        var kind = lesson.groupName
            ? '小組課 · ' + lesson.groupName
            : [lesson.classType || '一對一', lesson.program, lesson.level].filter(Boolean).join(' · ');
        return [(lesson.isMakeup ? '補堂 · ' : '') + kind, originLine(lesson), '導師：' + (lesson.tutor || ''), '狀態：' + locationCode(lesson), STATUS_HINT]
            .filter(Boolean).join('\n');
    }

    function describeCell(cell) {
        if (!cell.isGroup) return describeLesson(cell.lessons[0]);
        var f = cell.lessons[0];
        var kind = f.groupName ? '小組課 · ' + f.groupName : [f.classType || '小組課', f.program, f.level].filter(Boolean).join(' · ');
        return [(f.isMakeup ? '補堂 · ' : '') + kind, originLine(f), '導師：' + (f.tutor || ''), '狀態：' + cellLocation(cell), STATUS_HINT, '成員：']
            .filter(Boolean)
            .concat(cell.lessons.map(function (l) { return l.studentId + ' ' + l.studentName; })).join('\n');
    }

    // 說明欄「狀態：xx」那一行 → 碼；有這行但空白／看不懂 → ''；沒這行 → null
    function statusFromDescription(desc) {
        var m = /(^|\n)[ \t]*狀態[：:][ \t]*([^\n]*)/.exec(String(desc || ''));
        if (!m) return null;
        var v = m[2].trim();
        if (!v) return '';
        var tok = (/^([A-Za-z]+)/.exec(v) || [])[1];
        if (tok && STATUS_CODES.indexOf(tok.toUpperCase()) !== -1) return tok.toUpperCase();
        for (var k in WORD_CODES) if (v.indexOf(k) === 0) return WORD_CODES[k];
        return '';
    }

    // 與 app.js getLocationText 同一契約（lib 自含一份，避免依賴 DOM 層）
    function locationCode(lesson) {
        if (lesson.status === 'LEAVE') return lesson.leaveType || 'L';
        if (lesson.status === 'NOSHOW') return 'NS';
        if (lesson.isMakeup) return 'MU';
        return '';
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    // "2026-09-16","21:30",60 → 結束 "2026-09-16T22:30:00"（純字串運算，跨日安全用 Date 但取 UTC 分量）
    function endDateTime(dateStr, timeStr, durationMin) {
        var d = String(dateStr).split('-').map(Number);
        var t = String(timeStr).split(':').map(Number);
        var end = new Date(Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1] + (Number(durationMin) || 45)));
        return end.getUTCFullYear() + '-' + pad2(end.getUTCMonth() + 1) + '-' + pad2(end.getUTCDate()) +
            'T' + pad2(end.getUTCHours()) + ':' + pad2(end.getUTCMinutes()) + ':00';
    }

    // lesson → events.insert 的 payload。titleFn 注入（瀏覽器傳 GACSchedule.lessonTitle）。
    // timeZone 必填（瀏覽器用 Intl.DateTimeFormat().resolvedOptions().timeZone）。
    function lessonToEventPayload(lesson, opts) {
        var titleFn = (opts && opts.titleFn) || function (l) { return l.studentId + ' ' + l.studentName; };
        var tz = (opts && opts.timeZone) || 'UTC';
        return {
            summary: titleFn(lesson),
            location: locationCode(lesson),
            description: describeLesson(lesson),
            start: { dateTime: lesson.date + 'T' + lesson.time + ':00', timeZone: tz },
            end: { dateTime: endDateTime(lesson.date, lesson.time, lesson.duration), timeZone: tz },
            extendedProperties: { private: { gacLessonId: lesson.lessonId } }
        };
    }

    // 事件開始時間 → {date:"YYYY-MM-DD", time:"HH:MM"|null}
    // 取 dateTime 字串的「牆鐘」部分（Google 回傳的 dateTime 已是日曆時區的本地時間），
    // 不經 Date 換算 → 與課表的浮動本地時間語義一致，且不受執行環境時區影響。
    function eventStartToLocal(event) {
        var start = event && event.start;
        if (!start) return null;
        if (start.dateTime) {
            var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(start.dateTime));
            return m ? { date: m[1], time: m[2] } : null;
        }
        if (start.date) return { date: start.date, time: null }; // 全日事件
        return null;
    }

    function eventLessonId(event) {
        return (event && event.extendedProperties && event.extendedProperties.private &&
            event.extendedProperties.private.gacLessonId) || null;
    }

    // 導出 .ics 的 UID：encodeURIComponent(課節 key) + '@guitaristic'。Google 匯入 .ics 時把 UID 存成 iCalUID，
    // 所以匯入的事件雖沒有 API 標籤，也能靠 iCalUID 認回是哪一節（一對一 key＝lessonId，編碼後不變，與舊檔相容）
    var ICS_UID_SUFFIX = '@guitaristic';
    function icsUidForCellKey(key) { return encodeURIComponent(String(key)) + ICS_UID_SUFFIX; }
    function cellKeyFromIcsUid(uid) {
        var s = String(uid || '');
        if (s.length <= ICS_UID_SUFFIX.length || s.slice(-ICS_UID_SUFFIX.length) !== ICS_UID_SUFFIX) return null;
        try { return decodeURIComponent(s.slice(0, -ICS_UID_SUFFIX.length)); } catch (e) { return null; }
    }

    // 事件的課節 key：小組事件 gacCellKey；一對一事件 gacLessonId；都沒有 → 看是不是本系統導出的 .ics（iCalUID／uid）。
    // null ＝ 非本系統事件（手動建立）
    function eventCellKey(event) {
        const p = event && event.extendedProperties && event.extendedProperties.private;
        return (p && (p.gacCellKey || p.gacLessonId)) || cellKeyFromIcsUid(event && (event.iCalUID || event.uid)) || null;
    }

    // 事件涵蓋的 lessonId 們（小組事件多個；一對一一個；無標籤空陣列）
    function eventLessonIds(event) {
        const p = event && event.extendedProperties && event.extendedProperties.private;
        if (p && p.gacLessonIds) return String(p.gacLessonIds).split(',').filter(Boolean);
        if (p && p.gacLessonId) return [p.gacLessonId];
        const k = cellKeyFromIcsUid(event && (event.iCalUID || event.uid));
        return k && k.indexOf('G|') !== 0 ? [k] : [];   // .ics 的小組事件只有課節 key，成員靠本地課節對回
    }

    function groupTitle(cell) {
        const f = cell.lessons[0];
        const name = f.groupName || ((f.program || '') + ' ' + (f.level || '') + ' 小組');
        const o = f.isMakeup ? GACSchedule.originSlot(f) : null;
        return name + (o ? ' 補堂' : '') + ' ×' + cell.lessons.length + ' (' + f.monthRef + (o ? ' ← ' + o.date.slice(5).replace('-', '/') : '') + ')';
    }

    // ===== 本地改期 → 認回 Calendar 上原本那個事件（改它，不另建）=====
    // 補堂改期在本地是「取消舊補堂＋排新補堂」（lessonId 換了）；小組課改期連課節 key 也換了。
    // 事件上的標籤還是舊 key——不記下來的話，同步會把舊事件當殘留刪掉、再推一個新的。
    // lesson.gcalMovedFrom = { key, date, time, inCal }：Calendar 上那個事件原本的課節 key 與時段
    // （連改幾次只記第一次——Calendar 上的仍是第一次的）；inCal＝確知它在 Calendar（推送過／按過「加進 GCal」）。
    function moveSnapshot(lesson) {
        return {
            key: GACSchedule.cellKey(lesson), date: lesson.date, time: lesson.time,
            gcalMovedFrom: lesson.gcalMovedFrom || null, gcalEventId: lesson.gcalEventId || null, gcalAdded: !!lesson.gcalAdded,
            gcalEid: lesson.gcalEid || '', gcalCode: lesson.gcalCode
        };
    }
    function noteLocalMove(lesson, snap) {
        var prev = snap.gcalMovedFrom;
        var mf = prev ? { key: prev.key, date: prev.date, time: prev.time, inCal: !!prev.inCal }
            : { key: snap.key, date: snap.date, time: snap.time, inCal: false };
        mf.inCal = mf.inCal || !!snap.gcalEventId || !!snap.gcalAdded || !!snap.gcalEid;   // 同步配對過（有 eid）也算確知在 Calendar
        if (snap.gcalEventId) lesson.gcalEventId = snap.gcalEventId;
        if (snap.gcalEid) lesson.gcalEid = snap.gcalEid;                 // 同一個事件，eid 不因改時間而變
        if (snap.gcalCode !== undefined) lesson.gcalCode = snap.gcalCode;
        delete lesson.gcalAdded;   // 新時段還沒進 Calendar
        if (mf.key === GACSchedule.cellKey(lesson) && mf.date === lesson.date && mf.time === lesson.time) {
            delete lesson.gcalMovedFrom;          // 搬回 Calendar 上原本的時段 → Calendar 不用改
            if (mf.inCal) lesson.gcalAdded = true;
        } else lesson.gcalMovedFrom = mf;
        return lesson;
    }

    // planLocalMoves(lessons, events)：本地改期過（有 gcalMovedFrom）的課節 ↔ Calendar 上原本那個事件
    //   moves   [{cell, lessons, lesson, event, from:{date,time}, tagOnly}]  要把事件改到本地的新時間
    //           （tagOnly＝Calendar 上已是新時間，只差標籤／內容）
    //   settled [{cell, lessons, event}]  事件已在新 key、新時間 → 記號可清
    // 用新 key 找得到事件但時間既不是新的也不是舊的＝Calendar 也被改過 → 不列，交給「時間變更」（以 Calendar 為準）。
    // 舊 key 仍是某個本地課節（例如小組只搬了部分成員）→ 那個事件屬於留下的課，不搶。
    function planLocalMoves(lessons, events) {
        var byKey = {}, byId = {};
        (events || []).forEach(function (ev) {
            if (!ev || ev.status === 'cancelled') return;
            if (ev.id) byId[ev.id] = ev;
            var k = eventCellKey(ev);
            if (k) byKey[k] = ev;
        });
        var cells = GACSchedule.groupByCell(lessons || []);
        var localKeys = {};
        cells.forEach(function (c) { localKeys[c.key] = true; });
        //   conflicts [{cell, lessons, lesson, event, at}]  事件既不在舊時段也不在新時段＝Calendar 也被改過（兩邊都改了）
        //           → 由呼叫方按設定決定：Calendar 為準交給「時間變更」；本系統為準當 move 處理
        var moves = [], settled = [], conflicts = [], used = {};
        cells.forEach(function (cell) {
            var flagged = cell.lessons.filter(function (l) { return l.gcalMovedFrom; });
            if (!flagged.length) return;
            var mf = flagged[0].gcalMovedFrom;
            var ev = byKey[cell.key], byNewKey = !!ev, at;
            if (!ev) ev = (mf.key && !localKeys[mf.key] && byKey[mf.key]) || null;
            if (!ev) flagged.some(function (l) {
                var e = l.gcalEventId && byId[l.gcalEventId];
                var k = e && eventCellKey(e);
                if (e && !(k && localKeys[k])) { ev = e; return true; }
                return false;
            });
            if (!ev || used[ev.id]) return;
            used[ev.id] = true;
            at = eventStartToLocal(ev) || {};
            var item = { cell: cell, lessons: cell.lessons, lesson: cell.lessons[0], event: ev, from: at, tagOnly: false };
            if (at.date === cell.date && at.time === cell.time) {
                if (byNewKey) settled.push({ cell: cell, lessons: cell.lessons, event: ev });
                else { item.tagOnly = true; moves.push(item); }   // Calendar 已是新時間，只差標籤
            } else if (at.date === mf.date && at.time === mf.time) moves.push(item);
            else conflicts.push({ cell: cell, lessons: cell.lessons, lesson: cell.lessons[0], event: ev, at: at });
        });
        return { moves: moves, settled: settled, conflicts: conflicts };
    }

    // ===== 狀態雙向：本地狀態 ↔ Calendar 狀態碼 =====
    // 本地「有資訊」：請假 L/SL/TL、缺席 NS、已上課 A；已排課＝沒資訊（null）
    function localStatusCode(lesson) {
        if (lesson.status === 'LEAVE') return lesson.leaveType || 'L';
        if (lesson.status === 'NOSHOW') return 'NS';
        if (lesson.status === 'ATTENDED') return 'A';
        return null;
    }
    // 課節：全員相同 → 該值；成員不一 → 'MIXED'
    function cellStatusCode(cell) {
        var codes = cell.lessons.map(localStatusCode);
        return codes.every(function (c) { return c === codes[0]; }) ? codes[0] : 'MIXED';
    }
    // Calendar 事件的碼：A/L/SL/TL/NS；沒填／MU → null
    function calStatusCode(event) {
        var to = parseStatusCode(event);
        return to ? (to.status === 'NOSHOW' ? 'NS' : to.status === 'ATTENDED' ? 'A' : to.leaveType) : null;
    }
    // 事件 htmlLink（…/event?eid=xxx）→ eid；打開該事件的編輯頁用 calendar.google.com/calendar/r/eventedit/<eid>
    function eidFromLink(link) {
        var m = /[?&]eid=([^&#]+)/.exec(String(link || ''));
        return m ? m[1] : '';
    }

    // planStatusSync(pairs, rule)：pairs [{cell, event}]（已配對的課節與事件）；rule 'gcal'｜'local'（兩邊都有資訊且不同時以哪邊為準）
    //   toLocal [{cell, lessons, lesson, event, to, conflict}]  Calendar 的碼 → 本地（與 reconcile.statusChanges 同形）
    //   toGcal  [{cell, lessons, lesson, event, code, conflict}] 本地的狀態 → 寫到 Calendar（A＝出席）
    // 只有一邊有資訊 → 流向沒資訊的那邊；兩邊都有、相同 → 不動；兩邊都有、不同 → 看 rule。
    // 小組成員狀態不一（MIXED）：Calendar 為準時照舊逐個成員更新；本系統為準時一個碼表達不了 → 不動。
    // 留空＝沒資訊、與已上課（A）視為同一回事：本地已上課、Calendar 留空 → 不動、不寫回（批量確認出席不必推）。
    // conflict：系統已確認出席、Calendar 卻填了請假／缺席 → 面板另列「⚠️ 狀態衝突」、預設不勾（仍按 rule 給出處理方向）。
    function planStatusSync(pairs, rule) {
        var toLocal = [], toGcal = [];
        (pairs || []).forEach(function (p) {
            var cell = p.cell, ev = p.event, rep = cell.lessons[0];
            var local = cellStatusCode(cell), cal = calStatusCode(ev);
            if (cal === null) {
                if (local && local !== 'A' && local !== 'MIXED') toGcal.push({ cell: cell, lessons: cell.lessons, lesson: rep, event: ev, code: local, conflict: false });
                return;
            }
            if (local === cal) return;
            var conflict = local === 'A';
            if (local === null || rule !== 'local') {
                var to = parseStatusCode(ev);
                var differs = cell.lessons.some(function (l) {
                    return l.status !== to.status || (to.status === 'LEAVE' && (l.leaveType || '') !== to.leaveType);
                });
                if (differs) toLocal.push({ cell: cell, lessons: cell.lessons, lesson: rep, event: ev, to: to, conflict: conflict });
                return;
            }
            if (local === 'MIXED') return;
            toGcal.push({ cell: cell, lessons: cell.lessons, lesson: rep, event: ev, code: local, conflict: conflict });
        });
        return { toLocal: toLocal, toGcal: toGcal };
    }

    // 寫回狀態的 PATCH 內容：只動地點欄與說明欄「狀態：」那一行（導師在說明欄寫的其他東西保留）；
    // 說明欄沒有「狀態：」一行（例如手動建的事件）才整份用本系統的格式重寫。code ''＝清碼，補堂回到 MU
    function withStatusLine(desc, code) {
        var s = String(desc || '');
        var re = /(^|\n)([ \t]*狀態[：:][ \t]*)([^\n]*)/;
        if (!re.test(s)) return null;
        return s.replace(re, function (m, a, b) { return a + b + code; });
    }
    function statusPatchPayload(cell, code, event) {
        var f = cell.lessons[0];
        var line = code || (f.isMakeup ? 'MU' : '');
        var location = code === 'A' ? (f.isMakeup ? 'MU' : '') : line;   // 出席只寫在說明欄「狀態：A」；地點欄留空（補堂回到 MU）
        var desc = withStatusLine(event && event.description, line);
        if (desc === null) desc = cell.isGroup ? describeCell(cell) : describeLesson(f);
        return { location: location, description: desc };
    }

    // 改期 PATCH 的內容：整份 payload（時間、標題、說明、地點碼、新標籤）；另一種課節型態的標籤設 null（PATCH 以 null 刪除該鍵），
    // 免得一對一 ↔ 小組之間留下舊標籤
    function movePatchPayload(cell, opts) {
        var p = cellToEventPayload(cell, opts);
        var priv = p.extendedProperties.private;
        ['gacLessonId', 'gacCellKey', 'gacLessonIds'].forEach(function (k) { if (!(k in priv)) priv[k] = null; });
        return p;
    }

    // 小組事件的狀態碼：全員同碼才寫入（個別成員的請假只在本地層面）
    function cellLocation(cell) {
        const codes = cell.lessons.map(locationCode);
        return codes.every(function (c) { return c === codes[0]; }) ? codes[0] : '';
    }

    // 課節 → 事件 payload：一對一沿用 lessonToEventPayload；小組一節一個事件、成員列在 description
    function cellToEventPayload(cell, opts) {
        if (!cell.isGroup) return lessonToEventPayload(cell.lessons[0], opts);
        const f = cell.lessons[0];
        const tz = (opts && opts.timeZone) || 'UTC';
        return {
            summary: groupTitle(cell),
            location: cellLocation(cell),
            description: describeCell(cell),
            start: { dateTime: f.date + 'T' + f.time + ':00', timeZone: tz },
            end: { dateTime: endDateTime(f.date, f.time, f.duration), timeZone: tz },
            extendedProperties: { private: {
                gacCellKey: cell.key,
                gacLessonIds: cell.lessons.map(function (l) { return l.lessonId; }).join(',')
            } }
        };
    }

    // 狀態碼 → {status, leaveType} 提案；MU/無碼 → null。
    // 讀取次序：說明欄「狀態：」一行（就是我們請導師填的地方）→ location 精確碼 → summary 獨立詞元
    function parseStatusCode(event) {
        var code = statusFromDescription(event && event.description) || null;
        var loc = String((event && event.location) || '').trim();
        if (code) {
            // 說明欄已定
        } else if (STATUS_CODES.indexOf(loc) !== -1) {
            code = loc;
        } else {
            var m = /(^|\s)(SL|TL|NS|MU|L)(\s|$)/.exec(String((event && event.summary) || ''));
            if (m) code = m[2];
        }
        if (!code || code === 'MU') return null; // MU 是補堂標記，不是狀態變更
        if (code === 'A') return { status: 'ATTENDED', leaveType: '' };   // 出席（標題裡的 A 不算——太常見，只認說明欄／地點欄）
        if (code === 'NS') return { status: 'NOSHOW', leaveType: '' };
        return { status: 'LEAVE', leaveType: code };
    }

    // summary 以已知 studentId 開頭（詞邊界）→ 歸屬該學生；否則 null（非本系統事件）
    function matchStudentPrefix(summary, knownStudentIds) {
        var s = String(summary || '');
        for (var i = 0; i < (knownStudentIds || []).length; i++) {
            var id = knownStudentIds[i];
            if (s === id || s.indexOf(id + ' ') === 0) return id;
        }
        return null;
    }

    // 對帳時間窗：月初 −7 天 ~ 月末 +7 天（容納跨月補堂），回 ISO（UTC）字串
    function syncWindow(monthKey) {
        var p = String(monthKey).split('-').map(Number);
        var first = Date.UTC(p[0], p[1] - 1, 1);
        var lastExclusive = Date.UTC(p[0], p[1], 1);
        return {
            timeMin: new Date(first - 7 * 86400000).toISOString(),
            timeMax: new Date(lastExclusive + 7 * 86400000).toISOString()
        };
    }

    // ===== 導入：check-then-insert，絕不 update 已存在事件（D1/D2 契約）=====
    // client 介面（可注入）：listByLessonId(lessonId)→Promise<events[]>、insert(payload)→Promise<event>
    // 副作用：成功 insert / 發現既有事件時回填 lesson.gcalEventId（呼叫方負責持久化）。
    // opts.onEach(已完成數, 總數)：每堂處理完呼叫一次（UI 進度用，可省略）。
    function importLessons(client, lessons, opts) {
        var inserted = [], skipped = [], failed = [];
        var total = (lessons || []).length;
        var onEach = (opts && typeof opts.onEach === 'function') ? opts.onEach : null;
        var doneCount = 0;
        var seq = Promise.resolve();
        (lessons || []).forEach(function (lesson) {
            seq = seq.then(function () {
                return client.listByLessonId(lesson.lessonId).then(function (existing) {
                    if (existing && existing.length) {
                        if (!lesson.gcalEventId) lesson.gcalEventId = existing[0].id || null;
                        skipped.push({ lessonId: lesson.lessonId, eventId: existing[0].id || null });
                        return;
                    }
                    return client.insert(lessonToEventPayload(lesson, opts)).then(function (ev) {
                        lesson.gcalEventId = (ev && ev.id) || null;
                        inserted.push({ lessonId: lesson.lessonId, eventId: lesson.gcalEventId });
                    });
                }).catch(function (e) {
                    failed.push({ lessonId: lesson.lessonId, error: (e && e.message) || String(e) });
                }).then(function () {
                    doneCount++;
                    if (onEach) { try { onEach(doneCount, total); } catch (e) { /* 進度回調不影響流程 */ } }
                });
            });
        });
        return seq.then(function () {
            return { ok: failed.length === 0, inserted: inserted, skipped: skipped, failed: failed };
        });
    }

    // ===== 課節導入：一節一個事件，check-then-insert（絕不 update）=====
    // cells 來自 GACSchedule.groupByCell。一對一以 gacLessonId 查重、小組以 gacCellKey 查重；
    // 命中或新增後把事件 id 回填到該節全體成員的 gcalEventId。
    // client 額外介面：listByCellKey(key)→Promise<events[]>（小組用）。opts.onEach 進度回調可省略。
    function importCells(client, cells, opts) {
        var inserted = [], skipped = [], failed = [];
        var total = (cells || []).length;
        var onEach = (opts && typeof opts.onEach === 'function') ? opts.onEach : null;
        var doneCount = 0;
        var seq = Promise.resolve();
        (cells || []).forEach(function (cell) {
            seq = seq.then(function () {
                var lookup = cell.isGroup
                    ? client.listByCellKey(cell.key)
                    : client.listByLessonId(cell.lessons[0].lessonId);
                var ids = cell.lessons.map(function (l) { return l.lessonId; });
                return lookup.then(function (existing) {
                    if (existing && existing.length) {
                        var eid0 = eidFromLink(existing[0].htmlLink);
                        cell.lessons.forEach(function (l) { if (!l.gcalEventId) l.gcalEventId = existing[0].id || null; if (eid0) l.gcalEid = eid0; });
                        skipped.push({ cellKey: cell.key, lessonIds: ids, eventId: existing[0].id || null });
                        return;
                    }
                    return client.insert(cellToEventPayload(cell, opts)).then(function (ev) {
                        var id = (ev && ev.id) || null;
                        var eid = eidFromLink(ev && ev.htmlLink);
                        cell.lessons.forEach(function (l) { l.gcalEventId = id; if (eid) l.gcalEid = eid; });
                        inserted.push({ cellKey: cell.key, lessonIds: ids, eventId: id });
                    });
                }).catch(function (e) {
                    failed.push({ cellKey: cell.key, lessonIds: ids, error: (e && e.message) || String(e) });
                }).then(function () {
                    doneCount++;
                    if (onEach) { try { onEach(doneCount, total); } catch (e) { /* 忽略 */ } }
                });
            });
        });
        return seq.then(function () {
            return { ok: failed.length === 0, inserted: inserted, skipped: skipped, failed: failed };
        });
    }

    // ===== 導入前檢測：GCal 上已導入的事件是否仍與本地一致（導入絕不 update，不一致須先刪再導）=====
    // events：帶標籤的事件（cancelled 在此再擋一次）；lessons：全部本地課（跨月）。按課節比對。
    // 回傳 existing（已導入）、stale [{cell,lesson,event,reasons[]}]（時間/標題/狀態碼/成員與本地不符）、
    //      orphans [event]（key 對不上任何本地課節＝改動/重新生成/舊格式的殘留）。
    function importPrecheck(lessons, events, opts) {
        var byKey = {};
        GACSchedule.groupByCell(lessons || []).forEach(function (c) { byKey[c.key] = c; });
        var existing = [], stale = [], orphans = [];
        (events || []).forEach(function (ev) {
            if (!ev || ev.status === 'cancelled') return;
            var key = eventCellKey(ev);
            if (!key) return;
            existing.push(ev);
            var cell = byKey[key];
            if (!cell) { orphans.push(ev); return; }
            var rep = cell.lessons[0];
            var expected = cellToEventPayload(cell, opts);
            var local = eventStartToLocal(ev);
            var reasons = [];
            if (!local || local.date !== rep.date || local.time !== rep.time) reasons.push('時間');
            if (String(ev.summary || '') !== expected.summary) reasons.push('標題');
            if (String(ev.location || '').trim() !== expected.location) reasons.push('狀態碼');
            if (cell.isGroup) {
                var evIds = eventLessonIds(ev).slice().sort().join(',');
                var localIds = cell.lessons.map(function (l) { return l.lessonId; }).sort().join(',');
                if (evIds !== localIds) reasons.push('成員');
            }
            if (reasons.length) stale.push({ cell: cell, lesson: rep, event: ev, reasons: reasons });
        });
        return { existing: existing, stale: stale, orphans: orphans };
    }

    // ===== 清理：批量刪除「本系統導入」的事件（UI 只把帶 gacLessonId 標籤的事件送進來）=====
    // items: [{eventId, lessonId}]；逐件刪除；404/410（已不存在）計入 gone、不算失敗。
    // client 介面：remove(eventId)→Promise。onEach(已完成數, 總數) 進度回調可省略。
    function deleteEvents(client, items, onEach) {
        var deleted = [], gone = [], failed = [];
        var total = (items || []).length;
        var doneCount = 0;
        var seq = Promise.resolve();
        (items || []).forEach(function (it) {
            seq = seq.then(function () {
                return client.remove(it.eventId).then(function () {
                    deleted.push(it);
                }).catch(function (e) {
                    var msg = (e && e.message) || String(e);
                    if (/\b(404|410)\b/.test(msg)) gone.push(it);
                    else failed.push({ eventId: it.eventId, lessonId: it.lessonId, error: msg });
                }).then(function () {
                    doneCount++;
                    if (typeof onEach === 'function') { try { onEach(doneCount, total); } catch (e) { /* 忽略 */ } }
                });
            });
        });
        return seq.then(function () {
            return { ok: failed.length === 0, deleted: deleted, gone: gone, failed: failed };
        });
    }

    // ===== 同步對帳（純 diff，不落任何變更；套用由 UI 逐條勾選）——按課節比對 =====
    // 每筆差異帶 cell / lessons（該節全體成員）與 lesson（代表成員＝首位），套用時對全體成員生效。
    //   timeChanges  [{cell, lessons, lesson, event, date, time}]  GCal 時間 ≠ 本地
    //   deletions    [{cell, lessons, lesson}]   曾導入（成員有 gcalEventId）但該事件已不存在於 GCal
    //   statusChanges[{cell, lessons, lesson, event, to}]  事件狀態碼 ≠ 任一成員狀態
    //   manualNew    [{event, studentId, date, time}]  無標籤、summary 可歸屬學生的手動事件
    // 其餘事件（無法歸屬）一律忽略（非本系統事件）。
    function reconcile(lessons, events, knownStudentIds) {
        var byKey = {}, liveIds = {}, byId = {};
        (events || []).forEach(function (ev) {
            if (!ev || ev.status === 'cancelled') return;
            if (ev.id) { liveIds[ev.id] = true; byId[ev.id] = ev; }
            var key = eventCellKey(ev);
            if (key) byKey[key] = ev;
        });

        var timeChanges = [], deletions = [], statusChanges = [], manualNew = [], pairs = [];
        var matchedKeys = {}, matchedEventIds = {};
        var cells = GACSchedule.groupByCell(lessons || []);
        var localKeys = {};
        cells.forEach(function (c) { localKeys[c.key] = true; });

        cells.forEach(function (cell) {
            var rep = cell.lessons[0];
            var ev = byKey[cell.key];
            if (!ev) {
                // key 對不上：成員記著的事件 id 仍在、且那事件不屬於別的本地課節 → 同一個事件
                // （小組在 Calendar 上被挪過而 key 換了、收編的手動事件、唯讀模式認回的事件）
                cell.lessons.some(function (l) {
                    var e = l.gcalEventId && byId[l.gcalEventId];
                    var k = e && eventCellKey(e);
                    if (e && !(k && localKeys[k])) { ev = e; return true; }
                    return false;
                });
            }
            if (ev) { matchedKeys[cell.key] = true; if (ev.id) matchedEventIds[ev.id] = true; pairs.push({ cell: cell, event: ev }); }
            if (!ev) {
                // 「已刪除」= 成員曾回填的事件 id 已不在 GCal（仍存在的舊格式事件屬殘留，不算刪除）。
                // 本地改期過的不算：以本地為準（寫入模式會重推；唯讀按內容配對去找舊時段的事件）
                var linkedGone = cell.lessons.some(function (l) { return l.gcalEventId && !liveIds[l.gcalEventId]; }) &&
                    !cell.lessons.some(function (l) { return l.gcalMovedFrom; });
                if (linkedGone) deletions.push({ cell: cell, lessons: cell.lessons, lesson: rep });
                return;
            }
            var local = eventStartToLocal(ev);
            if (local && local.time && (local.date !== rep.date || local.time !== rep.time)) {
                timeChanges.push({ cell: cell, lessons: cell.lessons, lesson: rep, event: ev, date: local.date, time: local.time });
            }
            var to = parseStatusCode(ev);
            if (to) {
                var differs = cell.lessons.some(function (l) {
                    return l.status !== to.status || (to.status === 'LEAVE' && (l.leaveType || '') !== to.leaveType);
                });
                if (differs) statusChanges.push({ cell: cell, lessons: cell.lessons, lesson: rep, event: ev, to: to });
            }
        });

        (events || []).forEach(function (ev) {
            if (!ev || ev.status === 'cancelled') return;
            if (eventCellKey(ev)) return; // 本系統事件（含不在本次 lessons 範圍者）不算手動新增
            if (ev.id && matchedEventIds[ev.id]) return; // 已靠事件 id 認回某一節
            var sid = matchStudentPrefix(ev.summary, knownStudentIds);
            if (!sid) return;
            var local = eventStartToLocal(ev);
            manualNew.push({ event: ev, studentId: sid, date: local && local.date, time: local && local.time });
        });

        return { timeChanges: timeChanges, deletions: deletions, statusChanges: statusChanges, manualNew: manualNew,
            matchedKeys: matchedKeys, matchedEventIds: matchedEventIds, pairs: pairs };
    }

    // ===== 按內容對帳（唯讀模式／ICS 匯入：事件沒有本系統標籤）=====
    // 學生歸屬：summary 以學生 ID 開頭（詞邊界）→ 否則 summary 含學生姓名（最長者優先，≥2 字，不分大小寫）。
    function matchStudent(summary, students) {
        var s = String(summary || '');
        var byId = matchStudentPrefix(s, (students || []).map(function (x) { return x.id; }));
        if (byId) return byId;
        var lower = s.toLowerCase();
        var best = null;
        (students || []).forEach(function (st) {
            var name = String(st.name || '').trim();
            if (name.length < 2 || lower.indexOf(name.toLowerCase()) === -1) return;
            if (!best || name.length > best.name.length) best = { id: st.id, name: name };
        });
        return best ? best.id : null;
    }

    // 小組歸屬：summary 含小組名稱（最長者優先）
    function matchGroup(summary, groups) {
        var lower = String(summary || '').toLowerCase();
        var best = null;
        (groups || []).forEach(function (g) {
            var name = String(g.name || '').trim();
            if (name.length < 2 || lower.indexOf(name.toLowerCase()) === -1) return;
            if (!best || name.length > best.name.length) best = g;
        });
        return best;
    }

    // reconcileByContent(lessons, events, opts)
    //   opts = { students:[{id,name}], groups:[{id,name}], tutor?: 只比對此導師的課（事件來自該導師的日曆）,
    //            skipCellKeys?: 已由標籤配對的課節 key（不再處理）, deleteFrom?/deleteTo?: 「Calendar 沒有」只在此日期範圍內判定,
    //            detectMissing?: 預設 true；false＝完全不判斷「Calendar 沒有這堂」（不確定這本日曆涵蓋哪些課時，
    //                            少報總比誤判整批請假好——例如多位導師各有日曆，卻只讀到其中一本）}
    // 配對：同一學生（或小組）同一天＝同一節——時間不同→時間變更；狀態碼不同→狀態變更；
    //   Calendar 有、本地那天沒課→手動新建（可收編；小組事件無對應課節則列為無法歸屬）；
    //   本地有、Calendar 沒有→已刪除（只限全體成員仍為「已排課」的節：已上課／請假／缺席不因 Calendar 缺席而動）。
    //   改到別的日子的課會同時出現在「已刪除」與「手動新建」，勾選＝請假＋補堂。帶標籤的事件在此一律略過。
    // 回傳與 reconcile 同形 ＋ unmatched（無法歸屬的事件）、matched（配對成功的課節數）。
    function reconcileByContent(lessons, events, opts) {
        var o = opts || {};
        var skip = o.skipCellKeys || {};
        var scoped = (lessons || []).filter(function (l) { return !o.tutor || l.tutor === o.tutor; });
        var cells = GACSchedule.groupByCell(scoped).filter(function (c) { return !skip[c.key]; });
        var cellsByTarget = {};
        cells.forEach(function (c) {
            var f = c.lessons[0];
            var keys = (c.isGroup && f.groupId) ? ['G:' + f.groupId] : [];
            c.lessons.forEach(function (l) { keys.push('S:' + l.studentId); });
            keys.forEach(function (k) { (cellsByTarget[k] = cellsByTarget[k] || []).push(c); });
        });
        var timeChanges = [], deletions = [], statusChanges = [], manualNew = [], unmatched = [];
        var staleMoves = [], settled = [], staleUsed = {}, pairs = [];
        var paired = {}, leftovers = [];
        var movedFrom = function (c) { var f = c.lessons.filter(function (l) { return l.gcalMovedFrom; })[0]; return f ? f.gcalMovedFrom : null; };
        (events || []).forEach(function (ev) {
            if (!ev || ev.status === 'cancelled') return;
            if (eventCellKey(ev)) return; // 帶標籤的事件由 reconcile 處理
            var local = eventStartToLocal(ev);
            if (!local) return;
            var g = matchGroup(ev.summary, o.groups);
            var sid = g ? null : matchStudent(ev.summary, o.students);
            if (!g && !sid) { unmatched.push(ev); return; }
            var target = g ? 'G:' + g.id : 'S:' + sid;
            var cell = (cellsByTarget[target] || []).filter(function (c) { return !paired[c.key] && c.date === local.date; })[0] || null;
            if (!cell) { leftovers.push({ ev: ev, local: local, target: target, group: !!g, sid: sid }); return; }
            paired[cell.key] = true;
            pairs.push({ cell: cell, event: ev });
            var rep = cell.lessons[0];
            var mf = movedFrom(cell);
            if (local.time && local.time !== rep.time) {
                if (mf && mf.date === local.date && mf.time === local.time) {
                    // 本地改了時間（同一天），Calendar 上還是舊時間 → 不是「Calendar 改了」，別把本地改回去
                    staleMoves.push({ cell: cell, lessons: cell.lessons, lesson: rep, event: ev, from: local, duplicate: false });
                } else timeChanges.push({ cell: cell, lessons: cell.lessons, lesson: rep, event: ev, date: local.date, time: local.time });
            } else if (mf) settled.push({ cell: cell, lessons: cell.lessons, event: ev });
            var to = parseStatusCode(ev);
            if (to) {
                var differs = cell.lessons.some(function (l) {
                    return l.status !== to.status || (to.status === 'LEAVE' && (l.leaveType || '') !== to.leaveType);
                });
                if (differs) statusChanges.push({ cell: cell, lessons: cell.lessons, lesson: rep, event: ev, to: to, conflict: cellStatusCode(cell) === 'A' });
            }
        });
        // 當天沒有對應課節的事件：若是某節本地改期前的舊時段 → staleMoves（該節新時間也已有事件＝重複的舊事件）；否則手動新建
        leftovers.forEach(function (x) {
            var moved = (cellsByTarget[x.target] || []).filter(function (c) {
                var mf = movedFrom(c);
                return mf && !staleUsed[c.key] && mf.date === x.local.date && mf.time === x.local.time;
            })[0];
            if (moved) {
                staleUsed[moved.key] = true;
                staleMoves.push({ cell: moved, lessons: moved.lessons, lesson: moved.lessons[0], event: x.ev, from: x.local, duplicate: !!paired[moved.key] });
                return;
            }
            if (x.group) { unmatched.push(x.ev); return; }
            manualNew.push({ event: x.ev, studentId: x.sid, date: x.local.date, time: x.local.time });
        });
        if (o.detectMissing !== false) cells.forEach(function (c) {
            if (paired[c.key] || staleUsed[c.key]) return;
            if (o.deleteFrom && c.date < o.deleteFrom) return;
            if (o.deleteTo && c.date > o.deleteTo) return;
            if (!c.lessons.every(function (l) { return l.status === 'SCHEDULED'; })) return;
            deletions.push({ cell: c, lessons: c.lessons, lesson: c.lessons[0] });
        });
        return { timeChanges: timeChanges, deletions: deletions, statusChanges: statusChanges, manualNew: manualNew, unmatched: unmatched,
            staleMoves: staleMoves, settled: settled, pairs: pairs, matched: Object.keys(paired).length };
    }

    // ===== Google Calendar REST 傳輸層（fetch 注入；token 由 GIS 取得後傳入）=====
    function createRestClient(deps) {
        var fetchFn = deps.fetchFn;
        var token = deps.token;
        var base = 'https://www.googleapis.com/calendar/v3/calendars/' +
            encodeURIComponent(deps.calendarId || 'primary') + '/events';

        function gfetch(url, init) {
            var opts = init || {};
            opts.headers = Object.assign({
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            }, opts.headers || {});
            return fetchFn(url, opts).then(function (res) {
                if (!res.ok) {
                    return res.json().catch(function () { return {}; }).then(function (body) {
                        var detail = (body && body.error && body.error.message) || '';
                        throw new Error('Google Calendar API ' + res.status + (detail ? '：' + detail : ''));
                    });
                }
                if (res.status === 204) return null; // events.delete 成功回空 body
                return res.json();
            });
        }

        return {
            listByLessonId: function (lessonId) {
                var url = base + '?maxResults=2&singleEvents=true&privateExtendedProperty=' +
                    encodeURIComponent('gacLessonId=' + lessonId);
                return gfetch(url).then(function (data) { return (data && data.items) || []; });
            },
            listByCellKey: function (cellKey) {
                var url = base + '?maxResults=2&singleEvents=true&privateExtendedProperty=' +
                    encodeURIComponent('gacCellKey=' + cellKey);
                return gfetch(url).then(function (data) { return (data && data.items) || []; });
            },
            insert: function (payload) {
                return gfetch(base, { method: 'POST', body: JSON.stringify(payload) });
            },
            remove: function (eventId) {
                return gfetch(base + '/' + encodeURIComponent(eventId), { method: 'DELETE' });
            },
            // 只在「本地改期 → 改 Calendar 上原本那個事件」用：改的是本系統自己的事件
            patch: function (eventId, payload) {
                return gfetch(base + '/' + encodeURIComponent(eventId), { method: 'PATCH', body: JSON.stringify(payload) });
            },
            // 讀一件事件：直接寫回狀態時先拿到說明欄，才能只換「狀態：」那一行
            get: function (eventId) {
                return gfetch(base + '/' + encodeURIComponent(eventId));
            },
            // 搬到另一本日曆（events.move）：事件 id 與內容不變。以前推送只到預設日曆、放錯了的事件搬回導師的日曆用
            move: function (eventId, destCalendarId) {
                return gfetch(base + '/' + encodeURIComponent(eventId) + '/move?destination=' + encodeURIComponent(destCalendarId), { method: 'POST' });
            },
            // 讀得到嗎？只取 1 件，測 ID 與權限用
            probe: function () {
                return gfetch(base + '?maxResults=1&singleEvents=true')
                    .then(function (data) { return { ok: true, sample: ((data && data.items) || []).length }; });
            },
            listWindow: function (timeMin, timeMax) {
                var all = [];
                function page(pageToken) {
                    var url = base + '?maxResults=2500&singleEvents=true' +
                        '&timeMin=' + encodeURIComponent(timeMin) +
                        '&timeMax=' + encodeURIComponent(timeMax) +
                        (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
                    return gfetch(url).then(function (data) {
                        all = all.concat((data && data.items) || []);
                        return data && data.nextPageToken ? page(data.nextPageToken) : all;
                    });
                }
                return page(null);
            }
        };
    }

    return {
        STATUS_CODES: STATUS_CODES,
        locationCode: locationCode,
        normalizeCalendarId: normalizeCalendarId,
        describeLesson: describeLesson,
        describeCell: describeCell,
        statusFromDescription: statusFromDescription,
        endDateTime: endDateTime,
        lessonToEventPayload: lessonToEventPayload,
        cellToEventPayload: cellToEventPayload,
        eventStartToLocal: eventStartToLocal,
        eventLessonId: eventLessonId,
        eventCellKey: eventCellKey,
        eventLessonIds: eventLessonIds,
        icsUidForCellKey: icsUidForCellKey,
        cellKeyFromIcsUid: cellKeyFromIcsUid,
        parseStatusCode: parseStatusCode,
        matchStudentPrefix: matchStudentPrefix,
        syncWindow: syncWindow,
        importLessons: importLessons,
        importCells: importCells,
        importPrecheck: importPrecheck,
        deleteEvents: deleteEvents,
        reconcile: reconcile,
        moveSnapshot: moveSnapshot,
        noteLocalMove: noteLocalMove,
        planLocalMoves: planLocalMoves,
        movePatchPayload: movePatchPayload,
        localStatusCode: localStatusCode,
        cellStatusCode: cellStatusCode,
        calStatusCode: calStatusCode,
        eidFromLink: eidFromLink,
        planStatusSync: planStatusSync,
        withStatusLine: withStatusLine,
        statusPatchPayload: statusPatchPayload,
        matchStudent: matchStudent,
        matchGroup: matchGroup,
        reconcileByContent: reconcileByContent,
        createRestClient: createRestClient
    };
}));
