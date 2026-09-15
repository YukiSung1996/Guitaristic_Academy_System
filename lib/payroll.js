// lib/payroll.js — 計薪過濾純函數庫（無 DOM 依賴）
// 原則（規格書場景 5）：工資只算實際上了的課（ATTENDED），按「實際上課日期」歸屬月份
// （9 月請假、10 月補堂 → 算 10 月工資，因補堂課存放在 10 月分桶）。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACPayroll = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
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
        expiredScheduled: expiredScheduled,
        computePayout: computePayout
    };
}));
