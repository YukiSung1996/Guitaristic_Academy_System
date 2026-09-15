// 測試組 D：Google Calendar 同步（規格書 §4-D；mock 傳輸層，無網路）
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/schedule.js');
const G = require('../lib/gcal.js');

function student(overrides) {
    return Object.assign({
        id: 'S001', name: 'Student 001', phone: '00000000', email: 'student001@example.com',
        type: '一對一', program: 'Pop Guitar', level: 'Intermediate 中級', duration: 45,
        tutor: 'Instructor A', weekday: 2, time: '21:30',
        effectiveMonth: '', futureWeekday: null, futureTime: ''
    }, overrides || {});
}

// 假日曆：記憶體事件陣列 + client 介面（listByLessonId / insert）
function mockCalendar(initialEvents) {
    const events = (initialEvents || []).slice();
    let nextId = 1;
    return {
        events,
        client: {
            listByLessonId: (lessonId) => Promise.resolve(events.filter(ev =>
                ev.status !== 'cancelled' &&
                ev.extendedProperties && ev.extendedProperties.private &&
                ev.extendedProperties.private.gacLessonId === lessonId)),
            insert: (payload) => {
                const ev = Object.assign({ id: 'ev' + (nextId++), status: 'confirmed' },
                    JSON.parse(JSON.stringify(payload)));
                events.push(ev);
                return Promise.resolve(ev);
            }
        }
    };
}

const IMPORT_OPTS = { titleFn: S.lessonTitle, timeZone: 'Asia/Hong_Kong' };

test('payload：summary 用日曆標題契約、狀態碼入 location、gacLessonId 入 extendedProperties', () => {
    const lessons = S.generateMonthLessons(student(), '2026-09');
    const l = lessons[0]; // 2026-09-01 週二
    const p = G.lessonToEventPayload(l, IMPORT_OPTS);
    assert.strictEqual(p.summary, 'S001 Student 001([1/5] 09/2026)');
    assert.strictEqual(p.start.dateTime, '2026-09-01T21:30:00');
    assert.strictEqual(p.end.dateTime, '2026-09-01T22:15:00');
    assert.strictEqual(p.start.timeZone, 'Asia/Hong_Kong');
    assert.strictEqual(p.extendedProperties.private.gacLessonId, l.lessonId);
    assert.strictEqual(p.location, '', 'SCHEDULED 常規課無狀態碼');
    l.status = 'LEAVE'; l.leaveType = 'SL';
    assert.strictEqual(G.lessonToEventPayload(l, IMPORT_OPTS).location, 'SL');
});

test('endDateTime 跨午夜安全', () => {
    assert.strictEqual(G.endDateTime('2026-09-30', '23:30', 60), '2026-10-01T00:30:00');
});

test('eventStartToLocal：取牆鐘部分不受執行環境時區影響；全日事件 time=null', () => {
    assert.deepStrictEqual(G.eventStartToLocal({ start: { dateTime: '2026-09-16T21:30:00+08:00' } }),
        { date: '2026-09-16', time: '21:30' });
    assert.deepStrictEqual(G.eventStartToLocal({ start: { date: '2026-09-16' } }),
        { date: '2026-09-16', time: null });
    assert.strictEqual(G.eventStartToLocal({}), null);
});

test('parseStatusCode：location 精確碼優先；summary 詞元邊界；MU/無碼 → null', () => {
    assert.deepStrictEqual(G.parseStatusCode({ location: 'SL' }), { status: 'LEAVE', leaveType: 'SL' });
    assert.deepStrictEqual(G.parseStatusCode({ location: 'NS' }), { status: 'NOSHOW', leaveType: '' });
    assert.strictEqual(G.parseStatusCode({ location: 'MU' }), null);
    assert.deepStrictEqual(G.parseStatusCode({ summary: 'S001 Student 001 TL' }), { status: 'LEAVE', leaveType: 'TL' });
    assert.strictEqual(G.parseStatusCode({ summary: 'SLOW practice' }), null, 'SLOW 不是 SL 詞元');
    assert.strictEqual(G.parseStatusCode({ summary: 'S001 Student 001([1/5] 09/2026)' }), null);
});

test('matchStudentPrefix：詞邊界匹配，S0012 不誤中 S001', () => {
    const known = ['S001', 'S003'];
    assert.strictEqual(G.matchStudentPrefix('S001 补课', known), 'S001');
    assert.strictEqual(G.matchStudentPrefix('S003', known), 'S003');
    assert.strictEqual(G.matchStudentPrefix('S0012 x', known), null);
    assert.strictEqual(G.matchStudentPrefix('Dentist', known), null);
});

test('syncWindow：月初−7 天 ~ 月末+7 天', () => {
    const w = G.syncWindow('2026-09');
    assert.strictEqual(w.timeMin, '2026-08-25T00:00:00.000Z');
    assert.strictEqual(w.timeMax, '2026-10-08T00:00:00.000Z');
});

test('D1: 空日曆全部 insert 並回填 gcalEventId；再導入一次 → 0 新增全 skip（不覆蓋）', async () => {
    const lessons = S.generateMonthLessons(student(), '2026-09');
    const cal = mockCalendar();
    const r1 = await G.importLessons(cal.client, lessons, IMPORT_OPTS);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.inserted.length, 5);
    assert.strictEqual(r1.skipped.length, 0);
    assert.ok(lessons.every(l => l.gcalEventId), '每節課回填 gcalEventId');
    assert.strictEqual(cal.events.length, 5);
    const r2 = await G.importLessons(cal.client, lessons, IMPORT_OPTS);
    assert.strictEqual(r2.inserted.length, 0);
    assert.strictEqual(r2.skipped.length, 5);
    assert.strictEqual(cal.events.length, 5, '沒有新建重複事件');
});

test('D2: GCal 手動改了事件時間後再導入 → 仍 skip，永不 update', async () => {
    const lessons = S.generateMonthLessons(student(), '2026-09');
    const cal = mockCalendar();
    await G.importLessons(cal.client, lessons, IMPORT_OPTS);
    cal.events[0].start.dateTime = '2026-09-03T10:00:00'; // 模擬人工挪動
    const r = await G.importLessons(cal.client, lessons, IMPORT_OPTS);
    assert.strictEqual(r.inserted.length, 0);
    assert.strictEqual(r.skipped.length, 5);
    assert.strictEqual(cal.events[0].start.dateTime, '2026-09-03T10:00:00', '事件保持人工改後的值');
});

test('D7: 傳輸失敗 → 明確報錯、不寫任何本地狀態', async () => {
    const lessons = S.generateMonthLessons(student(), '2026-09');
    const failing = {
        listByLessonId: () => Promise.reject(new Error('offline')),
        insert: () => Promise.reject(new Error('offline'))
    };
    const r = await G.importLessons(failing, lessons, IMPORT_OPTS);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failed.length, 5);
    assert.strictEqual(r.inserted.length, 0);
    assert.ok(lessons.every(l => l.gcalEventId === null), '失敗不回填 gcalEventId');
});

test('restClient：非 2xx 回應帶狀態碼與 Google 錯誤訊息', async () => {
    const client = G.createRestClient({
        token: 'tok', calendarId: 'primary',
        fetchFn: () => Promise.resolve({
            ok: false, status: 401,
            json: () => Promise.resolve({ error: { message: 'Invalid Credentials' } })
        })
    });
    await assert.rejects(() => client.listByLessonId('X'), /401.*Invalid Credentials/);
});

test('restClient：listWindow 走分頁並合併結果', async () => {
    const calls = [];
    const pages = [
        { items: [{ id: 'a' }], nextPageToken: 'p2' },
        { items: [{ id: 'b' }, { id: 'c' }] }
    ];
    const client = G.createRestClient({
        token: 'tok',
        fetchFn: (url) => { calls.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve(pages.shift()) }); }
    });
    const items = await client.listWindow('2026-08-25T00:00:00Z', '2026-10-08T00:00:00Z');
    assert.deepStrictEqual(items.map(e => e.id), ['a', 'b', 'c']);
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].includes('pageToken=p2'));
});

test('D3-D6: reconcile 分類——時間變更/已刪除/狀態碼/手動新增；無關事件忽略', () => {
    const lessons = S.generateMonthLessons(student(), '2026-09'); // 9/1,8,15,22,29
    const ids = lessons.map(l => l.lessonId);
    const evFor = (lesson, over) => Object.assign({
        id: 'ev-' + lesson.lessonId, status: 'confirmed',
        summary: S.lessonTitle(lesson), location: '',
        start: { dateTime: lesson.date + 'T' + lesson.time + ':00+08:00' },
        extendedProperties: { private: { gacLessonId: lesson.lessonId } }
    }, over || {});
    lessons[2].gcalEventId = 'ev-' + ids[2]; // 曾導入，稍後事件消失 → D4
    lessons[3].gcalEventId = null;           // 從未導入，事件缺席不算刪除
    const events = [
        evFor(lessons[0], { start: { dateTime: '2026-09-02T21:30:00+08:00' } }), // D3 時間變更 9/1→9/2
        evFor(lessons[1], { location: 'SL' }),                                    // D6 狀態碼
        evFor(lessons[4]),                                                        // 完全一致 → 無 diff
        { id: 'manual1', status: 'confirmed', summary: 'S001 补课',
          start: { dateTime: '2026-10-05T18:00:00+08:00' } },                     // D5 手動新增
        { id: 'foreign', status: 'confirmed', summary: 'Dentist',
          start: { dateTime: '2026-09-10T10:00:00+08:00' } },                     // 非本系統 → 忽略
        { id: 'gone', status: 'cancelled', summary: 'S001 x',
          start: { dateTime: '2026-09-11T10:00:00+08:00' } }                      // cancelled → 忽略
    ];
    const r = G.reconcile(lessons, events, ['S001', 'S003']);
    assert.strictEqual(r.timeChanges.length, 1);
    assert.strictEqual(r.timeChanges[0].lesson.lessonId, ids[0]);
    assert.strictEqual(r.timeChanges[0].date, '2026-09-02');
    assert.strictEqual(r.timeChanges[0].time, '21:30');
    assert.strictEqual(r.statusChanges.length, 1);
    assert.deepStrictEqual(r.statusChanges[0].to, { status: 'LEAVE', leaveType: 'SL' });
    assert.strictEqual(r.deletions.length, 1, '只有曾導入（有 gcalEventId）且事件消失的課');
    assert.strictEqual(r.deletions[0].lesson.lessonId, ids[2]);
    assert.strictEqual(r.manualNew.length, 1);
    assert.strictEqual(r.manualNew[0].studentId, 'S001');
    assert.strictEqual(r.manualNew[0].date, '2026-10-05');
    assert.strictEqual(r.manualNew[0].time, '18:00');
    // 狀態已一致 → 不再提案（勾選套用後重新對帳應歸零）
    lessons[1].status = 'LEAVE'; lessons[1].leaveType = 'SL';
    const r2 = G.reconcile(lessons, events, ['S001']);
    assert.strictEqual(r2.statusChanges.length, 0);
});
