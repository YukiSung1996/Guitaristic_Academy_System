// lib/schedule.js — 排課純函數庫（無 DOM 依賴，瀏覽器與 Node 皆可載入）
// 職責：日期生成、確定性 lessonId、月度課表生成、merge（非 wipe）語義、撞堂檢測、學號容錯比對、學生在學／停課狀態。
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

    // ===== 學生狀態：在學／停課 =====
    // student.inactivePeriods = [{ from: 'YYYY-MM-DD', resume: 'YYYY-MM-DD' 或 '' }]——每一段停課一筆（結束了的留作紀錄，重新生成舊月份才對）。
    //   from＝第一天不上課（可以是將來的日子＝預定停課）；resume＝復課日（當天起恢復上課）；resume 空白＝復課日未定，from 起一直停課。
    // 停課的日子生成時不出課——不收學費、不佔時段、不推 Calendar；精確到日（月中停課／月中復課都只略過停課那幾天）。
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    function isDateStr(s) { return DATE_RE.test(String(s || '')); }

    // 清理：丟掉沒有開始日期的項目、resume 不是日期就當未定；按開始日期排序
    function normalizeInactivePeriods(list) {
        return (list || []).filter(function (p) { return p && isDateStr(p.from); }).map(function (p) {
            return { from: p.from, resume: isDateStr(p.resume) ? p.resume : '' };
        }).sort(function (a, b) { return a.from.localeCompare(b.from); });
    }

    // 表單檢查一段停課：回傳錯誤訊息（'' ＝ 沒問題）
    function validateInactivePeriod(p) {
        if (!p || !isDateStr(p.from)) return '請填停課由哪一天開始。';
        if (p.resume && !isDateStr(p.resume)) return '復課日期格式不對。';
        if (p.resume && p.resume <= p.from) return '復課日期要在停課開始日期之後（復課日當天恢復上課）。';
        return '';
    }

    // dateStr 落在哪一段停課（沒有 → null）
    function inactivePeriodOn(student, dateStr) {
        const list = (student && student.inactivePeriods) || [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!p || !isDateStr(p.from)) continue;
            if (dateStr >= p.from && (!p.resume || dateStr < p.resume)) return p;
        }
        return null;
    }
    function isInactiveOn(student, dateStr) { return !!inactivePeriodOn(student, dateStr); }

    // 目前要顯示／編輯的那一段：今天正在停課的；否則最近一段還沒開始的（預定停課）；都沒有 → null（在學）
    // 回傳 { period, on }——on＝今天已在停課中
    function currentInactivePeriod(student, todayStr) {
        const list = normalizeInactivePeriods(student && student.inactivePeriods);
        const on = list.filter(function (p) { return todayStr >= p.from && (!p.resume || todayStr < p.resume); })[0];
        if (on) return { period: on, on: true };
        const next = list.filter(function (p) { return p.from > todayStr; })[0];
        return next ? { period: next, on: false } : null;
    }

    // 編輯表單 → 新的停課紀錄。edit = { inactive: true, from, resume } 或 { inactive: false }
    //   停課：把「目前那一段」（正在停課／預定停課的）換成表單填的；沒有就新增一段。
    //   在學：預定但還沒開始的停課 → 取消；正在停課 → 今天復課（今天才剛開始的那段等於沒停過，直接拿掉）。已結束的舊紀錄不動。
    function applyStatusEdit(periods, todayStr, edit) {
        const list = normalizeInactivePeriods(periods);
        const cur = currentInactivePeriod({ inactivePeriods: list }, todayStr);
        const rest = cur ? list.filter(function (p) { return !(p.from === cur.period.from && p.resume === cur.period.resume); }) : list;
        if (edit && edit.inactive) return normalizeInactivePeriods(rest.concat([{ from: edit.from, resume: edit.resume || '' }]));
        if (!cur || !cur.on || cur.period.from >= todayStr) return rest;
        return normalizeInactivePeriods(rest.concat([{ from: cur.period.from, resume: todayStr }]));
    }

    // 該生某月個別課（按常規時間）落在停課期間、因此不生成的日期
    function inactiveSkippedDates(student, monthStr) {
        const sched = getScheduleForMonth(student, monthStr);
        return monthDatesForWeekday(monthStr, sched.weekday).filter(function (d) { return isInactiveOn(student, d); });
    }

    // 生成一名學生某月的全部常規課（status 一律 SCHEDULED，merge 交給 mergeMonthLessons）。
    // 停課的日子不生成；lessonNum／totalRegular 只數實際生成的課（學費按實際堂數）
    function generateMonthLessons(student, monthStr) {
        const sched = getScheduleForMonth(student, monthStr);
        const dates = monthDatesForWeekday(monthStr, sched.weekday).filter(function (d) { return !isInactiveOn(student, d); });
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
                makeupLessonIds: [],
                gcalEventId: null
            };
        });
    }

    // 小組班：一個時段多個學生的一堂課。group = { id, name, program, level, duration, tutor, weekday, time, memberIds, startMonth? }
    // 每位成員各自一筆 lesson（出席／請假／學費按人），共享 groupId 讓課表／日曆／薪酬把它們當「一節」。
    // lessonId 仍是 studentId+日期時間（與個別課同一 id 空間；同一人同時段不可能既上個別課又上小組課）。
    // 停課的成員那幾天不生成（其他成員照常）；小組形式（N人小組）按全體成員計，不因有人停課而改變其他人的收費。
    function generateGroupMonthLessons(group, members, monthStr) {
        // 有開始月份的小組班（舊寫法轉過來的：從下個月起）→ 之前的月份不出課
        if (group.startMonth && String(monthStr) < String(group.startMonth)) return [];
        const dates = monthDatesForWeekday(monthStr, group.weekday);
        const parts = String(monthStr).split('-');
        const monthRef = parts[1] + '/' + parts[0];
        const classType = (members || []).length + '人小組';
        const out = [];
        (members || []).forEach(function (m) {
            dates.forEach(function (dateStr, idx) {
                if (isInactiveOn(m, dateStr)) return;
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
                    makeupLessonIds: [],
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

    // 只處理「某位成員在某個小組」的課（改了這位學生的在學／停課狀態時用——同組其他成員、其他課一律不動）。
    // 語義同 mergeMonthLessons：命中的保留；沒命中的仍是 SCHEDULED → 刪除，已有狀態 → 保留並列入 conflicts；缺的補上
    function mergeMemberGroupLessons(existing, generated, groupId, studentId) {
        const genIds = new Set((generated || []).map(function (l) { return l.lessonId; }));
        const have = new Set();
        const kept = [], removed = [], conflicts = [];
        (existing || []).forEach(function (old) {
            have.add(old.lessonId);
            if (old.isMakeup || old.groupId !== groupId || old.studentId !== studentId || genIds.has(old.lessonId)) { kept.push(old); return; }
            if (old.status === 'SCHEDULED') { removed.push(old); return; }
            kept.push(old);
            conflicts.push({ lesson: old, reason: '這位成員已不在此日上課，但此課已有狀態（' + old.status + '），請人工處理' });
        });
        const added = (generated || []).filter(function (l) { return !have.has(l.lessonId); });
        const lessons = kept.concat(added).sort(function (a, b) {
            return (a.date + ' ' + a.time + ' ' + a.studentId).localeCompare(b.date + ' ' + b.time + ' ' + b.studentId);
        });
        return { lessons: lessons, added: added, removed: removed, conflicts: conflicts };
    }

    function timeToMinutes(timeStr) {
        const parts = String(timeStr).split(':').map(Number);
        return parts[0] * 60 + (parts[1] || 0);
    }

    // 'HH:MM' 加幾分鐘 → 'HH:MM'（過午夜就停在 23:59 之內循環，排課不會用到）
    function addMinutes(timeStr, minutes) {
        const t = ((timeToMinutes(timeStr) + (Number(minutes) || 0)) % 1440 + 1440) % 1440;
        return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
    }

    // 這堂算幾堂：分段補堂（duration 小於原課一整堂 baseDuration）按比例，例如 45 分鐘課補 15 分鐘＝1/3 堂；其他一律 1
    function lessonWeight(lesson) {
        const base = Number(lesson && lesson.baseDuration) || 0, d = Number(lesson && lesson.duration) || 0;
        if (!base || !d || d === base) return 1;
        return d / base;
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
        // 本人停課的日子不會出課，不用預覽
        return monthDatesForWeekday(monthStr, weekday).filter(function (d) { return !isInactiveOn(student, d); }).map(function (dateStr) {
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

    // ===== 舊寫法的小組 → 小組班 =====
    // 以前「2人小組」這類小組形式可以寫在學生自己的常規課上（同一位導師、同一時間的幾位學生湊成一節）。
    // 現在小組一律用小組班（2 人、5 人都一樣），學生自己的常規課只有一對一。
    function nextMonthKey(monthKey) {
        const p = String(monthKey).split('-').map(Number);
        return p[1] === 12 ? (p[0] + 1) + '-01' : p[0] + '-' + pad2(p[1] + 1);
    }

    // 學生自己的常規課寫的是小組形式（舊寫法）
    function isLegacyGroupStudent(s) {
        return !!s && s.weekday !== null && s.weekday !== undefined && s.weekday !== '' && !!s.time
            && String(s.type || '').indexOf('小組') !== -1;
    }

    // 找出舊寫法的學生，按「導師＋星期＋時間」分堆，一堆＝一個要建的小組班。可以直接轉（ready）要同時符合：
    // 至少兩位；課程、級別、時長一樣；轉了以後每位的每堂收費都不變（rateFn 用課堂欄位查價——以前按學生寫的形式，
    // 以後按小組人數）；沒有預定的改時間；同一時段沒有別的小組班。其他的寫明原因（manual），留給人處理。
    // 回傳 { ready: [item], manual: [item] }，item = { students, group（要建的小組班，還沒編號、沒名字）, reasons, rate, newRate }
    function planLegacyGroups(students, groups, rateFn) {
        const buckets = new Map();
        (students || []).filter(isLegacyGroupStudent).forEach(function (s) {
            const k = [s.tutor, Number(s.weekday), s.time].join('|');
            if (!buckets.has(k)) buckets.set(k, []);
            buckets.get(k).push(s);
        });
        const ready = [], manual = [];
        buckets.forEach(function (list) {
            const s0 = list[0];
            const group = {
                program: s0.program || '', level: s0.level || '', duration: Number(s0.duration) || 60,
                tutor: s0.tutor, tutorLevel: s0.tutorLevel || '', weekday: Number(s0.weekday), time: s0.time,
                memberIds: list.map(function (s) { return s.id; })
            };
            const reasons = [];
            const same = function (f) { return list.every(function (s) { return String(s[f] == null ? '' : s[f]) === String(s0[f] == null ? '' : s0[f]); }); };
            if (list.length < 2) reasons.push('同一位導師、同一時間找不到其他學生');
            else if (!['program', 'level', 'duration'].every(same)) reasons.push('同一時段的學生課程、級別或時長不一樣');
            if (list.some(function (s) { return s.effectiveMonth && s.futureWeekday !== null && s.futureWeekday !== undefined; })) reasons.push('有預定的改時間，請先處理');
            const taken = (groups || []).find(function (g) { return g.tutor === s0.tutor && Number(g.weekday) === Number(s0.weekday) && g.time === s0.time; });
            if (taken) reasons.push('同一時段已有小組班「' + taken.name + '」');
            const rateOf = function (s) {
                return rateFn ? rateFn({ program: s.program, level: s.level, classType: s.type, duration: s.duration, tutor: s.tutor, tutorLevel: s.tutorLevel }) : null;
            };
            const rate = rateOf(s0);
            const newRate = rateFn ? rateFn({ program: group.program, level: group.level, classType: list.length + '人小組', duration: group.duration, tutor: group.tutor, tutorLevel: group.tutorLevel }) : null;
            if (!reasons.length && list.some(function (s) { return rateOf(s) !== newRate; })) {
                const olds = list.map(rateOf).filter(function (r, i, a) { return a.indexOf(r) === i; });
                reasons.push(list.length + ' 位學生、形式寫「' + s0.type + '」：轉成小組班後每堂收費會由 $' + olds.join('／$') + ' 變成 $' + newRate);
            }
            (reasons.length ? manual : ready).push({ students: list, group: group, reasons: reasons, rate: rate, newRate: newRate });
        });
        // 按導師、星期（一 → 日）、時間排
        const key = function (it) { return [it.group.tutor, (Number(it.group.weekday) + 6) % 7, it.group.time].join('|'); };
        const order = function (a, b) { return key(a).localeCompare(key(b)); };
        return { ready: ready.sort(order), manual: manual.sort(order) };
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
        normalizeInactivePeriods: normalizeInactivePeriods,
        validateInactivePeriod: validateInactivePeriod,
        inactivePeriodOn: inactivePeriodOn,
        isInactiveOn: isInactiveOn,
        currentInactivePeriod: currentInactivePeriod,
        applyStatusEdit: applyStatusEdit,
        inactiveSkippedDates: inactiveSkippedDates,
        generateMonthLessons: generateMonthLessons,
        generateGroupMonthLessons: generateGroupMonthLessons,
        mergeMonthLessons: mergeMonthLessons,
        mergeMemberGroupLessons: mergeMemberGroupLessons,
        timeToMinutes: timeToMinutes,
        addMinutes: addMinutes,
        lessonWeight: lessonWeight,
        isSameGroupLesson: isSameGroupLesson,
        isGroupLesson: isGroupLesson,
        cellKey: cellKey,
        groupByCell: groupByCell,
        detectClashes: detectClashes,
        lessonTitle: lessonTitle,
        originSlot: originSlot,
        previewTimeChange: previewTimeChange,
        nextMonthKey: nextMonthKey,
        isLegacyGroupStudent: isLegacyGroupStudent,
        planLegacyGroups: planLegacyGroups
    };
}));
