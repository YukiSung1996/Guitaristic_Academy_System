// 測試組 E：工資（規格書 §4-E）
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/schedule.js');
const LS = require('../lib/lessonState.js');
const P = require('../lib/payroll.js');

function student(overrides) {
    return Object.assign({
        id: 'S001', name: 'Student 001', phone: '00000000', email: 'student001@example.com',
        type: '一對一', program: 'Pop Guitar', level: 'Intermediate 中級', duration: 45,
        tutor: 'Instructor A', weekday: 2, time: '21:30',
        effectiveMonth: '', futureWeekday: null, futureTime: ''
    }, overrides || {});
}

test('E1: 5 節課：3 ATTENDED + 1 SCHEDULED（未來）+ 1 LEAVE → 計 3 節', () => {
    const buckets = { '2026-09': S.generateMonthLessons(student(), '2026-09') };
    LS.markStatus(buckets, 'S001-20260901-2130', 'ATTENDED');
    LS.markStatus(buckets, 'S001-20260908-2130', 'ATTENDED');
    LS.markStatus(buckets, 'S001-20260915-2130', 'ATTENDED');
    LS.markStatus(buckets, 'S001-20260922-2130', 'LEAVE', { leaveType: 'L' });
    // 9/29 仍是 SCHEDULED（未來）
    assert.strictEqual(P.payableLessons(buckets, '2026-09').length, 3);
    assert.deepStrictEqual(P.countPayableByStudent(buckets, '2026-09'), { S001: 3 });
});

test('E2: 9 月請假、10 月 5 日補堂 ATTENDED → 9 月不含此節，10 月含（按實際上課日期歸屬）', () => {
    const buckets = { '2026-09': S.generateMonthLessons(student(), '2026-09') };
    LS.markStatus(buckets, 'S001-20260908-2130', 'LEAVE', { leaveType: 'L' });
    const mu = LS.scheduleMakeup(buckets, 'S001-20260908-2130', { date: '2026-10-05', time: '15:00' }).makeup;
    LS.markStatus(buckets, mu.lessonId, 'ATTENDED');
    assert.strictEqual(P.payableLessons(buckets, '2026-09').length, 0, 'LEAVE 不計薪');
    const oct = P.payableLessons(buckets, '2026-10');
    assert.strictEqual(oct.length, 1);
    assert.strictEqual(oct[0].lessonId, mu.lessonId);
});

test('E3: NOSHOW 開關：on（預設）→ 計入；off → 不計', () => {
    const buckets = { '2026-09': S.generateMonthLessons(student(), '2026-09') };
    LS.markStatus(buckets, 'S001-20260901-2130', 'ATTENDED');
    LS.markStatus(buckets, 'S001-20260908-2130', 'NOSHOW');
    assert.strictEqual(P.payableLessons(buckets, '2026-09').length, 2, '預設 NOSHOW 計薪');
    assert.strictEqual(P.payableLessons(buckets, '2026-09', { payNoShow: true }).length, 2);
    assert.strictEqual(P.payableLessons(buckets, '2026-09', { payNoShow: false }).length, 1);
});

test('E4: gross=3000、share=60%、調整 +200/−50 → payout=1950', () => {
    const res = P.computePayout(3000, 60, [
        { name: '獎金', type: 'add', amount: 200 },
        { name: '扣款', type: 'sub', amount: 50 }
    ]);
    assert.strictEqual(res.adjTotal, 150);
    assert.strictEqual(res.payout, 1950);
});

test('E5: 存在「日期已過仍 SCHEDULED」的課 → 警告清單列出', () => {
    const buckets = { '2026-09': S.generateMonthLessons(student(), '2026-09') };
    LS.markStatus(buckets, 'S001-20260901-2130', 'ATTENDED');
    // 今天 2026-09-20：9/8、9/15 已過但仍 SCHEDULED
    const expired = P.expiredScheduled(buckets, '2026-09', '2026-09-20');
    assert.deepStrictEqual(expired.map(l => l.date), ['2026-09-08', '2026-09-15']);
});
