// 測試組 I：操作歷史／撤銷（lib/history.js）＋ storage 的歷史讀寫與配額退讓
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('../lib/history.js');
const ST = require('../lib/storage.js');

test('I1: makeSnapshot 深拷貝（之後改原物件不影響）、估算大小、id 唯一', () => {
    const state = { students: [{ id: 'S001', name: 'A' }], lessons: { '2026-09': [{ lessonId: 'x', status: 'SCHEDULED' }] } };
    const snap = H.makeSnapshot(state, '測試', '2026-09-19T10:00:00.000Z');
    state.students[0].name = 'B';
    state.lessons['2026-09'][0].status = 'ATTENDED';
    const back = H.restore(snap);
    assert.strictEqual(back.students[0].name, 'A');
    assert.strictEqual(back.lessons['2026-09'][0].status, 'SCHEDULED');
    assert.strictEqual(snap.description, '測試');
    assert.strictEqual(snap.timestamp, '2026-09-19T10:00:00.000Z');
    const expectedSize = JSON.stringify([{ id: 'S001', name: 'A' }]).length + JSON.stringify({ '2026-09': [{ lessonId: 'x', status: 'SCHEDULED' }] }).length;
    assert.strictEqual(snap.size, expectedSize, '大小＝各鍵 JSON 長度合計（拍照當下）');
    const snap2 = H.makeSnapshot(state, '測試', '2026-09-19T10:00:00.000Z');
    assert.notStrictEqual(snap.id, snap2.id);
    assert.deepStrictEqual(H.restore({ data: { bad: '{oops' } }), { bad: null }, '損壞鍵回 null');
});

test('I2: push 最新在前、超過上限砍最舊；totalSize／formatSize', () => {
    let list = [];
    for (let i = 1; i <= 25; i++) list = H.push(list, H.makeSnapshot({ n: i }, 'op' + i), 20);
    assert.strictEqual(list.length, 20);
    assert.strictEqual(list[0].description, 'op25');
    assert.strictEqual(list[19].description, 'op6');
    assert.strictEqual(H.totalSize(list), 4 * 1 + 16 * 2, '留下 6..25：4 個一位數＋16 個兩位數的 JSON 長度');
    assert.strictEqual(H.formatSize(500), '500 B');
    assert.strictEqual(H.formatSize(2048), '2 KB');
    assert.strictEqual(H.formatSize(1572864), '1.5 MB');
    assert.strictEqual(H.push(null, H.makeSnapshot({}, 'x')).length, 1, 'list 不是陣列時新建');
});

test('I3: storage loadHistory／saveHistory——配額不足時逐筆丟最舊、回傳實際保存筆數', () => {
    const mem = new Map();
    const limit = { max: Infinity };
    const storage = {
        getItem: k => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => { if (String(v).length > limit.max) throw new Error('QuotaExceededError'); mem.set(k, String(v)); },
        removeItem: k => mem.delete(k)
    };
    const store = ST.createStore(storage);
    assert.deepStrictEqual(store.loadHistory(), [], '無資料回空陣列');
    let list = [];
    for (let i = 1; i <= 5; i++) list = H.push(list, H.makeSnapshot({ blob: 'x'.repeat(100) }, 'op' + i, '2026-09-19T10:00:0' + i + '.000Z'));
    assert.strictEqual(store.saveHistory(list), 5);
    assert.strictEqual(store.loadHistory().length, 5);
    assert.strictEqual(store.loadHistory()[0].description, 'op5');
    limit.max = JSON.stringify(list.slice(0, 2)).length + 10; // 只容得下 2 筆
    assert.strictEqual(store.saveHistory(list), 2, '丟最舊直到寫得進去');
    assert.deepStrictEqual(store.loadHistory().map(h => h.description), ['op5', 'op4']);
    limit.max = 1;
    assert.strictEqual(store.saveHistory(list), 0, '一筆都寫不進 → 0');
    mem.set(store.KEYS.history, '{bad json');
    assert.deepStrictEqual(store.loadHistory(), [], '損壞資料回空陣列');
    assert.ok(store.errors.length > 0, '損壞有記錄');
});
