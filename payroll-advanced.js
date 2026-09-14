const advancedPayrollState = {
  rows: [],
  adjustments: JSON.parse(localStorage.getItem('gac_adjustments') || '[]'),
  archives: JSON.parse(localStorage.getItem('gac_payroll_archives') || '[]'),
  share: Number(localStorage.getItem('gac_tutor_share_pct') || 50),
  events: []
};

function advancedTutor(student) {
  return student.tutor === 'Instructor B' ? '資深導師' : '普通導師';
}

function advancedGrade(student) {
  const value = String(student.level || '').trim();
  return GRADE_OPTIONS.includes(value) ? value : 'Intermediate 中級';
}

function advancedClassType(student) {
  return student.type === '一對一' ? '一對一個別授課 Individual' : student.type === '3人小組' ? '3-4人小組授課' : '2人小組授課';
}

function advancedRate(student) {
  const match = rateTable.find(item => item.tutor === advancedTutor(student) && item.instrument === student.program && item.grade === advancedGrade(student) && item.classType === advancedClassType(student) && item.duration === Number(student.duration));
  if (match) return match.rate;
  const duration = Number(student.duration) || 45;
  const levelFactor = /Grade [5-8]|Advanced/.test(String(student.level || '')) ? 1.15 : 1;
  return Math.round(230 * duration / 45 * levelFactor);
}

function advancedMoney(value) {
  return `HK$ ${Number(value || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}

function advancedRenderRows() {
  const body = document.querySelector('#advancedPayrollBody');
  if (!body) return;
  body.innerHTML = advancedPayrollState.rows.map((row, index) => `<tr><td>${row.id}</td><td>${row.name}</td><td>${row.tutor}</td><td><input data-advanced-lessons="${index}" type="number" min="0" value="${row.lessons}"></td><td>${advancedMoney(row.rate)}</td><td>${advancedMoney(row.lessons * row.rate)}</td><td><button type="button" data-remove-advanced="${index}">刪除</button></td></tr>`).join('') || '<tr><td colspan="7">請從學生資料匯入薪酬資料。</td></tr>';
  body.querySelectorAll('[data-advanced-lessons]').forEach(input => input.addEventListener('input', () => { advancedPayrollState.rows[Number(input.dataset.advancedLessons)].lessons = Number(input.value) || 0; advancedCalculate(); }));
  body.querySelectorAll('[data-remove-advanced]').forEach(button => button.addEventListener('click', () => { advancedPayrollState.rows.splice(Number(button.dataset.removeAdvanced), 1); advancedRenderRows(); advancedCalculate(); }));
}

function advancedRenderAdjustments() {
  const body = document.querySelector('#advancedAdjustmentsBody');
  if (!body) return;
  body.innerHTML = advancedPayrollState.adjustments.map((item, index) => `<tr><td><input data-adjust-name="${index}" value="${item.name || ''}"></td><td><select data-adjust-type="${index}"><option value="add" ${item.type === 'add' ? 'selected' : ''}>津貼 / 獎金 (+)</option><option value="sub" ${item.type === 'sub' ? 'selected' : ''}>扣除款項 (-)</option></select></td><td><input data-adjust-amount="${index}" type="number" value="${item.amount || 0}"></td><td><button type="button" data-remove-adjust="${index}">刪除</button></td></tr>`).join('') || '<tr><td colspan="4">沒有調整項目。</td></tr>';
  body.querySelectorAll('[data-adjust-name],[data-adjust-type],[data-adjust-amount]').forEach(input => input.addEventListener('change', () => { const index = Number(input.dataset.adjustName ?? input.dataset.adjustType ?? input.dataset.adjustAmount); const item = advancedPayrollState.adjustments[index]; item.name = body.querySelector(`[data-adjust-name="${index}"]`).value; item.type = body.querySelector(`[data-adjust-type="${index}"]`).value; item.amount = Number(body.querySelector(`[data-adjust-amount="${index}"]`).value) || 0; localStorage.setItem('gac_adjustments', JSON.stringify(advancedPayrollState.adjustments)); advancedCalculate(); }));
  body.querySelectorAll('[data-remove-adjust]').forEach(button => button.addEventListener('click', () => { advancedPayrollState.adjustments.splice(Number(button.dataset.removeAdjust), 1); localStorage.setItem('gac_adjustments', JSON.stringify(advancedPayrollState.adjustments)); advancedRenderAdjustments(); advancedCalculate(); }));
}

function advancedCalculate() {
  const gross = advancedPayrollState.rows.reduce((sum, row) => sum + row.lessons * row.rate, 0);
  const adjustments = advancedPayrollState.adjustments.reduce((sum, item) => sum + (item.type === 'sub' ? -1 : 1) * Number(item.amount || 0), 0);
  const payout = gross * advancedPayrollState.share / 100 + adjustments;
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  set('advancedGross', advancedMoney(gross)); set('advancedPayout', advancedMoney(payout)); set('advancedLessons', advancedPayrollState.rows.reduce((sum, row) => sum + row.lessons, 0)); set('advancedAdjustmentTotal', advancedMoney(adjustments));
}

function advancedImportStudents() {
  advancedPayrollState.rows = studentDatabase.map(student => ({id: student.id, name: student.name, tutor: student.tutor, rate: advancedRate(student), lessons: masterScheduleEvents.filter(event => event.studentId === student.id && ['NORMAL', 'MAKEUP'].includes(event.status)).length}));
  advancedRenderRows(); advancedCalculate();
}

function advancedAddAdjustment() {
  advancedPayrollState.adjustments.push({name: '額外調整', type: 'add', amount: 0});
  localStorage.setItem('gac_adjustments', JSON.stringify(advancedPayrollState.adjustments)); advancedRenderAdjustments();
}

function advancedSaveArchive() {
  const record = {savedAt: new Date().toLocaleString('zh-HK'), month: document.getElementById('advancedPayrollMonth').value, share: advancedPayrollState.share, rows: structuredClone(advancedPayrollState.rows), adjustments: structuredClone(advancedPayrollState.adjustments)};
  advancedPayrollState.archives.unshift(record); localStorage.setItem('gac_payroll_archives', JSON.stringify(advancedPayrollState.archives)); advancedRenderArchives();
}

function advancedRenderArchives() {
  const body = document.querySelector('#advancedArchivesBody'); if (!body) return;
  body.innerHTML = advancedPayrollState.archives.map((archive, index) => `<tr><td>${archive.savedAt}</td><td>${archive.month}</td><td><button type="button" data-restore-advanced="${index}">載入</button><button type="button" data-delete-advanced="${index}">刪除</button></td></tr>`).join('') || '<tr><td colspan="3">沒有封存紀錄。</td></tr>';
  body.querySelectorAll('[data-restore-advanced]').forEach(button => button.addEventListener('click', () => { const archive = advancedPayrollState.archives[Number(button.dataset.restoreAdvanced)]; advancedPayrollState.rows = structuredClone(archive.rows); advancedPayrollState.adjustments = structuredClone(archive.adjustments); advancedPayrollState.share = archive.share; document.getElementById('advancedShare').value = archive.share; advancedRenderRows(); advancedRenderAdjustments(); advancedCalculate(); }));
  body.querySelectorAll('[data-delete-advanced]').forEach(button => button.addEventListener('click', () => { advancedPayrollState.archives.splice(Number(button.dataset.deleteAdvanced), 1); localStorage.setItem('gac_payroll_archives', JSON.stringify(advancedPayrollState.archives)); advancedRenderArchives(); }));
}

function advancedExport() {
  const payload = {month: document.getElementById('advancedPayrollMonth').value, share: advancedPayrollState.share, rows: advancedPayrollState.rows, adjustments: advancedPayrollState.adjustments};
  const link = document.createElement('a'); link.href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`; link.download = `Guitaristic_payroll_${payload.month}.json`; link.click();
}

function advancedParseManualLogs() {
  const input = document.getElementById('advancedManualLogs');
  const text = input?.value.trim(); if (!text) return;
  const parsed = text.split(/\r?\n/).map(line => line.match(/(\d{1,2})[\/-](\d{1,2}).*?(\d+)\s*(?:堂|lesson)?/i)).filter(Boolean);
  advancedPayrollState.events = parsed.map(match => ({date: `${match[1]}/${match[2]}`, lessons: Number(match[3]) || 1}));
  const notice = document.getElementById('advancedSyncStatus'); if (notice) notice.textContent = `已解析 ${advancedPayrollState.events.length} 行手動紀錄。`;
}

async function advancedLoadPublicIcs() {
  const notice = document.getElementById('advancedSyncStatus');
  try {
    const response = await fetch('https://calendar.google.com/calendar/ical/yuyanruan179%40gmail.com/public/basic.ics', {cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text(); advancedPayrollState.events = [...text.matchAll(/DTSTART[^:]*:(\d{8})/g)].map(match => ({date: match[1], lessons: 1}));
    if (notice) notice.textContent = `公開 ICS 讀取成功：${advancedPayrollState.events.length} 個事件。`;
  } catch (error) { if (notice) notice.textContent = '公開 ICS 讀取失敗，請改用手動文字解析。'; }
}

function initAdvancedPayroll() {
  const month = document.getElementById('advancedPayrollMonth'); if (month) month.value = new Date().toISOString().slice(0, 7);
  const share = document.getElementById('advancedShare'); if (share) { share.value = advancedPayrollState.share; share.addEventListener('input', () => { advancedPayrollState.share = Math.max(0, Math.min(100, Number(share.value) || 0)); localStorage.setItem('gac_tutor_share_pct', advancedPayrollState.share); advancedCalculate(); }); }
  document.getElementById('advancedImportStudents')?.addEventListener('click', advancedImportStudents);
  document.getElementById('advancedAddAdjustment')?.addEventListener('click', advancedAddAdjustment);
  document.getElementById('advancedSaveArchive')?.addEventListener('click', advancedSaveArchive);
  document.getElementById('advancedExport')?.addEventListener('click', advancedExport);
  document.getElementById('advancedParseLogs')?.addEventListener('click', advancedParseManualLogs);
  document.getElementById('advancedLoadIcs')?.addEventListener('click', advancedLoadPublicIcs);
  const darkButton = document.getElementById('advancedDarkMode');
  if (darkButton) darkButton.addEventListener('click', () => { document.documentElement.classList.toggle('dark'); localStorage.setItem('gac_dark_mode', document.documentElement.classList.contains('dark') ? 'true' : 'false'); });
  if (localStorage.getItem('gac_dark_mode') === 'true') document.documentElement.classList.add('dark');
  advancedRenderRows(); advancedRenderAdjustments(); advancedRenderArchives(); advancedCalculate();
}

window.addEventListener('DOMContentLoaded', initAdvancedPayroll);
