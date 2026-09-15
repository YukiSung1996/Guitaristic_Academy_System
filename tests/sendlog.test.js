// 測試組 C（邏輯部分）：發送中心紀錄（規格書 §4-C 的可單元測試部分）
const { test } = require('node:test');
const assert = require('node:assert');
const SL = require('../lib/sendlog.js');

const params = () => ({
    studentId: 'S001', studentName: 'Student 001', phone: '00000000',
    monthKey: '2026-09', amount: 1500, count: 5,
    dates: ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']
});

test('C1: 學費條目建立（5 節 × 300 = 1500）；key 幂等；手改金額後 upsert 不覆蓋', () => {
    const log = {};
    const e = SL.upsertTuition(log, params());
    assert.strictEqual(e.key, 'TUITION:S001:2026-09');
    assert.strictEqual(e.amount, 1500);
    assert.strictEqual(e.status, 'TODO');
    // 再次 upsert（重生成課表）→ 不產生重複條目
    SL.upsertTuition(log, params());
    assert.strictEqual(Object.keys(log).length, 1);
    // 手改金額 → 之後 upsert 保留手改值，但堂數仍會刷新
    SL.setAmount(log, e.key, 1400);
    const again = SL.upsertTuition(log, Object.assign(params(), { amount: 1800, count: 6 }));
    assert.strictEqual(again.amount, 1400, '手改金額不被自動覆蓋');
    assert.strictEqual(again.count, 6, '堂數仍刷新');
});

test('C3/C4/C5: 標記已發（wa_link / manual）與移回待發', () => {
    const log = {};
    const e = SL.upsertTuition(log, params());
    SL.markSent(log, e.key, 'wa_link', '2026-09-15T10:00:00.000Z');
    assert.strictEqual(e.status, 'SENT');
    assert.strictEqual(e.method, 'wa_link');
    assert.strictEqual(e.sentAt, '2026-09-15T10:00:00.000Z');
    // SENT 後 upsert 絕不改動
    SL.upsertTuition(log, Object.assign(params(), { amount: 9999 }));
    assert.strictEqual(e.amount, 1500);
    // 移回待發 → 可重發
    SL.markUnsent(log, e.key);
    assert.strictEqual(e.status, 'TODO');
    assert.strictEqual(e.sentAt, null);
    assert.strictEqual(e.method, null);
    SL.markSent(log, e.key, 'manual');
    assert.strictEqual(e.method, 'manual');
});

test('C6: 按月份分欄，各月獨立', () => {
    const log = {};
    SL.upsertTuition(log, params());
    SL.upsertTuition(log, Object.assign(params(), { monthKey: '2026-10', amount: 1200, count: 4 }));
    SL.markSent(log, 'TUITION:S001:2026-09', 'manual');
    const sep = SL.listByMonth(log, '2026-09');
    const oct = SL.listByMonth(log, '2026-10');
    assert.strictEqual(sep.sent.length, 1);
    assert.strictEqual(sep.todo.length, 0);
    assert.strictEqual(oct.todo.length, 1);
    assert.strictEqual(oct.sent.length, 0);
});

test('C7: 請假/補堂確認條目 key 幂等，重複標記不產生重複條目', () => {
    const log = {};
    const leave = { lessonId: 'S001-20260908-2130', studentId: 'S001', studentName: 'Student 001', phone: '00000000', date: '2026-09-08' };
    SL.ensureLessonEntry(log, 'LEAVE_CONFIRM', leave);
    SL.ensureLessonEntry(log, 'LEAVE_CONFIRM', leave);
    assert.strictEqual(Object.keys(log).length, 1);
    assert.strictEqual(log['LEAVE_CONFIRM:S001-20260908-2130'].month, '2026-09');
    const mu = { lessonId: 'S001-20261002-1500-MU-20260908-2130', studentId: 'S001', studentName: 'Student 001', phone: '00000000', date: '2026-10-02' };
    SL.ensureLessonEntry(log, 'MAKEUP_CONFIRM', mu);
    assert.strictEqual(log['MAKEUP_CONFIRM:' + mu.lessonId].month, '2026-10', '補堂確認歸屬補堂日期月份');
});

test('孤兒清理：課被刪除的 TODO 確認條目移除，SENT 保留作紀錄', () => {
    const log = {};
    const a = { lessonId: 'A-1', studentId: 'S001', date: '2026-09-08' };
    const b = { lessonId: 'B-1', studentId: 'S001', date: '2026-09-08' };
    SL.ensureLessonEntry(log, 'MAKEUP_CONFIRM', a);
    SL.ensureLessonEntry(log, 'MAKEUP_CONFIRM', b);
    SL.markSent(log, 'MAKEUP_CONFIRM:B-1', 'manual');
    const removed = SL.pruneOrphans(log, id => false); // 兩節課都已不存在
    assert.deepStrictEqual(removed, ['MAKEUP_CONFIRM:A-1']);
    assert.ok(log['MAKEUP_CONFIRM:B-1'], 'SENT 條目保留');
});
