// lib/paysheet.js — 導師糧單（Teacher's Tuition Fee Mark Sheet）的版面模型（純函數，無 DOM）
// 一位導師一張：頂部留三列放標誌 → 標題（月份）→ 導師名／日期／Cheque # → 學生明細（每堂價、堂數、金額、導師應得）→ Sub Total
// → 「樂器銷售佣金／其他調整」（薪酬頁指名給這位導師的津貼／扣款）→ Total。
// 這裡只產生「格子模型」（列、欄寬、樣式鍵、公式與顯示文字）；同一個模型交給 lib/xlsx.js 寫成 Excel，
// 也交給頁面（paysheet-ui.js）畫到 canvas 轉成 PDF，所以兩種檔案長得一樣。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACPaysheet = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var FONT = 'Century Gothic';
    var COLS = [4.5, 16, 29, 9, 7, 11, 16, 22];   // #｜Student｜Grade｜$/LSN.｜#/LSN｜Amount｜Tutor Portion｜Remarks
    var LOGO_ROWS = 3, LOGO_ROW_H = 20, ROW_H = 18;
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
    var PAY_FMT = '"HK$ "#,##0.00';

    function td(extra) {
        var st = { font: { name: FONT, sz: 11 }, border: 'lrtb', align: { h: 'center', v: 'center', shrink: true } };
        Object.keys(extra || {}).forEach(function (k) { st[k] = extra[k]; });
        return st;
    }
    var STYLES = {
        title: { font: { name: FONT, sz: 12, b: true }, align: { h: 'center', v: 'center' } },
        label: { font: { name: FONT, sz: 12 }, align: { h: 'left', v: 'center' } },
        date: { font: { name: FONT, sz: 12 }, align: { h: 'right', v: 'center' }, fmt: 'yyyy-mm-dd' },
        rule: { font: { name: FONT, sz: 12 }, border: 'b', align: { v: 'center' } },
        ruleRight: { font: { name: FONT, sz: 12 }, border: 'b', align: { h: 'right', v: 'center' } },
        ruleCenter: { font: { name: FONT, sz: 12 }, border: 'b', align: { h: 'center', v: 'center', shrink: true } },
        th: { font: { name: FONT, sz: 12 }, fill: 'E7E6E6', border: 'lrtb', align: { h: 'center', v: 'center', shrink: true } },
        td: td(),
        tdMoney0: td({ fmt: '"$"#,##0' }),
        tdMoney2: td({ fmt: '"$"#,##0.00' }),
        tdPay: td({ fmt: PAY_FMT }),
        subLabel: { font: { name: FONT, sz: 11, b: true, color: '006100' }, border: 'lrtb', align: { h: 'right', v: 'center' } },
        subValue: { font: { name: FONT, sz: 11, b: true, color: '006100' }, border: 'lrtb', align: { h: 'center', v: 'center', shrink: true }, fmt: PAY_FMT },
        secTitle: { font: { name: FONT, sz: 12, b: true }, border: 'b', align: { h: 'center', v: 'center' } },
        totalLabel: { font: { name: FONT, sz: 12, b: true, color: '006100' }, fill: 'C6EFCE', border: 'lrtb', align: { h: 'right', v: 'center' } },
        totalValue: { font: { name: FONT, sz: 12, b: true, color: '006100' }, fill: 'C6EFCE', border: 'lrtb', align: { h: 'center', v: 'center', shrink: true }, fmt: PAY_FMT }
    };

    // '2026-09' → 'Sept 2026'
    function monthLabel(monthKey) {
        var p = String(monthKey || '').split('-');
        return (MONTHS[Number(p[1]) - 1] || p[1] || '') + ' ' + (p[0] || '');
    }

    // 金額顯示文字（PDF 用；Excel 那邊由數字格式顯示同樣的結果）
    function money(value, prefix, decimals) {
        var n = Number(value) || 0;
        var s = Math.abs(n).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (n < 0 ? '-' : '') + prefix + s;
    }

    function dateSerial(dateStr) {   // 'YYYY-MM-DD' → Excel 日期序號
        var p = String(dateStr || '').split('-').map(Number);
        if (!p[0] || !p[1] || !p[2]) return null;
        return Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / 86400000);
    }

    // 一位導師某月「可計薪」的課 → 糧單明細列。同一位學生、同一個報讀項目、同一個每堂價合成一列，
    // 所以每列的 堂數 × 每堂價 加起來一定等於課程總額（同一位學生月內有不同價錢的課，例如補堂時長不同，會拆成兩列）。
    // rateFn(lesson) → 該堂的課程費用。回傳 [{ studentId, studentName, student, grade, rate, count, amount, remark }]
    function lessonRows(lessons, rateFn) {
        var byKey = {}, rows = [];
        (lessons || []).forEach(function (l) {
            var rate = Number(rateFn(l)) || 0;
            var key = [l.groupId || '', l.studentId, l.program || '', l.level || '', rate].join('|');
            var row = byKey[key];
            if (!row) {
                row = byKey[key] = { studentId: l.studentId, studentName: l.studentName || l.studentId, groupId: l.groupId || '', groupName: l.groupName || '',
                    classType: l.classType || '', program: l.program || '', level: l.level || '', duration: Number(l.duration) || 0,
                    rate: rate, count: 0, noShow: 0, makeup: 0 };
                rows.push(row);
            }
            row.count++;
            if (l.status === 'NOSHOW') row.noShow++;
            if (l.isMakeup) row.makeup++;
        });
        rows.sort(function (a, b) {
            return (a.groupName + '|' + a.studentId + '|' + a.program).localeCompare(b.groupName + '|' + b.studentId + '|' + b.program) || a.rate - b.rate;
        });
        var idsByName = {}, rowsByItem = {};
        rows.forEach(function (r) {
            (idsByName[r.studentName] = idsByName[r.studentName] || {})[r.studentId] = true;
            var item = r.groupId + '|' + r.studentId;
            rowsByItem[item] = (rowsByItem[item] || 0) + 1;
        });
        rows.forEach(function (r) {
            // 同名不同人才帶學號，免得糧單上分不出是誰
            r.student = Object.keys(idsByName[r.studentName]).length > 1 ? r.studentName + '（' + r.studentId + '）' : r.studentName;
            r.grade = [r.program, r.level].filter(Boolean).join(' - ');
            r.amount = r.rate * r.count;
            var notes = [];
            if (r.groupName) notes.push('小組：' + r.groupName);
            else if (/小組/.test(r.classType)) notes.push(r.classType);
            if (rowsByItem[r.groupId + '|' + r.studentId] > 1 && r.duration) notes.push(r.duration + ' 分鐘');
            if (r.makeup) notes.push('含補堂 ' + r.makeup + ' 堂');
            if (r.noShow) notes.push('含缺席 ' + r.noShow + ' 堂');
            r.remark = notes.join('；');
        });
        return rows;
    }

    // 標誌放進頂部三列：等比例縮到列高，橫向置中；太寬就改以表格寬為限。回傳點座標（距工作表左上角）
    function layoutLogo(logo, tableWidthPt) {
        if (!logo || !(logo.width > 0) || !(logo.height > 0)) return null;
        var boxH = LOGO_ROWS * LOGO_ROW_H, pad = 2;
        var h = boxH - pad * 2, w = h * logo.width / logo.height;
        if (w > tableWidthPt) { w = tableWidthPt; h = w * logo.height / logo.width; }
        return { x: (tableWidthPt - w) / 2, y: (boxH - h) / 2, w: w, h: h };
    }

    // o = { tutor, monthKey, rows（lessonRows 的結果）, adjustments:[{ name, amount（扣款為負）}], sharePct, dateStr:'YYYY-MM-DD', chequeNo,
    //       logo:{ width, height }（標誌的像素尺寸，只用來算比例；沒有就留白）}
    // 回傳工作表模型：{ name, cols, rows:[{ h, cells:[{ v, f, text, s } | null] }], merges, styles, image, titleRows, bodyRows, totals }
    function buildSheet(o) {
        var share = Number(o.sharePct) || 0;
        var rows = [], merges = [];
        function cell(v, s, extra) {
            var c = { v: v, s: s, text: (v === null || v === undefined) ? '' : String(v) };
            Object.keys(extra || {}).forEach(function (k) { c[k] = extra[k]; });
            return c;
        }
        function push(h, cells) { rows.push({ h: h, cells: cells }); return rows.length - 1; }
        function merge(r, c1, c2) { merges.push({ r: r, c1: c1, c2: c2 }); }
        function fill(n, s) { var a = [], i; for (i = 0; i < n; i++) a.push(cell(null, s)); return a; }
        function moneyCell(v, s, dec, f) { return cell(v, s, { text: money(v, s === 'tdMoney0' || s === 'tdMoney2' ? '$' : 'HK$ ', dec), f: f }); }
        var xl = function (r) { return r + 1; };   // 0 起算的列 → Excel 列號

        var i;
        for (i = 0; i < LOGO_ROWS; i++) push(LOGO_ROW_H, []);

        var r = push(20, [cell("Teacher's Tuition Fee Mark Sheet (" + monthLabel(o.monthKey) + ')', 'title')].concat(fill(7, 'title')));
        merge(r, 0, 7);

        var serial = dateSerial(o.dateStr);
        r = push(ROW_H, [cell("Tutor's name", 'label'), cell(null, 'label'), cell(o.tutor || '', 'label'), cell(null, 'label'), cell(null, 'label'), cell(null, 'label'),
            cell(null, 'label'), cell(serial, 'date', { text: o.dateStr || '' })]);
        merge(r, 0, 1); merge(r, 2, 5);

        push(ROW_H, fill(6, 'rule').concat([cell('Cheque #', 'ruleRight'), cell(o.chequeNo || null, 'ruleCenter')]));

        var head = push(20, [cell(null, 'th'), cell('Student', 'th'), cell('Grade', 'th'), cell('$/LSN.', 'th'), cell('#/LSN', 'th'), cell('Amount', 'th'), cell('Tutor Portion', 'th'), cell('Remarks', 'th')]);

        var first = rows.length, subTotal = 0;
        (o.rows || []).forEach(function (it, idx) {
            var n = xl(rows.length), portion = it.amount * share / 100;
            var rateStyle = it.rate % 1 ? 'tdMoney2' : 'tdMoney0', amtStyle = it.amount % 1 ? 'tdMoney2' : 'tdMoney0';
            subTotal += portion;
            push(ROW_H, [cell(idx + 1, 'td'), cell(it.student, 'td'), cell(it.grade, 'td'),
                moneyCell(it.rate, rateStyle, it.rate % 1 ? 2 : 0), cell(it.count, 'td'),
                moneyCell(it.amount, amtStyle, it.amount % 1 ? 2 : 0, 'D' + n + '*E' + n),
                moneyCell(portion, 'tdPay', 2, 'F' + n + '*' + share + '%'),
                cell(it.remark || null, 'td')]);
        });
        push(ROW_H, fill(8, 'td'));   // 留一列空白：在 Excel 裡要手動補一筆時直接填，Sub Total 的公式已經包住它
        var last = rows.length - 1;

        var sub = push(ROW_H, [null, null, null, null, null, cell('Sub Total', 'subLabel'),
            moneyCell(subTotal, 'subValue', 2, 'SUM(G' + xl(first) + ':G' + xl(last) + ')'), null]);

        push(16, []);
        r = push(20, [cell('樂器銷售佣金／其他調整', 'secTitle')].concat(fill(7, 'secTitle')));
        merge(r, 0, 7);
        r = push(20, [cell(null, 'th'), cell('Student', 'th'), cell('Item', 'th'), cell('%', 'th'), cell('Amount', 'th'), cell(null, 'th'), cell('Commission', 'th'), cell('Remarks', 'th')]);
        merge(r, 4, 5);

        var adjFirst = rows.length, adjTotal = 0, adj = o.adjustments || [];
        for (i = 0; i < Math.max(2, adj.length); i++) {
            var a = adj[i];
            if (a) adjTotal += Number(a.amount) || 0;
            r = push(ROW_H, [cell(i + 1, 'td'), cell(a ? null : '/', 'td'), cell(a ? (a.name || '') : null, 'td'), cell(null, 'td'), cell(null, 'td'), cell(null, 'td'),
                a ? moneyCell(Number(a.amount) || 0, 'tdPay', 2) : cell(null, 'tdPay'),
                cell(a && Number(a.amount) < 0 ? '扣款' : null, 'td')]);
            merge(r, 4, 5);
        }
        var adjLast = rows.length - 1;

        push(20, [null, null, null, null, null, cell('Total', 'totalLabel'),
            moneyCell(subTotal + adjTotal, 'totalValue', 2, 'G' + xl(sub) + '+SUM(G' + xl(adjFirst) + ':G' + xl(adjLast) + ')'), null]);

        var tableW = COLS.reduce(function (sum, w) { return sum + Math.floor(w * 7 + 5) * 0.75; }, 0);   // 欄寬（字元）→ 點，同 lib/xlsx.js colPt
        return {
            name: o.tutor || 'Tutor',
            cols: COLS.slice(),
            rows: rows,
            merges: merges,
            styles: STYLES,
            image: layoutLogo(o.logo, tableW),
            titleRows: [head, head],     // 表頭那一列：跨頁時每頁重複
            bodyRows: [first, last],     // 學生明細的範圍（PDF 分頁時，只有這一段跨頁才重畫表頭）
            totals: { subTotal: subTotal, adjTotal: adjTotal, total: subTotal + adjTotal }
        };
    }

    // 檔名：Guitaristic_Paysheet_2026-09.xlsx（全部導師）／Guitaristic_Paysheet_2026-09_Instructor-B.pdf（一位）
    function fileName(monthKey, tutor, ext) {
        var parts = ['Guitaristic', 'Paysheet', monthKey || ''];
        if (tutor) parts.push(String(tutor).trim().replace(/\s+/g, '-').replace(/[\\/:*?"<>|]+/g, '').slice(0, 40));
        return parts.filter(Boolean).join('_') + '.' + ext;
    }

    return {
        STYLES: STYLES,
        COLS: COLS,
        monthLabel: monthLabel,
        money: money,
        dateSerial: dateSerial,
        lessonRows: lessonRows,
        layoutLogo: layoutLogo,
        buildSheet: buildSheet,
        fileName: fileName
    };
}));
