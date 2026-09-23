// lib/analytics.js — 數據分析純函數庫（無 DOM 依賴）
// 職責：某月課堂 → KPI（出席率／缺席率／請假率、可計薪節數與工時、已上課課值、學費應收與已收）、
//       各導師／各課程分項、狀態分佈。口徑與薪酬頁一致：可計薪＝已上課（＋缺席，視設定）；小組同時段算一節。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./schedule.js'), require('./payroll.js'));
    } else {
        root.GACAnalytics = factory(root.GACSchedule, root.GACPayroll);
    }
}(typeof self !== 'undefined' ? self : this, function (GACSchedule, GACPayroll) {
    'use strict';

    function pct(n, d) { return d > 0 ? Math.round(n / d * 100) : null; }
    function round1(x) { return Math.round(x * 10) / 10; }

    // opts: { rateFn(lesson) → 每堂學費, payNoShow（缺席是否計薪，預設 true）, tuitionEntries: 該月 TUITION 條目 }
    function monthStats(buckets, monthKey, opts) {
        opts = opts || {};
        var rateFn = typeof opts.rateFn === 'function' ? opts.rateFn : function () { return 0; };
        var all = (buckets && buckets[monthKey]) || [];

        var status = { SCHEDULED: 0, ATTENDED: 0, LEAVE: 0, NOSHOW: 0 };
        var leaveTypes = { L: 0, SL: 0, TL: 0 };
        var regular = 0, pendingMakeups = 0;
        all.forEach(function (l) {
            if (status[l.status] !== undefined) status[l.status]++;
            if (l.status === 'LEAVE') {
                var t = l.leaveType || 'L';
                leaveTypes[t] = (leaveTypes[t] || 0) + 1;
                if (!l.makeupLessonId) pendingMakeups++;
            }
            if (!l.isMakeup) regular++;
        });
        var held = status.ATTENDED + status.NOSHOW;

        var payable = GACPayroll.payableLessons(buckets, monthKey, { payNoShow: opts.payNoShow });
        var cells = GACSchedule.groupByCell(payable);

        var byTutorMap = {};
        function tutorOf(name) {
            var k = name || '';
            if (!byTutorMap[k]) byTutorMap[k] = { tutor: k, sessions: 0, minutes: 0, lessons: 0, revenue: 0, students: {} };
            return byTutorMap[k];
        }
        var totalMinutes = 0;
        cells.forEach(function (cell) {
            var t = tutorOf(cell.tutor || (cell.lessons[0] && cell.lessons[0].tutor));
            var mins = Number(cell.lessons[0].duration) || 0;
            t.sessions++;
            t.minutes += mins;
            totalMinutes += mins;
        });
        var revenue = 0;
        payable.forEach(function (l) {
            var r = Number(rateFn(l)) || 0;
            revenue += r;
            var t = tutorOf(l.tutor);
            t.lessons++;
            t.revenue += r;
            t.students[l.studentId] = true;
        });
        all.forEach(function (l) { tutorOf(l.tutor); }); // 本月有課但無可計薪堂的導師也列出（0）
        var byTutor = Object.keys(byTutorMap).sort().map(function (k) {
            var t = byTutorMap[k];
            return { tutor: t.tutor, sessions: t.sessions, hours: round1(t.minutes / 60), lessons: t.lessons,
                revenue: t.revenue, students: Object.keys(t.students).length };
        });

        var byProgramMap = {};
        all.forEach(function (l) {
            var p = l.program || '（未填）';
            if (!byProgramMap[p]) byProgramMap[p] = { program: p, lessons: 0, revenue: 0 };
            byProgramMap[p].lessons++;
        });
        payable.forEach(function (l) {
            byProgramMap[l.program || '（未填）'].revenue += Number(rateFn(l)) || 0;
        });
        var byProgram = Object.keys(byProgramMap).map(function (k) { return byProgramMap[k]; })
            .sort(function (a, b) { return b.lessons - a.lessons || a.program.localeCompare(b.program); });

        var tuitionDue = 0, tuitionPaid = 0;
        (opts.tuitionEntries || []).forEach(function (e) {
            tuitionDue += Number(e.amount) || 0;
            // 與 lib/sendlog.js paymentValid 同一規則：有實收金額且有付款方式才算收到
            if (Number(e.paidAmount) > 0 && String(e.payMethod || '') !== '') tuitionPaid += Number(e.paidAmount) || 0;
        });

        return {
            month: monthKey,
            lessons: all.length, regular: regular, makeups: all.length - regular,
            status: status, leaveTypes: leaveTypes,
            held: held,
            attendanceRate: pct(status.ATTENDED, held),   // 已上課 ÷（已上課＋缺席）
            noShowRate: pct(status.NOSHOW, held),
            leaveRate: pct(status.LEAVE, regular),         // 請假 ÷ 常規堂
            pendingMakeups: pendingMakeups,
            unconfirmed: status.SCHEDULED,
            sessions: cells.length,
            tutorHours: round1(totalMinutes / 60),
            revenue: revenue,                                // 已上課課值（可計薪堂 Σ 每堂學費）
            tuitionDue: tuitionDue, tuitionPaid: tuitionPaid, tuitionOutstanding: tuitionDue - tuitionPaid,
            byTutor: byTutor, byProgram: byProgram
        };
    }

    return { monthStats: monthStats, pct: pct };
}));
