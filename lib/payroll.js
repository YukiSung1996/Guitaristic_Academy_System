// lib/payroll.js — 計薪過濾純函數庫（無 DOM 依賴）
// 原則（規格書場景 5）：工資只算實際上了的課（ATTENDED），按「實際上課日期」歸屬月份
// （9 月請假、10 月補堂 → 算 10 月工資，因補堂課存放在 10 月分桶）。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./schedule.js'));
    } else {
        root.GACPayroll = factory(root.GACSchedule);
    }
}(typeof self !== 'undefined' ? self : this, function (GACSchedule) {
    'use strict';

    // 某月可計薪的課。opts.payNoShow 預設 true。
    // TODO(跟老闆確認)：NOSHOW 預設計薪（學生沒來但導師已到場，通常照付），可在設定關閉。
    function payableLessons(buckets, monthKey, opts) {
        const payNoShow = !opts || opts.payNoShow !== false;
        const arr = (buckets && buckets[monthKey]) || [];
        return arr.filter(function (l) {
            return l.status === 'ATTENDED' || (payNoShow && l.status === 'NOSHOW');
        });
    }

    // { studentId: 可計薪堂數 }
    function countPayableByStudent(buckets, monthKey, opts) {
        const counts = {};
        payableLessons(buckets, monthKey, opts).forEach(function (l) {
            counts[l.studentId] = (counts[l.studentId] || 0) + 1;
        });
        return counts;
    }

    // 導師節數：{ tutor: 節數 }。小組課同組同時段只算一節（分組特徵對齊 schedule.isSameGroupLesson：
    // 同導師、同日、同時間、同 program、同小組形式、同時長）；一對一每堂算一節。
    // 用途：小組 5 人一齊上一堂，學生人次是 5、但導師實際只教了 1 節——按節計工時看這個數。
    function tutorSessions(buckets, monthKey, opts) {
        const sessions = {};
        GACSchedule.groupByCell(payableLessons(buckets, monthKey, opts)).forEach(function (cell) {
            const tutor = cell.tutor || '';
            sessions[tutor] = (sessions[tutor] || 0) + 1;
        });
        return sessions;
    }

    // 月度薪酬彙總：把某月的課分成「已確認」（ATTENDED，NOSHOW 依 payNoShow）與「待確認」（SCHEDULED），
    // 兩者相加＝「預期」。請假不算——其補堂是另一筆課堂記錄，落在補堂當月。
    // opts = { payNoShow, rateFn(lesson) → 該堂的課程費用 }
    // 回傳 { tutors: [{tutor, items[], expected, current, pending, expectedGross, currentGross, expectedSessions, currentSessions}], totals }
    // items ＝該導師名下每個「報讀項目」一筆（個別課一筆、每個小組的每位成員一筆）。
    function monthPayroll(buckets, monthKey, opts) {
        var o = opts || {};
        var payNoShow = o.payNoShow !== false;
        var rateFn = o.rateFn || function () { return 0; };
        var bucket = (buckets && buckets[monthKey]) || [];
        function kindOf(l) {
            if (l.status === "ATTENDED") return "current";
            if (l.status === "NOSHOW") return payNoShow ? "current" : null;
            if (l.status === "SCHEDULED") return "pending";
            return null;
        }
        var tutors = [], byTutor = {}, expectedLessons = [], currentLessons = [];
        bucket.forEach(function (l) {
            var kind = kindOf(l);
            if (!kind) return;
            expectedLessons.push(l);
            if (kind === "current") currentLessons.push(l);
            var name = l.tutor || "";
            var t = byTutor[name];
            if (!t) {
                t = byTutor[name] = { tutor: name, items: [], _byKey: {}, expected: 0, current: 0, pending: 0,
                    expectedGross: 0, currentGross: 0, expectedSessions: 0, currentSessions: 0 };
                tutors.push(t);
            }
            var key = l.groupId ? "G:" + l.groupId + ":" + l.studentId : "IND:" + l.studentId;
            var item = t._byKey[key];
            if (!item) {
                item = t._byKey[key] = { key: key, studentId: l.studentId, studentName: l.studentName || l.studentId,
                    groupId: l.groupId || "", groupName: l.groupName || "", program: l.program || "", level: l.level || "",
                    rate: Number(rateFn(l)) || 0, expected: 0, current: 0, pending: 0 };
                t.items.push(item);
            }
            var rate = Number(rateFn(l)) || 0;
            item.expected++; t.expected++; t.expectedGross += rate;
            if (kind === "current") { item.current++; t.current++; t.currentGross += rate; }
            else { item.pending++; t.pending++; }
        });
        // 節數：小組同時段只算一節（與 tutorSessions 同一分組規則）
        GACSchedule.groupByCell(expectedLessons).forEach(function (c) {
            var t = byTutor[c.tutor || ""];
            if (t) t.expectedSessions++;
        });
        GACSchedule.groupByCell(currentLessons).forEach(function (c) {
            var t = byTutor[c.tutor || ""];
            if (t) t.currentSessions++;
        });
        tutors.sort(function (a, b) { return String(a.tutor).localeCompare(String(b.tutor)); });
        var totals = { expected: 0, current: 0, pending: 0, expectedGross: 0, currentGross: 0, expectedSessions: 0, currentSessions: 0 };
        tutors.forEach(function (t) {
            delete t._byKey;
            t.items.sort(function (a, b) { return (a.groupName + "|" + a.studentId).localeCompare(b.groupName + "|" + b.studentId); });
            Object.keys(totals).forEach(function (k) { totals[k] += t[k]; });
        });
        return { tutors: tutors, totals: totals };
    }

    // 計算前置檢查：日期已過但仍是 SCHEDULED 的課（即忘了確認出席的）
    function expiredScheduled(buckets, monthKey, todayStr) {
        const arr = (buckets && buckets[monthKey]) || [];
        return arr.filter(function (l) {
            return l.status === 'SCHEDULED' && l.date < todayStr;
        });
    }

    // 課程總額 × 拆帳 % ＋ 調整項目（type 'sub' 為扣款）
    function computePayout(gross, sharePct, adjustments) {
        const adjTotal = (adjustments || []).reduce(function (sum, item) {
            return sum + (item.type === 'sub' ? -1 : 1) * Number(item.amount || 0);
        }, 0);
        const payout = Number(gross || 0) * (Number(sharePct) || 0) / 100 + adjTotal;
        return { gross: Number(gross || 0), adjTotal: adjTotal, payout: payout };
    }

    return {
        payableLessons: payableLessons,
        countPayableByStudent: countPayableByStudent,
        tutorSessions: tutorSessions,
        monthPayroll: monthPayroll,
        expiredScheduled: expiredScheduled,
        computePayout: computePayout
    };
}));
