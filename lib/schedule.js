// lib/schedule.js — 排課純函數庫（無 DOM 依賴，瀏覽器與 Node 皆可載入）
// 職責：日期生成、確定性 lessonId、月度課表生成、merge（非 wipe）語義、撞堂檢測。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACSchedule = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function pad2(n) { return String(n).padStart(2, '0'); }

    // "2026-09-15","21:30" → "20260915-2130"
    function compactDateTime(dateStr, timeStr) {
        return String(dateStr).replace(/-/g, '') + '-' + String(timeStr).replace(':', '');
    }

    // 常規課 id："S001-20260915-2130"（studentId + 原定日期時間，確定性生成、永不變）
    function makeLessonId(studentId, dateStr, timeStr) {
        return studentId + '-' + compactDateTime(dateStr, timeStr);
    }

    // 補堂課 id："S001-20261002-1500-MU-20260915-2130"
    // originLessonId 必須指向鏈條最初的原課（lessonState.scheduleMakeup 保證此不變量），
    // 其字串本身已編碼原課日期時間，直接截取，無需查表。
    function makeMakeupLessonId(studentId, dateStr, timeStr, originLessonId) {
        const originCompact = String(originLessonId).slice(String(studentId).length + 1);
        return studentId + '-' + compactDateTime(dateStr, timeStr) + '-MU-' + originCompact;
    }

    function monthKeyOf(dateStr) { return String(dateStr).slice(0, 7); }

    // "2026-09", 2(週二) → ["2026-09-01","2026-09-08",...]（用 UTC 避免時區偏移）
    function monthDatesForWeekday(monthStr, weekday) {
        const parts = String(monthStr).split('-').map(Number);
        const y = parts[0], m = parts[1];
        const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const dates = [];
        for (let d = 1; d <= total; d++) {
            if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === weekday) {
                dates.push(y + '-' + pad2(m) + '-' + pad2(d));
            }
        }
        return dates;
    }

    // 沿用 app.js 既有的 effectiveMonth 規則：由生效月份起套用新星期/時間
    function getScheduleForMonth(student, monthStr) {
        if (student.effectiveMonth && monthStr >= student.effectiveMonth &&
            student.futureWeekday !== null && student.futureWeekday !== undefined) {
            return { weekday: student.futureWeekday, time: student.futureTime, isFuture: true };
        }
        return { weekday: student.weekday, time: student.time, isFuture: false };
    }

    // 生成一名學生某月的全部常規課（status 一律 SCHEDULED，merge 交給 mergeMonthLessons）
    function generateMonthLessons(student, monthStr) {
        const sched = getScheduleForMonth(student, monthStr);
        const dates = monthDatesForWeekday(monthStr, sched.weekday);
        const parts = String(monthStr).split('-');
        const monthRef = parts[1] + '/' + parts[0]; // "09/2026"，日曆標題契約
        return dates.map(function (dateStr, idx) {
            return {
                lessonId: makeLessonId(student.id, dateStr, sched.time),
                studentId: student.id,
                studentName: student.name,
                tutor: student.tutor,
                phone: student.phone || '',
                email: student.email || '',
                program: student.program || '',
                level: student.level || '',
                classType: student.type || '',
                date: dateStr,
                time: sched.time,
                duration: Number(student.duration) || 45,
                lessonNum: idx + 1,
                totalRegular: dates.length,
                monthRef: monthRef,
                status: 'SCHEDULED',
                leaveType: '',
                isMakeup: false,
                originLessonId: null,
                makeupLessonId: null,
                gcalEventId: null
            };
        });
    }

    // 命中的既有課會刷新這些顯示欄位（改名/換導師等），但絕不動 status / 鏈接 / 日期時間
    const DISPLAY_FIELDS = ['studentName', 'tutor', 'phone', 'email', 'program', 'level',
        'classType', 'duration', 'lessonNum', 'totalRegular', 'monthRef'];

    // merge 語義（非 wipe）：
    // - lessonId 命中 → 保留既有課（含狀態與鏈接），刷新顯示欄位
    // - 補堂課永遠保留（不由生成邏輯管理）
    // - 未命中的常規課，僅當「在本次範圍內」才處理：範圍 = 本次勾選的學生 ∪ 已從資料庫移除的學生
    //   （確保只勾選部分學生生成時，絕不誤刪未勾選學生的課）
    //   - 仍是 SCHEDULED → 刪除
    //   - 已有狀態（ATTENDED/LEAVE/NOSHOW）→ 保留並列入 conflicts 讓用戶處理
    function mergeMonthLessons(existing, generated, opts) {
        const selected = new Set((opts && opts.selectedStudentIds) || []);
        const all = new Set((opts && opts.allStudentIds) || []);
        const genById = new Map(generated.map(function (l) { return [l.lessonId, l]; }));
        const matched = new Set();
        const kept = [];
        const removed = [];
        const conflicts = [];

        (existing || []).forEach(function (old) {
            if (old.isMakeup) { kept.push(old); return; }
            const gen = genById.get(old.lessonId);
            if (gen) {
                matched.add(old.lessonId);
                const merged = Object.assign({}, old);
                DISPLAY_FIELDS.forEach(function (f) { merged[f] = gen[f]; });
                kept.push(merged);
                return;
            }
            const inScope = selected.has(old.studentId) || !all.has(old.studentId);
            if (!inScope) { kept.push(old); return; }
            if (old.status === 'SCHEDULED') {
                removed.push(old);
            } else {
                kept.push(old);
                conflicts.push({
                    lesson: old,
                    reason: '學生已移除或時間已變，但此課已有狀態（' + old.status + '），請人工處理'
                });
            }
        });

        const added = [];
        generated.forEach(function (gen) {
            if (!matched.has(gen.lessonId)) { kept.push(gen); added.push(gen); }
        });

        kept.sort(function (a, b) {
            return (a.date + ' ' + a.time + ' ' + a.studentId)
                .localeCompare(b.date + ' ' + b.time + ' ' + b.studentId);
        });
        return { lessons: kept, added: added, removed: removed, conflicts: conflicts };
    }

    function timeToMinutes(timeStr) {
        const parts = String(timeStr).split(':').map(Number);
        return parts[0] * 60 + (parts[1] || 0);
    }

    // 同組小組課豁免：同導師同日同時段、同 program、同小組形式 → 視為同一組課，不算撞堂
    function isSameGroupLesson(a, b) {
        const isGroup = function (t) { return typeof t === 'string' && t.indexOf('小組') !== -1; };
        return isGroup(a.classType) && isGroup(b.classType) &&
            a.classType === b.classType &&
            a.program === b.program &&
            a.time === b.time &&
            Number(a.duration) === Number(b.duration);
    }

    // 回傳撞堂的 lessonId Set。LEAVE 課不佔時段；同組小組課不互撞。
    function detectClashes(lessons) {
        const clashIds = new Set();
        const active = (lessons || []).filter(function (l) { return l.status !== 'LEAVE'; });
        for (let i = 0; i < active.length; i++) {
            for (let j = i + 1; j < active.length; j++) {
                const a = active[i], b = active[j];
                if (a.tutor !== b.tutor || a.date !== b.date) continue;
                const aStart = timeToMinutes(a.time), aEnd = aStart + (Number(a.duration) || 0);
                const bStart = timeToMinutes(b.time), bEnd = bStart + (Number(b.duration) || 0);
                if (aStart < bEnd && bStart < aEnd) {
                    if (isSameGroupLesson(a, b)) continue;
                    clashIds.add(a.lessonId);
                    clashIds.add(b.lessonId);
                }
            }
        }
        return clashIds;
    }

    // 日曆標題契約："S001 Student 001([1/5] 09/2026)"（studentId 前綴是同步對賬的匹配錨點）
    function lessonTitle(lesson) {
        return lesson.studentId + ' ' + lesson.studentName +
            '([' + lesson.lessonNum + '/' + lesson.totalRegular + '] ' + lesson.monthRef + ')';
    }

    return {
        pad2: pad2,
        compactDateTime: compactDateTime,
        makeLessonId: makeLessonId,
        makeMakeupLessonId: makeMakeupLessonId,
        monthKeyOf: monthKeyOf,
        monthDatesForWeekday: monthDatesForWeekday,
        getScheduleForMonth: getScheduleForMonth,
        generateMonthLessons: generateMonthLessons,
        mergeMonthLessons: mergeMonthLessons,
        timeToMinutes: timeToMinutes,
        isSameGroupLesson: isSameGroupLesson,
        detectClashes: detectClashes,
        lessonTitle: lessonTitle
    };
}));
