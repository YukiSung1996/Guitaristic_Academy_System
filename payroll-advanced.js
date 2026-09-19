const advancedPayrollState = {
  rows: [],
  adjustments: JSON.parse(localStorage.getItem('gac_adjustments') || '[]'),
  archives: JSON.parse(localStorage.getItem('gac_payroll_archives') || '[]'),
  share: Number(localStorage.getItem('gac_tutor_share_pct') || 50),
  events: []
};

// 導師級別（計費用）：學生／小組／課堂記錄自帶 tutorLevel；缺少時回退示範對應（Instructor B＝資深）
function advancedTutor(student) {
  if (student && student.tutorLevel) return student.tutorLevel;
  const fromList = (typeof tutorTier === 'function') ? tutorTier(student && student.tutor) : null; // 導師名單（設定頁）
  if (fromList) return fromList;
  return student && student.tutor === 'Instructor B' ? '資深導師' : '普通導師';
}

function advancedGrade(student) {
  const value = String(student.level || '').trim();
  return GRADE_OPTIONS.includes(value) ? value : 'Intermediate 中級';
}

function advancedClassType(student) {
  return GACRates.studentTypeToClassType(student.type);
}

function advancedRate(student) {
  const match = rateTable.find(item => item.tutor === advancedTutor(student) && item.instrument === student.program && item.grade === advancedGrade(student) && item.classType === advancedClassType(student) && item.duration === Number(student.duration));
  if (match) return match.rate;
  const duration = Number(student.duration) || 45;
  const levelFactor = /Grade [5-8]|Advanced/.test(String(student.level || '')) ? 1.15 : 1;
  return Math.round(230 * duration / 45 * levelFactor);
}

// 單堂費率：按該堂課自身的 program/level/形式/時長/導師查表（小組課與個別課各自的價）
function rateForLesson(l) {
  return advancedRate({ program: l.program, level: l.level, type: l.classType, duration: l.duration, tutor: l.tutor, tutorLevel: l.tutorLevel });
}

function advancedMoney(value) {
  return `HK$ ${Number(value || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}

// 按導師分組渲染：每位導師一行小計（學生行數／人次堂數／導師節數／課程總額／導師應得），
// 「隱藏 0 堂學生」勾選時 0 堂行不顯示（仍在資料中，取消勾選即回來）。
// 行內編輯用原始 index 映射回 state.rows，分組不影響編輯/刪除。
function advancedRenderRows() {
  const body = document.querySelector('#advancedPayrollBody');
  if (!body) return;
  const hideZero = !!document.getElementById('advancedHideZero')?.checked;
  const share = advancedPayrollState.share;
  const sessions = advancedPayrollState.sessions || null;
  const groups = new Map();
  advancedPayrollState.rows.forEach((row, index) => {
    if (!groups.has(row.tutor)) groups.set(row.tutor, []);
    groups.get(row.tutor).push({ row, index });
  });
  const parts = [];
  let hiddenCount = 0;
  groups.forEach((items, tutor) => {
    const gross = items.reduce((s, x) => s + x.row.lessons * x.row.rate, 0);
    const headcount = items.reduce((s, x) => s + x.row.lessons, 0);
    const sess = sessions ? (sessions[tutor] || 0) : null;
    parts.push(`<tr class="advanced-tutor-head"><td colspan="7"><b>👨‍🏫 ${tutor}</b>　學生 ${items.length} 行｜人次 ${headcount} 堂${sess !== null ? `｜導師節數 ${sess}（小組同時段算 1 節，按課表計）` : ''}｜課程總額 ${advancedMoney(gross)}｜導師應得（${share}%）<b>${advancedMoney(gross * share / 100)}</b></td></tr>`);
    items.forEach(({ row, index }) => {
      if (hideZero && !row.lessons) { hiddenCount++; return; }
      parts.push(`<tr><td>${row.id}</td><td>${row.name}</td><td>${row.tutor}</td><td><input data-advanced-lessons="${index}" type="number" min="0" value="${row.lessons}"></td><td>${advancedMoney(row.rate)}</td><td>${advancedMoney(row.lessons * row.rate)}</td><td><button type="button" data-remove-advanced="${index}">刪除</button></td></tr>`);
    });
  });
  if (hiddenCount) parts.push(`<tr><td colspan="7" style="color:#94a3b8;font-size:.72rem">已隱藏 ${hiddenCount} 行 0 堂學生（取消「隱藏 0 堂學生」勾選可顯示）。</td></tr>`);
  body.innerHTML = parts.join('') || '<tr><td colspan="7">請從學生資料匯入薪酬資料。</td></tr>';
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
  const headcount = advancedPayrollState.rows.reduce((sum, row) => sum + row.lessons, 0);
  const sess = advancedPayrollState.sessions;
  const sessTotal = sess ? Object.keys(sess).reduce((sum, k) => sum + sess[k], 0) : null;
  set('advancedGross', advancedMoney(gross)); set('advancedPayout', advancedMoney(payout));
  set('advancedLessons', sessTotal !== null ? `${headcount}（節數 ${sessTotal}）` : String(headcount));
  set('advancedAdjustmentTotal', advancedMoney(adjustments));
}

function advancedTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// v2：工資只算實際上了的課（ATTENDED；NOSHOW 由設定 payNoShow 控制，預設計入 // TODO 跟老闆確認），
// 按實際上課日期歸屬月份，數據源是 gac_lessons_v2（不再依賴內存課表）。
function advancedImportStudents() {
  const monthKey = document.getElementById('advancedPayrollMonth')?.value || '';
  if (!monthKey) { alert('請先選擇薪酬月份！'); return; }
  const payNoShow = !appSettings || appSettings.payNoShow !== false;
  // 每個「報讀項目」一行：學生的個別課一行（有個別課或有個別可計薪堂數才列）＋ 每個小組的每位成員一行
  const payable = GACPayroll.payableLessons(lessonsByMonth, monthKey, {payNoShow});
  const rows = [];
  studentDatabase.forEach(student => {
    const n = payable.filter(l => l.studentId === student.id && !l.groupId).length;
    if (student.weekday === null || student.weekday === undefined || student.weekday === '') { if (!n) return; }
    rows.push({id: student.id, name: student.name, tutor: student.tutor, rate: advancedRate(student), lessons: n});
  });
  (typeof groupClasses !== 'undefined' ? groupClasses : []).forEach(g => {
    const gRate = advancedRate({ program: g.program, level: g.level, type: (g.memberIds || []).length + '人小組', duration: g.duration, tutor: g.tutor, tutorLevel: g.tutorLevel });
    (g.memberIds || []).forEach(sid => {
      const stu = studentDatabase.find(s => s.id === sid);
      if (!stu) return;
      const n = payable.filter(l => l.studentId === sid && l.groupId === g.id).length;
      rows.push({id: sid, name: `${stu.name} @ ${g.name}`, tutor: g.tutor, rate: gRate, lessons: n, groupId: g.id});
    });
  });
  advancedPayrollState.rows = rows;
  // 導師節數（小組同時段算 1 節）按課表計算；手改堂數只影響金額，不影響節數
  advancedPayrollState.sessions = GACPayroll.tutorSessions(lessonsByMonth, monthKey, {payNoShow});
  advancedRenderExpiredWarning(monthKey);
  advancedRenderRows(); advancedCalculate();
}

// 計算前置檢查：列出「日期已過但仍是已排課」的課（即忘了確認出席的），可跳轉去批量確認。
// 未確認完也允許繼續計算（堂數 input 手改仍是 escape hatch）。
function advancedRenderExpiredWarning(monthKey) {
  const box = document.getElementById('advancedExpiredWarning');
  if (!box) return;
  const expired = GACPayroll.expiredScheduled(lessonsByMonth, monthKey, advancedTodayStr());
  if (!expired.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = `<div class="font-bold">⚠️ ${monthKey} 有 ${expired.length} 堂課「日期已過但仍是已排課」，未確認出席的課不會計入工資：</div>` +
    `<div>${expired.map(l => `${l.date} ${l.time} ${l.studentName}`).join('、')}</div>` +
    `<button onclick="advancedGoConfirm('${monthKey}')" class="mt-1 px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded font-bold">前往總表批量確認出席</button>`;
}

function advancedGoConfirm(monthKey) {
  const batchMonth = document.getElementById('batchMonth');
  if (batchMonth) batchMonth.value = monthKey;
  switchTab('masterTab');
  rebuildMonthContext();
  renderAll();
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
  body.querySelectorAll('[data-restore-advanced]').forEach(button => button.addEventListener('click', () => { const archive = advancedPayrollState.archives[Number(button.dataset.restoreAdvanced)]; advancedPayrollState.rows = structuredClone(archive.rows); advancedPayrollState.adjustments = structuredClone(archive.adjustments); advancedPayrollState.share = archive.share; advancedPayrollState.sessions = null; /* 封存不含節數，載入後不顯示以免誤導 */ document.getElementById('advancedShare').value = archive.share; advancedRenderRows(); advancedRenderAdjustments(); advancedCalculate(); }));
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
  // v2：不再內建任何真實網址，改由設定（gac_settings_v2.publicIcsUrl）提供；未設定時提示輸入並保存
  let url = ((appSettings && appSettings.publicIcsUrl) || '').trim();
  if (!url) {
    url = (prompt('請輸入公開 ICS 網址（將保存到設定，之後不需再輸入）：') || '').trim();
    if (!url) { if (notice) notice.textContent = '未設定公開 ICS 網址，已取消。'; return; }
    appSettings.publicIcsUrl = url;
    if (gacStore) gacStore.saveSettings(appSettings);
  }
  try {
    const response = await fetch(url, {cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text(); advancedPayrollState.events = [...text.matchAll(/DTSTART[^:]*:(\d{8})/g)].map(match => ({date: match[1], lessons: 1}));
    if (notice) notice.textContent = `公開 ICS 讀取成功：${advancedPayrollState.events.length} 個事件。`;
  } catch (error) { if (notice) notice.textContent = '公開 ICS 讀取失敗，請改用手動文字解析。'; }
}

function initAdvancedPayroll() {
  const month = document.getElementById('advancedPayrollMonth'); if (month) month.value = new Date().toISOString().slice(0, 7);
  const share = document.getElementById('advancedShare'); if (share) { share.value = advancedPayrollState.share; share.addEventListener('input', () => { advancedPayrollState.share = Math.max(0, Math.min(100, Number(share.value) || 0)); localStorage.setItem('gac_tutor_share_pct', advancedPayrollState.share); advancedCalculate(); }); }
  document.getElementById('advancedImportStudents')?.addEventListener('click', advancedImportStudents);
  document.getElementById('advancedHideZero')?.addEventListener('change', advancedRenderRows);
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
