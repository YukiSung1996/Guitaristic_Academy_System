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
