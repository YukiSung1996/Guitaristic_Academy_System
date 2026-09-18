// lib/sendlog.js — 發送中心紀錄純函數庫（無 DOM 依賴）
// log = gac_sendlog_v2 的物件結構：{ "<key>": sendEntry, ... }，key 幂等（同一課/同一學生月不會重複）。
// key 形式："TUITION:S001:2026-09" | "LEAVE_CONFIRM:<lessonId>" | "MAKEUP_CONFIRM:<lessonId>"
//          | "CUSTOM:<batchId>:<studentId>"（自定義群發，batchId 區分同月多次群發）
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
    // params = { studentId, studentName?, phone?, monthKey, amount, count, dates: [], now? }
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
        if (!existing.amountEdited) existing.amount = Number(params.amount) || 0;
        return existing;
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
        upsertTuition: upsertTuition,
        ensureLessonEntry: ensureLessonEntry,
        addCustomEntry: addCustomEntry,
        setAmount: setAmount,
        markSent: markSent,
        markUnsent: markUnsent,
        markWaOpened: markWaOpened,
        listByMonth: listByMonth,
        purgeMonth: purgeMonth,
        pruneOrphans: pruneOrphans
    };
}));
