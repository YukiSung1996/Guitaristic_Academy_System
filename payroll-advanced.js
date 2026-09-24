// payroll-advanced.js — 高級薪酬管理頁
// 一句話模型：**預期**＝本月排定的課全部上完能拿多少；**目前應付**＝已確認出席的課現在該付多少。
// 數字全部由課表算出（lib/payroll.js monthPayroll），頁面不可手改堂數——要加減錢請用「額外津貼／扣款」。
//   已確認＝ATTENDED（NOSHOW 依設定 payNoShow）；待確認＝SCHEDULED；請假不算（其補堂是另一筆課堂記錄，落在補堂當月）。
// 調整／封存／分成走 gacStorage（state.js：serve.cmd 模式是本資料夾的 local-state.json）；深色模式是 UI 偏好，仍在 localStorage
const advancedPayrollState = {
  adjustments: JSON.parse(gacStorage.getItem('gac_adjustments') || '[]'),
  archives: JSON.parse(gacStorage.getItem('gac_payroll_archives') || '[]'),
  share: Number(gacStorage.getItem('gac_tutor_share_pct') || 50),
  summary: null,          // 最近一次 monthPayroll 的結果
  openTutors: new Set()   // 明細展開中的導師
};

// ===== 查價（其他頁面也用：學費訊息 rateForLesson、數據分析、繳費表）=====
// 導師級別（計費用）：學生／小組／課堂記錄自帶 tutorLevel；缺少時回退導師名單，再回退示範對應（Instructor B＝資深）
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

function advancedMonth() {
  return document.getElementById('advancedPayrollMonth')?.value || '';
}

// ===== 調整項目：可指定導師（算進該導師的應付）或留空＝全月不分導師 =====
function advancedAdjustFor(tutor) {
  return advancedPayrollState.adjustments.reduce((sum, item) => {
    if ((item.tutor || '') !== (tutor || '')) return sum;
    return sum + (item.type === 'sub' ? -1 : 1) * (Number(item.amount) || 0);
  }, 0);
}

function advancedAdjustTotal() {
  return advancedPayrollState.adjustments.reduce((sum, item) => sum + (item.type === 'sub' ? -1 : 1) * (Number(item.amount) || 0), 0);
}

function advancedSaveAdjustments() {
  gacStorage.setItem('gac_adjustments', JSON.stringify(advancedPayrollState.adjustments));
}

// 某導師的應付：課程總額 × 拆帳 ％ ＋ 指名給他的調整項目
function advancedTutorPayout(t, which) {
  const gross = which === 'expected' ? t.expectedGross : t.currentGross;
  return gross * advancedPayrollState.share / 100 + advancedAdjustFor(t.tutor);
}

function advancedTotalPayout(summary, which) {
  const tutors = (summary && summary.tutors) || [];
  const named = tutors.reduce((sum, t) => sum + advancedTutorPayout(t, which), 0);
  const unassigned = advancedAdjustFor(''); // 沒指名導師的調整
  return named + unassigned;
}

// ===== 主流程：重新由課表計算並重繪整頁 =====
function advancedRefresh() {
  const monthKey = advancedMonth();
  if (!monthKey) return;
  const payNoShow = typeof appSettings === 'undefined' || !appSettings || appSettings.payNoShow !== false;
  advancedPayrollState.summary = GACPayroll.monthPayroll(lessonsByMonth, monthKey, { payNoShow, rateFn: rateForLesson });
  advancedRenderExpiredWarning(monthKey);
  advancedRenderSummary();
  advancedRenderTutors();
  advancedRenderAdjustments();
  advancedRenderArchives();
}

function advancedRenderSummary() {
  const s = advancedPayrollState.summary;
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  if (!s) return;
  const t = s.totals;
  set('advPayExpected', advancedMoney(advancedTotalPayout(s, 'expected')));
  set('advPayCurrent', advancedMoney(advancedTotalPayout(s, 'current')));
  set('advPayPending', `${t.pending} 堂`);
  set('advPayAdjust', advancedMoney(advancedAdjustTotal()));
  const pct = t.expected ? Math.round(t.current / t.expected * 100) : 0;
  const bar = document.getElementById('advPayBar');
  if (bar) bar.style.width = pct + '%';
  // 待確認分兩種：日期已過但忘了確認（要去確認）／還沒到上課日（等上完課自然會確認）
  const overdue = GACPayroll.expiredScheduled(lessonsByMonth, advancedMonth(), advancedTodayStr()).length;
  const future = Math.max(0, t.pending - overdue);
  const pendingNote = !t.pending ? '本月課堂已全部確認。'
    : `待確認 ${t.pending} 堂＝${overdue ? `<b class="text-amber-700">${overdue} 堂日期已過但未確認</b>（到總課表按「批量確認出席」）` : ''}${overdue && future ? '＋' : ''}${future ? `${future} 堂尚未到上課日` : ''}。`;
  set('advPayPending', `${t.pending} 堂`);
  const noteEl = document.getElementById('advPayPendingNote');
  if (noteEl) noteEl.innerHTML = t.expected ? pendingNote : '';
  set('advPayProgress', t.expected
    ? `已確認 ${t.current} / 預期 ${t.expected} 堂（${pct}%）　·　導師節數 ${t.currentSessions} / ${t.expectedSessions}　·　課程總額 ${advancedMoney(t.currentGross)} / ${advancedMoney(t.expectedGross)}`
    : '此月份沒有排定課堂——到「總課表」選月份並按「生成」。');
}

function toggleAdvTutor(name) {
  const set = advancedPayrollState.openTutors;
  if (set.has(name)) set.delete(name); else set.add(name);
  advancedRenderTutors();
}

function advancedRenderTutors() {
  const box = document.getElementById('advancedTutorList');
  const s = advancedPayrollState.summary;
  if (!box || !s) return;
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : (x => String(x));
  const share = advancedPayrollState.share;
  if (!s.tutors.length) {
    box.innerHTML = '<div class="p-6 text-center text-slate-400 text-xs">📭 此月份沒有可計薪的課堂。</div>';
    return;
  }
  box.innerHTML = s.tutors.map(t => {
    const open = advancedPayrollState.openTutors.has(t.tutor);
    const adj = advancedAdjustFor(t.tutor);
    const rows = t.items.map(i => `<tr>
        <td class="p-2">${esc(i.studentName)} <span class="text-slate-400">(${esc(i.studentId)})</span></td>
        <td class="p-2 text-slate-600">${i.groupName ? esc(i.groupName) : '個別課'}<span class="text-slate-400"> · ${esc(i.program)} ${esc(i.level)}</span></td>
        <td class="p-2 text-right">${advancedMoney(i.rate)}</td>
        <td class="p-2 text-center font-semibold text-emerald-700">${i.current}</td>
        <td class="p-2 text-center ${i.pending ? 'text-amber-600 font-semibold' : 'text-slate-400'}">${i.pending}</td>
        <td class="p-2 text-right font-semibold">${advancedMoney(i.current * i.rate)}</td>
        <td class="p-2 text-right text-slate-500">${advancedMoney(i.expected * i.rate)}</td>
      </tr>`).join('');
    return `<div class="border border-slate-200 rounded-xl overflow-hidden">
        <button type="button" onclick="toggleAdvTutor('${esc(t.tutor).replace(/'/g, "\\'")}')" class="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left text-xs hover:bg-slate-50">
          <i class="fa-solid fa-chevron-${open ? 'down' : 'right'} text-slate-400 text-[10px]"></i>
          <b class="text-slate-800">${esc(t.tutor)}</b>
          <span class="text-slate-500">已確認 <b class="text-emerald-700">${t.current}</b> / 預期 ${t.expected} 堂${t.pending ? `　·　<b class="text-amber-600">${t.pending} 堂待確認</b>` : ''}　·　節數 ${t.currentSessions}/${t.expectedSessions}</span>
          <span class="ml-auto text-right">
            <span class="block text-slate-800 font-bold">目前應付 ${advancedMoney(advancedTutorPayout(t, 'current'))}</span>
            <span class="block text-[10px] text-slate-400">預期 ${advancedMoney(advancedTutorPayout(t, 'expected'))}${adj ? `（含調整 ${advancedMoney(adj)}）` : ''}</span>
          </span>
        </button>
        ${open ? `<div class="border-t border-slate-100 overflow-x-auto">
          <table class="w-full text-xs text-left">
            <thead class="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
              <tr><th class="p-2">學生</th><th class="p-2">報讀項目</th><th class="p-2 text-right">每堂</th><th class="p-2 text-center">已確認</th><th class="p-2 text-center">待確認</th><th class="p-2 text-right">已確認金額</th><th class="p-2 text-right">預期金額</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">${rows}</tbody>
            <tfoot class="bg-slate-50 font-bold text-slate-700">
              <tr><td class="p-2" colspan="3">課程總額</td><td class="p-2 text-center">${t.current}</td><td class="p-2 text-center">${t.pending}</td><td class="p-2 text-right">${advancedMoney(t.currentGross)}</td><td class="p-2 text-right">${advancedMoney(t.expectedGross)}</td></tr>
              <tr><td class="p-2" colspan="5">導師應得（拆帳 ${share}%${adj ? `，含指名調整 ${advancedMoney(adj)}` : ''}）</td><td class="p-2 text-right">${advancedMoney(advancedTutorPayout(t, 'current'))}</td><td class="p-2 text-right">${advancedMoney(advancedTutorPayout(t, 'expected'))}</td></tr>
            </tfoot>
          </table></div>` : ''}
      </div>`;
  }).join('');
}

// ===== 額外津貼／扣款：頁面唯一可手改金額的地方 =====
function advancedRenderAdjustments() {
  const body = document.getElementById('advancedAdjustmentsBody');
  if (!body) return;
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : (x => String(x));
  const names = (typeof allTutorNames === 'function') ? allTutorNames() : [];
  const inp = 'w-full px-2 py-1 border border-slate-300 rounded-lg text-xs';
  body.innerHTML = advancedPayrollState.adjustments.map((item, index) => `<tr>
      <td class="p-2"><input data-adjust-name="${index}" value="${esc(item.name || '')}" placeholder="例如：交通津貼" class="${inp}"></td>
      <td class="p-2"><select data-adjust-tutor="${index}" class="${inp} bg-white"><option value="">全月（不分導師）</option>${names.map(n => `<option value="${esc(n)}"${(item.tutor || '') === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></td>
      <td class="p-2"><select data-adjust-type="${index}" class="${inp} bg-white"><option value="add"${item.type === 'add' ? ' selected' : ''}>津貼／獎金 (+)</option><option value="sub"${item.type === 'sub' ? ' selected' : ''}>扣除款項 (−)</option></select></td>
      <td class="p-2"><input data-adjust-amount="${index}" type="number" min="0" value="${Number(item.amount) || 0}" class="${inp} text-right"></td>
      <td class="p-2 text-right"><button type="button" data-remove-adjust="${index}" class="px-2 py-1 text-rose-600 hover:bg-rose-50 rounded-lg" title="刪除此項"><i class="fa-solid fa-trash-can"></i></button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="p-4 text-center text-slate-400 text-xs">沒有調整項目。薪酬數字全部由課表計算，要加減錢（津貼、扣款、補回漏算的堂）就在這裡新增一筆。</td></tr>';
  body.querySelectorAll('[data-adjust-name],[data-adjust-type],[data-adjust-amount],[data-adjust-tutor]').forEach(input => input.addEventListener('change', () => {
    const index = Number(input.dataset.adjustName ?? input.dataset.adjustType ?? input.dataset.adjustAmount ?? input.dataset.adjustTutor);
    const item = advancedPayrollState.adjustments[index];
    item.name = body.querySelector(`[data-adjust-name="${index}"]`).value;
    item.tutor = body.querySelector(`[data-adjust-tutor="${index}"]`).value;
    item.type = body.querySelector(`[data-adjust-type="${index}"]`).value;
    item.amount = Number(body.querySelector(`[data-adjust-amount="${index}"]`).value) || 0;
    advancedSaveAdjustments();
    advancedRenderSummary();
    advancedRenderTutors();
  }));
  body.querySelectorAll('[data-remove-adjust]').forEach(button => button.addEventListener('click', () => {
    advancedPayrollState.adjustments.splice(Number(button.dataset.removeAdjust), 1);
    advancedSaveAdjustments();
    advancedRenderAdjustments();
    advancedRenderSummary();
    advancedRenderTutors();
  }));
}

function advancedAddAdjustment() {
  advancedPayrollState.adjustments.push({ name: '額外調整', tutor: '', type: 'add', amount: 0 });
  advancedSaveAdjustments();
  advancedRenderAdjustments();
  advancedRenderSummary();
  advancedRenderTutors();
}

// ===== 歷史封存：把當下的「目前應付」存成一筆紀錄（發了薪就封存，之後可對照）=====
function advancedSaveArchive() {
  const s = advancedPayrollState.summary;
  const monthKey = advancedMonth();
  if (!s || !monthKey) return;
  advancedPayrollState.archives.unshift({
    savedAt: new Date().toLocaleString('zh-HK'),
    month: monthKey,
    share: advancedPayrollState.share,
    lessons: s.totals.current,
    gross: s.totals.currentGross,
    payout: advancedTotalPayout(s, 'current'),
    tutors: s.tutors.map(t => ({ tutor: t.tutor, lessons: t.current, gross: t.currentGross, payout: advancedTutorPayout(t, 'current') })),
    adjustments: JSON.parse(JSON.stringify(advancedPayrollState.adjustments))
  });
  gacStorage.setItem('gac_payroll_archives', JSON.stringify(advancedPayrollState.archives));
  advancedRenderArchives();
  if (typeof showToast === 'function') showToast(`✅ 已封存 ${monthKey} 糧單：${advancedMoney(advancedTotalPayout(s, 'current'))}`);
}

function advancedDeleteArchive(index) {
  advancedPayrollState.archives.splice(index, 1);
  gacStorage.setItem('gac_payroll_archives', JSON.stringify(advancedPayrollState.archives));
  advancedRenderArchives();
}

function advancedRenderArchives() {
  const body = document.getElementById('advancedArchivesBody');
  if (!body) return;
  const esc = (typeof escapeHtml === 'function') ? escapeHtml : (x => String(x));
  body.innerHTML = advancedPayrollState.archives.map((a, index) => {
    const who = Array.isArray(a.tutors) && a.tutors.length
      ? a.tutors.map(t => `${esc(t.tutor)} ${advancedMoney(t.payout)}`).join('、')
      : '<span class="text-slate-400">舊格式紀錄</span>';
    return `<tr>
      <td class="p-2 whitespace-nowrap"><b>${esc(a.month || '—')}</b><div class="text-[10px] text-slate-400">${esc(a.savedAt || '')}</div></td>
      <td class="p-2 text-center">${a.lessons === undefined ? '—' : a.lessons}</td>
      <td class="p-2 text-right">${a.gross === undefined ? '—' : advancedMoney(a.gross)}</td>
      <td class="p-2 text-right font-bold">${a.payout === undefined ? '—' : advancedMoney(a.payout)}</td>
      <td class="p-2 text-slate-500">${who}</td>
      <td class="p-2 text-right"><button type="button" onclick="advancedDeleteArchive(${index})" class="px-2 py-1 text-rose-600 hover:bg-rose-50 rounded-lg" title="刪除此封存"><i class="fa-solid fa-trash-can"></i></button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="p-4 text-center text-slate-400 text-xs">沒有封存紀錄。發了薪之後按「封存本月糧單」留一筆存底。</td></tr>';
}

function advancedTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 計算前置檢查：列出「日期已過但仍是已排課」的課（即忘了確認出席的）——這些課只在「預期」裡，不在「目前應付」
function advancedRenderExpiredWarning(monthKey) {
  const box = document.getElementById('advancedExpiredWarning');
  if (!box) return;
  const expired = GACPayroll.expiredScheduled(lessonsByMonth, monthKey, advancedTodayStr());
  if (!expired.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  // 只給數字與範圍——逐堂列出來幾十行沒人看，要處理就按鈕過去批量確認
  const dates = expired.map(l => l.date).sort();
  const span = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`;
  box.innerHTML = `<div class="flex flex-wrap items-center gap-2">
      <span class="font-bold">⚠️ ${monthKey} 有 ${expired.length} 堂「日期已過但仍是已排課」（${span}）</span>
      <span class="text-amber-700">未確認出席前只算在「預期」，不算「目前應付」。</span>
      <button onclick="advancedGoConfirm('${monthKey}')" class="ml-auto px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded font-bold whitespace-nowrap">前往總表批量確認出席</button>
    </div>`;
}

function advancedGoConfirm(monthKey) {
  const batchMonth = document.getElementById('batchMonth');
  if (batchMonth) batchMonth.value = monthKey;
  switchTab('masterTab');
  rebuildMonthContext();
  renderAll();
}

function initAdvancedPayroll() {
  const month = document.getElementById('advancedPayrollMonth');
  if (month) {
    month.value = new Date().toISOString().slice(0, 7);
    month.addEventListener('change', advancedRefresh);
  }
  const share = document.getElementById('advancedShare');
  if (share) {
    share.value = advancedPayrollState.share;
    share.addEventListener('input', () => {
      advancedPayrollState.share = Math.max(0, Math.min(100, Number(share.value) || 0));
      gacStorage.setItem('gac_tutor_share_pct', advancedPayrollState.share);
      advancedRenderSummary();
      advancedRenderTutors();
    });
  }
  document.getElementById('advancedAddAdjustment')?.addEventListener('click', advancedAddAdjustment);
  document.getElementById('advancedSaveArchive')?.addEventListener('click', advancedSaveArchive);
  const darkButton = document.getElementById('advancedDarkMode');
  if (darkButton) darkButton.addEventListener('click', () => { document.documentElement.classList.toggle('dark'); localStorage.setItem('gac_dark_mode', document.documentElement.classList.contains('dark') ? 'true' : 'false'); });
  if (localStorage.getItem('gac_dark_mode') === 'true') document.documentElement.classList.add('dark');
  advancedRenderAdjustments();
  advancedRenderArchives();
}

window.addEventListener('DOMContentLoaded', initAdvancedPayroll);
