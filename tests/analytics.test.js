// 測試組 H：數據分析（lib/analytics.js）——口徑與薪酬頁一致
const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../lib/analytics.js');

const mk = (id, sid, tutor, date, time, status, extra) => Object.assign({
    lessonId: id, studentId: sid, studentName: 'Student ' + sid.slice(1), tutor, program: 'Pop Guitar', level: 'Elementary 初級',
    classType: '一對一', date, time, duration: 45, status, leaveType: status === 'LEAVE' ? 'L' : '',
    isMakeup: false, originLessonId: null, makeupLessonId: null
}, extra || {});
const grp = { classType: '2人小組', duration: 60, program: 'Classical Guitar' };
const buckets = {
    '2026-09': [
        mk('a1', 'S001', 'Instructor A', '2026-09-07', '21:30', 'ATTENDED'),
        mk('a2', 'S001', 'Instructor A', '2026-09-14', '21:30', 'ATTENDED'),
        mk('a3', 'S001', 'Instructor A', '2026-09-21', '21:30', 'LEAVE'),
        mk('a4', 'S001', 'Instructor A', '2026-09-28', '21:30', 'SCHEDULED'),
        // 小組（同時段兩人 = 一節）
        mk('g1', 'S003', 'Instructor A', '2026-09-09', '21:30', 'ATTENDED', grp),
        mk('g2', 'S004', 'Instructor A', '2026-09-09', '21:30', 'ATTENDED', grp),
        mk('g3', 'S003', 'Instructor A', '2026-09-16', '21:30', 'ATTENDED', grp),
        mk('g4', 'S004', 'Instructor A', '2026-09-16', '21:30', 'NOSHOW', grp),
        // 另一位導師：一堂已上＋一堂補堂
        mk('b1', 'S020', 'Instructor B', '2026-09-02', '18:00', 'ATTENDED'),
        mk('b2', 'S020', 'Instructor B', '2026-09-30', '19:00', 'ATTENDED', { isMakeup: true, originLessonId: 'x' })
    ]
};
const rateFn = l => (String(l.classType).indexOf('小組') !== -1 ? 100 : 300);

test('H1: 狀態分佈／出席率／請假率／待補堂／未確認', () => {
    const st = A.monthStats(buckets, '2026-09', { rateFn });
    assert.deepStrictEqual(st.status, { SCHEDULED: 1, ATTENDED: 7, LEAVE: 1, NOSHOW: 1 });
    assert.strictEqual(st.lessons, 10);
    assert.strictEqual(st.regular, 9);
    assert.strictEqual(st.makeups, 1);
    assert.strictEqual(st.held, 8);
    assert.strictEqual(st.attendanceRate, 88, '7/8');
    assert.strictEqual(st.noShowRate, 13, '1/8 四捨五入');
    assert.strictEqual(st.leaveRate, 11, '1/9');
    assert.strictEqual(st.pendingMakeups, 1);
    assert.strictEqual(st.unconfirmed, 1);
    assert.deepStrictEqual(st.leaveTypes, { L: 1, SL: 0, TL: 0 });
});

test('H2: 節數／工時／收入（缺席計薪 vs 不計）', () => {
    const on = A.monthStats(buckets, '2026-09', { rateFn, payNoShow: true });
    // 可計薪：a1 a2 g1 g2 g3 g4 b1 b2 = 8 堂；節：a1 a2 (2) + 9/9 小組 (1) + 9/16 小組 (1) + b1 b2 (2) = 6
    assert.strictEqual(on.sessions, 6);
    assert.strictEqual(on.tutorHours, 5, '45×4 + 60×2 = 300 分鐘');
    assert.strictEqual(on.revenue, 300 * 4 + 100 * 4);
    const off = A.monthStats(buckets, '2026-09', { rateFn, payNoShow: false });
    assert.strictEqual(off.sessions, 6, 'g3 仍在 9/16 那節，節數不變');
    assert.strictEqual(off.revenue, 300 * 4 + 100 * 3);
});

test('H3: 各導師／各課程分項與學費彙總', () => {
    const st = A.monthStats(buckets, '2026-09', { rateFn, tuitionEntries: [
        { amount: 1200, paid: true, paidAmount: 1200, payMethod: '1' }, { amount: 500, paid: true, paidAmount: 200, payMethod: '2' },
        { amount: 300, paid: true, paidAmount: 300, payMethod: '' } // 填了金額但沒選付款方式 → 不算收到
    ] });
    assert.deepStrictEqual(st.byTutor.map(t => t.tutor), ['Instructor A', 'Instructor B']);
    const a = st.byTutor[0], b = st.byTutor[1];
    assert.strictEqual(a.sessions, 4);
    assert.strictEqual(a.hours, 3.5, '45×2 + 60×2');
    assert.strictEqual(a.lessons, 6);
    assert.strictEqual(a.students, 3);
    assert.strictEqual(a.revenue, 600 + 400);
    assert.strictEqual(b.sessions, 2);
    assert.strictEqual(b.revenue, 600);
    assert.deepStrictEqual(st.byProgram.map(p => p.program), ['Pop Guitar', 'Classical Guitar']);
    assert.strictEqual(st.byProgram[1].revenue, 400);
    assert.strictEqual(st.tuitionDue, 2000);
    assert.strictEqual(st.tuitionPaid, 1400);
    assert.strictEqual(st.tuitionOutstanding, 600);
});

test('H4: 空月份不爆、比率為 null', () => {
    const st = A.monthStats({}, '2026-10', {});
    assert.strictEqual(st.lessons, 0);
    assert.strictEqual(st.attendanceRate, null);
    assert.strictEqual(st.sessions, 0);
    assert.deepStrictEqual(st.byTutor, []);
});
