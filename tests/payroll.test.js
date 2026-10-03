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

test('E3: 缺席（NOSHOW）照計薪——沒有開關', () => {
    const buckets = { '2026-09': S.generateMonthLessons(student(), '2026-09') };
    LS.markStatus(buckets, 'S001-20260901-2130', 'ATTENDED');
    LS.markStatus(buckets, 'S001-20260908-2130', 'NOSHOW');
    assert.strictEqual(P.payableLessons(buckets, '2026-09').length, 2, '已上課＋缺席');
    assert.strictEqual(P.payableLessons(buckets, '2026-09', { payNoShow: false }).length, 2, '舊參數不再有作用');
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

test('E6: 導師節數——樂理五人小組同時段算 1 節；成員的一對一另計；不同導師分開', () => {
    // 樂理 Grade 5 五人小組（Instructor B，週六 15:00）：S020-T/S021-T（另有一對一）＋ S030–S032（只上小組）
    const theory = (id) => student({
        id: id, type: '5人小組', program: 'Music Theory', level: 'Grade 5',
        duration: 60, tutor: 'Instructor B', weekday: 6, time: '15:00'
    });
    const buckets = { '2026-09': [] };
    ['S020-T', 'S021-T', 'S030', 'S031', 'S032'].forEach(id => {
        buckets['2026-09'].push(...S.generateMonthLessons(theory(id), '2026-09'));
    });
    // S020 自己的一對一（Instructor B 週三）＋另一導師的一對一（Instructor A）
    buckets['2026-09'].push(...S.generateMonthLessons(student({ id: 'S020', tutor: 'Instructor B', weekday: 3, time: '18:00', duration: 60 }), '2026-09'));
    buckets['2026-09'].push(...S.generateMonthLessons(student({ id: 'S001', tutor: 'Instructor A' }), '2026-09'));
    // 首週六（9/5）小組五人全部出席 → B 只算 1 節；S020 一對一 9/2 出席 → B +1；A 的 9/1 出席 → A 1 節
    ['S020-T', 'S021-T', 'S030', 'S031', 'S032'].forEach(id => {
        LS.markStatus(buckets, id + '-20260905-1500', 'ATTENDED');
    });
    LS.markStatus(buckets, 'S020-20260902-1800', 'ATTENDED');
    LS.markStatus(buckets, 'S001-20260901-2130', 'ATTENDED');
    const sessions = P.tutorSessions(buckets, '2026-09');
    assert.deepStrictEqual(sessions, { 'Instructor B': 2, 'Instructor A': 1 },
        '小組 5 人＝1 節；一對一各算 1 節；導師分開統計');
    // 人次照舊分開計（收費按學生）
    const counts = P.countPayableByStudent(buckets, '2026-09');
    assert.strictEqual(counts['S020-T'], 1);
    assert.strictEqual(counts['S030'], 1);
    assert.strictEqual(counts['S020'], 1);
    // 第二週六（9/12）只有 3 人出席 → 仍是同一時段一節：B 節數 +1
    ['S020-T', 'S030', 'S031'].forEach(id => {
        LS.markStatus(buckets, id + '-20260912-1500', 'ATTENDED');
    });
    assert.strictEqual(P.tutorSessions(buckets, '2026-09')['Instructor B'], 3);
});

test('E7: monthPayroll——預期＝已確認＋待確認（請假不計）；按導師與報讀項目分組；小組同時段算一節；NOSHOW 開關', () => {
    const buckets = { '2026-09': S.generateMonthLessons(student(), '2026-09') }; // S001 週二 ×5，Instructor A
    LS.markStatus(buckets, 'S001-20260901-2130', 'ATTENDED');
    LS.markStatus(buckets, 'S001-20260908-2130', 'NOSHOW');
    LS.markStatus(buckets, 'S001-20260915-2130', 'LEAVE', { leaveType: 'L' });
    // 另一位導師的小組課：兩位成員同時段兩堂
    const g = (date, sid, status) => ({
        lessonId: sid + '-G01-' + date, studentId: sid, studentName: sid, tutor: 'Instructor B', date: date, time: '15:00',
        duration: 60, status: status, leaveType: '', isMakeup: false, groupId: 'G01', groupName: '樂理小組',
        program: 'Music Theory', level: 'Grade 5'
    });
    buckets['2026-09'].push(g('2026-09-05', 'S020', 'ATTENDED'), g('2026-09-05', 'S021', 'ATTENDED'),
        g('2026-09-12', 'S020', 'SCHEDULED'), g('2026-09-12', 'S021', 'SCHEDULED'));
    const r = P.monthPayroll(buckets, '2026-09', { rateFn: l => (l.groupId ? 100 : 300) });
    assert.deepStrictEqual(r.tutors.map(t => t.tutor), ['Instructor A', 'Instructor B']);
    const a = r.tutors[0], b = r.tutors[1];
    assert.deepStrictEqual([a.current, a.pending, a.expected], [2, 2, 4], '請假那堂不計；NOSHOW 算已確認');
    assert.deepStrictEqual([a.currentGross, a.expectedGross], [600, 1200]);
    assert.deepStrictEqual([a.currentSessions, a.expectedSessions], [2, 4], '一對一每堂一節');
    assert.strictEqual(a.items.length, 1);
    assert.deepStrictEqual([a.items[0].studentId, a.items[0].rate, a.items[0].current, a.items[0].pending], ['S001', 300, 2, 2]);
    assert.deepStrictEqual([b.current, b.pending, b.expected], [2, 2, 4], '小組按人次');
    assert.deepStrictEqual([b.currentSessions, b.expectedSessions], [1, 2], '小組同時段算一節');
    assert.deepStrictEqual([b.currentGross, b.expectedGross], [200, 400]);
    assert.deepStrictEqual(b.items.map(i => [i.studentId, i.groupName, i.current]), [['S020', '樂理小組', 1], ['S021', '樂理小組', 1]]);
    assert.deepStrictEqual([r.totals.current, r.totals.pending, r.totals.expected], [4, 4, 8]);
    assert.deepStrictEqual([r.totals.currentGross, r.totals.expectedGross], [800, 1600]);
    assert.deepStrictEqual([r.totals.currentSessions, r.totals.expectedSessions], [3, 6]);
    assert.deepStrictEqual(P.monthPayroll(buckets, '2026-01', {}), { tutors: [], totals: { expected: 0, current: 0, pending: 0, expectedGross: 0, currentGross: 0, expectedSessions: 0, currentSessions: 0 } }, '空月份');
});

test('E8: 分段補堂按比例——45 分鐘的課補三段 15 分鐘：已上課兩段＝⅔ 堂、課程費用＝每堂價的 ⅔；三段齊＝1 堂；節數同樣按比例；rateFn 回傳一整堂的價', () => {
    const buckets = { '2026-09': S.generateMonthLessons(student(), '2026-09') };
    LS.markStatus(buckets, 'S001-20260901-2130', 'LEAVE', { leaveType: 'L' });
    ['S001-20260908-2130', 'S001-20260915-2130', 'S001-20260922-2130'].forEach((host, i) => {
        const r = LS.scheduleMakeup(buckets, 'S001-20260901-2130', { date: '2026-09-' + (8 + i * 7), time: '22:15', duration: 15, hostLessonId: host });
        assert.strictEqual(r.ok, true);
    });
    LS.markStatus(buckets, 'S001-20260908-2130', 'ATTENDED');   // 主課已上課 → 那一段跟著已上課
    LS.markStatus(buckets, 'S001-20260915-2130', 'ATTENDED');
    const rateFn = l => { assert.strictEqual(l.baseDuration || l.duration, 45, '查價用一整堂的長度'); return 360; };
    const r = P.monthPayroll(buckets, '2026-09', { rateFn });
    const t = r.tutors[0];
    // 已確認：9/8、9/15 兩堂常規＋兩段 15 分鐘＝2⅔ 堂；待確認：9/22、9/29 常規＋一段＝2⅓ 堂；請假的 9/1 不計
    assert.deepStrictEqual([t.current, t.pending, t.expected], [2.666667, 2.333333, 5]);
    assert.deepStrictEqual([t.currentGross, t.expectedGross], [360 * 2 + 240, 360 * 5]);
    assert.deepStrictEqual([t.currentSessions, t.expectedSessions], [2.666667, 5], '節數也按比例');
    assert.deepStrictEqual([t.items.length, t.items[0].partMinutes], [1, { expected: 45, current: 30 }], '同一個報讀項目一筆；記分段補堂的分鐘數');
    assert.ok(Math.abs(P.countPayableByStudent(buckets, '2026-09').S001 - (2 + 2 / 3)) < 1e-9);
    assert.ok(Math.abs(P.tutorSessions(buckets, '2026-09')['Instructor A'] - (2 + 2 / 3)) < 1e-9);
    assert.deepStrictEqual([P.formatCount(t.current), P.formatCount(t.pending), P.formatCount(t.expected)], ['2⅔', '2⅓', '5']);
});
