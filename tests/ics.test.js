// 測試組 K：.ics 解析與展開（lib/ics.js）——Google Calendar 匯出格式
const { test } = require('node:test');
const assert = require('node:assert');
const I = require('../lib/ics.js');

const HK = 'Asia/Hong_Kong';
const ics = (body, tz) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'X-WR-CALNAME:Instructor A 課表', 'X-WR-TIMEZONE:' + (tz || HK),
    'BEGIN:VTIMEZONE', 'TZID:Asia/Hong_Kong', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:HKT', 'DTSTART:19700101T000000', 'END:STANDARD', 'END:VTIMEZONE'
].concat(body, ['END:VCALENDAR']).join('\r\n');

test('K1: 單一事件——UTC、TZID、浮動時間都換算成輸出時區牆鐘；全日事件；行摺疊與轉義；VALARM 內的 DESCRIPTION 不誤入', () => {
    const text = ics([
        'BEGIN:VEVENT', 'UID:u1@google.com', 'DTSTART:20260916T133000Z', 'DTEND:20260916T141500Z',
        'SUMMARY:S001 Student 001 \\, 補課\\; 測試', 'DESCRIPTION:第一行\\n第二行 very long description that is folded acro',
        ' ss two lines', 'LOCATION:SL', 'STATUS:CONFIRMED',
        'BEGIN:VALARM', 'TRIGGER:-P0DT0H30M0S', 'ACTION:DISPLAY', 'DESCRIPTION:This is an event reminder', 'END:VALARM',
        'END:VEVENT',
        'BEGIN:VEVENT', 'UID:u2', 'DTSTART;TZID=Asia/Hong_Kong:20260917T210000', 'DTEND;TZID=Asia/Hong_Kong:20260917T220000', 'SUMMARY:S003 Student 003', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:u3', 'DTSTART:20260918T190000', 'DURATION:PT45M', 'SUMMARY:floating', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:u4', 'DTSTART;VALUE=DATE:20260919', 'DTEND;VALUE=DATE:20260920', 'SUMMARY:全日', 'END:VEVENT'
    ]);
    const cal = I.parse(text);
    assert.strictEqual(cal.name, 'Instructor A 課表');
    assert.strictEqual(cal.timeZone, HK);
    assert.strictEqual(cal.events.length, 4);
    const ev = I.toEvents(cal, { timeZone: HK });
    assert.strictEqual(ev.length, 4);
    assert.strictEqual(ev[0].id, 'u1@google.com');
    assert.strictEqual(ev[0].start.dateTime, '2026-09-16T21:30:00', 'UTC 13:30 → 香港 21:30');
    assert.strictEqual(ev[0].end.dateTime, '2026-09-16T22:15:00');
    assert.strictEqual(ev[0].summary, 'S001 Student 001 , 補課; 測試');
    assert.strictEqual(ev[0].description, '第一行\n第二行 very long description that is folded across two lines', '摺疊行接回、\\n 轉換；VALARM 的 DESCRIPTION 不覆蓋');
    assert.strictEqual(ev[0].location, 'SL');
    assert.strictEqual(ev[0].status, 'confirmed');
    assert.strictEqual(ev[1].start.dateTime, '2026-09-17T21:00:00', 'TZID 時間原樣');
    assert.strictEqual(ev[2].start.dateTime, '2026-09-18T19:00:00', '浮動時間視為日曆時區');
    assert.strictEqual(ev[2].end.dateTime, '2026-09-18T19:45:00', 'DURATION');
    assert.deepStrictEqual(ev[3].start, { date: '2026-09-19' });
    // 換輸出時區：UTC 事件在東京是 22:30
    assert.strictEqual(I.toEvents(cal, { timeZone: 'Asia/Tokyo' })[0].start.dateTime, '2026-09-16T22:30:00');
    assert.strictEqual(I.toEvents(cal, { timeZone: 'Asia/Tokyo' })[1].start.dateTime, '2026-09-17T22:00:00', 'TZID 香港 21:00 → 東京 22:00');
});

test('K2: 每週重複——BYDAY、UNTIL、EXDATE、RECURRENCE-ID 覆寫（改時間）、視窗過濾、COUNT、INTERVAL', () => {
    const text = ics([
        'BEGIN:VEVENT', 'UID:w1', 'DTSTART;TZID=Asia/Hong_Kong:20260907T213000', 'DTEND;TZID=Asia/Hong_Kong:20260907T221500',
        'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261005T000000Z', 'EXDATE;TZID=Asia/Hong_Kong:20260928T213000', 'SUMMARY:S001 Student 001', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:w1', 'RECURRENCE-ID;TZID=Asia/Hong_Kong:20260921T213000', 'DTSTART;TZID=Asia/Hong_Kong:20260921T200000', 'DTEND;TZID=Asia/Hong_Kong:20260921T204500', 'SUMMARY:S001 Student 001（改時）', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:c1', 'DTSTART:20260902T133000Z', 'DTEND:20260902T143000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Group', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:i2', 'DTSTART;TZID=Asia/Hong_Kong:20260901T100000', 'DTEND;TZID=Asia/Hong_Kong:20260901T110000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', 'SUMMARY:BiWeekly', 'END:VEVENT'
    ]);
    const ev = I.toEvents(I.parse(text), { timeZone: HK, from: '2026-08-25', to: '2026-10-07' });
    const w1 = ev.filter(e => e.uid === 'w1').map(e => e.start.dateTime);
    assert.deepStrictEqual(w1, ['2026-09-07T21:30:00', '2026-09-14T21:30:00', '2026-09-21T20:00:00'], '9/21 用覆寫時間、9/28 被 EXDATE、10/5 超出 UNTIL');
    const w1Ov = ev.find(e => e.uid === 'w1' && e.start.dateTime.startsWith('2026-09-21'));
    assert.strictEqual(w1Ov.summary, 'S001 Student 001（改時）');
    assert.ok(w1Ov.id !== ev.find(e => e.uid === 'w1' && e.start.dateTime.startsWith('2026-09-07')).id, '各次 id 不同');
    assert.ok(ev.filter(e => e.uid === 'w1').every(e => e.recurring));
    const c1 = ev.filter(e => e.uid === 'c1').map(e => e.start.dateTime);
    assert.deepStrictEqual(c1, ['2026-09-02T21:30:00', '2026-09-09T21:30:00', '2026-09-16T21:30:00'], 'COUNT=3；UTC 母事件每次都換算成香港牆鐘');
    const i2 = ev.filter(e => e.uid === 'i2').map(e => e.start.dateTime.slice(0, 10));
    assert.deepStrictEqual(i2, ['2026-09-01', '2026-09-03', '2026-09-15', '2026-09-17', '2026-09-29', '2026-10-01'], 'INTERVAL=2 隔週二四');
    // 視窗縮小：只要 9 月中
    const mid = I.toEvents(I.parse(text), { timeZone: HK, from: '2026-09-10', to: '2026-09-20' });
    assert.deepStrictEqual(mid.filter(e => e.uid === 'w1').map(e => e.start.dateTime), ['2026-09-14T21:30:00']);
});

test('K3: 每日／每月／每年重複、月底日期跳過、不支援的 FREQ 只取首次、CANCELLED 狀態、覆寫改到視窗內', () => {
    const text = ics([
        'BEGIN:VEVENT', 'UID:d1', 'DTSTART;TZID=Asia/Hong_Kong:20260901T090000', 'DTEND;TZID=Asia/Hong_Kong:20260901T093000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:daily', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:m1', 'DTSTART;TZID=Asia/Hong_Kong:20260131T100000', 'DTEND;TZID=Asia/Hong_Kong:20260131T110000', 'RRULE:FREQ=MONTHLY;COUNT=4', 'SUMMARY:monthly31', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:y1', 'DTSTART;TZID=Asia/Hong_Kong:20250915T100000', 'DTEND;TZID=Asia/Hong_Kong:20250915T110000', 'RRULE:FREQ=YEARLY', 'SUMMARY:yearly', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:x1', 'DTSTART;TZID=Asia/Hong_Kong:20260903T100000', 'DTEND;TZID=Asia/Hong_Kong:20260903T110000', 'RRULE:FREQ=HOURLY;COUNT=5', 'SUMMARY:hourly', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:k1', 'DTSTART;TZID=Asia/Hong_Kong:20260904T100000', 'DTEND;TZID=Asia/Hong_Kong:20260904T110000', 'STATUS:CANCELLED', 'SUMMARY:cancelled', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:o1', 'DTSTART;TZID=Asia/Hong_Kong:20260701T100000', 'DTEND;TZID=Asia/Hong_Kong:20260701T110000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:old', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:o1', 'RECURRENCE-ID;TZID=Asia/Hong_Kong:20260708T100000', 'DTSTART;TZID=Asia/Hong_Kong:20260910T100000', 'DTEND;TZID=Asia/Hong_Kong:20260910T110000', 'SUMMARY:old moved into window', 'END:VEVENT'
    ]);
    const ev = I.toEvents(I.parse(text), { timeZone: HK, from: '2026-01-01', to: '2026-12-31' });
    assert.deepStrictEqual(ev.filter(e => e.uid === 'd1').map(e => e.start.dateTime.slice(0, 10)), ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.deepStrictEqual(ev.filter(e => e.uid === 'm1').map(e => e.start.dateTime.slice(0, 10)), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'], '2、4、6 月沒有 31 號跳過，不計入 COUNT');
    assert.deepStrictEqual(ev.filter(e => e.uid === 'y1').map(e => e.start.dateTime.slice(0, 10)), ['2026-09-15'], '每年：視窗內只有 2026');
    assert.deepStrictEqual(ev.filter(e => e.uid === 'x1').map(e => e.start.dateTime), ['2026-09-03T10:00:00'], '不支援的 FREQ 只回首次');
    assert.strictEqual(ev.find(e => e.uid === 'k1').status, 'cancelled');
    assert.deepStrictEqual(ev.filter(e => e.uid === 'o1').map(e => e.start.dateTime.slice(0, 10)), ['2026-07-01', '2026-09-10'], '覆寫把 7/8 那次改到 9/10');
});

test('K4: 工具函數——parseProperty 引號內冒號、durationToMs、zonedToUtc／wallClock 互逆、無效時區退回', () => {
    const p = I.parseProperty('ATTACH;FMTTYPE=text/plain;X-A="a:b":http://x/y:z');
    assert.strictEqual(p.name, 'ATTACH');
    assert.strictEqual(p.params.FMTTYPE, 'text/plain');
    assert.strictEqual(p.params['X-A'], 'a:b');
    assert.strictEqual(p.value, 'http://x/y:z');
    assert.strictEqual(I.durationToMs('PT45M'), 45 * 60000);
    assert.strictEqual(I.durationToMs('P1DT2H'), 26 * 3600000);
    assert.strictEqual(I.durationToMs('bad'), null);
    const ms = I.zonedToUtc({ y: 2026, mo: 9, d: 16, h: 21, mi: 30, s: 0 }, HK);
    assert.strictEqual(ms, Date.UTC(2026, 8, 16, 13, 30));
    assert.deepStrictEqual(I.wallClock(ms, HK), { date: '2026-09-16', time: '21:30' });
    assert.deepStrictEqual(I.wallClock(ms, 'Not/AZone'), { date: '2026-09-16', time: '13:30' }, '無效時區退回 UTC');
    assert.strictEqual(I.isValidTz('Asia/Hong_Kong'), true);
    assert.strictEqual(I.isValidTz('Nope'), false);
    assert.strictEqual(I.parseStamp('2026-09-16'), null);
    // 夏令時區：紐約 2026-03-08 02:30 不存在 → 仍收斂到一個時刻，且 11 月前後偏移不同
    const ny1 = I.zonedToUtc({ y: 2026, mo: 7, d: 1, h: 12, mi: 0, s: 0 }, 'America/New_York');
    const ny2 = I.zonedToUtc({ y: 2026, mo: 12, d: 1, h: 12, mi: 0, s: 0 }, 'America/New_York');
    assert.strictEqual(ny1, Date.UTC(2026, 6, 1, 16, 0), 'EDT −4');
    assert.strictEqual(ny2, Date.UTC(2026, 11, 1, 17, 0), 'EST −5');
});

test('K5: 沒有 X-WR-TIMEZONE 且未指定輸出時區 → UTC；空檔案；沒有 DTSTART 的事件略過', () => {
    const cal = I.parse(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20260916T133000Z', 'SUMMARY:x', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b', 'SUMMARY:no start', 'END:VEVENT', 'END:VCALENDAR'].join('\n'));
    assert.strictEqual(cal.timeZone, '');
    const ev = I.toEvents(cal, {});
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].start.dateTime, '2026-09-16T13:30:00');
    assert.strictEqual(ev[0].end.dateTime, '2026-09-16T14:30:00', '無 DTEND → 預設 60 分鐘');
    assert.deepStrictEqual(I.toEvents(I.parse(''), {}), []);
});
