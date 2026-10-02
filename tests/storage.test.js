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
    assert.strictEqual(settings.gcalConflict, 'gcal', '設定回退預設值');
    assert.ok(store.errors.length >= 3, '錯誤被收集供 UI 提示：' + store.errors.join('; '));
});

test('設定：預設值合併，已存部分設定不丟失', () => {
    const storage = fakeStorage({ gac_settings_v2: JSON.stringify({ gcalConflict: 'local' }) });
    const settings = ST.createStore(storage).loadSettings();
    assert.strictEqual(settings.gcalConflict, 'local');
    assert.strictEqual(settings.gcalCalendarId, 'primary', '未存的設定用預設值');
});

test('F1: 全量導出→清空→導入 → students/lessons/sendlog/settings 全部還原', () => {
    const data = {
        students: demoStudents,
        lessons: { '2026-09': [{ lessonId: 'S001-20260901-2130', status: 'ATTENDED' }] },
        sendlog: { 'TUITION:S001:2026-09': { key: 'TUITION:S001:2026-09', status: 'SENT' } },
        settings: { gcalConflict: 'local', publicIcsUrl: '' },
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
    assert.strictEqual(store.loadSettings().gcalConflict, 'local');
});

test('導入兼容：舊版純學生陣列可識別；垃圾輸入被拒絕', () => {
    const legacy = ST.parseImportPayload(JSON.stringify(demoStudents));
    assert.strictEqual(legacy.ok, true);
    assert.strictEqual(legacy.legacy, true);
    assert.strictEqual(legacy.students.length, 1);

    assert.strictEqual(ST.parseImportPayload('not json at all').ok, false);
    assert.strictEqual(ST.parseImportPayload('{"foo": 1}').ok, false, '缺 schemaVersion 拒絕');
});

test('F6: 小組班持久化與備份——loadGroups 預設落盤、saveGroups、全量備份含 groups、舊 v2 備份缺 groups → 空陣列', () => {
    const storage = fakeStorage({});
    const store = ST.createStore(storage);
    const defaults = [{ id: 'G01', name: '樂理 Grade 5 小組', program: 'Music Theory', level: 'Grade 5', duration: 60,
        tutor: 'Instructor B', weekday: 6, time: '15:00', memberIds: ['S020', 'S030'] }];
    const groups = store.loadGroups(defaults);
    assert.strictEqual(groups.length, 1);
    assert.ok(storage.getItem('gac_groups_v2'), '首次載入寫入預設');
    groups[0].memberIds.push('S031');
    store.saveGroups(groups);
    assert.deepStrictEqual(JSON.parse(storage.getItem('gac_groups_v2'))[0].memberIds, ['S020', 'S030', 'S031']);
    // 備份含 groups；解析回來一致
    const payload = ST.buildExportPayload({ students: demoStudents, groups: groups, lessons: {}, sendlog: {}, settings: {} });
    const parsed = ST.parseImportPayload(JSON.stringify(payload));
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.groups.length, 1);
    assert.deepStrictEqual(parsed.groups[0].memberIds, ['S020', 'S030', 'S031']);
    // 舊 v2 備份（沒有 groups 鍵）→ 空陣列而非 undefined
    const old = ST.parseImportPayload(JSON.stringify({ schemaVersion: 2, students: demoStudents, lessons: {}, sendlog: {}, settings: {} }));
    assert.deepStrictEqual(old.groups, []);
});

test('學費單模板：舊的三段（開頭／總額／結尾）轉成一整段，按舊拼法接起來；預設三段 → 等於新預設', () => {
    const OLD_H = '【學費】\n你好，以下是 {month} 的學費單：\n\n【{m}月份上堂詳情及學費】\n學生：{name}';
    assert.strictEqual(ST.tuitionTemplateFromParts(OLD_H, '總額：{amount}', '＊以上收費均以每位學生計算'), ST.DEFAULT_SETTINGS.tplTuition);
    // 改過開頭（例如去掉了空行）
    const m = ST.migrateSettings({ tplTuitionHeader: '【學費】\n開頭 {name}', tplTuitionTotal: '總額：{amount}', tplTuitionFooter: '結尾', feeNotice: 'x' });
    assert.strictEqual(m.tplTuition, '【學費】\n開頭 {name}\n\n{details}\n\n總額：{total}\n\n結尾\n\n{fps}\n{notice}\n{rules}');
    assert.ok(!('tplTuitionHeader' in m) && !('tplTuitionTotal' in m) && !('tplTuitionFooter' in m), '舊欄位不留');
    assert.strictEqual(m.feeNotice, 'x', '其他設定不動');
    // 舊模板留空＝用預設
    assert.strictEqual(ST.migrateSettings({ tplTuitionHeader: '', tplTuitionTotal: '', tplTuitionFooter: '' }).tplTuition, ST.DEFAULT_SETTINGS.tplTuition);
    // 已經有一整段的 → 保留，只清掉舊欄位
    assert.deepStrictEqual(ST.migrateSettings({ tplTuition: 'X {details}', tplTuitionHeader: 'old' }), { tplTuition: 'X {details}' });
    // 沒有舊欄位 → 原樣；壞資料 → 空物件；不改傳進來的物件
    assert.deepStrictEqual(ST.migrateSettings({ a: 1 }), { a: 1 });
    assert.deepStrictEqual(ST.migrateSettings(null), {});
    assert.deepStrictEqual(ST.migrateSettings([1]), {});
    const src = { tplTuitionHeader: 'h' };
    ST.migrateSettings(src);
    assert.deepStrictEqual(src, { tplTuitionHeader: 'h' });
});

test('loadSettings：存檔裡是舊的三段模板 → 讀出來已是一整段；沒存過 → 新預設', () => {
    const store = ST.createStore(fakeStorage({ gac_settings_v2: JSON.stringify({ tplTuitionHeader: '【學費】\n開頭', tplTuitionTotal: '總額：{amount}', tplTuitionFooter: '結尾' }) }));
    const s = store.loadSettings();
    assert.strictEqual(s.tplTuition, '【學費】\n開頭\n\n{details}\n\n總額：{total}\n\n結尾\n\n{fps}\n{notice}\n{rules}');
    assert.ok(!('tplTuitionHeader' in s));
    assert.strictEqual(ST.createStore(fakeStorage({})).loadSettings().tplTuition, ST.DEFAULT_SETTINGS.tplTuition);
});
