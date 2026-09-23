// 測試組 J：導師名單與費率覆寫的儲存／備份（lib/storage.js）＋ 費率覆寫套用（lib/rates.js）
const { test } = require('node:test');
const assert = require('node:assert');
const ST = require('../lib/storage.js');
const R = require('../lib/rates.js');

function fakeStorage(initial) {
    const map = new Map(Object.entries(initial || {}));
    return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k), _map: map };
}
const defaults = [{ name: 'Instructor A', tier: '普通導師' }, { name: 'Instructor B', tier: '資深導師' }];
const withCal = list => list.map(t => Object.assign({ calendarId: '' }, t)); // 載入後一律補齊日曆 ID 欄位

test('J1: loadTutors——沒有資料用預設並落盤；有資料則正規化 tier；壞資料回退預設', () => {
    const storage = fakeStorage();
    const store = ST.createStore(storage);
    const t = store.loadTutors(defaults);
    assert.deepStrictEqual(t, withCal(defaults));
    assert.strictEqual(JSON.parse(storage.getItem('gac_tutors_v3')).length, 2, '預設已落盤');
    store.saveTutors([{ name: 'X', tier: '資深導師' }, { name: '', tier: '資深導師' }, { name: 'Y', tier: '亂填' }]);
    assert.deepStrictEqual(store.loadTutors(defaults), withCal([{ name: 'X', tier: '資深導師' }, { name: 'Y', tier: '普通導師' }]), '空名略過、非法等級→普通');
    const bad = ST.createStore(fakeStorage({ gac_tutors_v3: '{not json' }));
    assert.deepStrictEqual(bad.loadTutors(defaults), withCal(defaults));
    assert.ok(bad.errors.length > 0);
});

test('J2: 費率覆寫——載入／儲存；非物件回空', () => {
    const store = ST.createStore(fakeStorage());
    assert.deepStrictEqual(store.loadRateOverrides(), {});
    store.saveRateOverrides({ 'a|b': 100 });
    assert.deepStrictEqual(store.loadRateOverrides(), { 'a|b': 100 });
    assert.deepStrictEqual(ST.createStore(fakeStorage({ gac_rate_overrides_v3: '[1,2]' })).loadRateOverrides(), {}, '陣列不是覆寫表');
});

test('J3: 備份／還原含導師名單與費率覆寫；舊備份缺鍵 → 空；舊版純陣列 → null', () => {
    const payload = ST.buildExportPayload({ students: [], groups: [], lessons: {}, sendlog: {}, settings: {}, tutors: defaults, rateOverrides: { k: 1 } });
    assert.deepStrictEqual(payload.tutors, defaults);
    assert.deepStrictEqual(payload.rateOverrides, { k: 1 });
    const back = ST.parseImportPayload(JSON.stringify(payload));
    assert.deepStrictEqual(back.tutors, defaults);
    assert.deepStrictEqual(back.rateOverrides, { k: 1 });
    const old = ST.parseImportPayload(JSON.stringify({ schemaVersion: 2, students: [], lessons: {}, sendlog: {}, settings: {} }));
    assert.deepStrictEqual(old.tutors, []);
    assert.deepStrictEqual(old.rateOverrides, {});
    const legacy = ST.parseImportPayload('[]');
    assert.strictEqual(legacy.tutors, null);
});

test('J4: applyOverrides 就地套用、首次記住基準價、移除覆寫回基準、非法值忽略、回傳套用筆數', () => {
    const table = [
        { tutor: '資深導師', instrument: 'Pop Guitar', grade: 'Grade 1', classType: '一對一個別授課 Individual', duration: 45, rate: 360 },
        { tutor: '資深導師', instrument: 'Pop Guitar', grade: 'Grade 1', classType: '一對一個別授課 Individual', duration: 60, rate: 450 }
    ];
    const k45 = R.overrideKey(table[0]);
    assert.strictEqual(k45, '資深導師|Pop Guitar|Grade 1|一對一個別授課 Individual|45');
    assert.strictEqual(R.applyOverrides(table, { [k45]: 400, bogus: 1 }), 1);
    assert.strictEqual(table[0].rate, 400);
    assert.strictEqual(table[0].baseRate, 360, '基準價保留');
    assert.strictEqual(table[1].rate, 450);
    assert.strictEqual(R.applyOverrides(table, { [k45]: 'abc' }), 0, '非數字忽略');
    assert.strictEqual(table[0].rate, 360, '沒有有效覆寫 → 回基準');
    assert.strictEqual(R.applyOverrides(table, {}), 0);
    assert.strictEqual(table[0].rate, 360);
    assert.strictEqual(table[0].baseRate, 360, '基準價不被後續套用改寫');
    assert.strictEqual(R.findRate(table, { tutorLevel: '資深導師', program: 'Pop Guitar', level: 'Grade 1', type: '一對一', duration: 45 }), 360);
    R.applyOverrides(table, { [k45]: 420 });
    assert.strictEqual(R.findRate(table, { tutorLevel: '資深導師', program: 'Pop Guitar', level: 'Grade 1', type: '一對一', duration: 45 }), 420, '查價走覆寫後的值');
});

test('J5: 導師日曆 ID——落盤後原樣載回、缺省補空字串、修剪空白、未知欄位不留', () => {
    const store = ST.createStore(fakeStorage());
    store.saveTutors([{ name: 'A', tier: '普通導師', calendarId: ' x@group.calendar.google.com ', calendarEmbed: '舊欄位' }, { name: 'B', tier: '資深導師' }]);
    const t = store.loadTutors(defaults);
    assert.strictEqual(t[0].calendarId, 'x@group.calendar.google.com');
    assert.deepStrictEqual(t[0], { name: 'A', tier: '普通導師', calendarId: 'x@group.calendar.google.com' }, '已移除的嵌入欄位不再載入');
    assert.deepStrictEqual(t[1], { name: 'B', tier: '資深導師', calendarId: '' });
});
