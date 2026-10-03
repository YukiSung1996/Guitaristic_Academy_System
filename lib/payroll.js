// lib/payroll.js — 計薪過濾純函數庫（無 DOM 依賴）
// 原則（規格書場景 5）：工資只算實際上了的課（ATTENDED），按「實際上課日期」歸屬月份
// （9 月請假、10 月補堂 → 算 10 月工資，因補堂課存放在 10 月分桶）。
// 分段補堂（例如 45 分鐘的課補 15 分鐘）按比例：堂數算 1/3 堂、課程費用算每堂價的 1/3（GACSchedule.lessonWeight）；
// rateFn(lesson) 一律回傳「一整堂」的價錢，比例由本庫乘。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./schedule.js'));
    } else {
        root.GACPayroll = factory(root.GACSchedule);
    }
}(typeof self !== 'undefined' ? self : this, function (GACSchedule) {
    'use strict';

    // 某月可計薪的課：已上課，以及缺席（學生沒來但導師已到場，照計）。
    function payableLessons(buckets, monthKey) {
        const arr = (buckets && buckets[monthKey]) || [];
        return arr.filter(function (l) {
            return l.status === 'ATTENDED' || l.status === 'NOSHOW';
        });
    }

    // { studentId: 可計薪堂數 }（分段補堂按比例）
    function countPayableByStudent(buckets, monthKey) {
        const counts = {};
        payableLessons(buckets, monthKey).forEach(function (l) {
            counts[l.studentId] = (counts[l.studentId] || 0) + GACSchedule.lessonWeight(l);
        });
        return counts;
    }

    // 堂數加總後收尾：1/3 加三次會變成 4.999999999999999，收到小數六位（分數格式與比較都不受影響）
    function roundCount(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

    // 堂數顯示：整數照印；1/2、1/3、2/3、1/4、3/4 這些（15 分鐘單位配 30／45／60 分鐘的課）印成分數，其他兩位小數
    var FRACTIONS = [[1, 2, '½'], [1, 3, '⅓'], [2, 3, '⅔'], [1, 4, '¼'], [3, 4, '¾']];
    function formatCount(n) {
        n = Number(n) || 0;
        var whole = Math.floor(n + 1e-9), frac = n - whole;
        if (frac < 1e-6) return String(whole);
        for (var i = 0; i < FRACTIONS.length; i++) {
            if (Math.abs(frac - FRACTIONS[i][0] / FRACTIONS[i][1]) < 1e-6) return (whole ? whole : '') + FRACTIONS[i][2];
        }
        return (Math.round(n * 100) / 100).toString();
    }

    // 導師節數：{ tutor: 節數 }。小組課同組同時段只算一節（分組特徵對齊 schedule.isSameGroupLesson：
    // 同導師、同日、同時間、同 program、同小組形式、同時長）；一對一每堂算一節。
    // 用途：小組 5 人一齊上一堂，學生人次是 5、但導師實際只教了 1 節——按節計工時看這個數。
    // 分段補堂的一節按比例（三段 15 分鐘＝一節）
    function tutorSessions(buckets, monthKey) {
        const sessions = {};
        GACSchedule.groupByCell(payableLessons(buckets, monthKey)).forEach(function (cell) {
            const tutor = cell.tutor || '';
            sessions[tutor] = (sessions[tutor] || 0) + GACSchedule.lessonWeight(cell.lessons[0]);
        });
        return sessions;
    }

    // 月度薪酬彙總：把某月的課分成「已確認」（ATTENDED 與 NOSHOW）與「待確認」（SCHEDULED），
    // 兩者相加＝「預期」。請假不算——其補堂是另一筆課堂記錄，落在補堂當月。
    // opts = { rateFn(lesson) → 該堂的課程費用 }
    // 回傳 { tutors: [{tutor, items[], expected, current, pending, expectedGross, currentGross, expectedSessions, currentSessions}], totals }
    // items ＝該導師名下每個「報讀項目」一筆（個別課一筆、每個小組的每位成員一筆）。堂數是整堂當量（分段補堂按比例），
    // item.partMinutes＝分段補堂的分鐘數（已確認／待確認），顯示「含分段補堂 N 分鐘」用。
    function monthPayroll(buckets, monthKey, opts) {
        var o = opts || {};
        var rateFn = o.rateFn || function () { return 0; };
        var bucket = (buckets && buckets[monthKey]) || [];
        function kindOf(l) {
            if (l.status === "ATTENDED" || l.status === "NOSHOW") return "current";
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
                    rate: Number(rateFn(l)) || 0, expected: 0, current: 0, pending: 0, partMinutes: { expected: 0, current: 0 } };
                t.items.push(item);
            }
            var w = GACSchedule.lessonWeight(l);
            var rate = (Number(rateFn(l)) || 0) * w;
            item.expected += w; t.expected += w; t.expectedGross += rate;
            if (w < 1) item.partMinutes.expected += Number(l.duration) || 0;
            if (kind === "current") { item.current += w; t.current += w; t.currentGross += rate; if (w < 1) item.partMinutes.current += Number(l.duration) || 0; }
            else { item.pending += w; t.pending += w; }
        });
        // 節數：小組同時段只算一節（與 tutorSessions 同一分組規則）
        GACSchedule.groupByCell(expectedLessons).forEach(function (c) {
            var t = byTutor[c.tutor || ""];
            if (t) t.expectedSessions += GACSchedule.lessonWeight(c.lessons[0]);
        });
        GACSchedule.groupByCell(currentLessons).forEach(function (c) {
            var t = byTutor[c.tutor || ""];
            if (t) t.currentSessions += GACSchedule.lessonWeight(c.lessons[0]);
        });
        tutors.sort(function (a, b) { return String(a.tutor).localeCompare(String(b.tutor)); });
        var totals = { expected: 0, current: 0, pending: 0, expectedGross: 0, currentGross: 0, expectedSessions: 0, currentSessions: 0 };
        tutors.forEach(function (t) {
            delete t._byKey;
            ['expected', 'current', 'pending', 'expectedSessions', 'currentSessions'].forEach(function (k) { t[k] = roundCount(t[k]); });
            t.items.forEach(function (it) { it.expected = roundCount(it.expected); it.current = roundCount(it.current); it.pending = roundCount(it.pending); });
            t.items.sort(function (a, b) { return (a.groupName + "|" + a.studentId).localeCompare(b.groupName + "|" + b.studentId); });
            Object.keys(totals).forEach(function (k) { totals[k] += t[k]; });
        });
        ['expected', 'current', 'pending', 'expectedSessions', 'currentSessions'].forEach(function (k) { totals[k] = roundCount(totals[k]); });
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
        formatCount: formatCount,
        roundCount: roundCount,
        tutorSessions: tutorSessions,
        monthPayroll: monthPayroll,
        expiredScheduled: expiredScheduled,
        computePayout: computePayout
    };
}));
