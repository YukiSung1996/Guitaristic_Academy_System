// lib/xlsx.js — 極簡 xlsx／pdf 檔案產生器（純函數，無 DOM、無第三方庫）
// 只做糧單（lib/paysheet.js）用得到的：多個工作表、欄寬列高、合併儲存格、字型／底色／框線／對齊／數字格式、公式（附快取值）、
// 每張表一張圖（標誌）、列印設定（A4 直向、寬度縮成一頁、每頁重複表頭）。壓縮一律「只存不壓」（檔案很小，換來同步、可測）。
// pdfFromJpegs：每頁一張 JPEG 鋪滿（糧單在瀏覽器畫到 canvas 再轉 JPEG；中文字型由瀏覽器處理，PDF 裡不用嵌字型）。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACXlsx = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var EMU_PER_PT = 12700;

    // ===== 位元組工具 =====
    function utf8(str) {
        var out = [], i, c;
        str = String(str);
        for (i = 0; i < str.length; i++) {
            c = str.charCodeAt(i);
            if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) {   // 代理對
                c = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00);
            }
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
            else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return new Uint8Array(out);
    }

    function concat(chunks) {
        var total = 0, i, pos = 0, out;
        for (i = 0; i < chunks.length; i++) total += chunks[i].length;
        out = new Uint8Array(total);
        for (i = 0; i < chunks.length; i++) { out.set(chunks[i], pos); pos += chunks[i].length; }
        return out;
    }

    var crcTable = null;
    function crc32(bytes) {
        var i, k, c;
        if (!crcTable) {
            crcTable = [];
            for (i = 0; i < 256; i++) {
                c = i;
                for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                crcTable[i] = c >>> 0;
            }
        }
        c = 0xFFFFFFFF;
        for (i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    // zip（只存不壓）。files = [{ name, data: Uint8Array | string }]
    function zip(files) {
        var chunks = [], central = [], offset = 0;
        files.forEach(function (f) {
            var name = utf8(f.name);
            var data = typeof f.data === 'string' ? utf8(f.data) : f.data;
            var crc = crc32(data);
            var local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
            lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);   // 固定時間 1980-01-01：同樣內容每次輸出一模一樣
            lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
            lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
            local.set(name, 30);
            var cen = new Uint8Array(46 + name.length), cv = new DataView(cen.buffer);
            cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
            cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
            cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
            cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
            cen.set(name, 46);
            chunks.push(local, data);
            central.push(cen);
            offset += local.length + data.length;
        });
        var cenBytes = concat(central);
        var end = new Uint8Array(22), ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
        ev.setUint32(12, cenBytes.length, true); ev.setUint32(16, offset, true);
        return concat(chunks.concat([cenBytes, end]));
    }

    // ===== xlsx =====
    function xmlEsc(s) {
        return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; })
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    }

    function colName(c) {   // 0 → A
        var s = '';
        for (c = c + 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s;
        return s;
    }

    // 欄寬（Excel 的字元寬）→ 像素／點。Excel 預設字型的數字寬 7px、左右留白共 5px
    function colPx(width) { return Math.floor(Number(width) * 7 + 5); }
    function colPt(width) { return colPx(width) * 0.75; }

    // 工作表名：最長 31 字、不可含 []:*?/\、不可重複
    function sheetNames(names) {
        var used = {};
        return names.map(function (raw, i) {
            var base = String(raw || '').replace(/[\[\]:*?\/\\]/g, ' ').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 31).trim() || ('Sheet' + (i + 1));
            var name = base, n = 2;
            while (used[name.toLowerCase()]) { var suf = ' (' + (n++) + ')'; name = base.slice(0, 31 - suf.length) + suf; }
            used[name.toLowerCase()] = true;
            return name;
        });
    }

    // 樣式表：把用到的樣式物件去重後編號。樣式 = { font:{name,sz,b,color}, fill:'RRGGBB', border:'lrtb' 的子集, align:{h,v,shrink,wrap}, fmt:'格式碼' }
    function styleBook() {
        var fonts = ['<font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>'];
        var fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
        var borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
        var fmts = [], xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'], seen = {};
        function intern(list, xml) { var i = list.indexOf(xml); return i >= 0 ? i : list.push(xml) - 1; }
        function add(st) {
            var key = JSON.stringify(st || {});
            if (seen[key] !== undefined) return seen[key];
            st = st || {};
            var f = st.font || {};
            var fontId = intern(fonts, '<font>' + (f.b ? '<b/>' : '') + '<sz val="' + (f.sz || 11) + '"/><color rgb="FF' + (f.color || '000000') + '"/><name val="' + xmlEsc(f.name || 'Calibri') + '"/><family val="2"/></font>');
            var fillId = st.fill ? intern(fills, '<fill><patternFill patternType="solid"><fgColor rgb="FF' + st.fill + '"/><bgColor indexed="64"/></patternFill></fill>') : 0;
            var b = st.border || '';
            function side(tag, ch) { return b.indexOf(ch) >= 0 ? '<' + tag + ' style="thin"><color rgb="FF000000"/></' + tag + '>' : '<' + tag + '/>'; }
            var borderId = b ? intern(borders, '<border>' + side('left', 'l') + side('right', 'r') + side('top', 't') + side('bottom', 'b') + '<diagonal/></border>') : 0;
            var numFmtId = 0;
            if (st.fmt) {
                var fi = fmts.indexOf(st.fmt);
                if (fi < 0) fi = fmts.push(st.fmt) - 1;
                numFmtId = 164 + fi;
            }
            var a = st.align || {};
            var align = (a.h || a.v || a.shrink || a.wrap)
                ? '<alignment' + (a.h ? ' horizontal="' + a.h + '"' : '') + (a.v ? ' vertical="' + a.v + '"' : '') + (a.wrap ? ' wrapText="1"' : '') + (a.shrink ? ' shrinkToFit="1"' : '') + '/>' : '';
            var xf = '<xf numFmtId="' + numFmtId + '" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + borderId + '" xfId="0"'
                + (numFmtId ? ' applyNumberFormat="1"' : '') + ' applyFont="1"' + (fillId ? ' applyFill="1"' : '') + (borderId ? ' applyBorder="1"' : '')
                + (align ? ' applyAlignment="1">' + align + '</xf>' : '/>');
            seen[key] = xfs.push(xf) - 1;
            return seen[key];
        }
        function xml() {
            return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + (fmts.length ? '<numFmts count="' + fmts.length + '">' + fmts.map(function (code, i) { return '<numFmt numFmtId="' + (164 + i) + '" formatCode="' + xmlEsc(code) + '"/>'; }).join('') + '</numFmts>' : '')
                + '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts>'
                + '<fills count="' + fills.length + '">' + fills.join('') + '</fills>'
                + '<borders count="' + borders.length + '">' + borders.join('') + '</borders>'
                + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                + '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>'
                + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
                + '</styleSheet>';
        }
        return { add: add, xml: xml };
    }

    // 點座標（距工作表左上角）→ 圖片錨點：落在第幾欄／列、欄內／列內偏移（EMU）
    function anchorOf(sheet, xPt, yPt) {
        var col = 0, row = 0, x = xPt, y = yPt, w, h;
        while (col < sheet.cols.length - 1 && x >= (w = colPt(sheet.cols[col]))) { x -= w; col++; }
        while (row < sheet.rows.length - 1 && y >= (h = sheet.rows[row].h || 15)) { y -= h; row++; }
        return { col: col, colOff: Math.round(x * EMU_PER_PT), row: row, rowOff: Math.round(y * EMU_PER_PT) };
    }

    function sheetXml(sheet, book, hasDrawing) {
        var styles = sheet.styles || {};
        var nCols = sheet.cols.length;
        var rows = sheet.rows.map(function (row, r) {
            var cells = (row.cells || []).map(function (cell, c) {
                if (!cell) return '';
                var ref = colName(c) + (r + 1);
                var s = book.add(styles[cell.s] || null);
                var attr = ' r="' + ref + '"' + (s ? ' s="' + s + '"' : '');
                var v = cell.v;
                if (cell.f) return '<c' + attr + '><f>' + xmlEsc(cell.f) + '</f>' + (typeof v === 'number' && isFinite(v) ? '<v>' + v + '</v>' : '') + '</c>';
                if (v === null || v === undefined || v === '') return '<c' + attr + '/>';
                if (typeof v === 'number' && isFinite(v)) return '<c' + attr + '><v>' + v + '</v></c>';
                return '<c' + attr + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
            }).join('');
            return '<row r="' + (r + 1) + '"' + (row.h ? ' ht="' + row.h + '" customHeight="1"' : '') + '>' + cells + '</row>';
        }).join('');
        var merges = (sheet.merges || []).map(function (m) { return '<mergeCell ref="' + colName(m.c1) + (m.r + 1) + ':' + colName(m.c2) + (m.r + 1) + '"/>'; });
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
            + '<dimension ref="A1:' + colName(nCols - 1) + sheet.rows.length + '"/>'
            + '<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>'
            + '<sheetFormatPr defaultRowHeight="15"/>'
            + '<cols>' + sheet.cols.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>'
            + '<sheetData>' + rows + '</sheetData>'
            + (merges.length ? '<mergeCells count="' + merges.length + '">' + merges.join('') + '</mergeCells>' : '')
            + '<printOptions horizontalCentered="1"/>'
            + '<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
            + '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>'   // A4 直向；寬度縮成一頁、長度不限
            + (hasDrawing ? '<drawing r:id="rId1"/>' : '')
            + '</worksheet>';
    }

    function drawingXml(sheet) {
        var im = sheet.image, a = anchorOf(sheet, im.x, im.y);
        var cx = Math.round(im.w * EMU_PER_PT), cy = Math.round(im.h * EMU_PER_PT);
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            + '<xdr:oneCellAnchor><xdr:from><xdr:col>' + a.col + '</xdr:col><xdr:colOff>' + a.colOff + '</xdr:colOff><xdr:row>' + a.row + '</xdr:row><xdr:rowOff>' + a.rowOff + '</xdr:rowOff></xdr:from>'
            + '<xdr:ext cx="' + cx + '" cy="' + cy + '"/>'
            + '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
            + '<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
            + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>'
            + '<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>';
    }

    // 圖片格式：看檔頭，不看副檔名（標誌檔叫 .png 但實際存成 JPEG 也照樣可用）
    function imageExt(bytes) {
        if (bytes && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
        if (bytes && bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
        return '';
    }

    // sheets = [{ name, cols:[字元寬], rows:[{ h:點, cells:[{ v, f, s } | null] }], merges:[{ r, c1, c2 }], styles:{ 鍵: 樣式 },
    //             image:{ x, y, w, h }（點，距左上角）, titleRows:[起, 迄]（0 起算；列印時每頁重複）}]
    // opts.image = Uint8Array（PNG 或 JPEG；所有工作表共用這一張）
    function build(sheets, opts) {
        var o = opts || {};
        var ext = imageExt(o.image);
        var book = styleBook();
        var names = sheetNames(sheets.map(function (s) { return s.name; }));
        var NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
        var NS_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
        var head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
        var files = [], sheetFiles = [];
        var drawn = sheets.map(function (s) { return !!(ext && s.image); });

        sheets.forEach(function (s, i) {
            var n = i + 1;
            sheetFiles.push({ name: 'xl/worksheets/sheet' + n + '.xml', data: sheetXml(s, book, drawn[i]) });
            if (!drawn[i]) return;
            sheetFiles.push({ name: 'xl/worksheets/_rels/sheet' + n + '.xml.rels', data: head + '<Relationships xmlns="' + NS_REL + '"><Relationship Id="rId1" Type="' + NS_DOC + '/drawing" Target="../drawings/drawing' + n + '.xml"/></Relationships>' });
            sheetFiles.push({ name: 'xl/drawings/drawing' + n + '.xml', data: drawingXml(s) });
            sheetFiles.push({ name: 'xl/drawings/_rels/drawing' + n + '.xml.rels', data: head + '<Relationships xmlns="' + NS_REL + '"><Relationship Id="rId1" Type="' + NS_DOC + '/image" Target="../media/image1.' + ext + '"/></Relationships>' });
        });

        var titles = sheets.map(function (s, i) {
            if (!s.titleRows) return '';
            return '<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">\'' + xmlEsc(names[i].replace(/'/g, "''")) + '\'!$' + (s.titleRows[0] + 1) + ':$' + (s.titleRows[1] + 1) + '</definedName>';
        }).join('');

        files.push({ name: '[Content_Types].xml', data: head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            + (drawn.indexOf(true) >= 0 ? '<Default Extension="' + ext + '" ContentType="image/' + ext + '"/>' : '')
            + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + sheets.map(function (s, i) {
                return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                    + (drawn[i] ? '<Override PartName="/xl/drawings/drawing' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '');
            }).join('') + '</Types>' });
        files.push({ name: '_rels/.rels', data: head + '<Relationships xmlns="' + NS_REL + '"><Relationship Id="rId1" Type="' + NS_DOC + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
        files.push({ name: 'xl/workbook.xml', data: head + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + NS_DOC + '">'
            + '<bookViews><workbookView/></bookViews>'
            + '<sheets>' + names.map(function (n, i) { return '<sheet name="' + xmlEsc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets>'
            + (titles ? '<definedNames>' + titles + '</definedNames>' : '')
            + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>' });   // 開檔時重算一次公式（快取值只給不會算公式的預覽程式看）
        files.push({ name: 'xl/_rels/workbook.xml.rels', data: head + '<Relationships xmlns="' + NS_REL + '">'
            + names.map(function (n, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="' + NS_DOC + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('')
            + '<Relationship Id="rId' + (names.length + 1) + '" Type="' + NS_DOC + '/styles" Target="styles.xml"/></Relationships>' });
        files = files.concat(sheetFiles);
        files.push({ name: 'xl/styles.xml', data: book.xml() });   // 放在工作表之後：樣式要等所有儲存格都登記完
        if (drawn.indexOf(true) >= 0) files.push({ name: 'xl/media/image1.' + ext, data: o.image });
        return zip(files);
    }

    // ===== pdf：每頁一張 JPEG 鋪滿 =====
    // pages = [{ jpeg: Uint8Array, pxW, pxH, wPt, hPt }]
    function pdfFromJpegs(pages) {
        var chunks = [], offsets = [], pos = 0;
        function ascii(s) { var b = new Uint8Array(s.length), i; for (i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xFF; return b; }
        function put(b) { chunks.push(b); pos += b.length; }
        function obj(n, body, stream) {
            offsets[n] = pos;
            put(ascii(n + ' 0 obj\n' + body + (stream ? '\nstream\n' : '\nendobj\n')));
            if (stream) { put(stream); put(ascii('\nendstream\nendobj\n')); }
        }
        function num(x) { return String(Math.round(x * 100) / 100); }
        put(ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
        var kids = pages.map(function (p, i) { return (3 + i * 3) + ' 0 R'; }).join(' ');
        obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
        obj(2, '<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>');
        pages.forEach(function (p, i) {
            var page = 3 + i * 3, content = page + 1, image = page + 2;
            var draw = ascii('q ' + num(p.wPt) + ' 0 0 ' + num(p.hPt) + ' 0 0 cm /Im0 Do Q');
            obj(page, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(p.wPt) + ' ' + num(p.hPt) + '] /Resources << /XObject << /Im0 ' + image + ' 0 R >> >> /Contents ' + content + ' 0 R >>');
            obj(content, '<< /Length ' + draw.length + ' >>', draw);
            obj(image, '<< /Type /XObject /Subtype /Image /Width ' + p.pxW + ' /Height ' + p.pxH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>', p.jpeg);
        });
        var total = 3 + pages.length * 3, xref = pos, i;
        var table = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
        for (i = 1; i < total; i++) table += ('0000000000' + offsets[i]).slice(-10) + ' 00000 n \n';
        put(ascii(table + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'));
        return concat(chunks);
    }

    return {
        build: build,
        pdfFromJpegs: pdfFromJpegs,
        zip: zip,
        crc32: crc32,
        utf8: utf8,
        colName: colName,
        colPx: colPx,
        colPt: colPt,
        sheetNames: sheetNames,
        anchorOf: anchorOf,
        imageExt: imageExt
    };
}));
