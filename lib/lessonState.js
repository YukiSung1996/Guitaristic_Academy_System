// lib/lessonState.js — 課堂狀態機與補堂鏈純函數庫（無 DOM 依賴）
// buckets = gac_lessons_v2 的月分桶結構：{ "2026-09": [lesson, ...], ... }
// 所有跨課引用一律用 lessonId 字串（可安全 JSON 序列化），不存物件引用。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./schedule.js'));
    } else {
        root.GACLessonState = factory(root.GACSchedule);
    }
}(typeof self !== 'undefined' ? self : this, function (GACSchedule) {
    'use strict';

    // 唯一允許的狀態轉換（規格書決策 B）
    const TRANSITIONS = {
        SCHEDULED: ['ATTENDED', 'LEAVE', 'NOSHOW'],
        ATTENDED: ['SCHEDULED'],
        LEAVE: ['SCHEDULED'],
        NOSHOW: ['SCHEDULED']
    };

    function allLessons(buckets) {
        const out = [];
        Object.keys(buckets || {}).sort().forEach(function (key) {
            (buckets[key] || []).forEach(function (l) { out.push(l); });
        });
        return out;
    }

    function findLesson(buckets, lessonId) {
        const keys = Object.keys(buckets || {});
        for (let k = 0; k < keys.length; k++) {
            const arr = buckets[keys[k]] || [];
            for (let i = 0; i < arr.length; i++) {
                if (arr[i].lessonId === lessonId) {
                    return { lesson: arr[i], monthKey: keys[k], index: i };
                }
            }
        }
        return null;
    }

    // 標記狀態。回傳 { ok, code?, error?, lesson? }。
    // 撤銷（→SCHEDULED）由呼叫方先 confirm；已排補堂的 LEAVE 撤銷會被攔截（HAS_MAKEUP）。
    function markStatus(buckets, lessonId, to, opts) {
        const found = findLesson(buckets, lessonId);
        if (!found) return { ok: false, code: 'NOT_FOUND', error: '找不到課堂 ' + lessonId };
        const lesson = found.lesson;
        if (lesson.status === to) return { ok: true, lesson: lesson, unchanged: true };
        const allowed = TRANSITIONS[lesson.status] || [];
        if (allowed.indexOf(to) === -1) {
            return {
                ok: false, code: 'ILLEGAL_TRANSITION', lesson: lesson,
                error: '不允許 ' + lesson.status + ' → ' + to + '（請先還原為已排課）'
            };
        }
        if (to === 'SCHEDULED' && lesson.status === 'LEAVE' && lesson.makeupLessonId) {
            return {
                ok: false, code: 'HAS_MAKEUP', lesson: lesson, makeupLessonId: lesson.makeupLessonId,
                error: '此請假已排補堂，請先取消補堂再還原'
            };
        }
        lesson.status = to;
        lesson.leaveType = (to === 'LEAVE') ? ((opts && opts.leaveType) || 'L') : '';
        return { ok: true, lesson: lesson };
    }

    // 為 LEAVE 課安排補堂。slot = { date, time, duration? }。
    // 防重複：已有補堂 → DUPLICATE_MAKEUP（附 existingMakeup）；opts.replaceExisting 才會取消舊補堂重排。
    // 鏈式補堂：origin 若本身是補堂課，新課的 originLessonId 仍指向鏈條最初的原課。
    function scheduleMakeup(buckets, originLessonId, slot, opts) {
        opts = opts || {};
        const found = findLesson(buckets, originLessonId);
        if (!found) return { ok: false, code: 'NOT_FOUND', error: '找不到課堂 ' + originLessonId };
        const origin = found.lesson;
        if (origin.status !== 'LEAVE') {
            return { ok: false, code: 'NOT_LEAVE', lesson: origin, error: '只有已請假的課才能安排補堂' };
        }
        if (origin.makeupLessonId) {
            const existing = findLesson(buckets, origin.makeupLessonId);
            if (!opts.replaceExisting) {
                return {
                    ok: false, code: 'DUPLICATE_MAKEUP', lesson: origin,
                    existingMakeup: existing ? existing.lesson : null,
                    error: '此請假已排過補堂'
                };
            }
            const cancelled = cancelMakeup(buckets, origin.makeupLessonId);
            if (!cancelled.ok) return cancelled;
        }
        const firstOriginId = origin.isMakeup ? origin.originLessonId : origin.lessonId;
        const newId = GACSchedule.makeMakeupLessonId(origin.studentId, slot.date, slot.time, firstOriginId);
        if (findLesson(buckets, newId)) {
            return { ok: false, code: 'DUPLICATE_LESSON_ID', error: '同一時段已存在相同的補堂課' };
        }
        const makeup = {
            lessonId: newId,
            studentId: origin.studentId,
            studentName: origin.studentName,
            tutor: origin.tutor,
            phone: origin.phone || '',
            email: origin.email || '',
            program: origin.program || '',
            level: origin.level || '',
            classType: origin.classType || '',
            date: slot.date,
            time: slot.time,
            duration: Number(slot.duration) || origin.duration,
            lessonNum: origin.lessonNum,
            totalRegular: origin.totalRegular,
            monthRef: origin.monthRef, // 標題沿用原課的 [n/total] MM/YYYY（日曆契約）
            status: 'SCHEDULED',
            leaveType: '',
            isMakeup: true,
            originLessonId: firstOriginId,
            makeupLessonId: null,
            gcalEventId: null
        };
        const key = GACSchedule.monthKeyOf(slot.date);
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(makeup);
        origin.makeupLessonId = newId;
        return { ok: true, makeup: makeup, origin: origin };
    }

    // 取消補堂：只允許取消仍是 SCHEDULED 的補堂課（已出席/已請假的補堂是歷史事實，需先還原）。
    // 上一環（原課或鏈中上一節補堂）的 makeupLessonId 清空 → 回到待補池。
    function cancelMakeup(buckets, makeupLessonId) {
        const found = findLesson(buckets, makeupLessonId);
        if (!found) return { ok: false, code: 'NOT_FOUND', error: '找不到補堂課 ' + makeupLessonId };
        const makeup = found.lesson;
        if (!makeup.isMakeup) return { ok: false, code: 'NOT_MAKEUP', error: '此課不是補堂課' };
        if (makeup.status !== 'SCHEDULED') {
            return {
                ok: false, code: 'MAKEUP_NOT_SCHEDULED', lesson: makeup,
                error: '補堂課目前狀態為 ' + makeup.status + '，請先還原為已排課再取消'
            };
        }
        let prev = null;
        const lessons = allLessons(buckets);
        for (let i = 0; i < lessons.length; i++) {
            if (lessons[i].makeupLessonId === makeupLessonId) { prev = lessons[i]; break; }
        }
        if (prev) prev.makeupLessonId = null;
        buckets[found.monthKey].splice(found.index, 1);
        if (buckets[found.monthKey].length === 0) delete buckets[found.monthKey];
        return { ok: true, removed: makeup, origin: prev };
    }

    function daysBetween(fromDateStr, toDateStr) {
        const f = String(fromDateStr).split('-').map(Number);
        const t = String(toDateStr).split('-').map(Number);
        return Math.round((Date.UTC(t[0], t[1] - 1, t[2]) - Date.UTC(f[0], f[1] - 1, f[2])) / 86400000);
    }

    // 待補堂池：跨月列出所有「已請假且未排補堂」的課，按已等待天數降序
    function pendingMakeups(buckets, todayStr) {
        return allLessons(buckets)
            .filter(function (l) { return l.status === 'LEAVE' && !l.makeupLessonId; })
            .map(function (l) { return { lesson: l, waitingDays: daysBetween(l.date, todayStr) }; })
            .sort(function (a, b) { return b.waitingDays - a.waitingDays; });
    }

    // 批量確認出席：把日期範圍內的 SCHEDULED 全部標為 ATTENDED。
    // TODO(跟老闆確認)：預設只確認 opts.maxDate（通常=今天）或以前的課，未來的課不可預先標出席。
    function confirmScheduledInRange(buckets, fromDateStr, toDateStr, opts) {
        const maxDate = (opts && opts.maxDate) || null;
        const confirmed = [];
        allLessons(buckets).forEach(function (l) {
            if (l.status !== 'SCHEDULED') return;
            if (l.date < fromDateStr || l.date > toDateStr) return;
            if (maxDate && l.date > maxDate) return;
            l.status = 'ATTENDED';
            l.leaveType = '';
            confirmed.push(l);
        });
        return { ok: true, count: confirmed.length, lessons: confirmed };
    }

    return {
        TRANSITIONS: TRANSITIONS,
        allLessons: allLessons,
        findLesson: findLesson,
        markStatus: markStatus,
        scheduleMakeup: scheduleMakeup,
        cancelMakeup: cancelMakeup,
        daysBetween: daysBetween,
        pendingMakeups: pendingMakeups,
        confirmScheduledInRange: confirmScheduledInRange
    };
}));
