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
            },
            remove: (eventId) => {
                const ev = events.find(e => e.id === eventId && e.status !== 'cancelled');
                if (!ev) return Promise.reject(new Error('Google Calendar API 410：Resource has been deleted'));
                ev.status = 'cancelled';
                return Promise.resolve(null);
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

test('importPrecheck：一致不報、時間/標題/狀態碼不符報 stale、標籤對不上報 orphan、無標籤/cancelled 忽略', () => {
    const lessons = S.generateMonthLessons(student(), '2026-09'); // 9/1,8,15,22,29
    const evFor = (lesson, over) => Object.assign({
        id: 'ev-' + lesson.lessonId, status: 'confirmed',
        summary: S.lessonTitle(lesson), location: '',
        start: { dateTime: lesson.date + 'T' + lesson.time + ':00+08:00' },
        extendedProperties: { private: { gacLessonId: lesson.lessonId } }
    }, over || {});
    const events = [
        evFor(lessons[0]),                                                        // 完全一致
        evFor(lessons[1], { start: { dateTime: '2026-09-09T10:00:00+08:00' } }),  // 時間不符
        evFor(lessons[2], { summary: 'S001 Student 001([9/9] 09/2026)' }),        // 標題不符（重新生成後編號變了）
        evFor(lessons[3], { location: 'SL' }),                                    // 狀態碼不符（本地 SCHEDULED）
        { id: 'orphan1', status: 'confirmed', summary: 'S001 舊課',
          start: { dateTime: '2026-09-10T10:00:00+08:00' },
          extendedProperties: { private: { gacLessonId: 'S001-OLD-ID' } } },      // 標籤對不上本地
        { id: 'manual', status: 'confirmed', summary: 'S001 手動',
          start: { dateTime: '2026-09-11T10:00:00+08:00' } },                     // 無標籤 → 忽略
        evFor(lessons[4], { status: 'cancelled' })                                // cancelled → 忽略
    ];
    const pre = G.importPrecheck(lessons, events, IMPORT_OPTS);
    assert.strictEqual(pre.existing.length, 5, '4 件對上＋1 件 orphan；無標籤與 cancelled 不算');
    assert.strictEqual(pre.stale.length, 3);
    assert.deepStrictEqual(pre.stale.map(s => s.reasons),
        [['時間'], ['標題'], ['狀態碼']]);
    assert.strictEqual(pre.orphans.length, 1);
    assert.strictEqual(pre.orphans[0].id, 'orphan1');
});

test('deleteEvents：逐件刪除；重刪回報 gone 不算失敗；刪後可重新導入', async () => {
    const lessons = S.generateMonthLessons(student(), '2026-09');
    const cal = mockCalendar();
    await G.importLessons(cal.client, lessons, IMPORT_OPTS);
    const items = lessons.map(l => ({ eventId: l.gcalEventId, lessonId: l.lessonId }));
    const r1 = await G.deleteEvents(cal.client, items);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.deleted.length, 5);
    assert.ok(cal.events.every(ev => ev.status === 'cancelled'));
    const r2 = await G.deleteEvents(cal.client, items);
    assert.strictEqual(r2.ok, true, '已不存在（410）不算失敗');
    assert.strictEqual(r2.deleted.length, 0);
    assert.strictEqual(r2.gone.length, 5);
    // 刪除後重新導入 → 全部重建（cancelled 事件不擋查重）
    lessons.forEach(l => { l.gcalEventId = null; });
    const r3 = await G.importLessons(cal.client, lessons, IMPORT_OPTS);
    assert.strictEqual(r3.inserted.length, 5);
    assert.strictEqual(r3.skipped.length, 0);
});

test('deleteEvents：傳輸失敗 → failed 帶錯誤訊息，ok=false', async () => {
    const failing = { remove: () => Promise.reject(new Error('offline')) };
    const r = await G.deleteEvents(failing, [{ eventId: 'x', lessonId: 'L1' }]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failed.length, 1);
    assert.match(r.failed[0].error, /offline/);
    assert.strictEqual(r.deleted.length, 0);
});

test('restClient：remove 走 DELETE，204 空回應視為成功', async () => {
    const calls = [];
    const client = G.createRestClient({
        token: 'tok',
        fetchFn: (url, opts) => {
            calls.push({ url, method: opts.method });
            return Promise.resolve({ ok: true, status: 204, json: () => Promise.reject(new Error('204 無 body')) });
        }
    });
    const out = await client.remove('ev123');
    assert.strictEqual(out, null);
    assert.strictEqual(calls[0].method, 'DELETE');
    assert.ok(calls[0].url.endsWith('/events/ev123'));
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

test('D8: 小組課一節一個事件——importCells 全組一件、成員回填同一 id、precheck/reconcile 按課節', async () => {
    const theory = (id) => student({ id: id, name: 'Student ' + id.slice(1), type: '5人小組', program: 'Music Theory', level: 'Grade 5', duration: 60, tutor: 'Instructor B', weekday: 6, time: '15:00' });
    const lessons = []
        .concat(S.generateMonthLessons(theory('S030'), '2026-09'))
        .concat(S.generateMonthLessons(theory('S031'), '2026-09'))
        .concat(S.generateMonthLessons(theory('S032'), '2026-09'))
        .concat(S.generateMonthLessons(student(), '2026-09')); // S001 一對一 ×5
    const cells = S.groupByCell(lessons);
    assert.strictEqual(cells.length, 4 + 5);
    const cal = mockCalendar();
    cal.client.listByCellKey = (key) => Promise.resolve(cal.events.filter(ev =>
        ev.status !== 'cancelled' && ev.extendedProperties && ev.extendedProperties.private &&
        ev.extendedProperties.private.gacCellKey === key));
    const r1 = await G.importCells(cal.client, cells, IMPORT_OPTS);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.inserted.length, 9, '4 個小組節 + 5 堂一對一 = 9 件事件（不是 12+5）');
    assert.strictEqual(cal.events.length, 9);
    const groupEv = cal.events.find(ev => ev.extendedProperties.private.gacCellKey);
    assert.strictEqual(groupEv.summary, 'Music Theory Grade 5 小組 ×3 (09/2026)');
    assert.ok(groupEv.description.includes('S030 Student 030') && groupEv.description.includes('S032 Student 032'));
    assert.strictEqual(groupEv.extendedProperties.private.gacLessonIds.split(',').length, 3);
    // 三位成員回填同一事件 id
    const sat1 = lessons.filter(l => l.date === '2026-09-05');
    assert.strictEqual(sat1.length, 3);
    assert.ok(sat1.every(l => l.gcalEventId === groupEv.id));
    // 再導入 → 全 skip
    const r2 = await G.importCells(cal.client, cells, IMPORT_OPTS);
    assert.strictEqual(r2.inserted.length, 0);
    assert.strictEqual(r2.skipped.length, 9);
    // precheck：全部一致；把小組事件挪時間 → 該節 stale「時間」；成員少一人 → 「成員」
    let pre = G.importPrecheck(lessons, cal.events, IMPORT_OPTS);
    assert.strictEqual(pre.stale.length, 0);
    assert.strictEqual(pre.orphans.length, 0);
    groupEv.start.dateTime = '2026-09-05T16:00:00+08:00';
    pre = G.importPrecheck(lessons, cal.events, IMPORT_OPTS);
    assert.deepStrictEqual(pre.stale.map(s => s.reasons), [['時間']]);
    // reconcile：時間變更帶全體 3 位成員；小組事件 location=TL → 狀態碼變更帶全體
    groupEv.location = 'TL';
    const diff = G.reconcile(lessons, cal.events, ['S001', 'S030', 'S031', 'S032']);
    assert.strictEqual(diff.timeChanges.length, 1);
    assert.strictEqual(diff.timeChanges[0].lessons.length, 3);
    assert.strictEqual(diff.timeChanges[0].time, '16:00');
    assert.strictEqual(diff.statusChanges.length, 1);
    assert.deepStrictEqual(diff.statusChanges[0].to, { status: 'LEAVE', leaveType: 'TL' });
    assert.strictEqual(diff.deletions.length, 0);
    // 舊格式：小組成員各自的逐人事件（gacLessonId 標籤）→ key 對不上小組節 → 殘留 orphan，且不算「已刪除」
    const legacy = { id: 'legacy1', status: 'confirmed', summary: 'S030 Student 030([2/4] 09/2026)', location: '',
        start: { dateTime: '2026-09-12T15:00:00+08:00' }, extendedProperties: { private: { gacLessonId: 'S030-20260912-1500' } } };
    cal.events.push(legacy);
    cal.events.find(ev => ev.extendedProperties.private.gacCellKey && ev.start.dateTime.startsWith('2026-09-12')).status = 'cancelled';
    lessons.filter(l => l.date === '2026-09-12').forEach(l => { l.gcalEventId = 'legacy1'; });
    pre = G.importPrecheck(lessons, cal.events, IMPORT_OPTS);
    assert.ok(pre.orphans.some(ev => ev.id === 'legacy1'), '逐人舊事件成殘留');
    const diff2 = G.reconcile(lessons, cal.events, ['S030', 'S031', 'S032', 'S001']);
    assert.strictEqual(diff2.deletions.length, 0, '成員連結的事件仍存在（舊格式）→ 不是刪除，交由殘留組清理');
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

test('D9: reconcileByContent——無標籤事件按學生 ID／姓名／小組名稱配對：同日時間變更、狀態碼、Calendar 沒有（只限已排課）、手動新建、無法歸屬、導師範圍、刪除日期範圍、標籤事件略過', () => {
    const lessons = S.generateMonthLessons(student(), '2026-09'); // S001 週二 9/1,8,15,22,29 21:30
    const s2 = S.generateMonthLessons(student({ id: 'S002', name: 'Student 002', tutor: 'Instructor B', weekday: 3 }), '2026-09'); // 週三
    lessons[4].status = 'ATTENDED';
    const g = (date, sid) => ({
        lessonId: sid + '-G01-' + date, studentId: sid, studentName: sid, tutor: 'Instructor B', date: date, time: '15:00', duration: 60,
        status: 'SCHEDULED', leaveType: '', isMakeup: false, groupId: 'G01', groupName: '樂理 Grade 5 小組', program: 'Music Theory', level: 'Grade 5'
    });
    const groupLessons = [g('2026-09-05', 'S020'), g('2026-09-05', 'S021')];
    const all = lessons.concat(s2, groupLessons);
    const ev = (id, summary, dt, extra) => Object.assign({ id: id, status: 'confirmed', summary: summary, location: '', start: { dateTime: dt } }, extra || {});
    const events = [
        ev('e1', 'S001 Student 001', '2026-09-01T21:30:00'),            // 一致
        ev('e2', 'Student 001 guitar', '2026-09-08T20:00:00'),           // 姓名配對、時間變更
        ev('e3', 'S001 Student 001', '2026-09-15T21:30:00', { location: 'SL' }), // 狀態碼
        ev('e4', 'S001 補課', '2026-09-10T18:00:00'),                      // 當天沒課 → 手動新建
        ev('e5', 'Dentist', '2026-09-11T10:00:00'),                        // 無法歸屬
        ev('e6', '樂理 Grade 5 小組', '2026-09-05T16:00:00'),               // 小組名稱、時間變更（全組）
        ev('e7', '樂理 Grade 5 小組', '2026-09-12T15:00:00'),               // 小組無對應課節 → 無法歸屬（不收編）
        ev('e8', 'S001 tagged', '2026-09-22T21:30:00', { extendedProperties: { private: { gacLessonId: 'x' } } }), // 帶標籤 → 略過
        { id: 'e9', status: 'cancelled', summary: 'S001 x', start: { dateTime: '2026-09-22T21:30:00' } }
    ];
    const students = [{ id: 'S001', name: 'Student 001' }, { id: 'S002', name: 'Student 002' }, { id: 'S020', name: 'Student 020' }, { id: 'S021', name: 'Student 021' }];
    const groups = [{ id: 'G01', name: '樂理 Grade 5 小組' }];
    const r = G.reconcileByContent(all, events, { students: students, groups: groups });
    assert.deepStrictEqual(r.timeChanges.map(c => [c.lesson.lessonId, c.time, c.lessons.length]), [[lessons[1].lessonId, '20:00', 1], ['S020-G01-2026-09-05', '16:00', 2]]);
    assert.strictEqual(r.statusChanges.length, 1);
    assert.strictEqual(r.statusChanges[0].lesson.lessonId, lessons[2].lessonId);
    assert.deepStrictEqual(r.statusChanges[0].to, { status: 'LEAVE', leaveType: 'SL' });
    assert.deepStrictEqual(r.manualNew.map(m => [m.studentId, m.date, m.time]), [['S001', '2026-09-10', '18:00']]);
    assert.deepStrictEqual(r.unmatched.map(e => e.id), ['e5', 'e7']);
    // Calendar 沒有：S001 9/22（e8 帶標籤不算、e9 cancelled 不算）；9/29 已上課不列；S002 週三全部沒事件 → 5 節
    const delIds = r.deletions.map(d => d.lesson.lessonId);
    assert.ok(delIds.includes(lessons[3].lessonId));
    assert.ok(!delIds.includes(lessons[4].lessonId), '已上課不因 Calendar 缺席而動');
    assert.strictEqual(delIds.filter(id => id.startsWith('S002')).length, 5);
    assert.strictEqual(r.matched, 4);
    // 導師範圍：只比 Instructor A 的課 → S002／小組不在範圍（小組事件變成無法歸屬）
    const rA = G.reconcileByContent(all, events, { students: students, groups: groups, tutor: 'Instructor A' });
    assert.strictEqual(rA.deletions.length, 1);
    assert.strictEqual(rA.timeChanges.length, 1);
    assert.deepStrictEqual(rA.unmatched.map(e => e.id), ['e5', 'e6', 'e7']);
    // 刪除只看指定範圍
    const rW = G.reconcileByContent(all, events, { students: students, groups: groups, tutor: 'Instructor A', deleteTo: '2026-09-20' });
    assert.strictEqual(rW.deletions.length, 0);
    // 已由標籤配對的課節跳過
    const skip = {}; skip[S.groupByCell([lessons[1]])[0].key] = true;
    const rS = G.reconcileByContent(all, events, { students: students, groups: groups, tutor: 'Instructor A', skipCellKeys: skip });
    assert.strictEqual(rS.timeChanges.length, 0);
    assert.deepStrictEqual(rS.manualNew.map(m => m.date), ['2026-09-08', '2026-09-10'], '該節被跳過 → 其事件成為手動新建');
    // 狀態已一致 → 不再提案
    lessons[2].status = 'LEAVE'; lessons[2].leaveType = 'SL';
    assert.strictEqual(G.reconcileByContent(all, events, { students: students, groups: groups }).statusChanges.length, 0);
    assert.strictEqual(G.matchStudent('student 001 lesson', students), 'S001', '姓名不分大小寫');
    assert.strictEqual(G.matchStudent('S0012 x', students), null, 'ID 詞邊界');
    assert.strictEqual(G.matchStudent('Student 0', students), null, '姓名要完整出現');
});
