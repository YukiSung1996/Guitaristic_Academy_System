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
    // 說明欄「狀態：」一行優先於 location 與 summary；接受小寫、中文、碼後加註；空白／看不懂 → 退回 location
    assert.deepStrictEqual(G.parseStatusCode({ description: '一對一 · Pop Guitar\n導師：Instructor A\n狀態：NS\n（提示）', location: 'L' }), { status: 'NOSHOW', leaveType: '' }, '說明欄優先');
    assert.deepStrictEqual(G.parseStatusCode({ description: '狀態：sl' }), { status: 'LEAVE', leaveType: 'SL' }, '小寫也認');
    assert.deepStrictEqual(G.parseStatusCode({ description: '狀態：導師請假' }), { status: 'LEAVE', leaveType: 'TL' }, '中文');
    assert.deepStrictEqual(G.parseStatusCode({ description: '狀態：請假（家長早上通知）' }), { status: 'LEAVE', leaveType: 'L' }, '碼後加註');
    assert.deepStrictEqual(G.parseStatusCode({ description: '狀態: L' }), { status: 'LEAVE', leaveType: 'L' }, '半形冒號');
    assert.deepStrictEqual(G.parseStatusCode({ description: '狀態：\n（提示）', location: 'NS' }), { status: 'NOSHOW', leaveType: '' }, '空白 → 退回 location');
    assert.strictEqual(G.parseStatusCode({ description: '狀態：補堂' }), null, '補堂只是標記');
    assert.strictEqual(G.parseStatusCode({ description: '狀態：亂打' }), null, '看不懂當沒填');
});

test('出席碼 A：說明欄／地點欄認 A 與「出席」→ ATTENDED；標題裡的 A 不算；留空而課已結束＝出席（planStatusSync／reconcileByContent 帶 now）；寫回出席只寫說明欄', () => {
    assert.deepStrictEqual(G.parseStatusCode({ description: '狀態：A' }), { status: 'ATTENDED', leaveType: '' });
    assert.deepStrictEqual(G.parseStatusCode({ description: '狀態：出席' }), { status: 'ATTENDED', leaveType: '' });
    assert.deepStrictEqual(G.parseStatusCode({ description: '狀態：已上課' }), { status: 'ATTENDED', leaveType: '' });
    assert.deepStrictEqual(G.parseStatusCode({ location: 'A' }), { status: 'ATTENDED', leaveType: '' });
    assert.strictEqual(G.parseStatusCode({ summary: 'S001 Student A' }), null, '標題裡的 A 不當出席碼');
    assert.strictEqual(G.calStatusCode({ description: '狀態：A' }), 'A');
    assert.strictEqual(G.localStatusCode({ status: 'ATTENDED' }), 'A');
    const L = (st, lt, id) => ({ lessonId: id || 'x', studentId: 'S001', date: '2026-09-10', time: '15:00', duration: 45, status: st, leaveType: lt || '' });
    const cell = (...ls) => ({ key: 'k', isGroup: ls.length > 1, lessons: ls });
    const ev = code => ({ id: 'e', description: '一對一\n導師：A\n狀態：' + code });
    const shape = r => [r.toLocal.map(x => x.to.status + (x.blank ? '/blank' : '')), r.toGcal.map(x => x.code)];
    const after = new Date(2026, 8, 10, 16, 0), before = new Date(2026, 8, 10, 15, 30);
    assert.strictEqual(G.lessonEnded(L('SCHEDULED'), after), true);
    assert.strictEqual(G.lessonEnded(L('SCHEDULED'), before), false, '15:00 開始 45 分鐘，15:30 還沒結束');
    assert.strictEqual(G.lessonEnded(L('SCHEDULED'), null), false);
    // 留空：課已結束、全員仍已排課 → 出席（標 blank）；還沒結束 → 不動；沒給 now → 不動
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('SCHEDULED')), event: ev('') }], 'gcal', { now: after })), [['ATTENDED/blank'], []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('SCHEDULED')), event: ev('') }], 'gcal', { now: before })), [[], []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('SCHEDULED')), event: ev('') }], 'gcal')), [[], []]);
    // 留空但本地已有資訊 → 照舊寫回；本地已上課 → 相同不動；小組成員不一 → 不動
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('NOSHOW')), event: ev('') }], 'gcal', { now: after })), [[], ['NS']]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('ATTENDED')), event: ev('') }], 'local', { now: after })), [[], []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('ATTENDED', '', 'a'), L('SCHEDULED', '', 'b')), event: ev('') }], 'gcal', { now: after })), [[], []]);
    // 明確填 A：本地已排課 → 出席（不看時間）；本地已上課 → 相同不動；本地請假：Calendar 為準 → 出席、本系統為準 → 寫回 L
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('SCHEDULED')), event: ev('A') }], 'gcal')), [['ATTENDED'], []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('ATTENDED')), event: ev('A') }], 'local')), [[], []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('LEAVE', 'L')), event: ev('A') }], 'gcal')), [['ATTENDED'], []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('LEAVE', 'L')), event: ev('A') }], 'local')), [[], ['L']]);
    // 寫回出席：說明欄「狀態：A」，地點欄留空（補堂回到 MU）
    assert.deepStrictEqual(G.statusPatchPayload(cell(L('ATTENDED')), 'A', { description: 'x\n狀態：L\ny' }), { location: '', description: 'x\n狀態：A\ny' });
    assert.deepStrictEqual(G.statusPatchPayload(cell(Object.assign(L('ATTENDED'), { isMakeup: true })), 'A', { description: '狀態：L' }), { location: 'MU', description: '狀態：A' });
    // 按內容對帳（匯入 ICS 走這裡）同一規則
    const lessons = [Object.assign(L('SCHEDULED', '', 'S001-20260910-1500'), { studentName: 'Student 001', classType: '一對一', tutor: 'Instructor A' })];
    const events = [{ id: 'e1', status: 'confirmed', summary: 'S001 Student 001', start: { dateTime: '2026-09-10T15:00:00+08:00' }, end: { dateTime: '2026-09-10T15:45:00+08:00' } }];
    const students = [{ id: 'S001', name: 'Student 001' }];
    const rc = G.reconcileByContent(lessons, events, { students, groups: [], now: after });
    assert.strictEqual(rc.statusChanges.length, 1);
    assert.deepStrictEqual(rc.statusChanges[0].to, { status: 'ATTENDED', leaveType: '' });
    assert.strictEqual(rc.statusChanges[0].blank, true);
    assert.strictEqual(G.reconcileByContent(lessons, events, { students, groups: [] }).statusChanges.length, 0, '沒給 now 不判斷');
    assert.strictEqual(G.reconcileByContent(lessons, events, { students, groups: [], now: before }).statusChanges.length, 0, '還沒結束不判斷');
});

test('describeLesson／describeCell：第一行具體課程、導師、狀態：一行、提示；補堂加原課；小組列成員；不含電話電郵', () => {
    const one = G.describeLesson({ studentId: 'S001', studentName: 'Student 001', classType: '一對一', program: 'Pop Guitar', level: 'Intermediate 中級', tutor: 'Instructor A', status: 'SCHEDULED', phone: '00000000', email: 'x@example.com' });
    assert.deepStrictEqual(one.split('\n'), ['一對一 · Pop Guitar · Intermediate 中級', '導師：Instructor A', '狀態：', '（出席留空或填 A；請假填 L、病假 SL、導師請假 TL、缺席 NS。系統同步時讀這一行）']);
    assert.ok(!one.includes('00000000') && !one.includes('example.com'));
    const mu = G.describeLesson({ studentId: 'S001', classType: '一對一', program: 'Pop Guitar', tutor: 'Instructor A', status: 'SCHEDULED', isMakeup: true, originLessonId: 'S001-20260916-1500' });
    assert.strictEqual(mu.split('\n')[0], '補堂 · 一對一 · Pop Guitar');
    assert.strictEqual(mu.split('\n')[1], '↩ 補的是：2026-09-16（三）15:00 請假的那一堂', '第二行就寫補哪一堂（含星期）');
    assert.strictEqual(mu.split('\n')[3], '狀態：MU');
    assert.strictEqual(G.statusFromDescription(mu), 'MU', '多了一行不影響讀狀態');
    const leave = G.describeLesson({ classType: '一對一', program: 'Pop Guitar', tutor: 'Instructor A', status: 'LEAVE', leaveType: 'SL' });
    assert.strictEqual(leave.split('\n')[2], '狀態：SL');
    const cell = { isGroup: true, lessons: [
        { studentId: 'S030', studentName: 'Student 030', groupName: '樂理 Grade 5 小組', program: 'Music Theory', tutor: 'Instructor B', status: 'SCHEDULED' },
        { studentId: 'S031', studentName: 'Student 031', groupName: '樂理 Grade 5 小組', program: 'Music Theory', tutor: 'Instructor B', status: 'SCHEDULED' }
    ] };
    const g = G.describeCell(cell).split('\n');
    assert.deepStrictEqual(g.slice(0, 5), ['小組課 · 樂理 Grade 5 小組', '導師：Instructor B', '狀態：', '（出席留空或填 A；請假填 L、病假 SL、導師請假 TL、缺席 NS。系統同步時讀這一行）', '成員：']);
    assert.deepStrictEqual(g.slice(5), ['S030 Student 030', 'S031 Student 031']);
    // 自己寫出去的說明，自己讀回來：沒填狀態 → null
    assert.strictEqual(G.parseStatusCode({ description: one }), null);
});

test('補堂事件標題：「補堂」＋「← 原課 MM/DD」；常規課與加課不變；小組補堂同樣', () => {
    const mu = { studentId: 'S001', studentName: 'Student 001', lessonNum: 2, totalRegular: 5, monthRef: '09/2026', isMakeup: true, originLessonId: 'S001-20260916-1500' };
    assert.strictEqual(S.lessonTitle(mu), 'S001 Student 001 補堂([2/5] 09/2026 ← 09/16)');
    assert.strictEqual(G.matchStudentPrefix(S.lessonTitle(mu), ['S001']), 'S001', '學號前綴錨點不變');
    assert.strictEqual(G.parseStatusCode({ summary: S.lessonTitle(mu) }), null, '標題不會被讀成狀態碼');
    assert.strictEqual(S.lessonTitle(Object.assign({}, mu, { isMakeup: false, originLessonId: null })), 'S001 Student 001([2/5] 09/2026)');
    assert.strictEqual(S.lessonTitle({ studentId: 'S001', studentName: 'Student 001', lessonNum: 0, totalRegular: 0, monthRef: '09/2026', isMakeup: true, originLessonId: null }),
        'S001 Student 001([0/0] 09/2026)', '加課沒有原課 → 不加');
    const gm = (sid) => ({ lessonId: sid + '-20260926-1500-MU-20260905-1500', studentId: sid, studentName: sid, tutor: 'Instructor B', date: '2026-09-26', time: '15:00', duration: 60,
        status: 'SCHEDULED', isMakeup: true, originLessonId: sid + '-20260905-1500', groupId: 'G01', groupName: '樂理 Grade 5 小組', monthRef: '09/2026' });
    const cell = S.groupByCell([gm('S020'), gm('S021')])[0];
    const p = G.cellToEventPayload(cell, IMPORT_OPTS);
    assert.strictEqual(p.summary, '樂理 Grade 5 小組 補堂 ×2 (09/2026 ← 09/05)');
    assert.ok(p.description.startsWith('補堂 · 小組課 · 樂理 Grade 5 小組\n↩ 補的是：2026-09-05（六）15:00 請假的那一堂'));
});

test('noteLocalMove：記下 Calendar 上原本的 key／時段；連改兩次只記第一次；搬回原時段就清掉', () => {
    const l = { lessonId: 'S001-20260924-1000-MU-20260916-1500', studentId: 'S001', date: '2026-09-24', time: '10:00', isMakeup: true, gcalEventId: 'evMU' };
    const snap = G.moveSnapshot(l);
    const l2 = Object.assign({}, l, { lessonId: 'S001-20260925-1100-MU-20260916-1500', date: '2026-09-25', time: '11:00', gcalEventId: null });
    G.noteLocalMove(l2, snap);
    assert.deepStrictEqual(l2.gcalMovedFrom, { key: l.lessonId, date: '2026-09-24', time: '10:00', inCal: true });
    assert.strictEqual(l2.gcalEventId, 'evMU', '事件 id 交接給新補堂');
    const l3 = Object.assign({}, l2, { lessonId: 'S001-20260926-1400-MU-20260916-1500', date: '2026-09-26', time: '14:00' });
    G.noteLocalMove(l3, G.moveSnapshot(l2));
    assert.strictEqual(l3.gcalMovedFrom.key, l.lessonId, 'Calendar 上的仍是第一次的');
    const back = Object.assign({}, l3, { lessonId: l.lessonId, date: '2026-09-24', time: '10:00' });
    G.noteLocalMove(back, G.moveSnapshot(l3));
    assert.strictEqual(back.gcalMovedFrom, undefined, '搬回原時段 → Calendar 不用改');
    const fresh = { lessonId: 'S001-20260901-2130', studentId: 'S001', date: '2026-09-01', time: '21:30' };
    const moved = Object.assign({}, fresh, { date: '2026-09-02' });
    G.noteLocalMove(moved, G.moveSnapshot(fresh));
    assert.strictEqual(moved.gcalMovedFrom.inCal, false, '沒推送過、沒按過加進 GCal → 不確定在 Calendar');
});

test('planLocalMoves：本地改期 ↔ Calendar 原事件——換了 key 靠舊 key／事件 id 認回；同 key 看時間；只差標籤；已好；Calendar 也改過不搶；舊 key 仍在用不搶', () => {
    const ev = (id, key, dt) => ({ id: id, status: 'confirmed', summary: 'x', start: { dateTime: dt }, extendedProperties: { private: { gacLessonId: key } } });
    const mk = (id, date, time, mf, extra) => Object.assign({ lessonId: id, studentId: 'S001', date: date, time: time, isMakeup: true, gcalMovedFrom: mf }, extra || {});
    const oldMu = 'S001-20260924-1000-MU-20260916-1500';
    // 補堂換了 id：舊 key 的事件還在舊時間 → move
    let r = G.planLocalMoves([mk('S001-20260925-1100-MU-20260916-1500', '2026-09-25', '11:00', { key: oldMu, date: '2026-09-24', time: '10:00', inCal: true })],
        [ev('evMU', oldMu, '2026-09-24T10:00:00+08:00')]);
    assert.deepStrictEqual(r.moves.map(m => [m.event.id, m.from.date, m.from.time, m.tagOnly]), [['evMU', '2026-09-24', '10:00', false]]);
    // 事件在 Calendar 上已被拖到新時間（只差標籤）→ tagOnly
    r = G.planLocalMoves([mk('S001-20260925-1100-MU-20260916-1500', '2026-09-25', '11:00', { key: oldMu, date: '2026-09-24', time: '10:00', inCal: true })],
        [ev('evMU', oldMu, '2026-09-25T11:00:00+08:00')]);
    assert.strictEqual(r.moves[0].tagOnly, true);
    // 舊 key 找不到，但成員記著事件 id（收編的手動事件／無標籤）→ 仍認得
    r = G.planLocalMoves([mk('S001-20260925-1100-MU-20260916-1500', '2026-09-25', '11:00', { key: oldMu, date: '2026-09-24', time: '10:00', inCal: true }, { gcalEventId: 'm1' })],
        [{ id: 'm1', status: 'confirmed', summary: 'S001 補課', start: { dateTime: '2026-09-24T10:00:00+08:00' } }]);
    assert.strictEqual(r.moves.length, 1);
    // 常規課改期（id 不變）：事件在舊時間 → move；在新時間 → settled；在第三個時間（Calendar 也改過）→ 都不列
    const reg = () => ({ lessonId: 'S001-20260901-2130', studentId: 'S001', date: '2026-09-02', time: '20:00', gcalMovedFrom: { key: 'S001-20260901-2130', date: '2026-09-01', time: '21:30', inCal: true } });
    r = G.planLocalMoves([reg()], [ev('e1', 'S001-20260901-2130', '2026-09-01T21:30:00+08:00')]);
    assert.strictEqual(r.moves.length, 1);
    r = G.planLocalMoves([reg()], [ev('e1', 'S001-20260901-2130', '2026-09-02T20:00:00+08:00')]);
    assert.deepStrictEqual([r.moves.length, r.settled.length], [0, 1]);
    r = G.planLocalMoves([reg()], [ev('e1', 'S001-20260901-2130', '2026-09-03T09:00:00+08:00')]);
    assert.deepStrictEqual([r.moves.length, r.settled.length, r.conflicts.length], [0, 0, 1], 'Calendar 也改過 → 衝突，由設定決定方向');
    assert.deepStrictEqual([r.conflicts[0].at.date, r.conflicts[0].at.time], ['2026-09-03', '09:00']);
    // 舊 key 仍是本地的一節（例如小組只搬了部分成員）→ 那個事件屬於留下的課
    const stay = { lessonId: oldMu, studentId: 'S001', date: '2026-09-24', time: '10:00', isMakeup: true };
    r = G.planLocalMoves([stay, mk('S001-20260925-1100-MU-20260916-1500', '2026-09-25', '11:00', { key: oldMu, date: '2026-09-24', time: '10:00', inCal: true })],
        [ev('evMU', oldMu, '2026-09-24T10:00:00+08:00')]);
    assert.strictEqual(r.moves.length, 0);
    // PATCH 內容：新時間＋新標籤，另一型態的標籤設 null
    const cell = S.groupByCell([mk('S001-20260925-1100-MU-20260916-1500', '2026-09-25', '11:00', null, { studentName: 'Student 001', lessonNum: 2, totalRegular: 5, monthRef: '09/2026', duration: 45, originLessonId: 'S001-20260916-1500' })])[0];
    const pp = G.movePatchPayload(cell, IMPORT_OPTS);
    assert.strictEqual(pp.start.dateTime, '2026-09-25T11:00:00');
    assert.deepStrictEqual(pp.extendedProperties.private, { gacLessonId: 'S001-20260925-1100-MU-20260916-1500', gacCellKey: null, gacLessonIds: null });
});

test('reconcile：key 對不上時靠成員記著的事件 id 認回（小組在 Calendar 被挪過 key 換了、收編的手動事件）；認回的不算手動新建', () => {
    const g = (sid) => ({ lessonId: sid + '-20260905-1500', studentId: sid, studentName: sid, tutor: 'Instructor B', date: '2026-09-06', time: '16:00', duration: 60,
        status: 'SCHEDULED', leaveType: '', groupId: 'G01', groupName: '樂理 Grade 5 小組', gcalEventId: 'evG' });
    const lessons = [g('S020'), g('S021')];
    const events = [{ id: 'evG', status: 'confirmed', summary: '樂理', start: { dateTime: '2026-09-06T16:00:00+08:00' },
        extendedProperties: { private: { gacCellKey: 'G|G01|2026-09-05|15:00', gacLessonIds: 'S020-20260905-1500,S021-20260905-1500' } } },
        { id: 'm1', status: 'confirmed', summary: 'S001 補課', start: { dateTime: '2026-09-10T18:00:00+08:00' } }];
    const extra = { lessonId: 'S001-20260910-1800-XT', studentId: 'S001', date: '2026-09-10', time: '18:00', status: 'SCHEDULED', isMakeup: true, gcalEventId: 'm1' };
    const r = G.reconcile(lessons.concat([extra]), events, ['S001', 'S020', 'S021']);
    assert.deepStrictEqual([r.timeChanges.length, r.deletions.length, r.manualNew.length], [0, 0, 0]);
    assert.ok(r.matchedKeys['G|G01|2026-09-06|16:00'] && r.matchedKeys['S001-20260910-1800-XT']);
    assert.ok(r.matchedEventIds.evG && r.matchedEventIds.m1);
    assert.deepStrictEqual(r.pairs.map(p => [p.cell.key, p.event.id]), [['G|G01|2026-09-06|16:00', 'evG'], ['S001-20260910-1800-XT', 'm1']], '配對結果供狀態雙向用');
});

test('planStatusSync：只有一邊有資訊就流向另一邊；兩邊都有且不同看規則；已上課與小組不一的特例', () => {
    const L = (st, lt, id) => ({ lessonId: id || 'x', studentId: 'S001', status: st, leaveType: lt || '' });
    const cell = (...ls) => ({ key: 'k', isGroup: ls.length > 1, lessons: ls });
    const ev = code => ({ id: 'e', description: '一對一\n導師：A\n狀態：' + code });
    const shape = r => [r.toLocal.length, r.toGcal.map(x => x.code)];
    // Calendar 沒碼、本地請假 → 寫回（兩種規則都一樣）
    ['gcal', 'local'].forEach(rule => assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('LEAVE', 'SL')), event: ev('') }], rule)), [0, ['SL']], rule));
    // 本地沒資訊、Calendar 有 → 拉回（兩種規則都一樣）
    ['gcal', 'local'].forEach(rule => {
        const r = G.planStatusSync([{ cell: cell(L('SCHEDULED')), event: ev('NS') }], rule);
        assert.deepStrictEqual(shape(r), [1, []], rule);
        assert.deepStrictEqual(r.toLocal[0].to, { status: 'NOSHOW', leaveType: '' });
    });
    // 相同 → 不動
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('LEAVE', 'L')), event: ev('L') }], 'local')), [0, []]);
    // 不同：Calendar 為準 → 拉回；本系統為準 → 寫回
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('LEAVE', 'L')), event: ev('SL') }], 'gcal')), [1, []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('LEAVE', 'L')), event: ev('SL') }], 'local')), [0, ['L']]);
    // 已上課：Calendar 沒碼 → 不動；Calendar 有碼：本系統為準 → 清掉碼（''）、Calendar 為準 → 拉回
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('ATTENDED')), event: ev('') }], 'local')), [0, []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('ATTENDED')), event: ev('L') }], 'local')), [0, ['A']]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('ATTENDED')), event: ev('L') }], 'gcal')), [1, []]);
    // 小組成員不一：Calendar 沒碼 → 不動；Calendar 有碼：Calendar 為準照舊拉回、本系統為準一個碼表達不了 → 不動
    const mixed = cell(L('LEAVE', 'L', 'a'), L('SCHEDULED', '', 'b'));
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: mixed, event: ev('') }], 'local')), [0, []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: mixed, event: ev('TL') }], 'gcal')), [1, []]);
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: mixed, event: ev('TL') }], 'local')), [0, []]);
    // 全組同碼 → 一個碼寫回
    assert.deepStrictEqual(shape(G.planStatusSync([{ cell: cell(L('LEAVE', 'TL', 'a'), L('LEAVE', 'TL', 'b')), event: ev('') }], 'gcal')), [0, ['TL']]);
});

test('statusPatchPayload：只改地點欄與說明欄「狀態：」一行，其他行保留；沒有那一行才整份重寫；補堂清碼回到 MU；eidFromLink', () => {
    const l = { lessonId: 'S001-20260916-1500', studentId: 'S001', studentName: 'Student 001', classType: '一對一', program: 'Pop Guitar', tutor: 'Instructor A', status: 'NOSHOW', leaveType: '' };
    const c = { key: l.lessonId, isGroup: false, lessons: [l] };
    const p = G.statusPatchPayload(c, 'NS', { description: '一對一 · Pop Guitar\n導師：Instructor A\n狀態：\n（提示）\n導師的筆記' });
    assert.deepStrictEqual(p, { location: 'NS', description: '一對一 · Pop Guitar\n導師：Instructor A\n狀態：NS\n（提示）\n導師的筆記' });
    assert.deepStrictEqual(Object.keys(p), ['location', 'description'], 'PATCH 不碰時間／標題／標籤');
    const p2 = G.statusPatchPayload(c, 'NS', { description: 'hand made' });
    assert.ok(p2.description.startsWith('一對一 · Pop Guitar') && p2.description.includes('狀態：NS'), '沒有「狀態：」一行 → 整份重寫');
    const mu = Object.assign({}, l, { status: 'ATTENDED', isMakeup: true, originLessonId: 'S001-20260909-1500' });
    assert.deepStrictEqual(G.statusPatchPayload({ key: 'm', isGroup: false, lessons: [mu] }, '', { description: '補堂 · 一對一\n狀態：L' }),
        { location: 'MU', description: '補堂 · 一對一\n狀態：MU' });
    assert.strictEqual(G.eidFromLink('https://www.google.com/calendar/event?eid=abc_DEF-123&x=1'), 'abc_DEF-123');
    assert.strictEqual(G.eidFromLink(''), '');
    assert.strictEqual(G.calStatusCode({ description: '狀態：病假' }), 'SL');
    assert.strictEqual(G.calStatusCode({ location: 'MU' }), null);
});

test('D10: reconcileByContent——本地改期過的課：Calendar 仍在舊時段 → staleMoves（不是手動新建、不是 Calendar 沒有、不改回本地）；新時間也有事件 → 舊的是重複；改好 → settled', () => {
    const base = { studentId: 'S001', studentName: 'Student 001', tutor: 'Instructor A', duration: 45, status: 'SCHEDULED', leaveType: '', isMakeup: true, originLessonId: 'S001-20260916-2130' };
    const mu = Object.assign({ lessonId: 'S001-20260926-1400-MU-20260916-2130', date: '2026-09-26', time: '14:00',
        gcalMovedFrom: { key: 'S001-20260925-1100-MU-20260916-2130', date: '2026-09-25', time: '11:00', inCal: true } }, base);
    const students = [{ id: 'S001', name: 'Student 001' }];
    const ev = (id, dt) => ({ id: id, status: 'confirmed', summary: 'S001 Student 001 補堂', htmlLink: 'https://calendar.google.com/event?eid=' + id, start: { dateTime: dt } });
    // 換了日子：舊事件在 9/25
    let r = G.reconcileByContent([mu], [ev('t1', '2026-09-25T11:00:00')], { students: students });
    assert.deepStrictEqual(r.staleMoves.map(m => [m.event.id, m.from.date, m.from.time, m.duplicate]), [['t1', '2026-09-25', '11:00', false]]);
    assert.deepStrictEqual([r.manualNew.length, r.deletions.length, r.timeChanges.length], [0, 0, 0]);
    // 新時間也已有一個（又按了加進 GCal）→ 舊的是重複
    r = G.reconcileByContent([mu], [ev('t2', '2026-09-26T14:00:00'), ev('t1', '2026-09-25T11:00:00')], { students: students });
    assert.deepStrictEqual(r.staleMoves.map(m => [m.event.id, m.duplicate]), [['t1', true]]);
    // 同一天只改時間：不當「Calendar 改了時間」
    const same = Object.assign({}, mu, { date: '2026-09-25', time: '15:00' });
    r = G.reconcileByContent([same], [ev('t1', '2026-09-25T11:00:00')], { students: students });
    assert.deepStrictEqual([r.staleMoves.length, r.timeChanges.length], [1, 0]);
    // 導師在 Calendar 改好了 → settled
    r = G.reconcileByContent([mu], [ev('t1', '2026-09-26T14:00:00')], { students: students });
    assert.deepStrictEqual([r.staleMoves.length, r.settled.length, r.manualNew.length, r.deletions.length], [0, 1, 0, 0]);
    // 沒有改期記號的課，照舊：不同日子的事件是手動新建、本地那節是 Calendar 沒有
    const plain = Object.assign({}, mu, { gcalMovedFrom: undefined });
    r = G.reconcileByContent([plain], [ev('t1', '2026-09-25T11:00:00')], { students: students });
    assert.deepStrictEqual([r.staleMoves.length, r.manualNew.length, r.deletions.length], [0, 1, 1]);
});

test('導出 .ics 的 UID ↔ 課節 key：一對一與小組都能從 iCalUID 認回；手動事件 null', () => {
    const one = 'S001-20260907-2130';
    const grp = 'G|G01|2026-09-05|15:00';
    assert.strictEqual(G.icsUidForCellKey(one), 'S001-20260907-2130@guitaristic', '一對一編碼後不變，與舊檔相容');
    assert.strictEqual(G.eventCellKey({ iCalUID: G.icsUidForCellKey(one) }), one);
    assert.strictEqual(G.eventCellKey({ iCalUID: G.icsUidForCellKey(grp) }), grp, '小組 key 含 | 與空格也能往返');
    assert.strictEqual(G.eventCellKey({ uid: G.icsUidForCellKey(one) }), one, '本地匯入 ICS 檔的事件用 uid');
    assert.deepStrictEqual(G.eventLessonIds({ iCalUID: G.icsUidForCellKey(one) }), [one]);
    assert.deepStrictEqual(G.eventLessonIds({ iCalUID: G.icsUidForCellKey(grp) }), []);
    assert.strictEqual(G.eventCellKey({ iCalUID: 'abc123@google.com' }), null, 'Google 自己產生的 iCalUID 不算');
    assert.strictEqual(G.eventCellKey({ summary: 'S001 手動' }), null);
    assert.strictEqual(G.eventCellKey({ iCalUID: 'x@google.com', extendedProperties: { private: { gacLessonId: one } } }), one, '標籤優先');
});

test('normalizeCalendarId：網址／%40／cid= base64 都整理成 API 用的 ID', () => {
    assert.strictEqual(G.normalizeCalendarId('  abc@group.calendar.google.com \n'), 'abc@group.calendar.google.com');
    assert.strictEqual(G.normalizeCalendarId('abc%40group.calendar.google.com'), 'abc@group.calendar.google.com', '%40 → @');
    assert.strictEqual(G.normalizeCalendarId('https://calendar.google.com/calendar/embed?src=abc%40group.calendar.google.com&ctz=Asia%2FHong_Kong'), 'abc@group.calendar.google.com', 'embed 網址取 src');
    const cid = Buffer.from('abc@group.calendar.google.com').toString('base64').replace(/=+$/, '');
    assert.strictEqual(G.normalizeCalendarId('https://calendar.google.com/calendar/u/0?cid=' + cid), 'abc@group.calendar.google.com', '分享連結 cid= base64');
    assert.strictEqual(G.normalizeCalendarId('primary'), 'primary');
    assert.strictEqual(G.normalizeCalendarId('someone@gmail.com'), 'someone@gmail.com');
    assert.strictEqual(G.normalizeCalendarId(''), '');
    assert.strictEqual(G.normalizeCalendarId(null), '');
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

test('restClient：patch 走 PATCH 到該事件，body 是 JSON', async () => {
    const calls = [];
    const client = G.createRestClient({
        token: 'tok', calendarId: 'abc@group.calendar.google.com',
        fetchFn: (url, opts) => {
            calls.push({ url, method: opts.method, body: opts.body });
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'ev1' }) });
        }
    });
    const out = await client.patch('ev1', { summary: 'x' });
    assert.strictEqual(out.id, 'ev1');
    assert.strictEqual(calls[0].method, 'PATCH');
    assert.ok(calls[0].url.endsWith('/calendars/' + encodeURIComponent('abc@group.calendar.google.com') + '/events/ev1'));
    assert.deepStrictEqual(JSON.parse(calls[0].body), { summary: 'x' });
});

test('restClient：get 走 GET 該事件；move 走 POST …/events/{id}/move?destination=另一本日曆', async () => {
    const calls = [];
    const client = G.createRestClient({
        token: 'tok', calendarId: 'a@group.calendar.google.com',
        fetchFn: (url, opts) => {
            calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'ev1' }) });
        }
    });
    const got = await client.get('ev1');
    assert.strictEqual(got.id, 'ev1');
    assert.strictEqual(calls[0].method, 'GET');
    assert.ok(calls[0].url.endsWith('/calendars/' + encodeURIComponent('a@group.calendar.google.com') + '/events/ev1'));
    const moved = await client.move('ev1', 'b@group.calendar.google.com');
    assert.strictEqual(moved.id, 'ev1');
    assert.strictEqual(calls[1].method, 'POST');
    assert.strictEqual(calls[1].body, undefined, 'move 不帶 body');
    assert.ok(calls[1].url.endsWith('/calendars/' + encodeURIComponent('a@group.calendar.google.com') + '/events/ev1/move?destination=' + encodeURIComponent('b@group.calendar.google.com')));
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
    assert.strictEqual(r.pairs.length, 4, '配對結果供狀態雙向用');
    // 導師範圍：只比 Instructor A 的課 → S002／小組不在範圍（小組事件變成無法歸屬）
    const rA = G.reconcileByContent(all, events, { students: students, groups: groups, tutor: 'Instructor A' });
    assert.strictEqual(rA.deletions.length, 1);
    assert.strictEqual(rA.timeChanges.length, 1);
    assert.deepStrictEqual(rA.unmatched.map(e => e.id), ['e5', 'e6', 'e7']);
    // 刪除只看指定範圍
    const rW = G.reconcileByContent(all, events, { students: students, groups: groups, tutor: 'Instructor A', deleteTo: '2026-09-20' });
    assert.strictEqual(rW.deletions.length, 0);
    // detectMissing:false → 完全不判斷「Calendar 沒有這堂」，其餘分類照常
    const rM = G.reconcileByContent(all, events, { students: students, groups: groups, detectMissing: false });
    assert.strictEqual(rM.deletions.length, 0, '不判斷缺席');
    assert.strictEqual(rM.timeChanges.length, 2, '時間變更照常');
    assert.strictEqual(rM.statusChanges.length, 1, '狀態碼照常');
    assert.strictEqual(rM.manualNew.length, 1, '手動新建照常');
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
