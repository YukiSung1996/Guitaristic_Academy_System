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

    var STATUS_CODES = ['L', 'SL', 'TL', 'MU', 'NS'];

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
            description: '導師：' + (lesson.tutor || ''),
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

    // 事件的課節 key：小組事件 gacCellKey；一對一事件 gacLessonId。null ＝ 非本系統事件（手動建立）
    function eventCellKey(event) {
        const p = event && event.extendedProperties && event.extendedProperties.private;
        return (p && (p.gacCellKey || p.gacLessonId)) || null;
    }

    // 事件涵蓋的 lessonId 們（小組事件多個；一對一一個；無標籤空陣列）
    function eventLessonIds(event) {
        const p = event && event.extendedProperties && event.extendedProperties.private;
        if (!p) return [];
        if (p.gacLessonIds) return String(p.gacLessonIds).split(',').filter(Boolean);
        return p.gacLessonId ? [p.gacLessonId] : [];
    }

    function groupTitle(cell) {
        const f = cell.lessons[0];
        return (f.program || '') + ' ' + (f.level || '') + ' 小組 ×' + cell.lessons.length + ' (' + f.monthRef + ')';
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
            description: '導師：' + (f.tutor || '') + '\n成員：\n' +
                cell.lessons.map(function (l) { return l.studentId + ' ' + l.studentName; }).join('\n'),
            start: { dateTime: f.date + 'T' + f.time + ':00', timeZone: tz },
            end: { dateTime: endDateTime(f.date, f.time, f.duration), timeZone: tz },
            extendedProperties: { private: {
                gacCellKey: cell.key,
                gacLessonIds: cell.lessons.map(function (l) { return l.lessonId; }).join(',')
            } }
        };
    }

    // location（精確）或 summary（獨立詞元）中的狀態碼 → {status, leaveType} 提案；MU/無碼 → null
    function parseStatusCode(event) {
        var code = null;
        var loc = String((event && event.location) || '').trim();
        if (STATUS_CODES.indexOf(loc) !== -1) {
            code = loc;
        } else {
            var m = /(^|\s)(SL|TL|NS|MU|L)(\s|$)/.exec(String((event && event.summary) || ''));
            if (m) code = m[2];
        }
        if (!code || code === 'MU') return null; // MU 是補堂標記，不是狀態變更
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
                        cell.lessons.forEach(function (l) { if (!l.gcalEventId) l.gcalEventId = existing[0].id || null; });
                        skipped.push({ cellKey: cell.key, lessonIds: ids, eventId: existing[0].id || null });
                        return;
                    }
                    return client.insert(cellToEventPayload(cell, opts)).then(function (ev) {
                        var id = (ev && ev.id) || null;
                        cell.lessons.forEach(function (l) { l.gcalEventId = id; });
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
        var byKey = {}, liveIds = {};
        (events || []).forEach(function (ev) {
            if (!ev || ev.status === 'cancelled') return;
            if (ev.id) liveIds[ev.id] = true;
            var key = eventCellKey(ev);
            if (key) byKey[key] = ev;
        });

        var timeChanges = [], deletions = [], statusChanges = [], manualNew = [];

        GACSchedule.groupByCell(lessons || []).forEach(function (cell) {
            var rep = cell.lessons[0];
            var ev = byKey[cell.key];
            if (!ev) {
                // 「已刪除」= 成員曾回填的事件 id 已不在 GCal（仍存在的舊格式事件屬殘留，不算刪除）
                var linkedGone = cell.lessons.some(function (l) { return l.gcalEventId && !liveIds[l.gcalEventId]; });
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
            var sid = matchStudentPrefix(ev.summary, knownStudentIds);
            if (!sid) return;
            var local = eventStartToLocal(ev);
            manualNew.push({ event: ev, studentId: sid, date: local && local.date, time: local && local.time });
        });

        return { timeChanges: timeChanges, deletions: deletions, statusChanges: statusChanges, manualNew: manualNew };
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
        endDateTime: endDateTime,
        lessonToEventPayload: lessonToEventPayload,
        cellToEventPayload: cellToEventPayload,
        eventStartToLocal: eventStartToLocal,
        eventLessonId: eventLessonId,
        eventCellKey: eventCellKey,
        eventLessonIds: eventLessonIds,
        parseStatusCode: parseStatusCode,
        matchStudentPrefix: matchStudentPrefix,
        syncWindow: syncWindow,
        importLessons: importLessons,
        importCells: importCells,
        importPrecheck: importPrecheck,
        deleteEvents: deleteEvents,
        reconcile: reconcile,
        createRestClient: createRestClient
    };
}));
