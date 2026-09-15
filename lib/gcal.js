// lib/gcal.js — Google Calendar 同步純函數庫（無 DOM 依賴；傳輸層可注入以便測試）
// 職責：lesson→事件 payload、事件解析（時間/狀態碼/學生歸屬）、check-then-insert 導入（絕不 update）、
//       同步對帳 diff（純函數，套用與否由 UI 逐條勾選決定）。
// 契約（見 spec 決策 C）：
//   summary  = lessonTitle 格式 "S001 Student 001([1/5] 09/2026)"（studentId 前綴是匹配錨點）
//   location = 狀態碼 L/SL/TL/MU/NS（art-rate-data.js CALENDAR_STATUS_CODES）
//   extendedProperties.private.gacLessonId = lessonId（機器匹配主鍵）
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACGcal = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
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
    function importLessons(client, lessons, opts) {
        var inserted = [], skipped = [], failed = [];
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
                });
            });
        });
        return seq.then(function () {
            return { ok: failed.length === 0, inserted: inserted, skipped: skipped, failed: failed };
        });
    }

    // ===== 同步對帳（純 diff，不落任何變更；套用由 UI 逐條勾選）=====
    // 回傳：
    //   timeChanges  [{lesson, event, date, time}]      GCal 時間 ≠ 本地
    //   deletions    [{lesson}]                          本地已回填 gcalEventId 但事件已不在
    //   statusChanges[{lesson, event, to:{status,leaveType}}] location/summary 狀態碼 ≠ 本地狀態
    //   manualNew    [{event, studentId, date, time}]    無 gacLessonId、summary 可歸屬學生的手動事件
    // 其餘事件（無法歸屬）一律忽略（非本系統事件）。
    function reconcile(lessons, events, knownStudentIds) {
        var byId = {};
        (events || []).forEach(function (ev) {
            if (ev && ev.status === 'cancelled') return;
            var id = eventLessonId(ev);
            if (id) byId[id] = ev;
        });

        var timeChanges = [], deletions = [], statusChanges = [], manualNew = [];

        (lessons || []).forEach(function (lesson) {
            var ev = byId[lesson.lessonId];
            if (!ev) {
                if (lesson.gcalEventId) deletions.push({ lesson: lesson });
                return;
            }
            var local = eventStartToLocal(ev);
            if (local && local.time && (local.date !== lesson.date || local.time !== lesson.time)) {
                timeChanges.push({ lesson: lesson, event: ev, date: local.date, time: local.time });
            }
            var to = parseStatusCode(ev);
            if (to && (lesson.status !== to.status ||
                (to.status === 'LEAVE' && (lesson.leaveType || '') !== to.leaveType))) {
                statusChanges.push({ lesson: lesson, event: ev, to: to });
            }
        });

        var knownLessonIds = {};
        (lessons || []).forEach(function (l) { knownLessonIds[l.lessonId] = true; });
        (events || []).forEach(function (ev) {
            if (!ev || ev.status === 'cancelled') return;
            var id = eventLessonId(ev);
            if (id) return; // 本系統事件（含不在本次 lessons 範圍者）不算手動新增
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
                return res.json();
            });
        }

        return {
            listByLessonId: function (lessonId) {
                var url = base + '?maxResults=2&singleEvents=true&privateExtendedProperty=' +
                    encodeURIComponent('gacLessonId=' + lessonId);
                return gfetch(url).then(function (data) { return (data && data.items) || []; });
            },
            insert: function (payload) {
                return gfetch(base, { method: 'POST', body: JSON.stringify(payload) });
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
        eventStartToLocal: eventStartToLocal,
        eventLessonId: eventLessonId,
        parseStatusCode: parseStatusCode,
        matchStudentPrefix: matchStudentPrefix,
        syncWindow: syncWindow,
        importLessons: importLessons,
        reconcile: reconcile,
        createRestClient: createRestClient
    };
}));
