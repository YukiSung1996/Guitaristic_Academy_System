// lib/ics.js — iCalendar（.ics）解析純函數庫（無 DOM 依賴）
// 職責：把 Google Calendar 匯出的 .ics 轉成與 Calendar API 同形的事件物件
//       { id, uid, status, summary, description, location, start:{dateTime|date}, end:{...}, recurring, source:'ics' }
//       供 lib/gcal.js 的對帳（reconcileByContent）使用——唯讀模式下「每月上傳一次 ICS 作基準，之後只比對改動」。
// 支援：行摺疊、文字反轉義、VALUE=DATE 全日、UTC（Z）／TZID／浮動時間、
//       RRULE（DAILY／WEEKLY／MONTHLY／YEARLY；INTERVAL／COUNT／UNTIL／BYDAY 週）、EXDATE、RECURRENCE-ID 覆寫、STATUS:CANCELLED。
// 不支援（只取首次出現）：MONTHLY/YEARLY 的 BYDAY／BYMONTH 等進階規則。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACIcs = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function pad2(n) { return String(n).padStart(2, '0'); }

    // ===== 文字層 =====
    function unfold(text) {
        return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
    }

    function unescapeText(s) {
        return String(s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    }

    // "NAME;P1=V1;P2="a:b":value" → { name, params, value }（冒號可在引號內）
    function parseProperty(line) {
        var inQ = false, idx = -1;
        for (var i = 0; i < line.length; i++) {
            var ch = line[i];
            if (ch === '"') inQ = !inQ;
            else if (ch === ':' && !inQ) { idx = i; break; }
        }
        if (idx === -1) return null;
        var left = line.slice(0, idx), value = line.slice(idx + 1);
        var parts = left.split(';');
        var params = {};
        parts.slice(1).forEach(function (p) {
            var eq = p.indexOf('=');
            if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
        });
        return { name: parts[0].toUpperCase(), params: params, value: value };
    }

    // ===== 時間層 =====
    // "20260916T133000Z" / "20260916T213000" / "20260916" → 分量
    function parseStamp(v) {
        var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(v || '').trim());
        if (!m) return null;
        return { y: +m[1], mo: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0, utc: !!m[7], isDate: !m[4] };
    }

    function isValidTz(tz) {
        if (!tz) return false;
        try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
    }

    // UTC ms → 某時區的牆鐘分量（tz 無效時當 UTC）
    function tzParts(ms, tz) {
        var fmt;
        var opts = { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
        try { fmt = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz || 'UTC' }, opts)); }
        catch (e) { fmt = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'UTC' }, opts)); }
        var o = {};
        fmt.formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10); });
        return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
    }

    function partsAsUtc(p) { return Date.UTC(p.y, p.mo - 1, p.d, p.h || 0, p.mi || 0, p.s || 0); }

    // 某時區的牆鐘分量 → UTC ms（兩次迭代修正偏移；跨 DST 邊界亦收斂）
    function zonedToUtc(p, tz) {
        var target = partsAsUtc(p);
        var guess = target;
        for (var i = 0; i < 2; i++) {
            var z = tzParts(guess, tz);
            guess += target - partsAsUtc(z);
        }
        return guess;
    }

    // DTSTART/DTEND/EXDATE/RECURRENCE-ID 的值＋參數 → 時刻 { isDate, ms } 或全日 { isDate:true, y, mo, d }
    function stampToInstant(value, params, defaultTz) {
        var p = parseStamp(value);
        if (!p) return null;
        if (p.isDate || (params && params.VALUE === 'DATE')) return { isDate: true, y: p.y, mo: p.mo, d: p.d };
        if (p.utc) return { isDate: false, ms: partsAsUtc(p) };
        var tz = (params && params.TZID) || defaultTz;
        if (!isValidTz(tz)) tz = isValidTz(defaultTz) ? defaultTz : 'UTC';
        return { isDate: false, ms: zonedToUtc(p, tz) };
    }

    function instKey(inst) {
        return inst.isDate ? 'D' + inst.y + pad2(inst.mo) + pad2(inst.d) : String(inst.ms);
    }

    function wallClock(ms, tz) {
        var z = tzParts(ms, tz);
        return { date: z.y + '-' + pad2(z.mo) + '-' + pad2(z.d), time: pad2(z.h) + ':' + pad2(z.mi) };
    }

    // ISO 8601 時長（PT45M、PT1H30M、P1D）→ ms；解析不了回 null
    function durationToMs(v) {
        var m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim());
        if (!m) return null;
        var ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * 86400000 + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000;
        return m[1] ? -ms : ms;
    }

    // ===== 結構層 =====
    function parseRrule(v) {
        var r = {};
        String(v || '').split(';').forEach(function (kv) {
            var i = kv.indexOf('=');
            if (i !== -1) r[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1);
        });
        return r;
    }

    // 文字 → { name, timeZone, events: [ { uid, summary, description, location, status, dtstart:{value,params}, dtend, duration, rrule, exdates:[], recurrenceId } ] }
    // VALARM 等子元件內的屬性不會誤入事件。
    function parse(text) {
        var lines = unfold(text).split('\n');
        var cal = { name: '', timeZone: '', events: [] };
        var cur = null, stack = [];
        lines.forEach(function (raw) {
            var line = raw.trim();
            if (!line) return;
            var prop = parseProperty(line);
            if (!prop) return;
            var name = prop.name, value = prop.value, params = prop.params;
            if (name === 'BEGIN') {
                var comp = value.trim().toUpperCase();
                stack.push(comp);
                if (comp === 'VEVENT') cur = { exdates: [] };
                return;
            }
            if (name === 'END') {
                var ended = value.trim().toUpperCase();
                stack.pop();
                if (ended === 'VEVENT' && cur) { cal.events.push(cur); cur = null; }
                return;
            }
            var top = stack[stack.length - 1];
            if (top === 'VCALENDAR') {
                if (name === 'X-WR-CALNAME') cal.name = unescapeText(value).trim();
                else if (name === 'X-WR-TIMEZONE') cal.timeZone = value.trim();
                return;
            }
            if (top !== 'VEVENT' || !cur) return;
            switch (name) {
                case 'UID': cur.uid = value.trim(); break;
                case 'SUMMARY': cur.summary = unescapeText(value).trim(); break;
                case 'DESCRIPTION': cur.description = unescapeText(value); break;
                case 'LOCATION': cur.location = unescapeText(value).trim(); break;
                case 'STATUS': cur.status = value.trim().toUpperCase(); break;
                case 'DTSTART': cur.dtstart = { value: value.trim(), params: params }; break;
                case 'DTEND': cur.dtend = { value: value.trim(), params: params }; break;
                case 'DURATION': cur.duration = value.trim(); break;
                case 'RRULE': cur.rrule = parseRrule(value); break;
                case 'EXDATE':
                    value.split(',').forEach(function (x) { if (x.trim()) cur.exdates.push({ value: x.trim(), params: params }); });
                    break;
                case 'RECURRENCE-ID': cur.recurrenceId = { value: value.trim(), params: params }; break;
                default: break;
            }
        });
        return cal;
    }

    // ===== 重複規則展開 =====
    var DAY_IDX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

    // 在事件自身時區的牆鐘上做日曆運算（DST 跨越仍保持同一本地時間），逐次轉成 UTC 時刻。
    // 回傳 [fromMs, toMs] 內的時刻（已按 COUNT／UNTIL 截斷）；cap 防呆。
    function expand(sp, tz, isUtc, rrule, fromMs, toMs, cap) {
        var freq = String(rrule.FREQ || '').toUpperCase();
        var interval = Math.max(1, parseInt(rrule.INTERVAL, 10) || 1);
        var count = rrule.COUNT ? (parseInt(rrule.COUNT, 10) || Infinity) : Infinity;
        var toInstant = function (p) { return isUtc ? partsAsUtc(p) : zonedToUtc(p, tz); };
        var untilMs = Infinity;
        if (rrule.UNTIL) {
            var u = parseStamp(rrule.UNTIL);
            if (u) untilMs = u.isDate ? Date.UTC(u.y, u.mo - 1, u.d, 23, 59, 59) : (u.utc ? partsAsUtc(u) : toInstant(u));
        }
        var partsOf = function (ms) {
            var d = new Date(ms);
            return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
        };
        var base = partsAsUtc(sp); // 「牆鐘當 UTC」做日曆運算
        var out = [], produced = 0, i;
        if (freq === 'WEEKLY') {
            var days = rrule.BYDAY
                ? rrule.BYDAY.split(',').map(function (s) { return DAY_IDX[s.trim().slice(-2).toUpperCase()]; }).filter(function (x) { return x !== undefined; })
                : [new Date(base).getUTCDay()];
            if (!days.length) days = [new Date(base).getUTCDay()];
            var startDow = new Date(base).getUTCDay();
            var weekStart = base - ((startDow + 6) % 7) * 86400000; // 該週的週一（WKST=MO）
            for (var w = 0, guard = 0; produced < count && guard <= cap; w += interval, guard++) {
                var wk = weekStart + w * 7 * 86400000;
                var cands = days.map(function (dw) { return wk + ((dw + 6) % 7) * 86400000; }).sort(function (a, b) { return a - b; });
                for (i = 0; i < cands.length; i++) {
                    if (cands[i] < base) continue;
                    if (produced >= count) break;
                    var inst = toInstant(partsOf(cands[i]));
                    if (inst > untilMs) return out;
                    produced++;
                    if (inst >= fromMs && inst <= toMs) out.push(inst);
                    if (inst > toMs) return out;
                }
            }
            return out;
        }
        for (i = 0; produced < count && i <= cap; i++) {
            var c;
            if (freq === 'DAILY') c = base + i * interval * 86400000;
            else if (freq === 'MONTHLY') c = Date.UTC(sp.y, sp.mo - 1 + i * interval, sp.d, sp.h, sp.mi, sp.s || 0);
            else if (freq === 'YEARLY') c = Date.UTC(sp.y + i * interval, sp.mo - 1, sp.d, sp.h, sp.mi, sp.s || 0);
            else { out.push(toInstant(sp)); return out; } // 不支援的 FREQ：只回首次
            if (freq === 'MONTHLY' && new Date(c).getUTCDate() !== sp.d) continue; // 該月無此日（如 31 號）
            var t = toInstant(partsOf(c));
            if (t > untilMs) break;
            produced++;
            if (t >= fromMs && t <= toMs) out.push(t);
            if (t > toMs) break;
        }
        return out;
    }

    // 事件 → 事件自身的時長（ms）：DTEND 優先，其次 DURATION，全日預設一天、有時間預設 60 分鐘
    function eventDurationMs(ev, startInst, defaultTz) {
        if (ev.dtend) {
            var e = stampToInstant(ev.dtend.value, ev.dtend.params, defaultTz);
            if (e && !e.isDate && !startInst.isDate) return Math.max(0, e.ms - startInst.ms);
            if (e && e.isDate && startInst.isDate) return Math.max(86400000, (Date.UTC(e.y, e.mo - 1, e.d) - Date.UTC(startInst.y, startInst.mo - 1, startInst.d)));
        }
        var d = ev.duration ? durationToMs(ev.duration) : null;
        if (d !== null && d > 0) return d;
        return startInst.isDate ? 86400000 : 3600000;
    }

    // parse() 的結果 → API 同形事件陣列。opts = { timeZone: 輸出牆鐘時區（預設 X-WR-TIMEZONE，再退 UTC）, from:'YYYY-MM-DD', to:'YYYY-MM-DD' }
    // 重複事件展開到 [from, to]（按輸出時區的牆鐘日期過濾）；EXDATE 排除；RECURRENCE-ID 覆寫取代該次（改到視窗外仍以自身時間判斷）。
    function toEvents(cal, opts) {
        var o = opts || {};
        var calTz = isValidTz(cal && cal.timeZone) ? cal.timeZone : '';
        var tz = isValidTz(o.timeZone) ? o.timeZone : (calTz || 'UTC');
        var defaultTz = calTz || tz; // 浮動時間（無 Z 無 TZID）視為日曆時區
        var dp = function (s) { var p = String(s).split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
        var fromMs = o.from ? dp(o.from) - 86400000 : -Infinity; // 寬鬆一天（時區差），最後再按牆鐘日期精確過濾
        var toMs = o.to ? dp(o.to) + 2 * 86400000 : Infinity;
        var events = (cal && cal.events) || [];
        var overrides = {};
        events.forEach(function (ev) {
            if (!ev.uid || !ev.recurrenceId || !ev.dtstart) return;
            var inst = stampToInstant(ev.recurrenceId.value, ev.recurrenceId.params, defaultTz);
            if (!inst) return;
            (overrides[ev.uid] = overrides[ev.uid] || {})[instKey(inst)] = ev;
        });
        var out = [];
        function emit(inst, src, recurring, occKey) {
            var base = {
                id: (src.uid || 'noid') + (occKey ? '_' + occKey : ''),
                uid: src.uid || '',
                status: src.status === 'CANCELLED' ? 'cancelled' : 'confirmed',
                summary: src.summary || '', description: src.description || '', location: src.location || '',
                recurring: !!recurring, source: 'ics'
            };
            var dur = eventDurationMs(src, inst, defaultTz);
            if (inst.isDate) {
                var endUtc = Date.UTC(inst.y, inst.mo - 1, inst.d) + dur;
                var ed = new Date(endUtc);
                base.start = { date: inst.y + '-' + pad2(inst.mo) + '-' + pad2(inst.d) };
                base.end = { date: ed.getUTCFullYear() + '-' + pad2(ed.getUTCMonth() + 1) + '-' + pad2(ed.getUTCDate()) };
            } else {
                var ws = wallClock(inst.ms, tz), we = wallClock(inst.ms + dur, tz);
                base.start = { dateTime: ws.date + 'T' + ws.time + ':00' };
                base.end = { dateTime: we.date + 'T' + we.time + ':00' };
            }
            out.push(base);
        }
        events.forEach(function (ev) {
            if (!ev.dtstart || ev.recurrenceId) return; // 覆寫在母事件展開時放入
            var startInst = stampToInstant(ev.dtstart.value, ev.dtstart.params, defaultTz);
            if (!startInst) return;
            if (!ev.rrule || startInst.isDate) { emit(startInst, ev, !!ev.rrule, null); return; } // 全日重複：只放首次
            var sp = parseStamp(ev.dtstart.value);
            var evTz = (ev.dtstart.params && ev.dtstart.params.TZID && isValidTz(ev.dtstart.params.TZID)) ? ev.dtstart.params.TZID : defaultTz;
            var occ = expand(sp, evTz, sp.utc, ev.rrule, fromMs, toMs, 1200);
            var ex = {};
            ev.exdates.forEach(function (x) {
                var i = stampToInstant(x.value, x.params, evTz);
                if (i) ex[instKey(i)] = true;
            });
            var ovr = Object.assign({}, overrides[ev.uid] || {});
            occ.forEach(function (ms) {
                var inst = { isDate: false, ms: ms };
                var k = instKey(inst);
                if (ex[k]) return;
                if (ovr[k]) {
                    var oi = stampToInstant(ovr[k].dtstart.value, ovr[k].dtstart.params, defaultTz);
                    if (oi) emit(oi, ovr[k], true, k);
                    delete ovr[k];
                    return;
                }
                emit(inst, ev, true, k);
            });
            // 母事件展開未涵蓋的覆寫（原次在視窗外、被改到視窗內）：以自身時間放入
            Object.keys(ovr).forEach(function (k) {
                var oe = ovr[k];
                var oi = stampToInstant(oe.dtstart.value, oe.dtstart.params, defaultTz);
                if (oi && !oi.isDate && oi.ms >= fromMs && oi.ms <= toMs) emit(oi, oe, true, k);
            });
        });
        return out.filter(function (e) {
            var d = e.start.dateTime ? e.start.dateTime.slice(0, 10) : e.start.date;
            return (!o.from || d >= o.from) && (!o.to || d <= o.to);
        });
    }

    return {
        unfold: unfold,
        unescapeText: unescapeText,
        parseProperty: parseProperty,
        parseStamp: parseStamp,
        isValidTz: isValidTz,
        zonedToUtc: zonedToUtc,
        tzParts: tzParts,
        wallClock: wallClock,
        durationToMs: durationToMs,
        parseRrule: parseRrule,
        parse: parse,
        expand: expand,
        toEvents: toEvents
    };
}));
