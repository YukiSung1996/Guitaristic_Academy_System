// 測試組 A：課表生成與 merge（規格書 §4-A）
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/schedule.js');

function student(overrides) {
    return Object.assign({
        id: 'S001', name: 'Student 001', phone: '00000000', email: 'student001@example.com',
        type: '一對一', program: 'Pop Guitar', level: 'Intermediate 中級', duration: 45,
        tutor: 'Instructor A', weekday: 2, time: '21:30',
        effectiveMonth: '', futureWeekday: null, futureTime: ''
    }, overrides || {});
}

test('A1: 2026-09 週二 → 5 節（1/8/15/22/29），lessonNum 1..5，totalRegular=5', () => {
    const lessons = S.generateMonthLessons(student(), '2026-09');
    assert.deepStrictEqual(lessons.map(l => l.date),
        ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);
    assert.deepStrictEqual(lessons.map(l => l.lessonNum), [1, 2, 3, 4, 5]);
    assert.ok(lessons.every(l => l.totalRegular === 5));
    assert.ok(lessons.every(l => l.status === 'SCHEDULED'));
    assert.strictEqual(lessons[0].lessonId, 'S001-20260901-2130');
    assert.strictEqual(lessons[0].monthRef, '09/2026');
    assert.strictEqual(S.lessonTitle(lessons[0]), 'S001 Student 001([1/5] 09/2026)');
});

test('A2: 同參數生成兩次 → lessonId 逐一相同（確定性）', () => {
    const a = S.generateMonthLessons(student(), '2026-09');
    const b = S.generateMonthLessons(student(), '2026-09');
    assert.deepStrictEqual(a.map(l => l.lessonId), b.map(l => l.lessonId));
});

test('A3: 第 2 節標 LEAVE 後再次生成同月 → 該節仍是 LEAVE，其餘不變，無重複課', () => {
    const s = student();
    const existing = S.generateMonthLessons(s, '2026-09');
    existing[1].status = 'LEAVE';
    existing[1].leaveType = 'SL';
    const regenerated = S.generateMonthLessons(s, '2026-09');
    const res = S.mergeMonthLessons(existing, regenerated,
        { selectedStudentIds: [s.id], allStudentIds: [s.id] });
    assert.strictEqual(res.lessons.length, 5);
    assert.strictEqual(res.added.length, 0);
    assert.strictEqual(res.removed.length, 0);
    assert.strictEqual(res.conflicts.length, 0);
    const leave = res.lessons.find(l => l.date === '2026-09-08');
    assert.strictEqual(leave.status, 'LEAVE');
    assert.strictEqual(leave.leaveType, 'SL');
    const ids = res.lessons.map(l => l.lessonId);
    assert.strictEqual(new Set(ids).size, ids.length, '不應有重複 lessonId');
});

test('A4: effectiveMonth=2026-10 改到週四 → 9 月仍週二、10 月變週四；9 月既有狀態不受影響', () => {
    const s = student({ effectiveMonth: '2026-10', futureWeekday: 4, futureTime: '18:00' });
    const sep = S.generateMonthLessons(s, '2026-09');
    const oct = S.generateMonthLessons(s, '2026-10');
    assert.ok(sep.every(l => new Date(l.date + 'T00:00:00Z').getUTCDay() === 2), '9 月應全是週二');
    assert.ok(oct.every(l => new Date(l.date + 'T00:00:00Z').getUTCDay() === 4), '10 月應全是週四');
    assert.ok(oct.every(l => l.time === '18:00'));
    // 9 月已有狀態，重生成 9 月不受 10 月變更影響
    sep[0].status = 'ATTENDED';
    const res = S.mergeMonthLessons(sep, S.generateMonthLessons(s, '2026-09'),
        { selectedStudentIds: [s.id], allStudentIds: [s.id] });
    assert.strictEqual(res.lessons.find(l => l.lessonId === sep[0].lessonId).status, 'ATTENDED');
    assert.strictEqual(res.removed.length, 0);
});

test('A5: 學生被移除後重新生成 → SCHEDULED 課被刪除；ATTENDED/LEAVE 保留並列入衝突報告', () => {
    const s1 = student();
    const s2 = student({ id: 'S002', name: 'Student 002', weekday: 3, time: '12:30' });
    const existing = S.generateMonthLessons(s1, '2026-09').concat(S.generateMonthLessons(s2, '2026-09'));
    // s2 的第一節已出席、第二節已請假
    const s2Lessons = existing.filter(l => l.studentId === 'S002');
    s2Lessons[0].status = 'ATTENDED';
    s2Lessons[1].status = 'LEAVE';
    // s2 已從資料庫移除：generated 只有 s1，allStudentIds 也只剩 s1
    const res = S.mergeMonthLessons(existing, S.generateMonthLessons(s1, '2026-09'),
        { selectedStudentIds: ['S001'], allStudentIds: ['S001'] });
    assert.ok(res.removed.every(l => l.studentId === 'S002' && l.status === 'SCHEDULED'));
    assert.strictEqual(res.removed.length, s2Lessons.length - 2);
    assert.strictEqual(res.conflicts.length, 2);
    const keptS2 = res.lessons.filter(l => l.studentId === 'S002');
    assert.strictEqual(keptS2.length, 2, '有狀態的課應保留');
});

test('A5b: 只勾選部分學生生成 → 未勾選學生的課完全不動（不誤刪）', () => {
    const s1 = student();
    const s2 = student({ id: 'S002', name: 'Student 002', weekday: 3, time: '12:30' });
    const existing = S.generateMonthLessons(s1, '2026-09').concat(S.generateMonthLessons(s2, '2026-09'));
    // 只勾選 s1；s2 仍在資料庫中
    const res = S.mergeMonthLessons(existing, S.generateMonthLessons(s1, '2026-09'),
        { selectedStudentIds: ['S001'], allStudentIds: ['S001', 'S002'] });
    assert.strictEqual(res.removed.length, 0);
    assert.strictEqual(res.lessons.filter(l => l.studentId === 'S002').length,
        existing.filter(l => l.studentId === 'S002').length);
});

test('A6: 撞堂檢測：重疊報撞、不同導師不報、同 2 人小組不報、LEAVE 不參與', () => {
    const mk = (id, tutor, time, duration, overrides) => Object.assign({
        lessonId: id, studentId: id.split('-')[0], tutor: tutor, date: '2026-09-02',
        time: time, duration: duration, status: 'SCHEDULED',
        classType: '一對一', program: 'Pop Guitar'
    }, overrides || {});

    // 同導師 21:30–22:15 vs 22:00–22:45 → 雙方撞
    let ids = S.detectClashes([mk('A-1', 'Instructor A', '21:30', 45), mk('B-1', 'Instructor A', '22:00', 45)]);
    assert.deepStrictEqual([...ids].sort(), ['A-1', 'B-1']);

    // 不同導師同時段 → 不報
    ids = S.detectClashes([mk('A-1', 'Instructor A', '21:30', 45), mk('B-1', 'Instructor B', '21:30', 45)]);
    assert.strictEqual(ids.size, 0);

    // S003/S004：同 2 人小組同 program 同時段 → 豁免不報
    ids = S.detectClashes([
        mk('S003-1', 'Instructor A', '21:30', 60, { classType: '2人小組', program: 'Pop Guitar' }),
        mk('S004-1', 'Instructor A', '21:30', 60, { classType: '2人小組', program: 'Pop Guitar' })
    ]);
    assert.strictEqual(ids.size, 0, '同組小組課不應報撞');

    // 但同時段的兩個「不同」小組（program 不同）仍要報撞
    ids = S.detectClashes([
        mk('S003-1', 'Instructor A', '21:30', 60, { classType: '2人小組', program: 'Pop Guitar' }),
        mk('S099-1', 'Instructor A', '21:30', 60, { classType: '2人小組', program: 'Classical Guitar' })
    ]);
    assert.strictEqual(ids.size, 2);

    // LEAVE 課不參與撞堂
    ids = S.detectClashes([
        mk('A-1', 'Instructor A', '21:30', 45, { status: 'LEAVE' }),
        mk('B-1', 'Instructor A', '21:30', 45)
    ]);
    assert.strictEqual(ids.size, 0);
});

test('A7: 月份首日即目標 weekday → 1 號被包含；2026-02（28 天）每個 weekday 恰 4 次', () => {
    // 2026-02-01 是星期日
    const sun = S.monthDatesForWeekday('2026-02', 0);
    assert.strictEqual(sun[0], '2026-02-01');
    assert.strictEqual(sun.length, 4);
    for (let wd = 0; wd < 7; wd++) {
        assert.strictEqual(S.monthDatesForWeekday('2026-02', wd).length, 4);
    }
    const feb = S.generateMonthLessons(student({ weekday: 0 }), '2026-02');
    assert.strictEqual(feb.length, 4);
    assert.ok(feb.every(l => l.totalRegular === 4));
});

test('補堂 lessonId：帶 -MU- 與最初原課的日期時間，確定性生成', () => {
    const id = S.makeMakeupLessonId('S001', '2026-10-02', '15:00', 'S001-20260915-2130');
    assert.strictEqual(id, 'S001-20261002-1500-MU-20260915-2130');
});

test('A9: 課節分組 groupByCell——小組同時段合成一節、一對一各自一節、依日期時間排序', () => {
    const theory = (id) => student({ id: id, type: '5人小組', program: 'Music Theory', level: 'Grade 5', duration: 60, tutor: 'Instructor B', weekday: 6, time: '15:00' });
    const lessons = []
        .concat(S.generateMonthLessons(theory('S030'), '2026-09'))
        .concat(S.generateMonthLessons(theory('S031'), '2026-09'))
        .concat(S.generateMonthLessons(theory('S032'), '2026-09'))
        .concat(S.generateMonthLessons(student({ id: 'S001' }), '2026-09'));   // 週二一對一 ×5
    const cells = S.groupByCell(lessons);
    // 9 月週六 4 天 → 4 個小組節；週二 5 堂一對一 → 5 節；共 9
    assert.strictEqual(cells.length, 9);
    const groupCells = cells.filter(c => c.isGroup);
    assert.strictEqual(groupCells.length, 4);
    assert.ok(groupCells.every(c => c.lessons.length === 3), '每個小組節 3 位成員');
    assert.deepStrictEqual(groupCells[0].lessons.map(l => l.studentId), ['S030', 'S031', 'S032'], '成員依 studentId 排序');
    assert.strictEqual(S.cellKey(groupCells[0].lessons[0]), S.cellKey(groupCells[0].lessons[1]), '同節 key 相同');
    assert.strictEqual(S.cellKey(lessons[lessons.length - 1]), lessons[lessons.length - 1].lessonId, '一對一 key = lessonId');
    // 排序：9/1（週二）在 9/5（週六）之前
    assert.strictEqual(cells[0].date, '2026-09-01');
    assert.strictEqual(cells[1].date, '2026-09-05');
});

test('A8: previewTimeChange — 對已生成月份：同導師重疊報撞、LEAVE 不佔時段、本人舊課不自擋', () => {
    const s1 = student(); // S001 週二 21:30
    const s2 = student({ id: 'S002', name: 'Student 002', weekday: 1, time: '21:30' }); // 週一 21:30
    const existing = S.generateMonthLessons(s1, '2026-09').concat(S.generateMonthLessons(s2, '2026-09'));
    // S002 的 9/14（週一）請假 → 該日不佔時段
    existing.find(l => l.lessonId === 'S002-20260914-2130').status = 'LEAVE';
    // S001 想改到週一 21:30 → 與 S002 撞（除請假的 9/14 外）
    const rows = S.previewTimeChange(s1, [s2], existing, '2026-09', { weekday: 1, time: '21:30', duration: 45 });
    assert.deepStrictEqual(rows.map(r => r.date),
        ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    assert.ok(rows[0].clashes.length === 1 && rows[0].clashes[0].studentId === 'S002');
    assert.strictEqual(rows[1].clashes.length, 0, 'LEAVE 課不佔時段');
    assert.ok(rows[2].clashes.length === 1 && rows[3].clashes.length === 1);
    // 本人週二舊課不會自擋：改回自己原本的週二 21:30 應全綠
    const self = S.previewTimeChange(s1, [s2], existing, '2026-09', { weekday: 2, time: '21:30', duration: 45 });
    assert.ok(self.every(r => r.clashes.length === 0), '本人的非補堂課應排除在佔用池外');
});

test('A8b: previewTimeChange — 未生成月份用其他學生常規時間模擬；不同導師不報；同組豁免', () => {
    const s1 = student(); // Instructor A 週二 21:30
    const s2 = student({ id: 'S002', name: 'Student 002', weekday: 4, time: '21:30' });
    const s3 = student({ id: 'S003', tutor: 'Instructor B', weekday: 4, time: '21:30' });
    // 該月完全未生成（existing 空）：s2 由常規時間模擬 → 週四 21:30 報撞；s3 不同導師不報
    const rows = S.previewTimeChange(s1, [s2, s3], [], '2026-10', { weekday: 4, time: '21:30', duration: 45 });
    assert.ok(rows.length > 0 && rows.every(r => r.clashes.length === 1));
    assert.ok(rows.every(r => r.clashes[0].studentId === 'S002'));
    // 同 2 人小組同 program 同時段 → 豁免
    const g1 = student({ id: 'S010', type: '2人小組', program: 'Pop Guitar', duration: 60 });
    const g2 = student({ id: 'S011', type: '2人小組', program: 'Pop Guitar', duration: 60, weekday: 3, time: '19:00' });
    const gRows = S.previewTimeChange(g1, [g2], [], '2026-10', { weekday: 3, time: '19:00', duration: 60 });
    assert.ok(gRows.every(r => r.clashes.length === 0), '同組小組課同時段應豁免');
});
