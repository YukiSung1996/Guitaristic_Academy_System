// lib/history.js — 操作歷史／撤銷純函數庫（無 DOM 依賴）
// 職責：在會改資料的操作「之前」拍快照（各鍵 JSON 字串＝深拷貝，可估大小）、維持最新在前的有上限清單、還原解析。
// 存哪些鍵由呼叫方決定（v3：students／groups／lessons／sendlog；設定與 GCal token 不入快照）。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACHistory = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var DEFAULT_CAP = 20;

    function makeSnapshot(state, description, nowIso) {
        var ts = nowIso || new Date().toISOString();
        var data = {};
        var size = 0;
        Object.keys(state || {}).forEach(function (k) {
            var s = JSON.stringify(state[k] === undefined ? null : state[k]);
            data[k] = s;
            size += s.length;
        });
        return {
            id: 'h_' + String(ts).replace(/\D/g, '').slice(0, 17) + '_' + Math.random().toString(36).slice(2, 7),
            timestamp: ts,
            description: String(description || ''),
            size: size,
            data: data
        };
    }

    // 最新在前；超過上限砍最舊。回傳同一個陣列（就地修改）以便呼叫方直接指派。
    function push(list, snapshot, cap) {
        var arr = Array.isArray(list) ? list : [];
        arr.unshift(snapshot);
        var max = Number(cap) > 0 ? Number(cap) : DEFAULT_CAP;
        while (arr.length > max) arr.pop();
        return arr;
    }

    // 快照 → state 物件（各鍵獨立深拷貝；解析失敗的鍵為 null，呼叫方應略過）
    function restore(snapshot) {
        var out = {};
        var data = (snapshot && snapshot.data) || {};
        Object.keys(data).forEach(function (k) {
            try { out[k] = JSON.parse(data[k]); } catch (e) { out[k] = null; }
        });
        return out;
    }

    function totalSize(list) {
        return (list || []).reduce(function (s, h) { return s + (Number(h && h.size) || 0); }, 0);
    }

    function formatSize(n) {
        n = Number(n) || 0;
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return Math.round(n / 1024) + ' KB';
        return n + ' B';
    }

    return {
        DEFAULT_CAP: DEFAULT_CAP,
        makeSnapshot: makeSnapshot,
        push: push,
        restore: restore,
        totalSize: totalSize,
        formatSize: formatSize
    };
}));
