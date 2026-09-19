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

    // 手動模式的直接設定：跳過 TRANSITIONS 矩陣，但仍保護補堂鏈——
    // 已排補堂的 LEAVE 改為其他狀態前必須先取消補堂（HAS_MAKEUP），避免產生無主補堂。
    function forceStatus(buckets, lessonId, to, opts) {
        if (['SCHEDULED', 'ATTENDED', 'LEAVE', 'NOSHOW'].indexOf(to) === -1) {
            return { ok: false, code: 'INVALID_STATUS', error: '無效狀態 ' + to };
        }
        const found = findLesson(buckets, lessonId);
        if (!found) return { ok: false, code: 'NOT_FOUND', error: '找不到課堂 ' + lessonId };
        const lesson = found.lesson;
        if (lesson.status === 'LEAVE' && to !== 'LEAVE' && lesson.makeupLessonId) {
            return {
                ok: false, code: 'HAS_MAKEUP', lesson: lesson, makeupLessonId: lesson.makeupLessonId,
                error: '此請假已排補堂，請先取消補堂'
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
            groupId: origin.groupId || null,     // 小組補堂仍同組（整組 TL 補堂排同時段時合成一節）
            groupName: origin.groupName || '',
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

    // 同步對帳「時間變更」套用：改 date/time，跨月時移桶。
    // lessonId 保持不變（不變主鍵，編碼的是「原定」時段）——補堂鏈與 GCal 映射不斷；
    // 重新生成的 merge 亦按此 id 命中且絕不動日期時間，改過的時間不會被生成邏輯還原。
    function moveLessonDateTime(buckets, lessonId, date, time) {
        const found = findLesson(buckets, lessonId);
        if (!found) return { ok: false, code: 'NOT_FOUND', error: '找不到課堂 ' + lessonId };
        const lesson = found.lesson;
        const toKey = String(date).slice(0, 7);
        lesson.date = date;
        if (time) lesson.time = time;
        if (toKey !== found.monthKey) {
            buckets[found.monthKey].splice(found.index, 1);
            if (buckets[found.monthKey].length === 0) delete buckets[found.monthKey];
            if (!buckets[toKey]) buckets[toKey] = [];
            buckets[toKey].push(lesson);
        }
        return { ok: true, lesson: lesson, fromMonthKey: found.monthKey, toMonthKey: toKey };
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

    // 同組同時段的其他學生課堂：同日、同時間、小組匹配（isSameGroupLesson）、不同學生。
    // 呼叫方自行按 status / isMakeup 過濾。對原課回傳同日原課；對補堂課回傳同補堂時段的同組補堂。
    function groupSiblings(buckets, lessonId) {
        const found = findLesson(buckets, lessonId);
        if (!found) return [];
        const me = found.lesson;
        const key = GACSchedule.monthKeyOf(me.date);
        return (buckets[key] || []).filter(function (l) {
            return l.lessonId !== me.lessonId &&
                l.studentId !== me.studentId &&
                l.date === me.date &&
                GACSchedule.isSameGroupLesson(l, me);
        });
    }

    // 小組一致性檢查（防範機制的兜底偵測，掃描 monthKey 當月的「原課」時段）：
    // 1) TL_PARTIAL：同組同時段有人已請導師假（TL），另有人卻非請假狀態——導師請假應影響全組。
    // 2) MAKEUP_DIVERGED：同組全員 TL 請假，但已排補堂的時段不一致——TL 補堂通常全組同一時段。
    // 只針對 TL 告警；個人假（L/SL）各自排補堂屬正常，不告警。
    // TODO(跟老闆確認)：全組同時請個人假時補堂是否也需對齊；混合假別（TL+SL）暫不告警。
    function detectGroupInconsistencies(buckets, monthKey) {
        const out = [];
        const origins = ((buckets && buckets[monthKey]) || []).filter(function (l) { return !l.isMakeup; });
        // 按 日期 + 小組特徵 聚成時段格
        const cells = [];
        origins.forEach(function (l) {
            for (let i = 0; i < cells.length; i++) {
                if (cells[i][0].date === l.date && GACSchedule.isSameGroupLesson(cells[i][0], l)) {
                    cells[i].push(l);
                    return;
                }
            }
            cells.push([l]);
        });
        cells.forEach(function (cell) {
            if (cell.length < 2) return;
            const tl = cell.filter(function (l) { return l.status === 'LEAVE' && l.leaveType === 'TL'; });
            if (!tl.length) return;
            const notLeave = cell.filter(function (l) { return l.status !== 'LEAVE'; });
            if (notLeave.length) {
                out.push({
                    type: 'TL_PARTIAL', date: cell[0].date, time: cell[0].time,
                    tlLessons: tl, others: notLeave
                });
                return;
            }
            if (!cell.every(function (l) { return l.leaveType === 'TL'; })) return;
            const withMakeup = cell
                .filter(function (l) { return l.makeupLessonId; })
                .map(function (l) {
                    const f = findLesson(buckets, l.makeupLessonId);
                    return f ? { origin: l, makeup: f.lesson } : null;
                })
                .filter(Boolean);
            if (withMakeup.length < 2) return;
            const slots = {};
            withMakeup.forEach(function (x) { slots[x.makeup.date + ' ' + x.makeup.time] = true; });
            if (Object.keys(slots).length > 1) {
                out.push({
                    type: 'MAKEUP_DIVERGED', date: cell[0].date, time: cell[0].time,
                    entries: withMakeup
                });
            }
        });
        return out;
    }

    // 清空整月（測試清場用，無視狀態機——已出席/已請假一樣刪）：
    // - 刪 monthKey 桶內全部課；
    // - 級聯刪跨月鏈條：被刪課掛連的補堂（makeupLessonId 向下）與 origin 屬被刪課的補堂
    //   （originLessonId 向上），固定點迭代直至鏈條掃盡；
    // - 倖存課的 makeupLessonId 若指向被刪課 → 清空（該請假回到待補池）。
    // 回傳 { removed: [lesson...], unlinked: [lesson...] }。
    function clearMonth(buckets, monthKey) {
        const doomed = {};
        ((buckets && buckets[monthKey]) || []).forEach(function (l) { doomed[l.lessonId] = true; });
        let grew = true;
        while (grew) {
            grew = false;
            allLessons(buckets).forEach(function (l) {
                if (doomed[l.lessonId]) {
                    if (l.makeupLessonId && !doomed[l.makeupLessonId]) {
                        doomed[l.makeupLessonId] = true;
                        grew = true;
                    }
                    return;
                }
                if (l.isMakeup && l.originLessonId && doomed[l.originLessonId]) {
                    doomed[l.lessonId] = true;
                    grew = true;
                }
            });
        }
        const removed = [], unlinked = [];
        Object.keys(buckets || {}).forEach(function (key) {
            const keep = [];
            (buckets[key] || []).forEach(function (l) {
                if (doomed[l.lessonId]) { removed.push(l); return; }
                if (l.makeupLessonId && doomed[l.makeupLessonId]) {
                    l.makeupLessonId = null;
                    unlinked.push(l);
                }
                keep.push(l);
            });
            if (keep.length) buckets[key] = keep;
            else delete buckets[key];
        });
        return { removed: removed, unlinked: unlinked };
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
        forceStatus: forceStatus,
        scheduleMakeup: scheduleMakeup,
        cancelMakeup: cancelMakeup,
        moveLessonDateTime: moveLessonDateTime,
        clearMonth: clearMonth,
        daysBetween: daysBetween,
        groupSiblings: groupSiblings,
        detectGroupInconsistencies: detectGroupInconsistencies,
        pendingMakeups: pendingMakeups,
        confirmScheduledInRange: confirmScheduledInRange
    };
}));
