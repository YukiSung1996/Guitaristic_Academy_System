// paysheet-ui.js — 糧單下載（高級薪酬管理頁）：Excel 與 PDF，一位導師一張
// 版面由 lib/paysheet.js 產生一個「格子模型」；Excel 交 lib/xlsx.js 寫檔，PDF 則把同一個模型畫到 canvas（A4，每頁一張圖）再包成 PDF，
// 所以兩種檔案長得一樣。數字只算「已確認」的課（已上課＋缺席），與頁面「目前應付」同口徑。
// 標誌：assets/paysheet-logo.png（6:1 的橫幅）。換成真實標誌只要覆蓋這個檔；比例不同也會等比例縮放、置中。

const PAYSHEET_LOGO_URL = 'assets/paysheet-logo.png';
const PAYSHEET_PAGE = { w: 595.28, h: 841.89, margin: 36, pxPerPt: 3 };   // A4（點）；3 像素／點 ≈ 216 dpi
const PAYSHEET_FONT = '"Century Gothic", "Microsoft JhengHei", "PingFang HK", "Noto Sans CJK TC", sans-serif';

// 讀標誌：位元組給 Excel、Image 給 canvas。讀不到（檔案不在、不是 PNG／JPEG）就不放標誌，照樣出檔
function paysheetLoadLogo() {
  return fetch(PAYSHEET_LOGO_URL, { cache: 'no-store' })
    .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.arrayBuffer(); })
    .then(buf => {
      const bytes = new Uint8Array(buf);
      const ext = GACXlsx.imageExt(bytes);
      if (!ext) throw new Error('not png/jpeg');
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ bytes: bytes, img: img, width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('decode'));
        img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/' + ext }));
      });
    })
    .catch(() => null);
}

// 目前月份要出糧單的導師 → 版面模型。tutorName 為 null＝全部導師；沒有已確認課堂也沒有調整的導師不出
function paysheetModels(tutorName, logo) {
  const monthKey = advancedMonth();
  const s = advancedPayrollState.summary;
  if (!monthKey || !s) return [];
  const payable = GACPayroll.payableLessons(lessonsByMonth, monthKey);
  return s.tutors.filter(t => tutorName === null || t.tutor === tutorName).map(t => {
    const rows = GACPaysheet.lessonRows(payable.filter(l => (l.tutor || '') === t.tutor), rateForLesson);
    // 只放指名給這位導師的調整；「全月（不分導師）」的調整不屬於任何一張糧單
    const adjustments = !t.tutor ? [] : advancedPayrollState.adjustments
      .filter(a => a.tutor === t.tutor && Number(a.amount))
      .map(a => ({ name: a.name || '', amount: (a.type === 'sub' ? -1 : 1) * Number(a.amount) }));
    if (!rows.length && !adjustments.length) return null;
    return GACPaysheet.buildSheet({
      tutor: t.tutor || '未指定導師', monthKey: monthKey, rows: rows, adjustments: adjustments,
      sharePct: advancedPayrollState.share, dateStr: advancedTodayStr(), logo: logo
    });
  }).filter(Boolean);
}

// 把一張糧單畫成 A4 頁面（canvas 陣列）。表格比紙寬就整體縮小；學生太多放不下一頁就分頁，新的一頁先重畫表頭
function paysheetRenderPages(model, logoImg) {
  const P = PAYSHEET_PAGE, S = model.styles;
  const colW = model.cols.map(GACXlsx.colPt);
  const colX = [];
  const tableW = colW.reduce((x, w, i) => { colX[i] = x; return x + w; }, 0);
  const scale = Math.min(1, (P.w - P.margin * 2) / tableW);
  const limit = (P.h - P.margin * 2) / scale;   // 一頁放得下的高度（以下座標一律是「工作表的點」）
  const span = {};                              // 'r,c' → 合併到第幾欄；被併掉的格子記 -1
  model.merges.forEach(m => { span[m.r + ',' + m.c1] = m.c2; for (let c = m.c1 + 1; c <= m.c2; c++) span[m.r + ',' + c] = -1; });
  const pages = [];
  let ctx = null, y = 0;

  const newPage = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(P.w * P.pxPerPt);
    canvas.height = Math.round(P.h * P.pxPerPt);
    ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const k = P.pxPerPt * scale;
    ctx.setTransform(k, 0, 0, k, (P.w - tableW * scale) / 2 * P.pxPerPt, P.margin * P.pxPerPt);
    pages.push(canvas);
    y = 0;
  };

  const drawRow = r => {
    const row = model.rows[r];
    const boxes = [];
    (row.cells || []).forEach((cell, c) => {
      if (!cell || span[r + ',' + c] === -1) return;
      const c2 = span[r + ',' + c] === undefined ? c : span[r + ',' + c];
      boxes.push({ cell: cell, st: S[cell.s] || {}, x: colX[c], w: colX[c2] + colW[c2] - colX[c] });
    });
    boxes.forEach(b => { if (b.st.fill) { ctx.fillStyle = '#' + b.st.fill; ctx.fillRect(b.x, y, b.w, row.h); } });
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 0.6;
    boxes.forEach(b => {
      const bd = b.st.border || '';
      const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
      if (bd.includes('l')) line(b.x, y, b.x, y + row.h);
      if (bd.includes('r')) line(b.x + b.w, y, b.x + b.w, y + row.h);
      if (bd.includes('t')) line(b.x, y, b.x + b.w, y);
      if (bd.includes('b')) line(b.x, y + row.h, b.x + b.w, y + row.h);
    });
    boxes.forEach(b => {
      const text = b.cell.text;
      if (!text) return;
      const f = b.st.font || {}, a = b.st.align || {};
      const pad = 3, maxW = b.w - pad * 2;
      let size = f.sz || 11;
      const setFont = () => { ctx.font = (f.b ? 'bold ' : '') + size + 'px ' + PAYSHEET_FONT; };
      setFont();
      if (a.shrink) while (ctx.measureText(text).width > maxW && size > 5) { size -= 0.5; setFont(); }   // 同 Excel 的「縮小字型以適合欄寬」
      ctx.fillStyle = '#' + (f.color || '000000');
      ctx.textBaseline = 'middle';
      ctx.textAlign = a.h === 'right' ? 'right' : a.h === 'center' ? 'center' : 'left';
      ctx.fillText(text, a.h === 'right' ? b.x + b.w - pad : a.h === 'center' ? b.x + b.w / 2 : b.x + pad, y + row.h / 2 + size * 0.06);
    });
    y += row.h;
  };

  newPage();
  if (logoImg && model.image) ctx.drawImage(logoImg, model.image.x, model.image.y, model.image.w, model.image.h);
  model.rows.forEach((row, r) => {
    if (y + row.h > limit) {
      newPage();
      if (r > model.bodyRows[0] && r <= model.bodyRows[1]) drawRow(model.titleRows[0]);
    }
    drawRow(r);
  });
  if (pages.length > 1) pages.forEach((canvas, i) => {   // 超過一頁才印頁碼
    const c = canvas.getContext('2d');
    c.setTransform(P.pxPerPt, 0, 0, P.pxPerPt, 0, 0);
    c.font = '8px ' + PAYSHEET_FONT;
    c.fillStyle = '#64748b';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(model.name + '　' + (i + 1) + ' / ' + pages.length, P.w / 2, P.h - P.margin / 2);
  });
  return pages;
}

function paysheetCanvasJpeg(canvas) {
  const bin = atob(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function paysheetPdfBytes(models, logo) {
  const pages = [];
  models.forEach(m => paysheetRenderPages(m, logo && logo.img).forEach(canvas => {
    pages.push({ jpeg: paysheetCanvasJpeg(canvas), pxW: canvas.width, pxH: canvas.height, wPt: PAYSHEET_PAGE.w, hPt: PAYSHEET_PAGE.h });
  }));
  return GACXlsx.pdfFromJpegs(pages);
}

function paysheetSave(bytes, filename, type) {
  const link = document.createElement('a');
  link.href = window.URL.createObjectURL(new Blob([bytes], { type: type }));
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// 下載糧單。kind = 'xlsx' | 'pdf'；tutorIndex（advancedPayrollState.summary.tutors 的位置）省略＝全部導師合成一個檔
// （Excel 每位導師一個工作表、PDF 每位導師另起一頁）。回傳 Promise<是否有出檔>
function advancedDownloadSheet(kind, tutorIndex) {
  const s = advancedPayrollState.summary, monthKey = advancedMonth();
  if (!s || !monthKey) return Promise.resolve(false);
  const only = tutorIndex === undefined ? null : s.tutors[tutorIndex];
  if (tutorIndex !== undefined && !only) return Promise.resolve(false);
  return paysheetLoadLogo().then(logo => {
    const models = paysheetModels(only ? only.tutor : null, logo);
    if (!models.length) {
      showToast(`⚠️ ${monthKey}${only ? '「' + (only.tutor || '未指定導師') + '」' : ''} 還沒有已確認的課堂，沒有糧單可下載。\n先到總課表按「批量確認出席」。`);
      return false;
    }
    const name = GACPaysheet.fileName(monthKey, only ? (only.tutor || '未指定導師') : '', kind);
    if (kind === 'pdf') paysheetSave(paysheetPdfBytes(models, logo), name, 'application/pdf');
    else paysheetSave(GACXlsx.build(models, { image: logo && logo.bytes }), name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const pending = only ? only.pending : s.totals.pending;
    showToast(`✅ 已下載糧單 ${name}（${models.length} 位導師）`
      + (pending ? `\n注意：還有 ${pending} 堂待確認，未計入糧單（只算已確認出席的課）。` : '')
      + (logo ? '' : `\n讀不到標誌圖檔（${PAYSHEET_LOGO_URL}），這次沒有放標誌。`));
    return true;
  }).catch(e => {
    showToast('⚠️ 糧單下載失敗：' + (e && e.message ? e.message : e));
    return false;
  });
}
