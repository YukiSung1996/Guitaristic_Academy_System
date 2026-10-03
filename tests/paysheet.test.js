// 糧單（Teacher's Tuition Fee Mark Sheet）：明細列、版面模型，以及 xlsx／pdf 檔案產生器
const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../lib/paysheet.js');
const X = require('../lib/xlsx.js');

function lessons(id, name, n, extra) {
    return Array.from({ length: n }, () => Object.assign({
        studentId: id, studentName: name, program: 'Pop Guitar', level: 'Elementary 初級', duration: 45, status: 'ATTENDED', tutor: 'Instructor B'
    }, extra || {}));
}
// 查價契約：回傳一整堂的價（分段補堂按 baseDuration 查，比例由 lessonRows 乘）
const rate = l => (l.groupId ? 180 : Math.round(245 * (l.baseDuration || l.duration) / 45));

// 讀回 zip（只存不壓）：{ 檔名: Buffer }，順便核對每個檔的 CRC
function unzip(bytes) {
    const buf = Buffer.from(bytes), out = {};
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = buf.readUInt16LE(end + 10);
    let pos = buf.readUInt32LE(end + 16);
    for (let i = 0; i < count; i++) {
        assert.strictEqual(buf.readUInt32LE(pos), 0x02014b50);
        const crc = buf.readUInt32LE(pos + 16), size = buf.readUInt32LE(pos + 24), nameLen = buf.readUInt16LE(pos + 28), local = buf.readUInt32LE(pos + 42);
        const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
        assert.strictEqual(buf.readUInt32LE(local), 0x04034b50);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        out[name] = buf.slice(start, start + size);
        assert.strictEqual(X.crc32(out[name]), crc, name + ' 的 CRC');
        pos += 46 + nameLen;
    }
    return out;
}

function sampleSheet(extra) {
    const all = [].concat(lessons('S001', 'Student 001', 4), lessons('S002', 'Student 002', 3),
        lessons('S002', 'Student 002', 1, { duration: 60, isMakeup: true }),
        lessons('S003', 'Student 003', 3, { groupId: 'G1', groupName: 'Pop 小組 A', classType: '小組' }),
        lessons('S003', 'Student 003', 1, { groupId: 'G1', groupName: 'Pop 小組 A', classType: '小組', status: 'NOSHOW' }));
    return P.buildSheet(Object.assign({
        tutor: 'Instructor B', monthKey: '2026-09', rows: P.lessonRows(all, rate),
        adjustments: [{ name: '交通津貼', amount: 500 }, { name: '遲到扣款', amount: -100 }],
        sharePct: 50, dateStr: '2026-10-01', logo: { width: 1200, height: 200 }
    }, extra || {}));
}
const texts = sheet => sheet.rows.map(r => (r.cells || []).map(c => (c ? c.text : '')));

test('monthLabel／fileName／money', () => {
    assert.strictEqual(P.monthLabel('2026-09'), 'Sept 2026');
    assert.strictEqual(P.monthLabel('2027-01'), 'Jan 2027');
    assert.strictEqual(P.fileName('2026-09', '', 'xlsx'), 'Guitaristic_Paysheet_2026-09.xlsx');
    assert.strictEqual(P.fileName('2026-09', 'Instructor B', 'pdf'), 'Guitaristic_Paysheet_2026-09_Instructor-B.pdf');
    assert.strictEqual(P.money(1234567.5, 'HK$ ', 2), 'HK$ 1,234,567.50');
    assert.strictEqual(P.money(-100, 'HK$ ', 2), '-HK$ 100.00');
    assert.strictEqual(P.money(980, '$', 0), '$980');
});

test('lessonRows：同一位學生同價合成一列；不同價拆列並註明時長；Σ 金額＝逐堂費率總和', () => {
    const all = [].concat(lessons('S001', 'Student 001', 4), lessons('S002', 'Student 002', 3),
        lessons('S002', 'Student 002', 1, { duration: 60, isMakeup: true }));
    const rows = P.lessonRows(all, rate);
    assert.deepStrictEqual(rows.map(r => [r.student, r.grade, r.rate, r.count, r.amount, r.remark]), [
        ['Student 001', 'Pop Guitar - Elementary 初級', 245, 4, 980, ''],
        ['Student 002', 'Pop Guitar - Elementary 初級', 245, 3, 735, '45 分鐘'],
        ['Student 002', 'Pop Guitar - Elementary 初級', 327, 1, 327, '60 分鐘；含補堂 1 堂']
    ]);
    assert.strictEqual(rows.reduce((s, r) => s + r.amount, 0), all.reduce((s, l) => s + rate(l), 0));
});

test('lessonRows：分段補堂併進同一列——堂數按比例（三段 15 分鐘＝1 堂、兩段＝⅔）、金額四捨五入到分、備註寫分鐘數', () => {
    const PR = require('../lib/payroll.js');
    const part = (n, mins) => lessons('S001', 'Student 001', n, { isMakeup: true, duration: mins, baseDuration: 45 });
    const rows = P.lessonRows([].concat(lessons('S001', 'Student 001', 4), part(3, 15)), rate);
    assert.deepStrictEqual(rows.map(r => [r.student, r.rate, r.count, r.amount, r.remark]), [['Student 001', 245, 5, 1225, '含分段補堂 45 分鐘（3 段）']], '三段 15 分鐘＝一整堂，和常規課併成一列');
    const two = P.lessonRows([].concat(lessons('S001', 'Student 001', 4), part(2, 15)), rate)[0];
    assert.deepStrictEqual([two.count, two.amount, PR.formatCount(two.count)], [4.666667, 1143.33, '4⅔']);
    const sheet = P.buildSheet({ tutor: 'T', monthKey: '2026-09', rows: P.lessonRows([].concat(lessons('S001', 'Student 001', 4), part(2, 15)), rate), adjustments: [], sharePct: 50, dateStr: '2026-10-01' });
    const c = sheet.rows[7].cells;
    assert.deepStrictEqual([c[4].text, c[4].s, c[5].text, c[5].f], ['4⅔', 'tdFrac', '$1,143.33', 'ROUND(D8*E8,2)'], 'Excel 用分數格式、PDF 印 ⅔；金額公式四捨五入到分');
    assert.strictEqual(c[4].v, 4.666667);
    assert.deepStrictEqual([2.5, 0.25, 0.75, 1.1, 3].map(PR.formatCount), ['2½', '¼', '¾', '1.1', '3']);
});

test('lessonRows：小組／舊式小組／缺席的備註；同名不同人帶學號；個別課排在小組前', () => {
    const rows = P.lessonRows([].concat(
        lessons('S010', 'Amy', 2, { groupId: 'G1', groupName: 'Pop 小組 A', classType: '小組' }),
        lessons('S010', 'Amy', 1, { groupId: 'G1', groupName: 'Pop 小組 A', classType: '小組', status: 'NOSHOW' }),
        lessons('S011', 'Amy', 4),
        lessons('S012', 'Ben', 4, { classType: '2人小組' })), rate);
    assert.deepStrictEqual(rows.map(r => [r.student, r.count, r.remark]), [
        ['Amy（S011）', 4, ''],
        ['Ben', 4, '2人小組'],
        ['Amy（S010）', 3, '小組：Pop 小組 A；含缺席 1 堂']
    ]);
});

test('buildSheet：標題、導師、日期、明細、Sub Total、調整、Total（公式與快取值一致）', () => {
    const sheet = sampleSheet();
    const t = texts(sheet);
    assert.strictEqual(t[3][0], "Teacher's Tuition Fee Mark Sheet (Sept 2026)");
    assert.deepStrictEqual([t[4][0], t[4][2], t[4][7]], ["Tutor's name", 'Instructor B', '2026-10-01']);
    assert.strictEqual(sheet.rows[4].cells[7].v, 46296);   // 2026-10-01 的 Excel 日期序號
    assert.strictEqual(t[5][6], 'Cheque #');
    assert.deepStrictEqual(t[6], ['', 'Student', 'Grade', '$/LSN.', '#/LSN', 'Amount', 'Tutor Portion', 'Remarks']);
    assert.deepStrictEqual(t[7], ['1', 'Student 001', 'Pop Guitar - Elementary 初級', '$245', '4', '$980', 'HK$ 490.00', '']);
    assert.deepStrictEqual(sheet.rows[7].cells.map(c => c.f), [undefined, undefined, undefined, undefined, undefined, 'ROUND(D8*E8,2)', 'F8*50%', undefined]);
    assert.deepStrictEqual(sheet.titleRows, [6, 6]);
    assert.deepStrictEqual(sheet.bodyRows, [7, 11]);   // 4 列明細＋1 列空白
    assert.ok(sheet.rows[11].cells.every(c => c.v === null), '明細後留一列空白');
    const sub = sheet.rows[12].cells;
    assert.deepStrictEqual([sub[5].text, sub[6].text, sub[6].f], ['Sub Total', 'HK$ 1,381.00', 'SUM(G8:G12)']);   // (980+735+327+720) × 50%
    assert.strictEqual(t[14][0], '樂器銷售佣金／其他調整');
    assert.deepStrictEqual(t[15], ['', 'Student', 'Item', '%', 'Amount', '', 'Commission', 'Remarks']);
    assert.deepStrictEqual([t[16][2], t[16][6], t[16][7]], ['交通津貼', 'HK$ 500.00', '']);
    assert.deepStrictEqual([t[17][2], t[17][6], t[17][7]], ['遲到扣款', '-HK$ 100.00', '扣款']);
    const total = sheet.rows[18].cells;
    assert.deepStrictEqual([total[5].text, total[6].text, total[6].f], ['Total', 'HK$ 1,781.00', 'G13+SUM(G17:G18)']);
    assert.deepStrictEqual(sheet.totals, { subTotal: 1381, adjTotal: 400, total: 1781 });
    assert.deepStrictEqual(sheet.merges, [{ r: 3, c1: 0, c2: 7 }, { r: 4, c1: 0, c2: 1 }, { r: 4, c1: 2, c2: 5 }, { r: 14, c1: 0, c2: 7 },
        { r: 15, c1: 4, c2: 5 }, { r: 16, c1: 4, c2: 5 }, { r: 17, c1: 4, c2: 5 }]);
});

test('buildSheet：沒有調整時佣金區留兩列「/」；非整數拆帳照算；價錢有小數時顯示兩位', () => {
    const sheet = sampleSheet({ adjustments: [], sharePct: 47.5, rows: P.lessonRows(lessons('S001', 'Student 001', 3), () => 245.5) });
    const t = texts(sheet);
    assert.deepStrictEqual(t[7].slice(3, 7), ['$245.50', '3', '$736.50', 'HK$ 349.84']);   // 736.5 × 47.5% = 349.8375
    assert.strictEqual(sheet.rows[7].cells[6].f, 'F8*47.5%');
    assert.deepStrictEqual([t[13][0], t[13][1], t[14][0], t[14][1]], ['1', '/', '2', '/']);
    assert.strictEqual(sheet.rows.length, 16);
    assert.ok(Math.abs(sheet.totals.total - 349.8375) < 1e-9 && sheet.totals.adjTotal === 0);
});

test('標誌：6:1 放進頂部三列並置中；比例不同照樣等比例；沒有標誌就留白', () => {
    const tableW = P.COLS.reduce((s, w) => s + X.colPt(w), 0);
    const im = sampleSheet().image;
    assert.deepStrictEqual([im.w, im.h, im.y], [336, 56, 2]);
    assert.ok(Math.abs(im.x - (tableW - 336) / 2) < 1e-9);
    const wide = P.layoutLogo({ width: 4000, height: 100 }, tableW);   // 40:1：以表格寬為限
    assert.ok(Math.abs(wide.w - tableW) < 1e-9 && Math.abs(wide.h - tableW / 40) < 1e-9 && wide.x === 0);
    const square = P.layoutLogo({ width: 300, height: 300 }, tableW);
    assert.deepStrictEqual([square.w, square.h], [56, 56]);
    assert.strictEqual(sampleSheet({ logo: null }).image, null);
});

test('xlsx：zip 結構與 CRC 正確；工作表、樣式、圖片、列印表頭都在', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]);
    const files = unzip(X.build([sampleSheet(), sampleSheet({ tutor: 'Instructor A' })], { image: png }));
    assert.deepStrictEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/drawings/_rels/drawing1.xml.rels',
        'xl/drawings/_rels/drawing2.xml.rels', 'xl/drawings/drawing1.xml', 'xl/drawings/drawing2.xml', 'xl/media/image1.png', 'xl/styles.xml', 'xl/workbook.xml',
        'xl/worksheets/_rels/sheet1.xml.rels', 'xl/worksheets/_rels/sheet2.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    assert.deepStrictEqual([...files['xl/media/image1.png']], [...png]);
    const wb = files['xl/workbook.xml'].toString('utf8');
    assert.ok(wb.includes('<sheet name="Instructor B" sheetId="1" r:id="rId1"/>') && wb.includes('<sheet name="Instructor A" sheetId="2" r:id="rId2"/>'));
    assert.ok(wb.includes('<definedName name="_xlnm.Print_Titles" localSheetId="0">\'Instructor B\'!$7:$7</definedName>') && wb.includes('fullCalcOnLoad="1"'));
    const sh = files['xl/worksheets/sheet1.xml'].toString('utf8');
    assert.ok(sh.includes('<is><t xml:space="preserve">Teacher\'s Tuition Fee Mark Sheet (Sept 2026)</t></is>'));
    assert.ok(/<c r="F8" s="\d+"><f>ROUND\(D8\*E8,2\)<\/f><v>980<\/v><\/c>/.test(sh) && /<c r="G13" s="\d+"><f>SUM\(G8:G12\)<\/f><v>1381<\/v><\/c>/.test(sh));
    assert.ok(/<c r="H5" s="\d+"><v>46296<\/v><\/c>/.test(sh), '日期寫成序號');
    assert.ok(sh.includes('<mergeCell ref="A4:H4"/>') && sh.includes('<mergeCell ref="E16:F16"/>') && sh.includes('<drawing r:id="rId1"/>'));
    assert.ok(sh.includes('fitToWidth="1" fitToHeight="0"') && sh.includes('showGridLines="0"'));
    assert.ok(sh.indexOf('<sheetData>') < sh.indexOf('<mergeCells') && sh.indexOf('<mergeCells') < sh.indexOf('<pageMargins') && sh.indexOf('<pageSetup') < sh.indexOf('<drawing'), '元素順序照規格');
    const styles = files['xl/styles.xml'].toString('utf8');
    assert.ok(styles.includes('formatCode="&quot;HK$ &quot;#,##0.00"') && styles.includes('formatCode="yyyy-mm-dd"') && styles.includes('<name val="Century Gothic"/>'));
    assert.ok(styles.includes('<fgColor rgb="FFC6EFCE"/>') && styles.includes('shrinkToFit="1"'));
    const ct = files['[Content_Types].xml'].toString('utf8');
    assert.ok(ct.includes('Extension="png" ContentType="image/png"') && ct.includes('/xl/drawings/drawing2.xml'));
    const dr = files['xl/drawings/drawing1.xml'].toString('utf8');
    assert.ok(dr.includes('<xdr:ext cx="' + 336 * 12700 + '" cy="' + 56 * 12700 + '"/>') && dr.includes('<xdr:row>0</xdr:row><xdr:rowOff>' + 2 * 12700 + '</xdr:rowOff>'));
});

test('xlsx：沒有圖片（或不是 PNG／JPEG）就不寫圖；特殊字元跳脫；同樣內容每次輸出一模一樣', () => {
    const sheet = sampleSheet({ tutor: 'A & <B> "C"' });
    const files = unzip(X.build([sheet], { image: new Uint8Array([1, 2, 3]) }));
    assert.ok(!Object.keys(files).some(n => /drawing|media/.test(n)));
    assert.ok(!files['xl/worksheets/sheet1.xml'].toString('utf8').includes('<drawing'));
    assert.ok(files['xl/worksheets/sheet1.xml'].toString('utf8').includes('A &amp; &lt;B&gt; &quot;C&quot;'));
    assert.ok(files['xl/workbook.xml'].toString('utf8').includes('<sheet name="A &amp; &lt;B&gt; &quot;C&quot;"'));
    assert.deepStrictEqual(Buffer.from(X.build([sheet], {})), Buffer.from(X.build([sheet], {})));
    assert.strictEqual(X.imageExt(new Uint8Array([0xFF, 0xD8, 0xFF])), 'jpeg');
});

test('sheetNames：去掉不合法字元、最長 31 字、重名加編號', () => {
    assert.deepStrictEqual(X.sheetNames(['Instructor A', 'instructor a', "A/B:C*D?[E]\\F", '', 'x'.repeat(40), "'Tom'"]),
        ['Instructor A', 'instructor a (2)', 'A B C D E F', 'Sheet4', 'x'.repeat(31), 'Tom']);
});

test('colName／colPt／utf8／anchorOf', () => {
    assert.deepStrictEqual([X.colName(0), X.colName(7), X.colName(25), X.colName(26), X.colName(701), X.colName(702)], ['A', 'H', 'Z', 'AA', 'ZZ', 'AAA']);
    assert.strictEqual(X.colPt(16), 87.75);   // floor(16×7+5)=117px → 87.75pt
    assert.deepStrictEqual([...X.utf8('A級😀')], [...Buffer.from('A級😀', 'utf8')]);
    const sheet = { cols: [4.5, 16, 29], rows: [{ h: 20 }, { h: 20 }, { h: 20 }] };
    assert.deepStrictEqual(X.anchorOf(sheet, 0, 0), { col: 0, colOff: 0, row: 0, rowOff: 0 });
    assert.deepStrictEqual(X.anchorOf(sheet, 27 + 10, 25), { col: 1, colOff: 127000, row: 1, rowOff: 63500 });   // 第一欄 36px＝27pt
});

test('pdfFromJpegs：每頁一張圖、xref 的位移都指到對應的物件', () => {
    const jpeg = new Uint8Array([0xFF, 0xD8, 9, 9, 9, 0xFF, 0xD9]);
    const pdf = Buffer.from(X.pdfFromJpegs([{ jpeg, pxW: 10, pxH: 20, wPt: 595.28, hPt: 841.89 }, { jpeg, pxW: 10, pxH: 20, wPt: 595.28, hPt: 841.89 }]));
    const text = pdf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4\n') && text.endsWith('%%EOF\n'));
    assert.ok(text.includes('/Type /Pages /Kids [3 0 R 6 0 R] /Count 2') && text.includes('/MediaBox [0 0 595.28 841.89]'));
    assert.strictEqual(text.split('/Filter /DCTDecode /Length 7 >>').length, 3);
    const xref = Number(/startxref\n(\d+)\n/.exec(text)[1]);
    assert.strictEqual(text.substr(xref, 4), 'xref');
    const lines = text.slice(xref).split('\n');
    assert.strictEqual(lines[1], '0 9');
    for (let i = 1; i < 9; i++) assert.ok(text.slice(Number(lines[2 + i].slice(0, 10))).startsWith(i + ' 0 obj'), '物件 ' + i);
});
