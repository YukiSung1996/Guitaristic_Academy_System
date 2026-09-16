// 測試組 F（邏輯部分）：資料持久化、備份與兼容（規格書 §4-F 的可單元測試部分）
const { test } = require('node:test');
const assert = require('node:assert');
const ST = require('../lib/storage.js');

// 模擬 localStorage
function fakeStorage(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: k => map.delete(k),
        _map: map
    };
}

const demoStudents = [{ id: 'S001', name: 'Student 001', weekday: 2, time: '21:30' }];

test('F2: 只有舊 key 的瀏覽器首次打開 → 學生自動遷移到新 key，舊 key 保留不動', () => {
    const raw = JSON.stringify(demoStudents);
    const storage = fakeStorage({ demo_music_academy_students_v1: raw });
    const store = ST.createStore(storage);
    const students = store.loadStudents([]);
    assert.strictEqual(students.length, 1);
    assert.strictEqual(students[0].id, 'S001');
    assert.strictEqual(storage.getItem('gac_students_v2'), raw, '已寫入新 key');
    assert.strictEqual(storage.getItem('demo_music_academy_students_v1'), raw, '舊 key 原封不動');
    assert.strictEqual(store.errors.length, 0);
});

test('新 key 優先於舊 key；兩者皆無 → 用預設名單並落盤', () => {
    const storage = fakeStorage({
        gac_students_v2: JSON.stringify([{ id: 'NEW' }]),
        demo_music_academy_students_v1: JSON.stringify([{ id: 'OLD' }])
    });
    assert.strictEqual(ST.createStore(storage).loadStudents([])[0].id, 'NEW');

    const empty = fakeStorage();
    const students = ST.createStore(empty).loadStudents(demoStudents);
    assert.strictEqual(students[0].id, 'S001');
    assert.ok(empty.getItem('gac_students_v2'));
});

test('F3: 損壞的 localStorage JSON → 不拋錯，收集錯誤並回退預設', () => {
    const storage = fakeStorage({
        gac_students_v2: '{broken json',
        gac_lessons_v2: '[not an object]',
        gac_sendlog_v2: 'oops',
        gac_settings_v2: '{{{'
    });
    const store = ST.createStore(storage);
    const students = store.loadStudents(demoStudents);
    const lessons = store.loadLessons();
    const sendlog = store.loadSendlog();
    const settings = store.loadSettings();
    assert.deepStrictEqual(students.map(s => s.id), ['S001']);
    assert.deepStrictEqual(lessons, {});
    assert.deepStrictEqual(sendlog, {});
    assert.strictEqual(settings.payNoShow, true, '設定回退預設值');
    assert.strictEqual(settings.waSentMode, 'confirm', 'WhatsApp 發送確認方式預設最安全的 confirm');
    assert.ok(store.errors.length >= 3, '錯誤被收集供 UI 提示：' + store.errors.join('; '));
});

test('設定：預設值合併，已存部分設定不丟失', () => {
    const storage = fakeStorage({ gac_settings_v2: JSON.stringify({ payNoShow: false }) });
    const settings = ST.createStore(storage).loadSettings();
    assert.strictEqual(settings.payNoShow, false);
    assert.strictEqual(settings.gcalCalendarId, 'primary', '未存的設定用預設值');
});

test('F1: 全量導出→清空→導入 → students/lessons/sendlog/settings 全部還原', () => {
    const data = {
        students: demoStudents,
        lessons: { '2026-09': [{ lessonId: 'S001-20260901-2130', status: 'ATTENDED' }] },
        sendlog: { 'TUITION:S001:2026-09': { key: 'TUITION:S001:2026-09', status: 'SENT' } },
        settings: { payNoShow: false, publicIcsUrl: '' },
        now: '2026-09-15T10:00:00.000Z'
    };
    const payload = ST.buildExportPayload(data);
    assert.strictEqual(payload.schemaVersion, 2);
    const text = JSON.stringify(payload);
    // 清空後導入
    const parsed = ST.parseImportPayload(text);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.legacy, false);
    assert.deepStrictEqual(parsed.students, data.students);
    assert.deepStrictEqual(parsed.lessons, data.lessons);
    assert.deepStrictEqual(parsed.sendlog, data.sendlog);
    assert.deepStrictEqual(parsed.settings, data.settings);
    // 寫回 store 再讀出
    const storage = fakeStorage();
    const store = ST.createStore(storage);
    store.saveStudents(parsed.students);
    store.saveLessons(parsed.lessons);
    store.saveSendlog(parsed.sendlog);
    store.saveSettings(parsed.settings);
    assert.deepStrictEqual(store.loadLessons(), data.lessons);
    assert.strictEqual(store.loadSettings().payNoShow, false);
});

test('導入兼容：舊版純學生陣列可識別；垃圾輸入被拒絕', () => {
    const legacy = ST.parseImportPayload(JSON.stringify(demoStudents));
    assert.strictEqual(legacy.ok, true);
    assert.strictEqual(legacy.legacy, true);
    assert.strictEqual(legacy.students.length, 1);

    assert.strictEqual(ST.parseImportPayload('not json at all').ok, false);
    assert.strictEqual(ST.parseImportPayload('{"foo": 1}').ok, false, '缺 schemaVersion 拒絕');
});
