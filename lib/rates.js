// lib/rates.js — 費率表查詢純函數庫（無 DOM 依賴）
// 職責：學生／快速編輯表單的連動下拉（導師級別 → 課程 → 級別 → 上課形式 → 時長，只列費率表有定價的組合）
//       與每堂學費查價。費率表（art-rate-data.js 的 rateTable）由呼叫方傳入，方便測試。
// 學生資料的「上課形式」存短形式（一對一／2人小組／3-4人小組），費率表用長標籤，本庫負責雙向對應。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACRates = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 表單欄位 → 費率表欄位；陣列順序即連動順序（上游改變 → 下游重算）
    var FIELDS = [
        { key: 'tutorLevel', col: 'tutor' },
        { key: 'program', col: 'instrument' },
        { key: 'level', col: 'grade' },
        { key: 'type', col: 'classType' },
        { key: 'duration', col: 'duration' }
    ];

    // 級別顯示順序（費率表列序不一，例如 Debut 入門 在最後）
    var GRADE_ORDER = ['Debut 入門', 'Pre Grade', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
        'Grade 7', 'Grade 8', 'ATCL/Dip/ ABRSM', 'Elementary 初級', 'Intermediate 中級', 'Advanced 高級'];

    var TYPE_MAP = [
        ['一對一', '一對一個別授課 Individual'],
        ['2人小組', '2人小組授課'],
        ['3-4人小組', '3-4人小組授課']
    ];

    // 學生資料短形式（含小組課的「5人小組」）→ 費率表上課形式
    function studentTypeToClassType(type) {
        var s = String(type || '');
        if (s === '一對一' || s.indexOf('Individual') !== -1) return '一對一個別授課 Individual';
        return /[3-9]人/.test(s) ? '3-4人小組授課' : '2人小組授課';
    }

    function classTypeToStudentType(label) {
        for (var i = 0; i < TYPE_MAP.length; i++) if (TYPE_MAP[i][1] === label) return TYPE_MAP[i][0];
        return String(label || '').indexOf('Individual') !== -1 ? '一對一' : String(label || '');
    }

    function hasRate(row) { return row && row.rate !== null && row.rate !== undefined && row.rate !== '' && !isNaN(Number(row.rate)); }

    function colValue(field, sel) {
        if (field.key === 'type') return studentTypeToClassType(sel.type);
        if (field.key === 'duration') return Number(sel.duration);
        return sel[field.key];
    }

    function matchesPrefix(row, sel, upto) {
        for (var i = 0; i < upto; i++) {
            if (row[FIELDS[i].col] !== colValue(FIELDS[i], sel)) return false;
        }
        return true;
    }

    function sortOptions(key, values) {
        if (key === 'duration') return values.slice().sort(function (a, b) { return a - b; });
        if (key === 'level') {
            var idx = function (v) { var i = GRADE_ORDER.indexOf(v); return i === -1 ? 999 : i; };
            return values.slice().sort(function (a, b) { return idx(a) - idx(b); });
        }
        return values; // 導師級別／課程／形式依費率表列序
    }

    // 某欄位在「連動順序上前面的欄位已定」下的可選值（只列有定價的組合）
    function optionsFor(table, sel, key) {
        var i = -1;
        for (var k = 0; k < FIELDS.length; k++) if (FIELDS[k].key === key) i = k;
        if (i === -1) return [];
        var vals = [];
        (table || []).forEach(function (row) {
            if (!hasRate(row) || !matchesPrefix(row, sel, i)) return;
            var v = row[FIELDS[i].col];
            if (key === 'type') v = classTypeToStudentType(v);
            if (key === 'duration') v = Number(v);
            if (vals.indexOf(v) === -1) vals.push(v);
        });
        return sortOptions(key, vals);
    }

    // 完整組合的每堂學費；無定價回 null（不做估算——估算屬薪酬頁的回退，不是表單的事）
    function findRate(table, sel) {
        for (var i = 0; i < (table || []).length; i++) {
            var row = table[i];
            if (hasRate(row) && matchesPrefix(row, sel, FIELDS.length)) return Number(row.rate);
        }
        return null;
    }

    // 連動解析：由上而下，欄位值不在可選清單就改成第一個可選（清單為空則保留原值）。
    // 回傳 { sel: 修正後的選擇, options: 各欄可選值, rate: 每堂學費或 null }
    function resolve(table, sel) {
        var out = {}, options = {};
        sel = sel || {};
        FIELDS.forEach(function (f) {
            var opts = optionsFor(table, out, f.key);
            var cur = f.key === 'duration' ? Number(sel[f.key]) : sel[f.key];
            var val = opts.indexOf(cur) !== -1 ? cur : (opts.length ? opts[0] : cur);
            out[f.key] = val;
            options[f.key] = opts;
        });
        return { sel: out, options: options, rate: findRate(table, out) };
    }

    return {
        FIELDS: FIELDS,
        GRADE_ORDER: GRADE_ORDER,
        studentTypeToClassType: studentTypeToClassType,
        classTypeToStudentType: classTypeToStudentType,
        optionsFor: optionsFor,
        findRate: findRate,
        resolve: resolve
    };
}));
