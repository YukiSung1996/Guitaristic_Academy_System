// 測試組 B：狀態機與補堂鏈（規格書 §4-B）
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/schedule.js');
const LS = require('../lib/lessonState.js');

function student(overrides) {
    return Object.assign({
        id: 'S001', name: 'Student 001', phone: '00000000', email: 'student001@example.com',
        type: '一對一', program: 'Pop Guitar', level: 'Intermediate 中級', duration: 45,
        tutor: 'Instructor A', weekday: 2, time: '21:30',
        effectiveMonth: '', futureWeekday: null, futureTime: ''
    }, overrides || {});
}

// 建立 9 月分桶：S001 五節週二課
function makeBuckets() {
    return { '2026-09': S.generateMonthLessons(student(), '2026-09') };
}
const L2 = 'S001-20260908-2130'; // 第 2 節（9/8）

test('B1: SCHEDULED→LEAVE（不填補堂）→ 成功，makeupLessonId=null，出現在待補池', () => {
    const buckets = makeBuckets();
    const res = LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.lesson.status, 'LEAVE');
    assert.strictEqual(res.lesson.leaveType, 'L');
    assert.strictEqual(res.lesson.makeupLessonId, null);
    const pool = LS.pendingMakeups(buckets, '2026-09-15');
    assert.strictEqual(pool.length, 1);
    assert.strictEqual(pool[0].lesson.lessonId, L2);
});

test('B2: 待補池跨月：9 月的假在 10 月仍在池中，等待天數正確，按等待天數降序', () => {
    const buckets = makeBuckets();
    buckets['2026-10'] = S.generateMonthLessons(student({ id: 'S002', name: 'Student 002' }), '2026-10');
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'SL' });
    LS.markStatus(buckets, 'S002-20261006-2130', 'LEAVE', { leaveType: 'L' });
    const pool = LS.pendingMakeups(buckets, '2026-10-15');
    assert.strictEqual(pool.length, 2);
    assert.strictEqual(pool[0].lesson.lessonId, L2, '等最久的排最前');
    assert.strictEqual(pool[0].waitingDays, 37); // 2026-09-08 → 2026-10-15
    assert.strictEqual(pool[1].waitingDays, 9);  // 2026-10-06 → 2026-10-15
});

test('B3: 排補堂 → 新課 isMakeup、originLessonId 正確；原課指向新課；從池中消失；入正確月份分桶', () => {
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    const res = LS.scheduleMakeup(buckets, L2, { date: '2026-10-02', time: '15:00' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.makeup.isMakeup, true);
    assert.strictEqual(res.makeup.status, 'SCHEDULED');
    assert.strictEqual(res.makeup.originLessonId, L2);
    assert.strictEqual(res.makeup.monthRef, '09/2026', '補堂標題沿用原課月份');
    const origin = LS.findLesson(buckets, L2).lesson;
    assert.strictEqual(origin.makeupLessonId, res.makeup.lessonId);
    assert.strictEqual(LS.pendingMakeups(buckets, '2026-10-15').length, 0);
    assert.ok(buckets['2026-10'].some(l => l.lessonId === res.makeup.lessonId), '補堂應存入 10 月分桶');
});

test('B4: 重複排補堂被攔截並附已有補堂資訊；「取消並重排」→ 舊補堂刪除、鏈更新', () => {
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    const first = LS.scheduleMakeup(buckets, L2, { date: '2026-10-02', time: '15:00' });
    // 不帶 replaceExisting → 攔截
    const dup = LS.scheduleMakeup(buckets, L2, { date: '2026-10-09', time: '16:00' });
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.code, 'DUPLICATE_MAKEUP');
    assert.strictEqual(dup.existingMakeup.date, '2026-10-02');
    // 取消並重排
    const replaced = LS.scheduleMakeup(buckets, L2, { date: '2026-10-09', time: '16:00' }, { replaceExisting: true });
    assert.strictEqual(replaced.ok, true);
    assert.strictEqual(LS.findLesson(buckets, first.makeup.lessonId), null, '舊補堂應被刪除');
    assert.strictEqual(LS.findLesson(buckets, L2).lesson.makeupLessonId, replaced.makeup.lessonId);
    // 已出席的舊補堂不可被重排取代
    LS.markStatus(buckets, replaced.makeup.lessonId, 'ATTENDED');
    const blocked = LS.scheduleMakeup(buckets, L2, { date: '2026-10-16', time: '16:00' }, { replaceExisting: true });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.code, 'MAKEUP_NOT_SCHEDULED');
});

test('B5: 補堂課再 LEAVE → 回池；再排補堂 → originLessonId 仍指向最初原課', () => {
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    const mu1 = LS.scheduleMakeup(buckets, L2, { date: '2026-10-02', time: '15:00' }).makeup;
    LS.markStatus(buckets, mu1.lessonId, 'LEAVE', { leaveType: 'SL' });
    const pool = LS.pendingMakeups(buckets, '2026-10-15');
    assert.strictEqual(pool.length, 1);
    assert.strictEqual(pool[0].lesson.lessonId, mu1.lessonId, '請假的補堂課本身回池');
    const mu2 = LS.scheduleMakeup(buckets, mu1.lessonId, { date: '2026-10-20', time: '15:00' }).makeup;
    assert.strictEqual(mu2.originLessonId, L2, '鏈式補堂 originLessonId 一直指向最初原課');
    assert.strictEqual(LS.findLesson(buckets, mu1.lessonId).lesson.makeupLessonId, mu2.lessonId);
});

test('B6: 撤銷 ATTENDED → 回 SCHEDULED；撤銷已有補堂的 LEAVE → 被要求先處理補堂', () => {
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'ATTENDED');
    const undo = LS.markStatus(buckets, L2, 'SCHEDULED');
    assert.strictEqual(undo.ok, true);
    assert.strictEqual(undo.lesson.status, 'SCHEDULED');
    // LEAVE + 補堂 → 撤銷被攔截
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    const mu = LS.scheduleMakeup(buckets, L2, { date: '2026-10-02', time: '15:00' }).makeup;
    const blocked = LS.markStatus(buckets, L2, 'SCHEDULED');
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.code, 'HAS_MAKEUP');
    assert.strictEqual(blocked.makeupLessonId, mu.lessonId);
    // 取消補堂後可撤銷
    const cancelled = LS.cancelMakeup(buckets, mu.lessonId);
    assert.strictEqual(cancelled.ok, true);
    assert.strictEqual(LS.findLesson(buckets, L2).lesson.makeupLessonId, null, '取消後回池');
    assert.strictEqual(LS.markStatus(buckets, L2, 'SCHEDULED').ok, true);
});

test('B7: 非法轉換（ATTENDED→LEAVE 直轉）→ 拒絕', () => {
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'ATTENDED');
    const res = LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'ILLEGAL_TRANSITION');
    assert.strictEqual(LS.findLesson(buckets, L2).lesson.status, 'ATTENDED', '狀態不應被改動');
});

test('B8: JSON 序列化重載（模擬刷新頁面）→ 狀態與鏈接完好，鏈仍可繼續操作', () => {
    let buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    const mu1 = LS.scheduleMakeup(buckets, L2, { date: '2026-10-02', time: '15:00' }).makeup;
    LS.markStatus(buckets, 'S001-20260901-2130', 'ATTENDED');
    // 模擬 localStorage round-trip
    buckets = JSON.parse(JSON.stringify(buckets));
    assert.strictEqual(LS.findLesson(buckets, L2).lesson.status, 'LEAVE');
    assert.strictEqual(LS.findLesson(buckets, L2).lesson.makeupLessonId, mu1.lessonId);
    assert.strictEqual(LS.findLesson(buckets, mu1.lessonId).lesson.originLessonId, L2);
    assert.strictEqual(LS.findLesson(buckets, 'S001-20260901-2130').lesson.status, 'ATTENDED');
    // 重載後鏈式操作仍正常（引用全是 ID，不會斷鏈）
    LS.markStatus(buckets, mu1.lessonId, 'LEAVE', { leaveType: 'TL' });
    const mu2 = LS.scheduleMakeup(buckets, mu1.lessonId, { date: '2026-10-20', time: '15:00' });
    assert.strictEqual(mu2.ok, true);
    assert.strictEqual(mu2.makeup.originLessonId, L2);
});

test('批量確認出席：只確認範圍內且不晚於 maxDate 的 SCHEDULED 課', () => {
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    const res = LS.confirmScheduledInRange(buckets, '2026-09-01', '2026-09-30', { maxDate: '2026-09-15' });
    // 9/1、9/15 可確認；9/8 是 LEAVE；9/22、9/29 晚於 maxDate
    assert.strictEqual(res.count, 2);
    assert.strictEqual(LS.findLesson(buckets, 'S001-20260901-2130').lesson.status, 'ATTENDED');
    assert.strictEqual(LS.findLesson(buckets, 'S001-20260915-2130').lesson.status, 'ATTENDED');
    assert.strictEqual(LS.findLesson(buckets, 'S001-20260922-2130').lesson.status, 'SCHEDULED');
    assert.strictEqual(LS.findLesson(buckets, L2).lesson.status, 'LEAVE');
});

// ---- 小組一致性（groupSiblings / detectGroupInconsistencies）----
// 小組桶：S003/S004 為 2 人小組（同 classType/program/時間/時長），週三 21:30；另有個別課 S001 週二
function makeGroupBuckets() {
    const g3 = student({ id: 'S003', name: 'Student 003', type: '2人小組', weekday: 3, duration: 60 });
    const g4 = student({ id: 'S004', name: 'Student 004', type: '2人小組', weekday: 3, duration: 60 });
    const lessons = S.generateMonthLessons(g3, '2026-09')
        .concat(S.generateMonthLessons(g4, '2026-09'))
        .concat(S.generateMonthLessons(student(), '2026-09'));
    lessons.forEach(function (l) { l.classType = l.studentId === 'S001' ? '一對一' : '2人小組'; });
    return { '2026-09': lessons };
}
const G3 = 'S003-20260916-2130'; // 9/16 週三
const G4 = 'S004-20260916-2130';

test('小組: groupSiblings 找到同組同日成員，排除不同日、非小組、同學生', () => {
    const buckets = makeGroupBuckets();
    const sibs = LS.groupSiblings(buckets, G3);
    assert.strictEqual(sibs.length, 1);
    assert.strictEqual(sibs[0].lessonId, G4);
    // 個別課無同組
    assert.strictEqual(LS.groupSiblings(buckets, 'S001-20260915-2130').length, 0);
    // 補堂課的 sibling 以補堂時段計：兩人補堂排同一時段 → 互為 sibling
    LS.markStatus(buckets, G3, 'LEAVE', { leaveType: 'TL' });
    LS.markStatus(buckets, G4, 'LEAVE', { leaveType: 'TL' });
    const m3 = LS.scheduleMakeup(buckets, G3, { date: '2026-10-14', time: '19:00' }).makeup;
    const m4 = LS.scheduleMakeup(buckets, G4, { date: '2026-10-14', time: '19:00' }).makeup;
    const mkSibs = LS.groupSiblings(buckets, m3.lessonId);
    assert.strictEqual(mkSibs.length, 1);
    assert.strictEqual(mkSibs[0].lessonId, m4.lessonId);
});

test('小組: 全部排定或全組 TL（未排/同時段補堂）→ 無告警', () => {
    const buckets = makeGroupBuckets();
    assert.strictEqual(LS.detectGroupInconsistencies(buckets, '2026-09').length, 0, '全 SCHEDULED');
    LS.markStatus(buckets, G3, 'LEAVE', { leaveType: 'TL' });
    LS.markStatus(buckets, G4, 'LEAVE', { leaveType: 'TL' });
    assert.strictEqual(LS.detectGroupInconsistencies(buckets, '2026-09').length, 0, '全組 TL 未排補堂');
    LS.scheduleMakeup(buckets, G3, { date: '2026-10-14', time: '19:00' });
    assert.strictEqual(LS.detectGroupInconsistencies(buckets, '2026-09').length, 0, '僅一人已排補堂（另一人仍在池中）');
    LS.scheduleMakeup(buckets, G4, { date: '2026-10-14', time: '19:00' });
    assert.strictEqual(LS.detectGroupInconsistencies(buckets, '2026-09').length, 0, '補堂同一時段');
});

test('小組: TL_PARTIAL —— 一人 TL、另一人未請假 → 告警', () => {
    const buckets = makeGroupBuckets();
    LS.markStatus(buckets, G3, 'LEAVE', { leaveType: 'TL' });
    const issues = LS.detectGroupInconsistencies(buckets, '2026-09');
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].type, 'TL_PARTIAL');
    assert.strictEqual(issues[0].date, '2026-09-16');
    assert.strictEqual(issues[0].tlLessons[0].studentId, 'S003');
    assert.strictEqual(issues[0].others[0].studentId, 'S004');
});

test('小組: MAKEUP_DIVERGED —— 全組 TL 但補堂時段不同 → 告警；個人假不告警', () => {
    const buckets = makeGroupBuckets();
    LS.markStatus(buckets, G3, 'LEAVE', { leaveType: 'TL' });
    LS.markStatus(buckets, G4, 'LEAVE', { leaveType: 'TL' });
    LS.scheduleMakeup(buckets, G3, { date: '2026-10-14', time: '19:00' });
    LS.scheduleMakeup(buckets, G4, { date: '2026-10-21', time: '20:00' });
    const issues = LS.detectGroupInconsistencies(buckets, '2026-09');
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].type, 'MAKEUP_DIVERGED');
    assert.strictEqual(issues[0].entries.length, 2);
    assert.deepStrictEqual(
        issues[0].entries.map(e => e.makeup.date).sort(),
        ['2026-10-14', '2026-10-21']
    );

    // 對照組：同樣的發散但假別是個人假（SL）→ 屬正常，不告警
    const b2 = makeGroupBuckets();
    LS.markStatus(b2, G3, 'LEAVE', { leaveType: 'SL' });
    LS.markStatus(b2, G4, 'LEAVE', { leaveType: 'SL' });
    LS.scheduleMakeup(b2, G3, { date: '2026-10-14', time: '19:00' });
    LS.scheduleMakeup(b2, G4, { date: '2026-10-21', time: '20:00' });
    assert.strictEqual(LS.detectGroupInconsistencies(b2, '2026-09').length, 0);
});

// ---- 手動模式 forceStatus ----
test('手動: forceStatus 跳過轉換矩陣（ATTENDED→LEAVE 直改）；無效狀態被拒', () => {
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'ATTENDED');
    // 正常狀態機不允許 ATTENDED → LEAVE
    assert.strictEqual(LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'SL' }).code, 'ILLEGAL_TRANSITION');
    const res = LS.forceStatus(buckets, L2, 'LEAVE', { leaveType: 'SL' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.lesson.status, 'LEAVE');
    assert.strictEqual(res.lesson.leaveType, 'SL');
    assert.strictEqual(LS.forceStatus(buckets, L2, 'CANCELLED').code, 'INVALID_STATUS');
});

test('手動: forceStatus 仍保護補堂鏈——已排補堂的請假不可直改他態；改假別則保留補堂', () => {
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    const mu = LS.scheduleMakeup(buckets, L2, { date: '2026-10-02', time: '15:00' }).makeup;
    assert.strictEqual(LS.forceStatus(buckets, L2, 'ATTENDED').code, 'HAS_MAKEUP');
    assert.strictEqual(LS.forceStatus(buckets, L2, 'SCHEDULED').code, 'HAS_MAKEUP');
    // 只改假別（LEAVE→LEAVE）合法，補堂鏈不動
    const res = LS.forceStatus(buckets, L2, 'LEAVE', { leaveType: 'TL' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.lesson.leaveType, 'TL');
    assert.strictEqual(res.lesson.makeupLessonId, mu.lessonId);
});

test('對帳: moveLessonDateTime 同月改時間——id 不變、桶不動', () => {
    const buckets = makeBuckets();
    const res = LS.moveLessonDateTime(buckets, L2, '2026-09-09', '19:00');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.lesson.date, '2026-09-09');
    assert.strictEqual(res.lesson.time, '19:00');
    assert.strictEqual(res.lesson.lessonId, L2, 'lessonId 是不變主鍵');
    assert.strictEqual(res.fromMonthKey, res.toMonthKey);
    assert.strictEqual(buckets['2026-09'].length, 5);
});

test('對帳: moveLessonDateTime 跨月移桶——鏈接與查找完好，空桶刪除', () => {
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    const mu = LS.scheduleMakeup(buckets, L2, { date: '2026-10-02', time: '15:00' }).makeup;
    // 把補堂從 10/2 挪到 11/1（跨月）
    const res = LS.moveLessonDateTime(buckets, mu.lessonId, '2026-11-01', '10:00');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.fromMonthKey, '2026-10');
    assert.strictEqual(res.toMonthKey, '2026-11');
    assert.strictEqual(buckets['2026-10'], undefined, '搬空的月桶被刪除');
    const found = LS.findLesson(buckets, mu.lessonId);
    assert.strictEqual(found.monthKey, '2026-11');
    assert.strictEqual(found.lesson.date, '2026-11-01');
    assert.strictEqual(LS.findLesson(buckets, L2).lesson.makeupLessonId, mu.lessonId, '原課仍指向同一補堂 id');
    assert.strictEqual(LS.moveLessonDateTime(buckets, 'NOPE', '2026-11-01', '10:00').code, 'NOT_FOUND');
});

test('清空整月 clearMonth：整桶刪除、跨月補堂級聯、鏈式補堂掃盡、倖存請假解鏈回池', () => {
    // 佈局：9 月 S001 五節；其中 9/8 請假 → 補堂排 10/6；10/6 補堂又請假 → 再補 11/3（鏈式）
    const buckets = makeBuckets();
    LS.markStatus(buckets, L2, 'LEAVE', { leaveType: 'L' });
    const m1 = LS.scheduleMakeup(buckets, L2, { date: '2026-10-06', time: '19:00' });
    assert.strictEqual(m1.ok, true);
    LS.markStatus(buckets, m1.makeup.lessonId, 'LEAVE', { leaveType: 'SL' });
    const m2 = LS.scheduleMakeup(buckets, m1.makeup.lessonId, { date: '2026-11-03', time: '19:00' });
    assert.strictEqual(m2.ok, true);
    // 另有：8 月 S002 請假 → 補堂排在 9 月（清 9 月時該補堂被刪，8 月原課應解鏈回池）
    buckets['2026-08'] = S.generateMonthLessons(student({ id: 'S002', name: 'Student 002' }), '2026-08');
    LS.markStatus(buckets, 'S002-20260804-2130', 'LEAVE', { leaveType: 'L' });
    const mIn = LS.scheduleMakeup(buckets, 'S002-20260804-2130', { date: '2026-09-10', time: '20:00' });
    assert.strictEqual(mIn.ok, true);
    // 不相干：12 月 S003 兩節，不應受影響
    buckets['2026-12'] = S.generateMonthLessons(student({ id: 'S003', name: 'Student 003' }), '2026-12').slice(0, 2);
    const decCount = buckets['2026-12'].length;

    const res = LS.clearMonth(buckets, '2026-09');
    // 刪除：9 月整桶（5 常規 + 1 入月補堂）＋ 10 月 m1 ＋ 11 月 m2 = 8
    assert.strictEqual(res.removed.length, 5 + 1 + 2);
    assert.strictEqual(buckets['2026-09'], undefined, '9 月桶應刪除');
    assert.strictEqual(buckets['2026-10'], undefined, '10 月只剩的鏈式補堂應級聯刪除');
    assert.strictEqual(buckets['2026-11'], undefined, '11 月鏈式補堂應級聯刪除');
    // 8 月原課解鏈回池
    const aug = LS.findLesson(buckets, 'S002-20260804-2130');
    assert.strictEqual(aug.lesson.makeupLessonId, null);
    assert.strictEqual(aug.lesson.status, 'LEAVE', '請假狀態保留（回到待補池）');
    assert.strictEqual(res.unlinked.length, 1);
    assert.strictEqual(LS.pendingMakeups(buckets, '2026-12-01')[0].lesson.lessonId, 'S002-20260804-2130');
    // 12 月不受影響
    assert.strictEqual(buckets['2026-12'].length, decCount);
});
