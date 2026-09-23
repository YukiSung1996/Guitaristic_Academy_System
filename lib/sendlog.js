// lib/sendlog.js — 發送中心紀錄純函數庫（無 DOM 依賴）
// log = gac_sendlog_v2 的物件結構：{ "<key>": sendEntry, ... }，key 幂等（同一課/同一學生月不會重複）。
// key 形式："TUITION:S001:2026-09" | "LEAVE_CONFIRM:<lessonId>" | "MAKEUP_CONFIRM:<lessonId>"
//          | "CUSTOM:<batchId>:<studentId>"（自定義群發，batchId 區分同月多次群發）
//          | "PAY_REMIND:<studentId>:<month>"（催繳）| "RECEIPT:<studentId>:<month>"（收款確認）——由學費條目派生，見 syncDerived
//          | "MOVE_CONFIRM:<lessonId>"（改期通知，帶改期前的 fromDate/fromTime 快照，見 ensureMoveEntry）
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACSendlog = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function tuitionKey(studentId, monthKey) { return 'TUITION:' + studentId + ':' + monthKey; }
    function leaveKey(lessonId) { return 'LEAVE_CONFIRM:' + lessonId; }
    function makeupKey(lessonId) { return 'MAKEUP_CONFIRM:' + lessonId; }
    function customKey(batchId, studentId) { return 'CUSTOM:' + batchId + ':' + studentId; }

    // 建立/刷新某學生某月的學費條目。
    // 規則：SENT 的條目絕不改動；TODO 的條目刷新堂數/日期，金額只在未被手改（amountEdited=false）時刷新。
    // 學費單明細：把某生當月常規課按「報讀項目」分組（個別課一項、每個小組各一項），
    // 供學費訊息逐項列出日期／時段／級別／形式／導師／每堂費用／小計。rateFn(lesson) → 每堂費用。
    // 同一項目內時段一致（同星期、同時間、同時長）才給 weekday/time/endTime；否則留空、由 times 逐堂列。
    function pad2(n) { return String(n).padStart(2, '0'); }
    function endTimeOf(time, duration) {
        var p = String(time || '').split(':').map(Number);
        if (p.length < 2 || isNaN(p[0]) || isNaN(p[1])) return '';
        var m = p[0] * 60 + p[1] + (Number(duration) || 0);
        return pad2(Math.floor(m / 60) % 24) + ':' + pad2(m % 60);
    }
    function weekdayOf(dateStr) {
        var p = String(dateStr).split('-').map(Number);
        return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    }
    function tuitionItems(lessons, rateFn) {
        var byKey = {}, order = [];
        (lessons || []).forEach(function (l) {
            var k = l.groupId ? 'G:' + l.groupId : 'IND';
            if (!byKey[k]) { byKey[k] = []; order.push(k); }
            byKey[k].push(l);
        });
        order.sort(function (a, b) { return ((a === 'IND' ? 0 : 1) - (b === 'IND' ? 0 : 1)) || a.localeCompare(b); });
        return order.map(function (k) {
            var ls = byKey[k].slice().sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
            var first = ls[0];
            var rates = ls.map(function (l) { return Number(rateFn ? rateFn(l) : 0) || 0; });
            var subtotal = rates.reduce(function (s, r) { return s + r; }, 0);
            var sameRate = rates.every(function (r) { return r === rates[0]; });
            var sameSlot = ls.every(function (l) {
                return l.time === first.time && weekdayOf(l.date) === weekdayOf(first.date) && Number(l.duration) === Number(first.duration);
            });
            return {
                groupId: first.groupId || null, groupName: first.groupName || '',
                program: first.program || '', level: first.level || '', classType: first.classType || '',
                tutor: first.tutor || '', duration: Number(first.duration) || 0,
                weekday: sameSlot ? weekdayOf(first.date) : null,
                time: sameSlot ? first.time : '', endTime: sameSlot ? endTimeOf(first.time, first.duration) : '',
                dates: ls.map(function (l) { return l.date; }),
                times: ls.map(function (l) { return l.time; }),
                count: ls.length, rate: sameRate ? rates[0] : null, subtotal: subtotal
            };
        });
    }

    // params = { studentId, studentName?, phone?, monthKey, amount, count, dates: [], items?: [], now? }
    // items = tuitionItems(...) 的明細（TODO 條目隨生成刷新；缺省時保留既有）
    function upsertTuition(log, params) {
        const key = tuitionKey(params.studentId, params.monthKey);
        const existing = log[key];
        if (existing && existing.status === 'SENT') return existing;
        if (!existing) {
            log[key] = {
                key: key,
                type: 'TUITION',
                studentId: params.studentId,
                studentName: params.studentName || '',
                phone: params.phone || '',
                month: params.monthKey,
                amount: Number(params.amount) || 0,
                amountEdited: false,
                count: Number(params.count) || 0,
                dates: (params.dates || []).slice(),
                items: (params.items || []).slice(),
                // 繳費紀錄（對應手工學費表：Paid／Method／Date／Receipt），由 setPayment 維護
                paid: false, paidAmount: 0, payMethod: '', payDate: '', receipt: false, payNote: '',
                status: 'TODO',
                sentAt: null,
                method: null,
                createdAt: params.now || null
            };
            return log[key];
        }
        existing.studentName = params.studentName || existing.studentName;
        existing.phone = params.phone || existing.phone;
        existing.count = Number(params.count) || 0;
        existing.dates = (params.dates || []).slice();
        if (params.items) existing.items = params.items.slice();
        if (!existing.amountEdited) existing.amount = Number(params.amount) || 0;
        return existing;
    }

    // ===== 繳費紀錄（只限 TUITION 條目）=====
    // fields 可含：paid（已繳）、paidAmount（實收）、payMethod（'1'|'2'|'3'，名稱在設定）、
    //   payDate（YYYY-MM-DD）、receipt（已發收據）、payNote。
    // 規則：勾 paid 而實收為 0 → 預設整額、日期補今天；改 paidAmount → paid 隨之（>0 為已繳、0 為未繳）；取消 paid → 實收歸零、日期保留。
    function setPayment(log, key, fields, todayStr) {
        const e = log[key];
        if (!e || e.type !== 'TUITION') return null;
        const f = fields || {};
        if ('receipt' in f) e.receipt = !!f.receipt;
        if ('payMethod' in f) e.payMethod = String(f.payMethod || '');
        if ('payDate' in f) e.payDate = String(f.payDate || '');
        if ('payNote' in f) e.payNote = String(f.payNote || '');
        if ('paidAmount' in f) {
            e.paidAmount = Math.max(0, Number(f.paidAmount) || 0);
            e.paid = e.paidAmount > 0;
            if (e.paid && !e.payDate) e.payDate = todayStr || '';
        }
        if ('paid' in f) {
            e.paid = !!f.paid;
            if (e.paid) {
                if (!(Number(e.paidAmount) > 0)) e.paidAmount = Number(e.amount) || 0;
                if (!e.payDate) e.payDate = todayStr || '';
            } else {
                e.paidAmount = 0;
                e.receiptSkipped = false; // 取消已繳＝新一輪：之後再繳清會重新建立收款確認
            }
        }
        return e;
    }

    // 'paid'（實收 ≥ 應收）| 'partial'（0 < 實收 < 應收）| 'unpaid'
    function paymentStatus(e) {
        if (!e || !e.paid) return 'unpaid';
        const got = Number(e.paidAmount) || 0;
        if (got <= 0) return 'unpaid';
        return got >= (Number(e.amount) || 0) ? 'paid' : 'partial';
    }

    function tuitionByMonth(log, monthKey) {
        return Object.keys(log || {})
            .map(function (k) { return log[k]; })
            .filter(function (e) { return e && e.type === 'TUITION' && e.month === monthKey; })
            .sort(function (a, b) { return String(a.studentId).localeCompare(String(b.studentId)); });
    }

    function paymentTotals(entries) {
        let due = 0, paid = 0;
        (entries || []).forEach(function (e) {
            due += Number(e.amount) || 0;
            if (e.paid) paid += Number(e.paidAmount) || 0;
        });
        return { due: due, paid: paid, outstanding: due - paid };
    }

    // ===== 由學費條目派生的訊息：催繳（PAY_REMIND）／收款確認（RECEIPT）=====
    // key 幂等：每生每月各一筆；條目帶 tuitionKey 指回學費條目。訊息文字不快照——UI 按模板＋學費條目現值即時組成
    //（部分繳交後催繳的「未繳」金額隨之更新）。沒有 lessonId，pruneOrphans 不碰；purgeMonth 按月份一併清。
    function remindKey(studentId, monthKey) { return 'PAY_REMIND:' + studentId + ':' + monthKey; }
    function receiptKey(studentId, monthKey) { return 'RECEIPT:' + studentId + ':' + monthKey; }

    function makeDerived(t, type, key, now) {
        return {
            key: key, type: type, tuitionKey: t.key,
            studentId: t.studentId, studentName: t.studentName || '', phone: t.phone || '',
            month: t.month, status: 'TODO', sentAt: null, method: null, createdAt: now || null
        };
    }

    // 催繳條件：學費單已發出（SENT）滿 days 天、未繳清（未繳或部分）、未被「不用發」略過
    function remindWanted(t, nowMs, days) {
        if (!t || t.type !== 'TUITION' || t.status !== 'SENT' || t.remindSkipped) return false;
        if (paymentStatus(t) === 'paid') return false;
        const sentMs = Date.parse(t.sentAt || '');
        return !isNaN(sentMs) && (nowMs - sentMs) >= days * 86400000;
    }

    // 收款確認條件：已繳清、未略過（不要求學費單已發——現場付現也要確認）
    function receiptWanted(t) {
        return !!t && t.type === 'TUITION' && !t.receiptSkipped && paymentStatus(t) === 'paid';
    }

    // 同步派生條目（每次渲染呼叫，幂等）。opts = { now: ISO 字串, remindAuto=true, remindDays=7, receiptAuto=true }
    //   1) 既有 TODO 派生條目：條件不再成立（繳清／移回待發／學費條目不存在／略過／自動關閉）→ 刪除；SENT 的留作紀錄。
    //   2) 每個學費條目：條件成立而條目不存在 → 建 TODO。已有 SENT 催繳的不會再建第二筆（要再催：把它「移回待發」）。
    // 回傳 { created: [key], removed: [key] }
    function syncDerived(log, opts) {
        const o = opts || {};
        const nowMs = Date.parse(o.now || new Date().toISOString());
        const days = Number(o.remindDays) > 0 ? Number(o.remindDays) : 7;
        const remindAuto = o.remindAuto !== false;
        const receiptAuto = o.receiptAuto !== false;
        const created = [], removed = [];
        const wanted = function (e) {
            const t = log[e.tuitionKey];
            return e.type === 'PAY_REMIND' ? (remindAuto && remindWanted(t, nowMs, days)) : (receiptAuto && receiptWanted(t));
        };
        Object.keys(log || {}).forEach(function (k) {
            const e = log[k];
            if (!e || (e.type !== 'PAY_REMIND' && e.type !== 'RECEIPT') || e.status !== 'TODO') return;
            if (!wanted(e)) { removed.push(k); delete log[k]; }
        });
        Object.keys(log || {}).forEach(function (k) {
            const t = log[k];
            if (!t || t.type !== 'TUITION') return;
            if (remindAuto && remindWanted(t, nowMs, days)) {
                const rk = remindKey(t.studentId, t.month);
                if (!log[rk]) { log[rk] = makeDerived(t, 'PAY_REMIND', rk, o.now); created.push(rk); }
            }
            if (receiptAuto && receiptWanted(t)) {
                const ck = receiptKey(t.studentId, t.month);
                if (!log[ck]) { log[ck] = makeDerived(t, 'RECEIPT', ck, o.now); created.push(ck); }
            }
        });
        return { created: created, removed: removed };
    }

    // 「不用發」：刪除派生條目並在學費條目記下略過（remindSkipped／receiptSkipped），之後同步不再重建。
    // 略過會在「學費單移回待發」（催繳）／「取消已繳」（收款確認）時重置。回傳被刪條目或 null。
    function dismissDerived(log, key) {
        const e = log[key];
        if (!e || (e.type !== 'PAY_REMIND' && e.type !== 'RECEIPT')) return null;
        const t = log[e.tuitionKey];
        if (t) t[e.type === 'PAY_REMIND' ? 'remindSkipped' : 'receiptSkipped'] = true;
        delete log[key];
        return e;
    }

    // ===== 訊息模板 =====
    function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US'); }
    function monthLabel(monthKey) {
        const p = String(monthKey || '').split('-').map(Number);
        return p.length === 2 && p[0] && p[1] ? p[0] + '年' + p[1] + '月' : String(monthKey || '');
    }

    // 學費條目 → 模板變數。opts = { methodNames: 付款方式名稱陣列, fpsId }
    // {name} {id} {month} {m} {amount}應收 {paid}已收 {outstanding}未繳 {method} {date} {payinfo}＝（方式，日期）{fps}＝「FPS 轉數快 ID：…」
    function paymentVars(t, opts) {
        const o = opts || {};
        const names = o.methodNames || [];
        const mi = parseInt(t.payMethod, 10);
        const method = mi >= 1 && mi <= names.length ? names[mi - 1] : '';
        const info = [method, t.payDate].filter(Boolean).join('，');
        const due = Number(t.amount) || 0;
        const got = t.paid ? (Number(t.paidAmount) || 0) : 0;
        return {
            name: t.studentName || t.studentId || '', id: t.studentId || '',
            month: monthLabel(t.month), m: String(parseInt(String(t.month || '').split('-')[1], 10) || ''),
            amount: money(due), paid: money(got), outstanding: money(Math.max(0, due - got)),
            method: method, date: t.payDate || '', payinfo: info ? '（' + info + '）' : '',
            fps: o.fpsId ? 'FPS 轉數快 ID：' + o.fpsId : ''
        };
    }

    // {key} 逐一代入；未知佔位符原樣保留；行尾空白、三行以上空行與尾端空白清掉（{fps} 留空時不留空行）
    function fillTemplate(tpl, vars) {
        const v = vars || {};
        const s = String(tpl || '').replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(v, k) ? String(v[k]) : m;
        });
        return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    }

    // 建立請假/補堂確認條目（type: 'LEAVE_CONFIRM' | 'MAKEUP_CONFIRM'）。key 幂等，重複呼叫不產生重複條目。
    // 條目歸屬月份 = 該課自身的日期月份（請假課=原課月份；補堂課=補堂日期月份）。
    function ensureLessonEntry(log, type, lesson, now) {
        const key = type + ':' + lesson.lessonId;
        if (!log[key]) {
            log[key] = {
                key: key,
                type: type,
                studentId: lesson.studentId,
                studentName: lesson.studentName || '',
                phone: lesson.phone || '',
                lessonId: lesson.lessonId,
                month: String(lesson.date).slice(0, 7),
                status: 'TODO',
                sentAt: null,
                method: null,
                createdAt: now || null
            };
        }
        return log[key];
    }

    // 改期通知（type 'MOVE_CONFIRM'）：key 按課堂；from＝改期前的日期時間（快照），改期後的時間在組訊息時讀課堂現值。
    // TODO 中再改期 → 保留原 from（學生只知道最初通知的時間）；已 SENT 又再改期 → 重開為 TODO，from＝這次改期前（＝上次已通知的時間）。
    function ensureMoveEntry(log, lesson, from, now) {
        const key = 'MOVE_CONFIRM:' + lesson.lessonId;
        const e = log[key];
        if (e && e.status === 'TODO') return e;
        if (e && e.status === 'SENT') {
            e.status = 'TODO'; e.sentAt = null; e.method = null; e.waOpenedAt = null;
            e.fromDate = from.date; e.fromTime = from.time; e.month = String(lesson.date).slice(0, 7); e.movedAt = now || null;
            return e;
        }
        log[key] = {
            key: key, type: 'MOVE_CONFIRM',
            studentId: lesson.studentId, studentName: lesson.studentName || '', phone: lesson.phone || '',
            lessonId: lesson.lessonId, month: String(lesson.date).slice(0, 7),
            fromDate: from.date, fromTime: from.time,
            status: 'TODO', sentAt: null, method: null, createdAt: now || null
        };
        return log[key];
    }

    // 自定義群發條目（type 'CUSTOM'）：訊息文字在建立時已按學生解析定稿（快照）。
    // key 帶 batchId：同一批次同一學生幂等；不同批次（如同月兩次群發）互不覆蓋。
    // title 是這批訊息的名稱（如「調整學費」），UI 以 batchId+title 作「自定義」下的二級分類。
    // 沒有 lessonId，pruneOrphans 不會碰它；刪除由 UI 顯式操作。
    // params = { batchId, title?, studentId, studentName?, phone?, monthKey, message, now? }
    function addCustomEntry(log, params) {
        const key = customKey(params.batchId, params.studentId);
        if (log[key]) return log[key];
        log[key] = {
            key: key,
            type: 'CUSTOM',
            batchId: String(params.batchId),
            title: String(params.title || ''),
            studentId: params.studentId,
            studentName: params.studentName || '',
            phone: params.phone || '',
            month: params.monthKey,
            message: String(params.message || ''),
            status: 'TODO',
            sentAt: null,
            method: null,
            createdAt: params.now || null
        };
        return log[key];
    }

    // 手改金額（之後 upsert 不會再覆蓋）
    function setAmount(log, key, amount) {
        const e = log[key];
        if (!e) return null;
        e.amount = Number(amount) || 0;
        e.amountEdited = true;
        return e;
    }

    // 標記已發（method: 'wa_link' | 'manual'）。開 WhatsApp 不會自動呼叫此函數（用戶要求手動確認）。
    function markSent(log, key, method, nowIso) {
        const e = log[key];
        if (!e) return null;
        e.status = 'SENT';
        e.sentAt = nowIso || new Date().toISOString();
        e.method = method || 'manual';
        // 收款確認訊息發出＝已發收據：回寫學費條目的 receipt（繳費表「收據」欄同步勾上）
        if (e.type === 'RECEIPT' && log[e.tuitionKey] && log[e.tuitionKey].type === 'TUITION') log[e.tuitionKey].receipt = true;
        return e;
    }

    // 移回待發（發錯了想重發）。waOpenedAt 一併清空：重發流程從頭開始。
    function markUnsent(log, key) {
        const e = log[key];
        if (!e) return null;
        e.status = 'TODO';
        e.sentAt = null;
        e.method = null;
        e.waOpenedAt = null;
        if (e.type === 'TUITION') e.remindSkipped = false; // 重發＝新一輪催繳週期
        return e;
    }

    // 記錄「已開啟過 WhatsApp」（僅標記，不改 status——點開 ≠ 已發出，是否移欄由 UI 依設定決定）
    function markWaOpened(log, key, nowIso) {
        const e = log[key];
        if (!e) return null;
        e.waOpenedAt = nowIso || new Date().toISOString();
        return e;
    }

    // 某月的條目，分成 { todo, sent } 兩欄。每月獨立。
    function listByMonth(log, monthKey) {
        const entries = Object.keys(log || {})
            .map(function (k) { return log[k]; })
            .filter(function (e) { return e && e.month === monthKey; });
        entries.sort(function (a, b) { return a.key.localeCompare(b.key); });
        return {
            todo: entries.filter(function (e) { return e.status === 'TODO'; }),
            sent: entries.filter(function (e) { return e.status === 'SENT'; })
        };
    }

    // 清場輔助：移除歸屬某月的全部條目（含 SENT——整月重來），以及引用被刪課堂的條目
    // （跨月補堂確認等）。removedLessonIds 來自 lessonState.clearMonth 的 removed。
    function purgeMonth(log, monthKey, removedLessonIds) {
        const gone = {};
        (removedLessonIds || []).forEach(function (id) { gone[id] = true; });
        const removed = [];
        Object.keys(log || {}).forEach(function (k) {
            const e = log[k];
            if (!e) return;
            if (e.month === monthKey || (e.lessonId && gone[e.lessonId])) {
                removed.push(k);
                delete log[k];
            }
        });
        return removed;
    }

    // 清理孤兒條目：課已被刪除（如補堂被取消）的 TODO 確認條目移除；SENT 保留作歷史紀錄。
    // existsFn(lessonId) → boolean
    function pruneOrphans(log, existsFn) {
        const removed = [];
        Object.keys(log || {}).forEach(function (k) {
            const e = log[k];
            if (!e || !e.lessonId) return;
            if (e.status === 'TODO' && !existsFn(e.lessonId)) {
                removed.push(k);
                delete log[k];
            }
        });
        return removed;
    }

    return {
        tuitionKey: tuitionKey,
        leaveKey: leaveKey,
        makeupKey: makeupKey,
        customKey: customKey,
        tuitionItems: tuitionItems,
        upsertTuition: upsertTuition,
        setPayment: setPayment,
        paymentStatus: paymentStatus,
        tuitionByMonth: tuitionByMonth,
        paymentTotals: paymentTotals,
        ensureLessonEntry: ensureLessonEntry,
        ensureMoveEntry: ensureMoveEntry,
        addCustomEntry: addCustomEntry,
        setAmount: setAmount,
        remindKey: remindKey,
        receiptKey: receiptKey,
        syncDerived: syncDerived,
        dismissDerived: dismissDerived,
        monthLabel: monthLabel,
        paymentVars: paymentVars,
        fillTemplate: fillTemplate,
        markSent: markSent,
        markUnsent: markUnsent,
        markWaOpened: markWaOpened,
        listByMonth: listByMonth,
        purgeMonth: purgeMonth,
        pruneOrphans: pruneOrphans
    };
}));
