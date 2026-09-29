// lib/schedule.js — 排課純函數庫（無 DOM 依賴，瀏覽器與 Node 皆可載入）
// 職責：日期生成、確定性 lessonId、月度課表生成、merge（非 wipe）語義、撞堂檢測、學號容錯比對、長假（停課）判斷。
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
        if (weekday === null || weekday === undefined || weekday === '' || isNaN(Number(weekday))) return []; // 無個別課（只上小組）
        weekday = Number(weekday);
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

    // ===== 學號容錯 =====
    // 比對鍵：去頭尾空白、英文字母轉大寫、每段數字去掉前導零——「32」「032」「0032」是同一號，「s032」＝「S32」。
    // 只用來「認人」（Calendar 標題、表單查重、搜尋）；學生記錄與 lessonId 裡的學號仍原樣保存，不改寫。
    function studentIdKey(id) {
        return String(id === null || id === undefined ? '' : id).trim().toUpperCase()
            .replace(/\d+/g, function (d) { return d.replace(/^0+(?=\d)/, ''); });
    }
    function sameStudentId(a, b) {
        const k = studentIdKey(a);
        return k !== '' && k === studentIdKey(b);
    }

    // ===== 長假（停課）=====
    // student.longLeaves = [{ from: 'YYYY-MM-DD', resume: 'YYYY-MM-DD' 或 '', note: '' }]
    //   from＝第一天不上課；resume＝復課日（當天起恢復上課）；resume 空白＝復課日未定：from 起一直算長假（無限期）。
    // 長假內的日子生成時不出課——不收學費、不佔時段、不推 Calendar；精確到日（月中開始／月中復課都只略過長假那幾天）。
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    function isDateStr(s) { return DATE_RE.test(String(s || '')); }

    // 清理：丟掉沒有開始日期的項目、resume 不是日期就當未定；按開始日期排序
    function normalizeLongLeaves(list) {
        return (list || []).filter(function (p) { return p && isDateStr(p.from); }).map(function (p) {
            return { from: p.from, resume: isDateStr(p.resume) ? p.resume : '', note: String(p.note || '').trim() };
        }).sort(function (a, b) { return a.from.localeCompare(b.from); });
    }

    // 表單檢查：回傳錯誤訊息（'' ＝ 沒問題）。空白列（兩個日期都沒填）不算錯，儲存時丟掉即可
    function validateLongLeaves(list) {
        for (let i = 0; i < (list || []).length; i++) {
            const p = list[i] || {};
            if (!p.from && !p.resume) continue;
            if (!isDateStr(p.from)) return '第 ' + (i + 1) + ' 項長假：請填開始日期。';
            if (p.resume && !isDateStr(p.resume)) return '第 ' + (i + 1) + ' 項長假：復課日期格式不對。';
            if (p.resume && p.resume <= p.from) return '第 ' + (i + 1) + ' 項長假：復課日期要在開始日期之後（復課日當天恢復上課）。';
        }
        return '';
    }

    // dateStr 落在哪一段長假（沒有 → null）
    function longLeaveOn(student, dateStr) {
        const list = (student && student.longLeaves) || [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!p || !isDateStr(p.from)) continue;
            if (dateStr >= p.from && (!p.resume || dateStr < p.resume)) return p;
        }
        return null;
    }
    function isOnLongLeave(student, dateStr) { return !!longLeaveOn(student, dateStr); }

    // 該生某月個別課（按常規時間）落在長假內、因此不生成的日期
    function longLeaveSkippedDates(student, monthStr) {
        const sched = getScheduleForMonth(student, monthStr);
        return monthDatesForWeekday(monthStr, sched.weekday).filter(function (d) { return isOnLongLeave(student, d); });
    }

    // 生成一名學生某月的全部常規課（status 一律 SCHEDULED，merge 交給 mergeMonthLessons）。
    // 長假內的日子不生成；lessonNum／totalRegular 只數實際生成的課（學費按實際堂數）
    function generateMonthLessons(student, monthStr) {
        const sched = getScheduleForMonth(student, monthStr);
        const dates = monthDatesForWeekday(monthStr, sched.weekday).filter(function (d) { return !isOnLongLeave(student, d); });
        const parts = String(monthStr).split('-');
        const monthRef = parts[1] + '/' + parts[0]; // "09/2026"，日曆標題契約
        return dates.map(function (dateStr, idx) {
            return {
                lessonId: makeLessonId(student.id, dateStr, sched.time),
                studentId: student.id,
                studentName: student.name,
                tutor: student.tutor,
                tutorLevel: student.tutorLevel || '',
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

    // 小組班：一個時段多個學生的一堂課。group = { id, name, program, level, duration, tutor, weekday, time, memberIds }
    // 每位成員各自一筆 lesson（出席／請假／學費按人），共享 groupId 讓課表／日曆／薪酬把它們當「一節」。
    // lessonId 仍是 studentId+日期時間（與個別課同一 id 空間；同一人同時段不可能既上個別課又上小組課）。
    // 長假中的成員那幾天不生成（其他成員照常）；小組形式（N人小組）按全體成員計，不因有人長假而改變其他人的收費。
    function generateGroupMonthLessons(group, members, monthStr) {
        const dates = monthDatesForWeekday(monthStr, group.weekday);
        const parts = String(monthStr).split('-');
        const monthRef = parts[1] + '/' + parts[0];
        const classType = (members || []).length + '人小組';
        const out = [];
        (members || []).forEach(function (m) {
            dates.forEach(function (dateStr, idx) {
                if (isOnLongLeave(m, dateStr)) return;
                out.push({
                    lessonId: makeLessonId(m.id, dateStr, group.time),
                    studentId: m.id,
                    studentName: m.name,
                    tutor: group.tutor,
                    tutorLevel: group.tutorLevel || '',
                    phone: m.phone || '',
                    email: m.email || '',
                    program: group.program || '',
                    level: group.level || '',
                    classType: classType,
                    groupId: group.id,
                    groupName: group.name || '',
                    date: dateStr,
                    time: group.time,
                    duration: Number(group.duration) || 60,
                    lessonNum: idx + 1,
                    totalRegular: dates.length,
                    monthRef: monthRef,
                    status: 'SCHEDULED',
                    leaveType: '',
                    isMakeup: false,
                    originLessonId: null,
                    makeupLessonId: null,
                    gcalEventId: null
                });
            });
        });
        return out;
    }

    // 命中的既有課會刷新這些顯示欄位（改名/換導師等），但絕不動 status / 鏈接 / 日期時間
    const DISPLAY_FIELDS = ['studentName', 'tutor', 'phone', 'email', 'program', 'level',
        'classType', 'duration', 'lessonNum', 'totalRegular', 'monthRef', 'groupId', 'groupName', 'tutorLevel'];

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
        const selectedGroups = new Set((opts && opts.selectedGroupIds) || []);
        const allGroups = new Set((opts && opts.allGroupIds) || []);
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
            // 小組課的範圍看 groupId（本次勾選的小組 ∪ 已刪除的小組）；個別課看 studentId——
            // 只勾了某學生的個別課時，絕不誤刪他的小組課
            const inScope = old.groupId
                ? (selectedGroups.has(old.groupId) || !allGroups.has(old.groupId))
                : (selected.has(old.studentId) || !all.has(old.studentId));
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
        // 有 groupId 以 groupId 為準（同組同日同時段）；舊資料回退特徵比對
        if (a.groupId || b.groupId) return !!a.groupId && a.groupId === b.groupId && a.date === b.date && a.time === b.time;
        const isGroup = function (t) { return typeof t === 'string' && t.indexOf('小組') !== -1; };
        return isGroup(a.classType) && isGroup(b.classType) &&
            a.classType === b.classType &&
            a.program === b.program &&
            a.time === b.time &&
            Number(a.duration) === Number(b.duration);
    }

    // ===== 課節（cell）：「一個時段一堂課，多個人」的統一單位 =====
    // 小組課：同導師、同日、同時間、同 program、同小組形式、同時長 → 同一節（與 isSameGroupLesson 一致）；
    // 一對一：每堂自成一節。GCal 一節一個事件、總課表一節一張卡、薪酬導師節數按節計。
    function isGroupLesson(lesson) {
        if (lesson.groupId) return true;
        return typeof lesson.classType === 'string' && lesson.classType.indexOf('小組') !== -1;
    }

    function cellKey(lesson) {
        if (!isGroupLesson(lesson)) return lesson.lessonId;
        if (lesson.groupId) return ['G', lesson.groupId, lesson.date, lesson.time].join('|');
        return ['G', lesson.tutor, lesson.date, lesson.time, lesson.program, lesson.classType,
            Number(lesson.duration) || 45].join('|');
    }

    // lessons → [{ key, isGroup, lessons: [...]（依 studentId 排序）, date, time, tutor }]（依日期時間排序）
    function groupByCell(lessons) {
        const map = new Map();
        (lessons || []).forEach(function (l) {
            const key = cellKey(l);
            if (!map.has(key)) {
                map.set(key, { key: key, isGroup: isGroupLesson(l), lessons: [], date: l.date, time: l.time, tutor: l.tutor });
            }
            map.get(key).lessons.push(l);
        });
        const cells = Array.from(map.values());
        cells.forEach(function (c) {
            c.lessons.sort(function (a, b) { return String(a.studentId).localeCompare(String(b.studentId)); });
        });
        cells.sort(function (a, b) {
            return (a.date + ' ' + a.time + ' ' + a.key).localeCompare(b.date + ' ' + b.time + ' ' + b.key);
        });
        return cells;
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

    // 補堂課的原課時段：originLessonId "S001-20260916-1500" → { date: "2026-09-16", time: "15:00" }；沒有 → null
    function originSlot(lesson) {
        if (!lesson || !lesson.originLessonId) return null;
        const c = String(lesson.originLessonId).slice(String(lesson.studentId || '').length + 1);
        if (c.length < 13) return null;
        return { date: c.slice(0, 4) + '-' + c.slice(4, 6) + '-' + c.slice(6, 8), time: c.slice(9, 11) + ':' + c.slice(11, 13) };
    }

    // 日曆標題契約："S001 Student 001([1/5] 09/2026)"（studentId 前綴是同步對賬的匹配錨點）
    // 補堂："S001 Student 001 補堂([2/5] 09/2026 ← 09/16)"——在 Calendar 上一眼看出補的是哪一天那堂
    function lessonTitle(lesson) {
        const o = lesson.isMakeup ? originSlot(lesson) : null;
        return lesson.studentId + ' ' + lesson.studentName + (o ? ' 補堂' : '') +
            '([' + lesson.lessonNum + '/' + lesson.totalRegular + '] ' + lesson.monthRef +
            (o ? ' ← ' + o.date.slice(5).replace('-', '/') : '') + ')';
    }

    // 常規時間變更預覽：student 若改為 cfg = { weekday, time, duration? } 上課，monthStr 該月會與誰撞堂。
    // 佔用池 = existing（該月已生成的課，排除本人的非補堂課——它們將被改掉）
    //        ＋ 未出現在 existing 的其他學生（others）按常規時間模擬的課（涵蓋尚未生成的月份）。
    // 撞堂規則與 detectClashes 一致：同導師時段重疊即撞、LEAVE 不佔時段、同組小組課豁免。
    // 回傳 [{ date, time, clashes: [lesson, ...] }]，clashes 為空即該日無衝突。
    function previewTimeChange(student, others, existing, monthStr, cfg) {
        const time = cfg.time;
        const weekday = Number(cfg.weekday);
        const duration = Number(cfg.duration) || Number(student.duration) || 45;
        const tutor = cfg.tutor || student.tutor;
        const pool = (existing || []).filter(function (l) {
            return !(l.studentId === student.id && !l.isMakeup);
        });
        const present = new Set((existing || []).map(function (l) { return l.studentId; }));
        (others || []).forEach(function (o) {
            if (o.id === student.id || present.has(o.id)) return;
            pool.push.apply(pool, generateMonthLessons(o, monthStr));
        });
        const candidate = {
            studentId: student.id, tutor: tutor, time: time, duration: duration,
            classType: student.type || '', program: student.program || ''
        };
        const cStart = timeToMinutes(time), cEnd = cStart + duration;
        // 本人長假的日子不會出課，不用預覽
        return monthDatesForWeekday(monthStr, weekday).filter(function (d) { return !isOnLongLeave(student, d); }).map(function (dateStr) {
            const clashes = pool.filter(function (l) {
                if (l.status === 'LEAVE') return false;
                if (l.tutor !== tutor || l.date !== dateStr) return false;
                const s = timeToMinutes(l.time), e = s + (Number(l.duration) || 0);
                if (!(cStart < e && s < cEnd)) return false;
                return !isSameGroupLesson(candidate, l);
            });
            return { date: dateStr, time: time, clashes: clashes };
        });
    }

    return {
        pad2: pad2,
        compactDateTime: compactDateTime,
        makeLessonId: makeLessonId,
        makeMakeupLessonId: makeMakeupLessonId,
        monthKeyOf: monthKeyOf,
        monthDatesForWeekday: monthDatesForWeekday,
        getScheduleForMonth: getScheduleForMonth,
        studentIdKey: studentIdKey,
        sameStudentId: sameStudentId,
        normalizeLongLeaves: normalizeLongLeaves,
        validateLongLeaves: validateLongLeaves,
        longLeaveOn: longLeaveOn,
        isOnLongLeave: isOnLongLeave,
        longLeaveSkippedDates: longLeaveSkippedDates,
        generateMonthLessons: generateMonthLessons,
        generateGroupMonthLessons: generateGroupMonthLessons,
        mergeMonthLessons: mergeMonthLessons,
        timeToMinutes: timeToMinutes,
        isSameGroupLesson: isSameGroupLesson,
        isGroupLesson: isGroupLesson,
        cellKey: cellKey,
        groupByCell: groupByCell,
        detectClashes: detectClashes,
        lessonTitle: lessonTitle,
        originSlot: originSlot,
        previewTimeChange: previewTimeChange
    };
}));
