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

test('自定義群發條目：快照訊息、同批次幂等、不同批次共存、孤兒清理不碰、可標記已發', () => {
    const log = {};
    const p = { batchId: '20260917120000', title: '調整學費', studentId: 'S001', studentName: 'Student 001', phone: '00000000', monthKey: '2026-09', message: 'Student 001 家長您好，學費將調整。', now: '2026-09-17T12:00:00.000Z' };
    const e = SL.addCustomEntry(log, p);
    assert.strictEqual(e.key, 'CUSTOM:20260917120000:S001');
    assert.strictEqual(e.type, 'CUSTOM');
    assert.strictEqual(e.batchId, '20260917120000', 'batchId 顯式落欄位（二級分類用）');
    assert.strictEqual(e.title, '調整學費', '批次名稱落欄位');
    assert.strictEqual(e.status, 'TODO');
    assert.strictEqual(e.month, '2026-09');
    assert.strictEqual(e.message, 'Student 001 家長您好，學費將調整。');
    // 同批次同學生幂等
    SL.addCustomEntry(log, Object.assign({}, p, { message: '不應覆蓋' }));
    assert.strictEqual(Object.keys(log).length, 1);
    assert.strictEqual(log[e.key].message, 'Student 001 家長您好，學費將調整。');
    // 不同批次（同月第二次群發）共存
    SL.addCustomEntry(log, Object.assign({}, p, { batchId: '20260918090000', message: '第二次通知' }));
    assert.strictEqual(Object.keys(log).length, 2);
    // 進入該月待發送欄；無 lessonId → 孤兒清理絕不移除
    assert.strictEqual(SL.listByMonth(log, '2026-09').todo.length, 2);
    assert.deepStrictEqual(SL.pruneOrphans(log, () => false), []);
    // 標記已發/移回照常
    SL.markSent(log, e.key, 'wa_link', '2026-09-17T13:00:00.000Z');
    assert.strictEqual(SL.listByMonth(log, '2026-09').sent.length, 1);
    SL.markUnsent(log, e.key);
    assert.strictEqual(log[e.key].status, 'TODO');
});

test('清空月份 purgeMonth：該月條目全刪（含 SENT），引用被刪課堂的跨月條目一併刪，其他保留', () => {
    const log = {};
    SL.upsertTuition(log, params());                                    // 2026-09 學費
    SL.markSent(log, 'TUITION:S001:2026-09', 'manual');                 // 已發送也要清
    SL.ensureLessonEntry(log, 'LEAVE_CONFIRM',
        { lessonId: 'S001-20260908-2130', studentId: 'S001', date: '2026-09-08' });
    SL.addCustomEntry(log, { batchId: 'B1', studentId: 'S001', monthKey: '2026-09', message: 'x' });
    // 跨月：9 月請假的補堂排在 10 月 → 條目歸 10 月，但課堂屬被刪集合
    SL.ensureLessonEntry(log, 'MAKEUP_CONFIRM',
        { lessonId: 'S001-20261006-1900-MU-20260908-2130', studentId: 'S001', date: '2026-10-06' });
    // 不相干的 10 月學費：保留
    SL.upsertTuition(log, Object.assign(params(), { monthKey: '2026-10' }));
    const removed = SL.purgeMonth(log, '2026-09',
        ['S001-20260908-2130', 'S001-20261006-1900-MU-20260908-2130']);
    assert.strictEqual(removed.length, 4);
    assert.deepStrictEqual(Object.keys(log), ['TUITION:S001:2026-10']);
});

test('WhatsApp 開啟標記：markWaOpened 只記時間不改狀態；移回待發時清空', () => {
    const log = {};
    const e = SL.upsertTuition(log, params());
    const marked = SL.markWaOpened(log, e.key, '2026-09-16T03:00:00.000Z');
    assert.strictEqual(marked.waOpenedAt, '2026-09-16T03:00:00.000Z');
    assert.strictEqual(marked.status, 'TODO', '點開 ≠ 已發，狀態不變');
    SL.markSent(log, e.key, 'wa_link', '2026-09-16T03:05:00.000Z');
    assert.strictEqual(log[e.key].waOpenedAt, '2026-09-16T03:00:00.000Z', '標記已發保留開啟紀錄');
    SL.markUnsent(log, e.key);
    assert.strictEqual(log[e.key].waOpenedAt, null, '移回待發 → 重發流程從頭開始');
    assert.strictEqual(SL.markWaOpened(log, 'NOPE'), null);
});

test('C9: tuitionItems 按報讀項目分組（個別一項＋每小組一項）；時段一致給星期/起訖/每堂費用；upsert 存明細', () => {
    const mk = (id, date, time, extra) => Object.assign({ lessonId: id, studentId: 'S020', date, time, duration: 60,
        program: 'Pop Guitar', level: 'Intermediate 中級', classType: '一對一', tutor: 'Instructor B' }, extra || {});
    const grp = { groupId: 'G01', groupName: '樂理 Grade 5 小組', program: 'Music Theory', level: 'Grade 5', classType: '5人小組' };
    const lessons = [
        mk('c', '2026-12-05', '15:00', grp), mk('a', '2026-12-02', '18:00'),
        mk('d', '2026-12-12', '15:00', grp), mk('b', '2026-12-09', '18:00')
    ];
    const items = SL.tuitionItems(lessons, l => (l.groupId ? 180 : 450));
    assert.strictEqual(items.length, 2, '個別一項＋小組一項');
    assert.strictEqual(items[0].groupId, null, '個別課排前');
    assert.deepStrictEqual(items[0].dates, ['2026-12-02', '2026-12-09'], '日期已排序');
    assert.strictEqual(items[0].weekday, 3);
    assert.strictEqual(items[0].time, '18:00');
    assert.strictEqual(items[0].endTime, '19:00');
    assert.strictEqual(items[0].rate, 450);
    assert.strictEqual(items[0].subtotal, 900);
    assert.strictEqual(items[1].groupId, 'G01');
    assert.strictEqual(items[1].groupName, '樂理 Grade 5 小組');
    assert.strictEqual(items[1].weekday, 6);
    assert.strictEqual(items[1].classType, '5人小組');
    assert.strictEqual(items[1].subtotal, 360);
    // 時段不一（其中一堂改時）→ weekday/time 留空、times 逐堂保留
    const moved = SL.tuitionItems([mk('a', '2026-12-02', '18:00'), mk('b', '2026-12-10', '20:00')], () => 450);
    assert.strictEqual(moved[0].weekday, null);
    assert.strictEqual(moved[0].time, '');
    assert.deepStrictEqual(moved[0].times, ['18:00', '20:00']);
    // 跨午夜起訖不爆
    assert.strictEqual(SL.tuitionItems([mk('z', '2026-12-02', '23:30')], () => 1)[0].endTime, '00:30');
    // upsertTuition：建立存明細；TODO 隨生成刷新；缺省 items 保留既有；SENT 不動
    const log = {};
    SL.upsertTuition(log, Object.assign(params(), { items }));
    assert.strictEqual(log['TUITION:S001:2026-09'].items.length, 2);
    SL.upsertTuition(log, params());
    assert.strictEqual(log['TUITION:S001:2026-09'].items.length, 2, '未傳 items → 保留');
    SL.upsertTuition(log, Object.assign(params(), { items: items.slice(0, 1) }));
    assert.strictEqual(log['TUITION:S001:2026-09'].items.length, 1, 'TODO 條目明細隨生成刷新');
    SL.markSent(log, 'TUITION:S001:2026-09', 'manual');
    SL.upsertTuition(log, Object.assign(params(), { items }));
    assert.strictEqual(log['TUITION:S001:2026-09'].items.length, 1, 'SENT 不改');
});

test('C10: 繳費紀錄——勾已繳預設整額＋今天；實收改動推導狀態；非學費條目拒絕；tuitionByMonth／paymentTotals', () => {
    const log = {};
    SL.upsertTuition(log, params()); // amount 1500
    const key = 'TUITION:S001:2026-09';
    assert.strictEqual(SL.paymentStatus(log[key]), 'unpaid');
    assert.strictEqual(log[key].paid, false);
    SL.setPayment(log, key, { paid: true }, '2026-09-19');
    assert.strictEqual(log[key].paidAmount, 1500, '勾已繳 → 整額');
    assert.strictEqual(log[key].payDate, '2026-09-19', '勾已繳 → 今天');
    assert.strictEqual(SL.paymentStatus(log[key]), 'paid');
    SL.setPayment(log, key, { paidAmount: 500, payMethod: '2', receipt: true });
    assert.strictEqual(SL.paymentStatus(log[key]), 'partial');
    assert.strictEqual(log[key].paid, true);
    assert.strictEqual(log[key].payMethod, '2');
    assert.strictEqual(log[key].receipt, true);
    assert.strictEqual(log[key].checked, undefined, '「核對」欄位已移除');
    SL.setPayment(log, key, { paid: false });
    assert.strictEqual(log[key].paidAmount, 0, '取消已繳 → 實收歸零');
    assert.strictEqual(SL.paymentStatus(log[key]), 'unpaid');
    SL.setPayment(log, key, { paidAmount: '1500' });
    assert.strictEqual(log[key].paid, true, '實收 > 0 → 已繳');
    assert.strictEqual(SL.paymentStatus(log[key]), 'paid');
    SL.setPayment(log, key, { paidAmount: 0 });
    assert.strictEqual(log[key].paid, false, '實收 0 → 未繳');
    assert.strictEqual(SL.setPayment(log, 'LEAVE_CONFIRM:x', { paid: true }), null, '非學費條目');
    // 重新生成不會洗掉繳費欄位（TODO 條目只刷新堂數／日期／金額）
    SL.setPayment(log, key, { paid: true, payMethod: '1' }, '2026-09-19');
    SL.upsertTuition(log, Object.assign(params(), { amount: 1800, count: 6 }));
    assert.strictEqual(log[key].paid, true);
    assert.strictEqual(log[key].payMethod, '1');
    assert.strictEqual(log[key].amount, 1800);
    assert.strictEqual(SL.paymentStatus(log[key]), 'partial', '應收升到 1800、實收仍 1500 → 部分');
    SL.upsertTuition(log, Object.assign(params(), { studentId: 'S002', amount: 1000 }));
    const list = SL.tuitionByMonth(log, '2026-09');
    assert.deepStrictEqual(list.map(e => e.studentId), ['S001', 'S002']);
    assert.deepStrictEqual(SL.paymentTotals(list), { due: 2800, paid: 1500, outstanding: 1300 });
    assert.deepStrictEqual(SL.tuitionByMonth(log, '2026-10'), []);
});

test('C11: 派生條目——催繳：學費單發出滿 N 天且未繳清才建、每生每月一筆、繳清／移回待發即清 TODO、SENT 保留、不用發略過、關閉自動不建、天數可設', () => {
    const log = {};
    SL.upsertTuition(log, params());
    const tk = 'TUITION:S001:2026-09', rk = 'PAY_REMIND:S001:2026-09';
    const sync = (now, extra) => SL.syncDerived(log, Object.assign({ now, remindDays: 7 }, extra || {}));
    assert.deepStrictEqual(sync('2026-09-20T00:00:00.000Z'), { created: [], removed: [] }, '未發出 → 無催繳');
    SL.markSent(log, tk, 'manual', '2026-09-01T10:00:00.000Z');
    assert.deepStrictEqual(sync('2026-09-08T09:00:00.000Z').created, [], '未滿 7 天');
    assert.deepStrictEqual(sync('2026-09-08T10:00:00.000Z').created, [rk], '滿 7 天 → 建催繳');
    assert.strictEqual(log[rk].type, 'PAY_REMIND');
    assert.strictEqual(log[rk].tuitionKey, tk);
    assert.strictEqual(log[rk].month, '2026-09');
    assert.strictEqual(log[rk].status, 'TODO');
    assert.strictEqual(log[rk].createdAt, '2026-09-08T10:00:00.000Z');
    assert.deepStrictEqual(sync('2026-09-20T00:00:00.000Z'), { created: [], removed: [] }, '幂等：不重建');
    SL.setPayment(log, tk, { paidAmount: 500 }, '2026-09-10');
    assert.deepStrictEqual(sync('2026-09-20T00:00:00.000Z').removed, [], '部分繳交仍催');
    SL.setPayment(log, tk, { paid: true, paidAmount: 1500 }, '2026-09-10');
    const r = sync('2026-09-20T00:00:00.000Z');
    assert.deepStrictEqual(r.removed, [rk], '繳清 → TODO 催繳刪除');
    assert.ok(!log[rk]);
    assert.deepStrictEqual(r.created, ['RECEIPT:S001:2026-09'], '繳清 → 建收款確認');
    // 取消已繳 → 催繳重建；已發出的催繳留作紀錄且不再建第二筆
    SL.setPayment(log, tk, { paid: false });
    assert.ok(sync('2026-09-20T00:00:00.000Z').created.includes(rk));
    SL.markSent(log, rk, 'wa_link', '2026-09-20T00:00:00.000Z');
    SL.setPayment(log, tk, { paid: true }, '2026-09-21');
    assert.deepStrictEqual(sync('2026-09-22T00:00:00.000Z').removed, [], 'SENT 催繳保留');
    assert.strictEqual(log[rk].status, 'SENT');
    SL.setPayment(log, tk, { paid: false });
    assert.strictEqual(sync('2026-10-01T00:00:00.000Z').created.length, 0, '已有 SENT 催繳 → 不建第二筆');
    // 不用發：刪除並略過；學費單移回待發後重置
    SL.markUnsent(log, rk);
    assert.strictEqual(log[rk].status, 'TODO');
    assert.strictEqual(SL.dismissDerived(log, rk).key, rk);
    assert.ok(!log[rk] && log[tk].remindSkipped === true);
    assert.deepStrictEqual(sync('2026-10-01T00:00:00.000Z').created, [], '略過後不重建');
    SL.markUnsent(log, tk);
    assert.strictEqual(log[tk].remindSkipped, false, '學費單移回待發 → 重置略過');
    SL.markSent(log, tk, 'manual', '2026-10-01T00:00:00.000Z');
    assert.deepStrictEqual(sync('2026-10-09T00:00:00.000Z').created, [rk], '重發滿 7 天再催');
    assert.deepStrictEqual(sync('2026-10-09T00:00:00.000Z', { remindAuto: false }).removed, [rk], '關閉自動 → 待發催繳清掉');
    assert.deepStrictEqual(sync('2026-10-09T00:00:00.000Z', { remindAuto: false }).created, []);
    assert.deepStrictEqual(sync('2026-10-05T00:00:00.000Z', { remindDays: 3 }).created, [rk], '天數可設');
    assert.strictEqual(SL.dismissDerived(log, tk), null, '非派生條目拒絕');
    log[rk].tuitionKey = 'TUITION:GONE:2026-09';
    assert.deepStrictEqual(sync('2026-10-09T00:00:00.000Z').removed, [rk], '學費條目不存在 → TODO 派生條目刪除');
});

test('C12: 派生條目——收款確認：繳清即建（不要求學費單已發）、標記已發回寫 receipt、取消已繳清 TODO 並重置略過、不用發略過、關閉自動不建、清月一併清', () => {
    const log = {};
    SL.upsertTuition(log, params());
    const tk = 'TUITION:S001:2026-09', ck = 'RECEIPT:S001:2026-09';
    const sync = extra => SL.syncDerived(log, Object.assign({ now: '2026-09-20T00:00:00.000Z' }, extra || {}));
    SL.setPayment(log, tk, { paidAmount: 500 }, '2026-09-10');
    assert.deepStrictEqual(sync().created, [], '部分繳交不建收款確認');
    SL.setPayment(log, tk, { paid: true, paidAmount: 1500, payMethod: '2' }, '2026-09-10');
    assert.deepStrictEqual(sync().created, [ck], '繳清 → 建');
    assert.strictEqual(log[ck].type, 'RECEIPT');
    assert.strictEqual(log[ck].tuitionKey, tk);
    assert.strictEqual(log[tk].receipt, false);
    SL.markSent(log, ck, 'wa_link', '2026-09-20T01:00:00.000Z');
    assert.strictEqual(log[tk].receipt, true, '收款確認發出 → 學費條目「收據」勾上');
    SL.setPayment(log, tk, { paid: false });
    assert.deepStrictEqual(sync().removed, [], 'SENT 收款確認保留');
    SL.markUnsent(log, ck);
    assert.deepStrictEqual(sync().removed, [ck], '未繳 + TODO 收款確認 → 刪');
    SL.setPayment(log, tk, { paid: true }, '2026-09-21');
    assert.deepStrictEqual(sync().created, [ck]);
    SL.dismissDerived(log, ck);
    assert.ok(!log[ck] && log[tk].receiptSkipped === true);
    assert.deepStrictEqual(sync().created, [], '略過後不重建');
    SL.setPayment(log, tk, { paid: false });
    assert.strictEqual(log[tk].receiptSkipped, false, '取消已繳 → 重置略過');
    SL.setPayment(log, tk, { paid: true }, '2026-09-22');
    assert.deepStrictEqual(sync({ receiptAuto: false }).created, [], '關閉自動不建');
    assert.deepStrictEqual(sync().created, [ck]);
    assert.deepStrictEqual(SL.pruneOrphans(log, () => false), [], '派生條目沒有 lessonId，孤兒清理不碰');
    assert.ok(SL.purgeMonth(log, '2026-09', []).includes(ck), '清月連派生條目一起清');
});

test('C13: 模板變數與代入——金額格式、月份標籤、付款方式名稱、payinfo 組合、fps 留空、未知佔位符保留、空行清理', () => {
    const log = {};
    SL.upsertTuition(log, params());
    const t = log['TUITION:S001:2026-09'];
    const names = ['現金', '轉數快 FPS', '銀行轉帳'];
    let v = SL.paymentVars(t, { methodNames: names, fpsId: '' });
    assert.strictEqual(v.month, '2026年9月');
    assert.strictEqual(v.m, '9');
    assert.strictEqual(v.name, 'Student 001');
    assert.strictEqual(v.id, 'S001');
    assert.strictEqual(v.amount, '$1,500');
    assert.strictEqual(v.paid, '$0');
    assert.strictEqual(v.outstanding, '$1,500');
    assert.strictEqual(v.method, '');
    assert.strictEqual(v.payinfo, '');
    assert.strictEqual(v.fps, '');
    SL.setPayment(log, 'TUITION:S001:2026-09', { paidAmount: 500, payMethod: '2' }, '2026-09-10');
    v = SL.paymentVars(t, { methodNames: names, fpsId: '123' });
    assert.strictEqual(v.paid, '$500');
    assert.strictEqual(v.outstanding, '$1,000');
    assert.strictEqual(v.method, '轉數快 FPS');
    assert.strictEqual(v.date, '2026-09-10');
    assert.strictEqual(v.payinfo, '（轉數快 FPS，2026-09-10）');
    assert.strictEqual(v.fps, 'FPS 轉數快 ID：123');
    assert.strictEqual(SL.fillTemplate('【學費提醒】\n{name} {month} 未繳 {outstanding}\n{fps}\n\n\n{unknown}', v),
        '【學費提醒】\nStudent 001 2026年9月 未繳 $1,000\nFPS 轉數快 ID：123\n\n{unknown}');
    assert.strictEqual(SL.fillTemplate('a {fps}\n\n', { fps: '' }), 'a', 'fps 空 → 行尾與尾端空白清掉');
    assert.strictEqual(SL.monthLabel('bad'), 'bad');
    assert.strictEqual(SL.fillTemplate(null, null), '');
});

test('C14: 改期通知 ensureMoveEntry——快照改期前時間；TODO 再改期保留原 from；SENT 再改期重開 TODO 並以上次已通知時間作 from；孤兒清理照舊', () => {
    const log = {};
    const lesson = { lessonId: 'S001-20260916-2130-MU-20260909-2130', studentId: 'S001', studentName: 'Student 001', phone: '00000000', date: '2026-09-23', time: '18:00' };
    const e = SL.ensureMoveEntry(log, lesson, { date: '2026-09-16', time: '21:30' }, '2026-09-19T10:00:00.000Z');
    assert.strictEqual(e.key, 'MOVE_CONFIRM:' + lesson.lessonId);
    assert.strictEqual(e.type, 'MOVE_CONFIRM');
    assert.strictEqual(e.fromDate, '2026-09-16');
    assert.strictEqual(e.fromTime, '21:30');
    assert.strictEqual(e.month, '2026-09');
    assert.strictEqual(e.status, 'TODO');
    lesson.date = '2026-09-30';
    SL.ensureMoveEntry(log, lesson, { date: '2026-09-23', time: '18:00' });
    assert.strictEqual(log[e.key].fromDate, '2026-09-16', 'TODO 中再改期 → 保留最初的 from');
    SL.markSent(log, e.key, 'wa_link', '2026-09-20T00:00:00.000Z');
    lesson.date = '2026-10-02'; lesson.time = '19:00';
    SL.ensureMoveEntry(log, lesson, { date: '2026-09-30', time: '18:00' }, '2026-09-21T00:00:00.000Z');
    assert.strictEqual(log[e.key].status, 'TODO', 'SENT 再改期 → 重開');
    assert.strictEqual(log[e.key].fromDate, '2026-09-30', 'from＝上次已通知的時間');
    assert.strictEqual(log[e.key].month, '2026-10', '歸屬月份跟課堂');
    assert.strictEqual(log[e.key].sentAt, null);
    assert.deepStrictEqual(SL.pruneOrphans(log, () => false), [e.key], '課堂不存在 → TODO 改期通知清掉');
});
