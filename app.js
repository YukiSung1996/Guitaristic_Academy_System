window.onload = function() {
            // v2：所有資料經 lib/storage.js 讀寫（新 key；舊 key 兼容讀取自動遷移；損壞 JSON 不白屏）
            gacStore = GACStorage.createStore(window.localStorage);
            // v3：導師名單與費率覆寫先載入（學生／課堂查價依賴）
            tutorsList = gacStore.loadTutors(typeof defaultTutors !== 'undefined' ? defaultTutors : []);
            rateOverrides = gacStore.loadRateOverrides();
            GACRates.applyOverrides(rateTable, rateOverrides);
            studentDatabase = gacStore.loadStudents(defaultStudents);
            groupClasses = gacStore.loadGroups(typeof defaultGroups !== 'undefined' ? defaultGroups : []);
            lessonsByMonth = gacStore.loadLessons();
            sendLog = gacStore.loadSendlog();
            appSettings = gacStore.loadSettings();
            actionHistory = gacStore.loadHistory();
            if (gacStore.errors.length) {
                alert('⚠️ 部分本機資料載入失敗（已回退預設值）：\n' + gacStore.errors.join('\n'));
            }

            const monthStr = localDateStr(new Date()).slice(0, 7);
            document.getElementById('batchMonth').value = monthStr;
            document.getElementById('sendMonth').value = monthStr;
            document.getElementById('payMonth').value = monthStr;
            document.getElementById('anaMonth').value = monthStr;

            // 切回頁面時詢問 WhatsApp 是否已發（waSentMode='confirm'）；focus 與 visibilitychange
            // 皆註冊，處理器以清空佇列保證幂等
            window.addEventListener('focus', handleWaReturnConfirm);
            document.addEventListener('visibilitychange', handleWaReturnConfirm);

            loadSettingsForm();
            if (typeof applyGcalModeUi === 'function') applyGcalModeUi();
            populateTutorSelects();
            renderBatchCheckboxes();
            renderStudentTable();
            rebuildMonthContext();
            renderAll();
            renderHistoryUI();
            installModalClose();
        };

        // ===== 彈窗通用關閉：點背景／Esc ＝ 關閉；表單類彈窗有未儲存改動時先確認（改動會丟失）=====
        // 各 open 函數在填好欄位、顯示後呼叫 markModalOpened(id) 拍一張「表單快照」；
        // requestCloseModal(id)（✕／取消／背景／Esc 共用）比對快照，有差異才 confirm。
        // 儲存路徑仍直接呼叫各自的 close 函數（已儲存的改動不必再問）。
        const MODAL_CLOSERS = {
            studentModal: () => closeStudentModal(),
            groupModal: () => closeGroupModal(),
            quickEditModal: () => closeQuickEdit(),
            broadcastModal: () => closeBroadcastModal(),
            moveModal: () => closeMoveModal(),
            msgModal: () => closeMsgModal(),
            // 同步面板：執行中（進度顯示、按鈕鎖定）不讓背景／Esc 關掉；✕ 仍可用
            gcalSyncModal: () => { if (typeof gcalSyncBusy !== 'undefined' && gcalSyncBusy) return; closeGcalSyncModal(); },
            icsImportModal: () => closeIcsImportModal(),
            lessonModal: () => closeLessonModal()
        };
        const modalSnapshots = {};
        function modalFormState(id) {
            const box = document.getElementById(id);
            if (!box) return '';
            return Array.from(box.querySelectorAll('input, select, textarea')).map((el, i) =>
                (el.id || i) + '=' + (el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 1 : 0) : el.value)).join('|');
        }
        function markModalOpened(id) { modalSnapshots[id] = modalFormState(id); }
        function modalIsDirty(id) { return (id in modalSnapshots) && modalSnapshots[id] !== modalFormState(id); }
        function requestCloseModal(id) {
            const closer = MODAL_CLOSERS[id];
            if (!closer) return false;
            if (modalIsDirty(id) && !confirm('有未儲存的改動，關閉後會丟失。\n確定要關閉嗎？')) return false;
            delete modalSnapshots[id];
            closer();
            return true;
        }
        function isModalOpen(id) {
            const el = document.getElementById(id);
            return !!el && !el.classList.contains('hidden');
        }
        function installModalClose() {
            Object.keys(MODAL_CLOSERS).forEach(id => {
                const overlay = document.getElementById(id);
                if (!overlay) return;
                // 只有「按下＋放開」都在背景才算點背景：在面板內拖選文字、放開時滑出面板不會誤關
                let downOnBackdrop = false;
                overlay.addEventListener('pointerdown', e => { downOnBackdrop = e.target === overlay; });
                overlay.addEventListener('click', e => {
                    if (e.target === overlay && downOnBackdrop) requestCloseModal(id);
                    downOnBackdrop = false;
                });
            });
            document.addEventListener('keydown', e => {
                if (e.key !== 'Escape') return;
                const open = Object.keys(MODAL_CLOSERS).find(isModalOpen);
                if (open) requestCloseModal(open);
            });
        }

        // 成功提示用右下角 toast（3.5 秒淡出，不阻斷操作）；只有需要用戶決定或必須看清的內容才用 alert/confirm
        let lastToast = '';
        function showToast(msg) {
            lastToast = String(msg);
            let box = document.getElementById('gacToast');
            if (!box) {
                box = document.createElement('div');
                box.id = 'gacToast';
                box.className = 'fixed bottom-5 right-5 z-[60] max-w-sm bg-slate-900 text-white text-xs rounded-xl shadow-2xl px-4 py-3 whitespace-pre-line transition-opacity duration-300';
                document.body.appendChild(box);
            }
            box.textContent = lastToast;
            box.style.opacity = '1';
            box.classList.remove('hidden');
            clearTimeout(box._timer);
            box._timer = setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.classList.add('hidden'), 300); }, 3500);
        }

        function saveToLocalStorage() {
            gacStore.saveStudents(studentDatabase);
            updateDashboardKPIs();
        }

        function persistLessons() {
            gacStore.saveLessons(lessonsByMonth);
            syncSendlog();
        }

        function persistSendlog() {
            gacStore.saveSendlog(sendLog);
        }

        // ===== 操作歷史與撤銷：每個會改資料的操作「之前」拍快照（學生／小組／課表／發送紀錄），最新在前、上限 20 筆 =====
        // 設定、薪酬調整、GCal token 不入快照。操作在拍照後失敗／取消時呼叫 dropLastHistory() 把那筆丟掉。
        // 還原前會先自動備份現狀，因此還原本身也能撤銷。
        const HISTORY_CAP = 20;
        const STATUS_LABEL = { SCHEDULED: '已排課', ATTENDED: '已上課', LEAVE: '請假', NOSHOW: '缺席' };
        // 重做堆疊：撤銷時把「撤銷前的現狀」推進來，重做即取回；任何新操作清空（操作在拍照後取消／失敗時還原）。只存記憶體，刷新即失。
        let redoStack = [];
        let redoStackBackup = null;

        function historyState() {
            return { students: studentDatabase, groups: groupClasses, lessons: lessonsByMonth, sendlog: sendLog, tutors: tutorsList, rateOverrides: rateOverrides };
        }

        function pushHistory(description) {
            const snap = GACHistory.makeSnapshot(historyState(), description, new Date().toISOString());
            actionHistory = GACHistory.push(actionHistory, snap, HISTORY_CAP);
            const kept = gacStore.saveHistory(actionHistory);
            if (kept < actionHistory.length) actionHistory = actionHistory.slice(0, kept); // 配額不足：只留寫得進去的最新幾筆
            redoStackBackup = redoStack; // 新操作 → 重做作廢；若操作隨後取消／失敗（dropLastHistory）則還原
            redoStack = [];
            renderHistoryUI();
        }

        function dropLastHistory() {
            actionHistory = actionHistory.slice(1);
            gacStore.saveHistory(actionHistory);
            if (redoStackBackup) { redoStack = redoStackBackup; redoStackBackup = null; }
            renderHistoryUI();
        }

        function applySnapshot(snap) {
            const st = GACHistory.restore(snap);
            if (st.students) studentDatabase = st.students;
            if (st.groups) groupClasses = st.groups;
            if (st.lessons) lessonsByMonth = st.lessons;
            if (st.sendlog) sendLog = st.sendlog;
            if (st.tutors) { tutorsList = st.tutors; persistTutors(); }
            if (st.rateOverrides) { rateOverrides = st.rateOverrides; applyRateOverridesToTable(); persistRateOverrides(); }
            populateTutorSelects();
            renderTutorManagementList();
            renderRateTableEditor();
            gacStore.saveStudents(studentDatabase);
            persistGroups();
            gacStore.saveLessons(lessonsByMonth);
            persistSendlog();
            renderBatchCheckboxes();
            renderStudentTable();
            rebuildMonthContext();
            renderAll();
        }

        // 撤銷不再彈確認——有「重做」兜底
        function undoLastAction() {
            if (!actionHistory.length) { showToast('ℹ️ 沒有可撤銷的操作'); return; }
            const snap = actionHistory[0];
            // 撤銷前的現狀進重做堆疊（描述沿用被撤銷的操作，重做鈕提示「重做：…」）
            redoStack = GACHistory.push(redoStack, GACHistory.makeSnapshot(historyState(), snap.description, new Date().toISOString()), HISTORY_CAP);
            actionHistory = actionHistory.slice(1);
            gacStore.saveHistory(actionHistory);
            applySnapshot(snap);
            renderHistoryUI();
            showToast(`↶ 已撤銷：${snap.description}（可「重做」）`);
        }

        function redoLastAction() {
            if (!redoStack.length) { showToast('ℹ️ 沒有可重做的操作'); return; }
            const snap = redoStack[0];
            // 重做前的現狀回到撤銷堆疊（之後仍可再撤銷）
            actionHistory = GACHistory.push(actionHistory, GACHistory.makeSnapshot(historyState(), snap.description, new Date().toISOString()), HISTORY_CAP);
            const kept = gacStore.saveHistory(actionHistory);
            if (kept < actionHistory.length) actionHistory = actionHistory.slice(0, kept);
            redoStack = redoStack.slice(1);
            applySnapshot(snap);
            renderHistoryUI();
            showToast(`↷ 已重做：${snap.description}`);
        }

        function restoreSnapshot(id) {
            const snap = actionHistory.find(h => h.id === id);
            if (!snap) return;
            if (!confirm(`還原到「${snap.description}」之前的狀態？\n目前狀態會先自動備份一筆，可再撤銷。`)) return;
            pushHistory(`還原前自動備份（還原至：${snap.description}）`);
            applySnapshot(snap);
            showToast(`✅ 已還原至「${snap.description}」之前`);
        }

        // 清空快照但不自己彈確認（清場流程已經問過）。回傳清掉的筆數。
        function clearHistorySilently() {
            const n = actionHistory.length;
            actionHistory = [];
            redoStack = [];
            redoStackBackup = null;
            gacStore.saveHistory(actionHistory);
            renderHistoryUI();
            return n;
        }

        function clearHistory() {
            if (!actionHistory.length) return;
            if (!confirm('清空全部歷史快照？之後將無法撤銷此前的操作。')) return;
            actionHistory = [];
            redoStack = [];
            redoStackBackup = null;
            gacStore.saveHistory(actionHistory);
            renderHistoryUI();
        }

        function renderHistoryUI() {
            const btn = document.getElementById('undoBtn');
            if (btn) {
                btn.disabled = !actionHistory.length;
                btn.title = actionHistory.length ? `撤銷上一步：${actionHistory[0].description}` : '沒有可撤銷的操作';
            }
            const cnt = document.getElementById('undoCount');
            if (cnt) { cnt.textContent = String(actionHistory.length); cnt.classList.toggle('hidden', !actionHistory.length); }
            const rbtn = document.getElementById('redoBtn');
            if (rbtn) {
                rbtn.disabled = !redoStack.length;
                rbtn.title = redoStack.length ? `重做：${redoStack[0].description}` : '沒有可重做的操作';
            }
            const rcnt = document.getElementById('redoCount');
            if (rcnt) { rcnt.textContent = String(redoStack.length); rcnt.classList.toggle('hidden', !redoStack.length); }
            const list = document.getElementById('historyList');
            if (!list) return;
            const sizeEl = document.getElementById('historySize');
            if (sizeEl) sizeEl.textContent = `${actionHistory.length} 筆 · ${GACHistory.formatSize(GACHistory.totalSize(actionHistory))}（上限 ${HISTORY_CAP} 筆）${redoStack.length ? ` · 可重做 ${redoStack.length} 步` : ''}`;
            list.innerHTML = actionHistory.length ? actionHistory.map((h, i) => `
                <div class="flex items-center justify-between gap-3 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                    <div class="min-w-0">
                        <div class="font-bold text-slate-800 truncate">${i === 0 ? '<span class="text-[10px] px-1 py-0.5 rounded bg-sky-100 text-sky-700 mr-1">最新</span>' : ''}${escapeHtml(h.description)}</div>
                        <div class="text-slate-400 text-[11px]">${String(h.timestamp).replace('T', ' ').slice(0, 16)} · ${GACHistory.formatSize(h.size)}</div>
                    </div>
                    <button onclick="restoreSnapshot('${h.id}')" class="shrink-0 px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-lg font-bold flex items-center gap-1.5" title="回到這個操作之前的狀態（現狀先自動備份）"><i class="fa-solid fa-clock-rotate-left"></i> 還原至此之前</button>
                </div>`).join('')
                : '<div class="text-center py-8 text-slate-400 text-xs">📭 尚無歷史快照。新增／編輯／刪除學生與小組、生成課表、出席／請假／補堂、繳費與發送紀錄變更前都會自動保存一筆。</div>';
        }

        // 課堂變更後同步發送紀錄（persistLessons 每次自動呼叫，任何路徑的取消/還原都被涵蓋）：
        // 1) 孤兒清理：課已刪除（如補堂被取消）的 TODO 條目移除；SENT 保留作歷史
        // 2) 失效清理：請假已被還原 → 其 TODO 請假確認不應再發（SENT 同樣保留）
        function syncSendlog() {
            GACSendlog.pruneOrphans(sendLog, id => !!GACLessonState.findLesson(lessonsByMonth, id));
            Object.keys(sendLog).forEach(k => {
                const e = sendLog[k];
                if (e && e.type === 'LEAVE_CONFIRM' && e.status === 'TODO') {
                    const f = GACLessonState.findLesson(lessonsByMonth, e.lessonId);
                    if (f && f.lesson.status !== 'LEAVE') delete sendLog[k];
                }
            });
            persistSendlog();
        }

        function localDateStr(d) {
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }

        function currentMonthKey() {
            return document.getElementById('batchMonth').value;
        }

        function currentMonthLessons() {
            return lessonsByMonth[currentMonthKey()] || [];
        }

        function sortedMonthLessons() {
            return [...currentMonthLessons()].sort((a, b) =>
                (a.date + ' ' + a.time + ' ' + a.studentId).localeCompare(b.date + ' ' + b.time + ' ' + b.studentId));
        }

        // Date 物件只在渲染時重建，儲存層一律是字串（date/time）
        function lessonStart(lesson) {
            const [y, m, d] = lesson.date.split('-').map(Number);
            const [h, min] = lesson.time.split(':').map(Number);
            return new Date(y, m - 1, d, h, min, 0);
        }

        function lessonEnd(lesson) {
            return new Date(lessonStart(lesson).getTime() + (Number(lesson.duration) || 45) * 60000);
        }

        // Navigation Tab Switching
        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

            document.getElementById(tabId).classList.remove('hidden');
            document.getElementById(`tab_${tabId}`).classList.add('active');

            if (tabId === 'databaseTab') {
                renderStudentTable();
            } else if (tabId === 'sendTab') {
                renderSendCenter();
            } else if (tabId === 'paymentTab') {
                renderPaymentTab();
            } else if (tabId === 'advancedPayrollTab') {
                advancedRefresh();
            } else if (tabId === 'analyticsTab') {
                renderAnalytics();
            } else if (tabId === 'historyTab') {
                renderHistoryUI();
            } else if (tabId === 'settingsTab') {
                applySettingsModules();
                loadSettingsForm();
                renderTutorManagementList();
                renderTutorCalendarList();
                renderRateTableEditor();
            }
        }

        function getStudentScheduleForMonth(student, targetMonthStr) {
            if (student.effectiveMonth && targetMonthStr >= student.effectiveMonth && student.futureWeekday !== null) {
                return { weekday: student.futureWeekday, time: student.futureTime, isFuture: true };
            }
            return { weekday: student.weekday, time: student.time, isFuture: false };
        }

        function updateDashboardKPIs() {
            document.getElementById('statTotalStudents').textContent = studentDatabase.length;
            const lessons = currentMonthLessons();
            document.getElementById('statTotalLessons').textContent = lessons.length;

            const makeupCount = lessons.filter(l => l.status === 'LEAVE' || l.isMakeup).length;
            document.getElementById('statMakeupCount').textContent = makeupCount;

            const clashCount = GACSchedule.detectClashes(lessons).size;
            document.getElementById('statClashCount').textContent = clashCount;

            const banner = document.getElementById('clashWarningBanner');
            banner.classList.toggle('hidden', clashCount === 0);
        }

        function renderBatchCheckboxes() {
            const grid = document.getElementById('batchStudentGrid');
            const selectedTutor = document.getElementById('filterTutor').value;
            const batchMonthVal = document.getElementById('batchMonth').value;
            const searchKeyword = document.getElementById('batchSearch').value.toLowerCase().trim();
            grid.innerHTML = '';

            studentDatabase.forEach((student, index) => {
                if (selectedTutor !== 'ALL' && student.tutor !== selectedTutor) return;
                
                // Enhanced Search including phone and email
                const matchSearch = !searchKeyword || 
                    student.name.toLowerCase().includes(searchKeyword) || 
                    student.id.toLowerCase().includes(searchKeyword) ||
                    (student.phone && student.phone.includes(searchKeyword)) ||
                    (student.email && student.email.toLowerCase().includes(searchKeyword));

                if (!matchSearch) return;

                const sched = getStudentScheduleForMonth(student, batchMonthVal);
                const hasSlot = hasIndividualSlot(sched);
                const div = document.createElement('div');
                div.className = 'flex items-center space-x-2 text-xs bg-white p-2 rounded-lg border border-slate-200 hover:border-sky-300 transition';

                div.innerHTML = `
                    <input type="checkbox" class="batch-student-chk accent-sky-600 rounded" value="${index}" id="batch_chk_${index}" ${hasSlot ? 'checked' : 'disabled'}>
                    <label for="batch_chk_${index}" class="cursor-pointer font-medium truncate flex-1">
                        <span class="font-bold text-slate-800">${student.id}</span> ${student.name}
                        ${hasSlot ? `<span class="text-sky-600 font-semibold">(${getWeekdayName(sched.weekday)} ${sched.time})</span>` : '<span class="text-slate-400">（只上小組）</span>'}
                    </label>
                    <button onclick="openQuickEdit(${index})" class="shrink-0 px-1.5 py-1 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition" title="調整常規時間／升班（含撞堂預覽）">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                `;
                grid.appendChild(div);
            });

            // 小組班 chip：勾選＝整組排課；✏️ 編輯成員／時段
            groupClasses.forEach(g => {
                if (selectedTutor !== 'ALL' && g.tutor !== selectedTutor) return;
                const memberNames = (g.memberIds || []).map(id => { const s = studentDatabase.find(x => x.id === id); return s ? s.name : id; });
                const hay = (g.name + ' ' + g.id + ' ' + memberNames.join(' ')).toLowerCase();
                if (searchKeyword && !hay.includes(searchKeyword)) return;
                const div = document.createElement('div');
                div.className = 'flex items-center space-x-2 text-xs bg-indigo-50 p-2 rounded-lg border border-indigo-200 hover:border-indigo-400 transition';
                div.innerHTML = `
                    <input type="checkbox" class="batch-group-chk accent-indigo-600 rounded" value="${g.id}" id="batch_grp_${g.id}" checked>
                    <label for="batch_grp_${g.id}" class="cursor-pointer font-medium truncate flex-1" title="${memberNames.join('、')}">
                        <span class="font-bold text-indigo-800"><i class="fa-solid fa-user-group"></i> ${g.name}</span>
                        <span class="text-indigo-600 font-semibold">×${(g.memberIds || []).length}（${getWeekdayName(g.weekday)} ${g.time}）</span>
                    </label>
                    <button onclick="openGroupModal('${g.id}')" class="shrink-0 px-1.5 py-1 text-slate-400 hover:text-indigo-700 hover:bg-indigo-100 rounded transition" title="編輯小組：成員／時段／導師">
                        <i class="fa-solid fa-pen"></i>
                    </button>`;
                grid.appendChild(div);
            });
            grid.onchange = updateBatchSelectorSummary; // 指派而非 addEventListener：每次重繪不會疊加
            updateBatchSelectorSummary();
            applyBatchSelectorState();
        }

        // ===== 學生／小組勾選區的折疊：預設收起，開合記在本機（純 UI，不入備份）=====
        function batchSelectorIsOpen() {
            try { return localStorage.getItem('gac_batch_open') === '1'; } catch (e) { return false; }
        }

        function applyBatchSelectorState() {
            const open = batchSelectorIsOpen();
            const body = document.getElementById('batchSelectorBody');
            const chev = document.getElementById('batchSelectorChevron');
            const hint = document.getElementById('batchSelectorHint');
            if (body) body.classList.toggle('hidden', !open);
            if (chev) chev.classList.toggle('rotate-90', open); // ▸ 收起／▾ 展開
            if (hint) hint.textContent = open ? '點擊收起' : '點擊展開選取';
        }

        function toggleBatchSelector() {
            try { localStorage.setItem('gac_batch_open', batchSelectorIsOpen() ? '0' : '1'); } catch (e) { /* ignore */ }
            applyBatchSelectorState();
        }

        // 折疊時標題列仍要看得出勾了多少（「生成」用的就是這些勾選）
        function updateBatchSelectorSummary() {
            const el = document.getElementById('batchSelectorSummary');
            const grid = document.getElementById('batchStudentGrid');
            if (!el || !grid) return;
            const boxes = [...grid.querySelectorAll('.batch-student-chk, .batch-group-chk')];
            const usable = boxes.filter(c => !c.disabled);
            el.textContent = usable.length ? `已勾選 ${usable.filter(c => c.checked).length} / ${usable.length}` : '';
            el.classList.toggle('hidden', !usable.length);
        }

        function hasIndividualSlot(sched) {
            return sched && sched.weekday !== null && sched.weekday !== undefined && sched.weekday !== '' && !!sched.time;
        }

        // ===== 小組班：一個時段一堂課、多位學生。建立／編輯／刪除＋成員勾選＋時段撞堂預覽 =====
        function findGroup(id) { return groupClasses.find(g => g.id === id) || null; }

        function groupsOfStudent(studentId) {
            return groupClasses.filter(g => (g.memberIds || []).indexOf(studentId) !== -1);
        }

        function nextGroupId() {
            let n = 1;
            while (findGroup('G' + String(n).padStart(2, '0'))) n++;
            return 'G' + String(n).padStart(2, '0');
        }

        function openGroupModal(id) {
            const g = id ? findGroup(id) : null;
            document.getElementById('gmId').value = g ? g.id : '';
            document.getElementById('gmTitle').innerHTML = g
                ? `<i class="fa-solid fa-user-group text-indigo-500"></i> 編輯小組班（${g.id}）`
                : '<i class="fa-solid fa-user-group text-indigo-500"></i> 新增小組班';
            const tutors = allTutorNames();
            document.getElementById('gmTutor').innerHTML = tutorOptionsHtml(tutors);
            document.getElementById('gmName').value = g ? g.name : '';
            document.getElementById('gmProgram').value = g ? (g.program || '') : '';
            document.getElementById('gmLevel').value = g ? (g.level || '') : '';
            document.getElementById('gmTutor').value = g ? g.tutor : tutors[0] || '';
            document.getElementById('gmTutorLevel').value = g ? (g.tutorLevel || advancedTutor({ tutor: g.tutor })) : (tutorTier(tutors[0]) || '普通導師');
            document.getElementById('gmDuration').value = g ? (g.duration || 60) : 60;
            document.getElementById('gmWeekday').value = g ? g.weekday : 6;
            document.getElementById('gmTime').value = g ? g.time : '15:00';
            document.getElementById('gmMemberSearch').value = '';
            const del = document.getElementById('gmDeleteBtn');
            if (del) del.classList.toggle('hidden', !g);
            groupModalMembers = new Set(g ? (g.memberIds || []) : []);
            renderGroupMemberList();
            renderGroupPreview();
            document.getElementById('groupModal').classList.remove('hidden');
            markModalOpened('groupModal');
        }

        let groupModalMembers = new Set(); // 彈窗內暫存的成員勾選（搜尋過濾時不丟失）

        function renderGroupMemberList() {
            const box = document.getElementById('gmMembers');
            if (!box) return;
            const q = (document.getElementById('gmMemberSearch')?.value || '').trim().toLowerCase();
            const rows = [];
            studentDatabase.forEach(s => {
                const hay = (s.id + ' ' + s.name).toLowerCase();
                if (q && !hay.includes(q)) return;
                const own = hasIndividualSlot(s) ? `個別 ${getWeekdayName(s.weekday)} ${s.time}` : '只上小組';
                rows.push(`<label class="flex items-center gap-2 bg-white p-1.5 rounded-lg border border-slate-200 cursor-pointer hover:border-indigo-300">
                    <input type="checkbox" value="${s.id}" ${groupModalMembers.has(s.id) ? 'checked' : ''} onchange="toggleGroupMember(this)" class="accent-indigo-600 rounded">
                    <span class="truncate"><b>${s.id}</b> ${s.name} <span class="text-slate-400">· ${own}</span></span>
                </label>`);
            });
            box.innerHTML = rows.join('') || '<span class="text-slate-400 italic">沒有符合的學生。</span>';
            const cnt = document.getElementById('gmMemberCount');
            if (cnt) cnt.textContent = `已選 ${groupModalMembers.size} 位成員`;
        }

        function toggleGroupMember(chk) {
            if (chk.checked) groupModalMembers.add(chk.value); else groupModalMembers.delete(chk.value);
            const cnt = document.getElementById('gmMemberCount');
            if (cnt) cnt.textContent = `已選 ${groupModalMembers.size} 位成員`;
            renderGroupPreview();
        }

        // 撞堂預覽：以檢視月份計，池子排除本小組自己的課（否則改回同時段會自擋）
        function renderGroupPreview() {
            const box = document.getElementById('gmPreview');
            if (!box) return;
            const gid = document.getElementById('gmId').value || null;
            const weekday = parseInt(document.getElementById('gmWeekday').value);
            const time = document.getElementById('gmTime').value;
            const duration = parseInt(document.getElementById('gmDuration').value) || 60;
            const tutor = document.getElementById('gmTutor').value;
            const monthKey = currentMonthKey() || localDateStr(new Date()).slice(0, 7);
            if (!time || isNaN(weekday) || !tutor) { box.innerHTML = ''; return; }
            const pseudo = { id: gid || '(new-group)', tutor: tutor, type: groupModalMembers.size + '人小組',
                program: document.getElementById('gmProgram').value.trim(), duration: duration };
            const existing = (lessonsByMonth[monthKey] || []).filter(l => !gid || l.groupId !== gid);
            const rows = GACSchedule.previewTimeChange(pseudo, studentDatabase, existing, monthKey, { weekday, time, duration, tutor });
            const clashDays = rows.filter(r => r.clashes.length);
            box.innerHTML = (clashDays.length
                ? `<div class="p-2 bg-amber-50 border border-amber-300 rounded-lg text-amber-900 font-bold">⚠️ ${monthKey} 逢 ${getWeekdayName(weekday)} ${time}：${rows.length} 節中有 ${clashDays.length} 節與 ${tutor} 的其他課重疊</div>`
                : `<div class="p-2 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 font-bold">✓ ${monthKey} 逢 ${getWeekdayName(weekday)} ${time}：${rows.length} 節均無時間衝突</div>`) +
                clashDays.map(r => `<div class="text-amber-800">⚠️ ${r.date} 與 ${r.clashes.map(c => `${c.studentName || c.studentId}（${c.time}）`).join('、')} 撞堂</div>`).join('') +
                '<div class="text-[10px] text-slate-400 mt-1">預覽依總課表目前檢視的月份計（已生成的課＋其他學生的個別課常規時間）。儲存後請到該月按「生成」套用。</div>';
        }

        function closeGroupModal() {
            document.getElementById('groupModal').classList.add('hidden');
        }

        function persistGroups() {
            gacStore.saveGroups(groupClasses);
        }

        function saveGroupModal() {
            const gid = document.getElementById('gmId').value || null;
            const name = document.getElementById('gmName').value.trim();
            const weekday = parseInt(document.getElementById('gmWeekday').value);
            const time = document.getElementById('gmTime').value;
            if (!name) { alert('請填寫小組名稱！'); return; }
            if (!time || isNaN(weekday)) { alert('請選擇常規星期與上課時間！'); return; }
            if (!groupModalMembers.size && !confirm('這個小組還沒有成員，仍要儲存嗎？')) return;
            const data = {
                name: name,
                program: document.getElementById('gmProgram').value.trim(),
                level: document.getElementById('gmLevel').value.trim(),
                tutor: document.getElementById('gmTutor').value,
                tutorLevel: document.getElementById('gmTutorLevel').value,
                duration: parseInt(document.getElementById('gmDuration').value) || 60,
                weekday: weekday, time: time,
                memberIds: [...groupModalMembers]
            };
            pushHistory(`${gid ? '編輯' : '新增'}小組：${name}`);
            let g = gid ? findGroup(gid) : null;
            if (g) Object.assign(g, data);
            else { g = Object.assign({ id: nextGroupId() }, data); groupClasses.push(g); }
            persistGroups();
            renderBatchCheckboxes();
            renderStudentTable();
            closeGroupModal();
            const genMonths = Object.keys(lessonsByMonth).sort();
            showToast(`✅ 已儲存小組「${g.name}」（${g.memberIds.length} 位成員，逢${getWeekdayName(g.weekday)} ${g.time}）` +
                (genMonths.length ? `\n記得到 ${genMonths.join('、')} 按「生成」套用` : ''));
        }

        function deleteGroupFromModal() {
            const gid = document.getElementById('gmId').value;
            const g = findGroup(gid);
            if (!g) return;
            if (!confirm(`刪除小組「${g.name}」？\n成員的學生資料不受影響；已生成的小組課下次「生成」時仍為「已排課」者會被移除，已有狀態的課保留。`)) return;
            pushHistory(`刪除小組：${g.name}`);
            groupClasses = groupClasses.filter(x => x.id !== gid);
            persistGroups();
            renderBatchCheckboxes();
            renderStudentTable();
            closeGroupModal();
        }

        // ===== 快速編輯（原「單一學生」頁籤已合併到此）：改常規時間（保留歷史）／升班，即時撞堂預覽 =====
        let quickEditIdx = -1;

        function openQuickEdit(index) {
            const s = studentDatabase[index];
            if (!s) return;
            quickEditIdx = index;
            const monthKey = currentMonthKey() || localDateStr(new Date()).slice(0, 7);
            const sched = getStudentScheduleForMonth(s, monthKey);
            document.getElementById('qeTitle').innerHTML =
                `<i class="fa-solid fa-user-pen text-amber-500 mr-1"></i>調整常規時間／升班 — ${s.id} ${s.name}`;
            renderQuickEditInfo(s);
            document.getElementById('qeWeekday').value = sched.weekday;
            document.getElementById('qeTime').value = sched.time;
            document.getElementById('qeDuration').value = s.duration || 45;
            document.getElementById('qeLevel').value = s.level || '';
            renderQuickEditFeeSelects();
            document.getElementById('qeEffMonth').value = monthKey;
            renderQuickEditPreview();
            document.getElementById('quickEditModal').classList.remove('hidden');
            markModalOpened('quickEditModal');
        }

        // 快速編輯的級別／時長：以學生的導師級別／課程／形式為前提，只列費率表有定價的級別與時長；舊資料組合不在表內則保留現值
        function renderQuickEditFeeSelects() {
            const s = studentDatabase[quickEditIdx];
            if (!s) return;
            const base = { tutorLevel: s.tutorLevel || advancedTutor(s), program: s.program, type: s.type };
            const levelEl = document.getElementById('qeLevel');
            const durEl = document.getElementById('qeDuration');
            const curLevel = levelEl.value || s.level;
            let levels = GACRates.optionsFor(rateTable, base, 'level');
            if (!levels.length) levels = [s.level || ''];
            const level = levels.indexOf(curLevel) !== -1 ? curLevel : (levels.indexOf(s.level) !== -1 ? s.level : levels[0]);
            fillSelect(levelEl, levels, level);
            const curDur = Number(durEl.value) || Number(s.duration);
            let durs = GACRates.optionsFor(rateTable, Object.assign({ level }, base), 'duration');
            if (!durs.length) durs = [Number(s.duration) || 45];
            const duration = durs.indexOf(curDur) !== -1 ? curDur : (durs.indexOf(Number(s.duration)) !== -1 ? Number(s.duration) : durs[0]);
            fillSelect(durEl, durs, duration, v => `${v} 分鐘`);
            const rate = GACRates.findRate(rateTable, Object.assign({ level, duration }, base));
            const rateEl = document.getElementById('qeRate');
            if (rateEl) rateEl.textContent = rate !== null ? `每堂學費：$${rate.toLocaleString('en-US')}（依費率表）` : '每堂學費：—（費率表無此組合）';
        }

        function onQuickEditFeeChange() {
            renderQuickEditFeeSelects();
            renderQuickEditPreview();
        }

        function renderQuickEditInfo(s) {
            const pending = s.effectiveMonth && s.futureWeekday !== null
                ? `<div class="p-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">💡 已排定變更：原逢 ${getWeekdayName(s.weekday)} ${s.time} ➔ 由 <b>${s.effectiveMonth}</b> 起改為 逢 ${getWeekdayName(s.futureWeekday)} ${s.futureTime}
                       <button onclick="qeClearFuture()" class="ml-1 px-2 py-0.5 bg-white border border-amber-300 text-amber-700 rounded font-semibold hover:bg-amber-100 transition">清除此變更</button></div>`
                : '';
            document.getElementById('qeInfo').innerHTML = `
                <div>導師：<b>${s.tutor}</b> · ${s.program} - <b>${s.level}</b>（${s.type}）· 基準時間 逢 ${getWeekdayName(s.weekday)} ${s.time}</div>
                ${pending}`;
        }

        // 撞堂預覽：以「生效月份」當月計算——該月已生成的課（排除本人）＋未生成者按其他學生常規時間模擬
        function renderQuickEditPreview() {
            const s = studentDatabase[quickEditIdx];
            const box = document.getElementById('qePreview');
            if (!s || !box) return;
            const weekday = parseInt(document.getElementById('qeWeekday').value);
            const time = document.getElementById('qeTime').value;
            const duration = parseInt(document.getElementById('qeDuration').value) || 45;
            const effMonth = document.getElementById('qeEffMonth').value;
            if (!time || !effMonth || isNaN(weekday)) {
                box.innerHTML = '<div class="text-slate-400 italic">請選擇星期、時間與生效月份以預覽衝突。</div>';
                return;
            }
            const others = studentDatabase.filter((x, i) => i !== quickEditIdx);
            const rows = GACSchedule.previewTimeChange(s, others, lessonsByMonth[effMonth] || [], effMonth,
                { weekday: weekday, time: time, duration: duration });
            const clashDays = rows.filter(r => r.clashes.length);
            const head = clashDays.length
                ? `<div class="p-2 bg-amber-50 border border-amber-300 rounded-lg text-amber-900 font-bold">⚠️ ${effMonth} 逢 ${getWeekdayName(weekday)} ${time}：${rows.length} 堂中有 ${clashDays.length} 堂與 ${s.tutor} 的其他課重疊</div>`
                : `<div class="p-2 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 font-bold">✓ ${effMonth} 逢 ${getWeekdayName(weekday)} ${time}：${rows.length} 堂均無時間衝突</div>`;
            box.innerHTML = head + rows.map(r => r.clashes.length
                ? `<div class="flex items-start gap-1.5 text-amber-800"><span class="shrink-0">⚠️ ${r.date}</span><span>與 ${r.clashes.map(c => `${c.studentName || c.studentId}（${c.time}，${c.duration}分）`).join('、')} 撞堂</span></div>`
                : `<div class="text-slate-500">✓ ${r.date} ${r.time}</div>`).join('') +
                `<div class="text-[10px] text-slate-400 mt-1.5">預覽依生效月份當月計算（已生成的課＋其他學生的常規時間）。保存後請到該月按「生成」套用；已生成的舊時間課（仍為已排課者）會在重新生成時自動移除並補上新時間的課。</div>`;
        }

        function closeQuickEdit() {
            quickEditIdx = -1;
            document.getElementById('quickEditModal').classList.add('hidden');
        }

        // 清除已排定但想撤銷的時間變更（基準時間不動）
        function qeClearFuture() {
            const s = studentDatabase[quickEditIdx];
            if (!s || !s.effectiveMonth) return;
            if (!confirm(`清除「由 ${s.effectiveMonth} 起改為 逢 ${getWeekdayName(s.futureWeekday)} ${s.futureTime}」的排定變更？\n（基準時間 逢 ${getWeekdayName(s.weekday)} ${s.time} 不變；已生成的課表需重新生成才會倒回）`)) return;
            pushHistory(`清除排定變更：${s.name}`);
            s.effectiveMonth = '';
            s.futureWeekday = null;
            s.futureTime = '';
            saveToLocalStorage();
            renderBatchCheckboxes();
            renderStudentTable();
            openQuickEdit(quickEditIdx); // 重載彈窗內容
        }

        function saveQuickEdit() {
            const s = studentDatabase[quickEditIdx];
            if (!s) return;
            const weekday = parseInt(document.getElementById('qeWeekday').value);
            const time = document.getElementById('qeTime').value;
            const duration = parseInt(document.getElementById('qeDuration').value) || 45;
            const level = document.getElementById('qeLevel').value.trim();
            const effMonth = document.getElementById('qeEffMonth').value;
            if (!time || !effMonth || isNaN(weekday)) {
                alert('請完整選擇「星期」「上課時間」與「生效月份」！');
                return;
            }
            const cur = getStudentScheduleForMonth(s, effMonth);
            const timeChanged = weekday !== Number(cur.weekday) || time !== cur.time;
            const levelChanged = level && level !== s.level;
            const oldLevel = s.level;
            if (timeChanged || levelChanged || Number(s.duration) !== duration) pushHistory(`快速編輯：${s.name}`);
            const changes = [];
            if (timeChanged) {
                // 二次變更且舊變更生效得更早 → 舊 future 晉升為基準，保住 [舊生效月, 新生效月) 的正確時間。
                // （單一 pending 變更模型只能保留兩段歷史；更早的過去月份通常已生成、不受影響）
                if (s.effectiveMonth && s.futureWeekday !== null && effMonth > s.effectiveMonth) {
                    s.weekday = s.futureWeekday;
                    s.time = s.futureTime;
                }
                s.effectiveMonth = effMonth;
                s.futureWeekday = weekday;
                s.futureTime = time;
                changes.push(`由 ${effMonth} 起改為 逢 ${getWeekdayName(weekday)} ${time}（此前月份保留舊時間）`);
            }
            if (Number(s.duration) !== duration) {
                s.duration = duration;
                changes.push(`時長改為 ${duration} 分鐘`);
            }
            if (levelChanged) {
                s.level = level;
                changes.push(`升班：${oldLevel} → ${level}`);
            }
            if (!changes.length) {
                alert('沒有任何變更。');
                return;
            }
            saveToLocalStorage();
            renderBatchCheckboxes();
            renderStudentTable();
            closeQuickEdit();
            const genMonths = Object.keys(lessonsByMonth).filter(k => k >= effMonth).sort();
            const genNote = timeChanged && genMonths.length
                ? `\n⚠️ ${genMonths.join('、')} 已生成：請到該月按「生成」重新套用`
                : '';
            showToast(`✅ 已保存「${s.name}」：${changes.join('；')}${genNote}`);
        }

        function selectAllStudents(checked) {
            document.querySelectorAll('.batch-student-chk').forEach(chk => { if (!chk.disabled) chk.checked = checked; });
            document.querySelectorAll('.batch-group-chk').forEach(chk => { chk.checked = checked; });
        }

        function getMonthDaysForWeekday(year, month, weekday) {
            const days = [];
            let dateObj = new Date(year, month - 1, 1);
            while (dateObj.getMonth() === month - 1) {
                if (dateObj.getDay() === weekday) {
                    days.push(dateObj.getDate());
                }
                dateObj.setDate(dateObj.getDate() + 1);
            }
            return days;
        }

        // v2：生成 = merge 而非 wipe。已存在的課保留其狀態與補堂鏈接，只新增缺失的；
        // 刪除範圍僅限「本次勾選的學生 ∪ 已從資料庫移除的學生」中仍是 SCHEDULED 的課。
        function generateMasterSchedule() {
            const monthKey = currentMonthKey();
            if (!monthKey) return;

            const checkboxes = document.querySelectorAll('.batch-student-chk:checked');
            const groupBoxes = document.querySelectorAll('.batch-group-chk:checked');
            if (checkboxes.length === 0 && groupBoxes.length === 0) {
                alert('請至少勾選一名學生或一個小組！');
                return;
            }

            const selectedStudents = [...checkboxes].map(chk => studentDatabase[parseInt(chk.value)]).filter(Boolean);
            const selectedGroups = [...groupBoxes].map(chk => findGroup(chk.value)).filter(Boolean);
            pushHistory(`生成課表：${monthKey}（${selectedStudents.length} 位學生、${selectedGroups.length} 個小組）`);
            const generated = [];
            selectedStudents.forEach(s => generated.push(...GACSchedule.generateMonthLessons(s, monthKey)));
            selectedGroups.forEach(g => {
                const members = (g.memberIds || []).map(id => studentDatabase.find(s => s.id === id)).filter(Boolean);
                generated.push(...GACSchedule.generateGroupMonthLessons(g, members, monthKey));
            });

            const res = GACSchedule.mergeMonthLessons(currentMonthLessons(), generated, {
                selectedStudentIds: selectedStudents.map(s => s.id),
                allStudentIds: studentDatabase.map(s => s.id),
                selectedGroupIds: selectedGroups.map(g => g.id),
                allGroupIds: groupClasses.map(g => g.id)
            });

            if (res.lessons.length) lessonsByMonth[monthKey] = res.lessons;
            else delete lessonsByMonth[monthKey];

            // 學費條目：每位涉及的學生（勾選的學生 ∪ 勾選小組的成員）upsert 當月 TUITION，
            // 金額＝該生當月所有常規課（個別＋小組）各按自身費率加總。
            // SENT 的條目絕不改動；金額被手改過（amountEdited）也不覆蓋——由 lib/sendlog.js 保證。
            const tuitionNow = new Date().toISOString();
            const touched = new Map();
            selectedStudents.forEach(s => touched.set(s.id, s));
            selectedGroups.forEach(g => (g.memberIds || []).forEach(id => {
                const s = studentDatabase.find(x => x.id === id);
                if (s) touched.set(s.id, s);
            }));
            touched.forEach(s => {
                const mine = (lessonsByMonth[monthKey] || []).filter(l => l.studentId === s.id && !l.isMakeup);
                if (!mine.length) return;
                GACSendlog.upsertTuition(sendLog, {
                    studentId: s.id, studentName: s.name, phone: s.phone, monthKey: monthKey,
                    amount: mine.reduce((sum, l) => sum + rateForLesson(l), 0), count: mine.length,
                    dates: mine.map(l => l.date).sort(), now: tuitionNow,
                    items: GACSendlog.tuitionItems(mine, rateForLesson)
                });
            });
            persistLessons();

            rebuildMonthContext();
            renderAll();

            let msg = `✅ ${monthKey} 課表已生成（merge 模式，不會清空既有狀態）：\n• 新增 ${res.added.length} 堂\n• 保留 ${res.lessons.length - res.added.length} 堂\n• 學費待發條目已更新（見「發送中心」頁籤）`;
            if (res.removed.length) {
                msg += `\n• 刪除 ${res.removed.length} 堂（僅限仍是「已排課」、且學生已移除/改時間的課）`;
            }
            if (res.conflicts.length) {
                msg += `\n\n⚠️ 以下 ${res.conflicts.length} 堂已有狀態，生成邏輯不會改動，請人工處理：\n` +
                    res.conflicts.map(c => `  • ${c.lesson.date} ${c.lesson.time} ${c.lesson.studentName}（${c.lesson.status}）`).join('\n');
            }
            // 常見誤會：生成只管本地課表；GCal 是投影，需另行同步（僅在已設定 GCal 時提示）
            if (appSettings.gcalClientId) {
                msg += `\n\nℹ️ Google Calendar 不會自動更新——需要時請按「同步 GCal」推送。`;
            }
            // 有需要人工處理的衝突才阻斷式提示；否則右下角 toast 即可
            if (res.conflicts.length) alert(msg); else showToast(msg);
        }

        function rebuildMonthContext() {
            const monthKey = currentMonthKey();
            if (!monthKey) return;
            const [year, month] = monthKey.split('-').map(Number);
            buildMonthWeeksData(year, month);
        }

        function renderAll() {
            rebuildScheduleFilters();
            updateDashboardKPIs();
            renderGroupWarnings();
            renderPendingPool();
            renderMasterScheduleList();
            renderMasterCalendarView();
            updateBatchConfirmBtn();
            renderSendCenter();
            renderPaymentTab();
            // 數據分析與薪酬只在頁籤可見時重算（圖表重建／整月彙總有成本）
            const anaTab = document.getElementById('analyticsTab');
            if (anaTab && !anaTab.classList.contains('hidden')) renderAnalytics();
            const payTab = document.getElementById('advancedPayrollTab');
            if (payTab && !payTab.classList.contains('hidden') && typeof advancedRefresh === 'function') advancedRefresh();
        }

        // 兩種視圖：清單（操作）＋月曆（總覽）。原「週曆」已移除——清單按週次過濾＋月曆已完全覆蓋其用途。
        function switchView(mode) {
            currentViewMode = mode;
            const listEl = document.getElementById('masterScheduleList');
            const calEl = document.getElementById('masterCalendarView');

            listEl.classList.add('hidden');
            calEl.classList.add('hidden');

            document.querySelectorAll('#masterScheduleWrapper .inline-flex button').forEach(b => b.classList.remove('bg-white', 'text-sky-600', 'shadow-sm'));

            if (mode === 'calendar') {
                calEl.classList.remove('hidden');
                document.getElementById('btnCalView').classList.add('bg-white', 'text-sky-600', 'shadow-sm');
            } else {
                listEl.classList.remove('hidden');
                document.getElementById('btnListView').classList.add('bg-white', 'text-sky-600', 'shadow-sm');
                renderMasterScheduleList();
            }
        }

        function onWeekSelectChange() {
            if (currentViewMode === 'list') renderMasterScheduleList();
            updateBatchConfirmBtn(); // 按鈕上的可確認堂數隨週次範圍變
        }

        // ===== 總課表篩選：導師／學生（或小組班）——清單與月曆同時套用；批量確認出席亦以此範圍為準 =====
        function rebuildScheduleFilters() {
            const tSel = document.getElementById('schedTutorFilter');
            const sSel = document.getElementById('schedStudentFilter');
            if (!tSel || !sSel) return;
            const prevT = tSel.value || 'ALL', prevS = sSel.value || 'ALL';
            const tutors = allTutorNames().slice().sort();
            tSel.innerHTML = '<option value="ALL">所有導師</option>' +
                tutors.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
            tSel.value = tutors.includes(prevT) ? prevT : 'ALL';
            const students = studentDatabase.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
            sSel.innerHTML = '<option value="ALL">所有學生</option>' +
                students.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.id)} ${escapeHtml(s.name)}</option>`).join('') +
                (groupClasses.length
                    ? '<optgroup label="小組班">' + groupClasses.map(g => `<option value="G:${escapeHtml(g.id)}">👥 ${escapeHtml(g.name)}</option>`).join('') + '</optgroup>'
                    : '');
            const validS = prevS === 'ALL' || students.some(s => s.id === prevS)
                || (prevS.startsWith('G:') && groupClasses.some(g => 'G:' + g.id === prevS));
            sSel.value = validS ? prevS : 'ALL';
        }

        function scheduleFilterValues() {
            const t = document.getElementById('schedTutorFilter');
            const s = document.getElementById('schedStudentFilter');
            return { tutor: (t && t.value) || 'ALL', student: (s && s.value) || 'ALL' };
        }

        // 單堂是否落在篩選範圍（批量確認用：選某學生只算該生自己的課；選小組班算該組全體）
        function lessonMatchesScheduleFilters(l, f) {
            f = f || scheduleFilterValues();
            if (f.tutor !== 'ALL' && l.tutor !== f.tutor) return false;
            if (f.student === 'ALL') return true;
            return f.student.startsWith('G:') ? l.groupId === f.student.slice(2) : l.studentId === f.student;
        }

        // 課節是否落在篩選範圍（清單／月曆用：選某學生時整節小組卡保留，看得到同組其他成員）
        function filterCellsByScheduleFilters(cells) {
            const f = scheduleFilterValues();
            if (f.tutor === 'ALL' && f.student === 'ALL') return cells;
            return cells.filter(cell => cell.lessons.some(l => lessonMatchesScheduleFilters(l, f)));
        }

        function scheduleFilterLabel() {
            const f = scheduleFilterValues();
            const parts = [];
            if (f.tutor !== 'ALL') parts.push(`導師 ${f.tutor}`);
            if (f.student !== 'ALL') {
                if (f.student.startsWith('G:')) {
                    const g = findGroup(f.student.slice(2));
                    parts.push(`小組 ${g ? g.name : f.student.slice(2)}`);
                } else {
                    const s = studentDatabase.find(x => x.id === f.student);
                    parts.push(`學生 ${s ? s.name : f.student}`);
                }
            }
            return parts.join('、');
        }

        function onScheduleFilterChange() {
            renderMasterScheduleList();
            renderMasterCalendarView();
            updateBatchConfirmBtn();
        }

        // ===== 課節操作彈窗：月曆色塊點開，內容就是清單那張卡片（同一套按鈕與流程）=====
        // 卡片內的展開框／下拉以 lessonId 為 id，清單與彈窗同時渲染會撞 id——開啟期間清單容器留空、關閉時重繪。
        // 每次清單重繪（＝課堂資料有變）時彈窗內容同步刷新；課節不見了（刪除／改時）就自動關閉。
        let lessonModalCellKey = null;

        // 嵌進 onclick 單引號字串的課節 key（小組 key 含「|」與名稱，名稱可能有引號）
        function jsStrAttr(s) {
            return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function findCellByKey(key) {
            return GACSchedule.groupByCell(sortedMonthLessons()).find(c => c.key === key) || null;
        }

        function openLessonModal(cellKey) {
            if (!findCellByKey(cellKey)) return;
            lessonModalCellKey = cellKey;
            renderMasterScheduleList(); // 開啟中：清單留空、內容畫到彈窗
            document.getElementById('lessonModal').classList.remove('hidden');
        }

        function closeLessonModal() {
            lessonModalCellKey = null;
            document.getElementById('lessonModal').classList.add('hidden');
            renderMasterScheduleList();
        }

        function renderLessonModalBody() {
            const cell = findCellByKey(lessonModalCellKey);
            if (!cell) { closeLessonModal(); return false; }
            const clashIds = GACSchedule.detectClashes(sortedMonthLessons());
            const first = cell.lessons[0];
            document.getElementById('lessonModalTitle').innerHTML =
                `<i class="fa-solid fa-calendar-check text-sky-500 mr-1"></i>${first.date}（${getWeekdayName(lessonStart(first).getDay())}）${first.time} · ` +
                (cell.isGroup ? `${first.groupName || first.program} 小組課 ×${cell.lessons.length}` : `${first.studentName}（${first.studentId}）`);
            document.getElementById('lessonModalBody').innerHTML = cell.isGroup
                ? renderGroupCard(cell, clashIds)
                : renderLessonRow(first, clashIds.has(first.lessonId));
            return true;
        }

        function buildMonthWeeksData(year, month) {
            monthWeeksData = [];
            const firstDayIndex = new Date(year, month - 1, 1).getDay();
            const totalDaysInMonth = new Date(year, month, 0).getDate();

            let currentWeek = [];
            for (let i = 0; i < firstDayIndex; i++) currentWeek.push(null);

            for (let day = 1; day <= totalDaysInMonth; day++) {
                const dateString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                currentWeek.push({ day, dateString });

                if (currentWeek.length === 7) {
                    monthWeeksData.push(currentWeek);
                    currentWeek = [];
                }
            }

            if (currentWeek.length > 0) {
                while (currentWeek.length < 7) currentWeek.push(null);
                monthWeeksData.push(currentWeek);
            }

            const weekSelect = document.getElementById('weekSelect');
            weekSelect.innerHTML = '<option value="ALL">全月</option>';

            monthWeeksData.forEach((w, idx) => {
                const validDays = w.filter(d => d !== null);
                const startStr = validDays[0].dateString;
                const endStr = validDays[validDays.length - 1].dateString;

                const option = document.createElement('option');
                option.value = idx;
                const md = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
                option.textContent = `第${idx + 1}週 ${md(startStr)}–${md(endStr)}`;
                weekSelect.appendChild(option);
            });
        }

        function renderMasterScheduleList() {
            const listContainer = document.getElementById('masterScheduleList');
            // 課節彈窗開啟中：內容畫到彈窗、清單留空（避免同 lessonId 的展開框 id 重複）；課節已不存在則彈窗自關並重繪清單
            if (lessonModalCellKey) {
                if (renderLessonModalBody()) listContainer.innerHTML = '';
                return;
            }
            const monthKey = currentMonthKey();
            const allLessons = sortedMonthLessons();
            const clashIds = GACSchedule.detectClashes(allLessons);

            const weekVal = document.getElementById('weekSelect').value;
            let filtered = allLessons;
            if (weekVal !== 'ALL' && monthWeeksData && monthWeeksData[parseInt(weekVal)]) {
                const selectedWeekDays = monthWeeksData[parseInt(weekVal)].filter(d => d !== null);
                const startDateStr = selectedWeekDays[0].dateString;
                const endDateStr = selectedWeekDays[selectedWeekDays.length - 1].dateString;
                filtered = filtered.filter(l => l.date >= startDateStr && l.date <= endDateStr);
            }

            // 按課節渲染：小組課同時段一張卡（成員列在卡內）；一對一每堂一張卡；再套導師／學生篩選
            const cells = filterCellsByScheduleFilters(GACSchedule.groupByCell(filtered));
            if (cells.length === 0) {
                listContainer.innerHTML = allLessons.length === 0
                    ? `<div class="text-center py-8 text-slate-400 text-xs">📭 ${monthKey} 尚未生成課表。勾選學生後按「生成」；重複生成採 merge 模式，不會覆蓋已有狀態。</div>`
                    : `<div class="text-center py-8 text-slate-400 text-xs">⚠️ 所選範圍內無排定課堂。</div>`;
                return;
            }

            // 補堂節緊接在原請假節之下、縮排並以連接線標示——兩者都在本次清單內才如此排；否則各自留原位，靠徽章互指
            const cellByLessonId = {};
            cells.forEach(c => c.lessons.forEach(l => { cellByLessonId[l.lessonId] = c; }));
            const nestedUnder = new Map(); // 原課節 key → [補堂節]
            const nestedKeys = new Set();
            cells.forEach(c => {
                const f = c.lessons[0];
                if (!f.isMakeup || !f.originLessonId) return;
                const origin = cellByLessonId[f.originLessonId];
                if (!origin || origin.key === c.key) return;
                if (!nestedUnder.has(origin.key)) nestedUnder.set(origin.key, []);
                nestedUnder.get(origin.key).push(c);
                nestedKeys.add(c.key);
            });
            const cardHtml = c => (c.isGroup ? renderGroupCard(c, clashIds) : renderLessonRow(c.lessons[0], clashIds.has(c.lessons[0].lessonId)));
            listContainer.innerHTML = cells.filter(c => !nestedKeys.has(c.key)).map(c => {
                const kids = nestedUnder.get(c.key) || [];
                if (!kids.length) return cardHtml(c);
                return `<div class="space-y-2">${cardHtml(c)}${kids.map(k => `
                    <div class="flex items-stretch" data-makeup-of="${jsStrAttr(c.key)}">
                        <div class="w-8 shrink-0 relative" title="此補堂補上面那節請假課">
                            <div class="absolute left-3 -top-2 h-[calc(50%+0.5rem)] w-4 border-l-2 border-b-2 border-emerald-400 rounded-bl-xl"></div>
                        </div>
                        <div class="flex-1 min-w-0">${cardHtml(k)}</div>
                    </div>`).join('')}</div>`;
            }).join('');
        }

        // 課堂列的訊息狀態徽章：對應發送中心條目（請假確認／補堂確認／改期通知）——待發／已開啟未標記／✓ 已發
        function lessonEntryKey(lessonId, type) {
            if (type === 'leave') return 'LEAVE_CONFIRM:' + lessonId;
            if (type === 'move' || sendLog['MOVE_CONFIRM:' + lessonId]) return 'MOVE_CONFIRM:' + lessonId;
            return 'MAKEUP_CONFIRM:' + lessonId;
        }

        function lessonSendBadge(lessonId, type) {
            const e = sendLog[lessonEntryKey(lessonId, type)];
            if (!e) return '';
            if (e.status === 'SENT') return `<span class="px-1.5 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-semibold" title="發送中心：已發於 ${String(e.sentAt || '').replace('T', ' ').slice(0, 16)}">✓ 已發</span>`;
            if (e.waOpenedAt) return '<span class="px-1.5 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-semibold" title="已開啟過 WhatsApp，尚未標記已發（切回頁面時會詢問，或到發送中心標記）"><i class="fa-brands fa-whatsapp"></i> 已開啟</span>';
            return '<span class="px-1.5 py-1 rounded bg-amber-50 border border-amber-200 text-amber-700 text-[10px] font-semibold" title="發送中心：待發送">待發</span>';
        }

        // 從補堂課的 originLessonId（"S001-20260908-2130"）還原出原課日期時間文字
        function originDateText(lesson) {
            const c = String(lesson.originLessonId).slice(String(lesson.studentId).length + 1);
            return `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)} ${c.slice(9, 11)}:${c.slice(11, 13)}`;
        }

        function makeupInfoText(lesson) {
            const f = GACLessonState.findLesson(lessonsByMonth, lesson.makeupLessonId);
            return f ? `${f.lesson.date} ${f.lesson.time}` : lesson.makeupLessonId;
        }

        // 課堂卡片的三塊零件（一對一卡片與小組卡成員列共用）：狀態徽章／展開框（請假假別、補堂日期、手動模式）／操作按鈕
        function lessonBadges(lesson, isClash) {
            const badges = [];
            if (isClash) badges.push(`<span class="bg-amber-500 text-white font-bold px-1.5 py-0.5 rounded text-[10px]">⚠️ 撞堂重疊</span>`);
            if (lesson.isMakeup) badges.push(`<span class="bg-emerald-600 text-white font-bold px-1.5 py-0.5 rounded text-[10px]">MU 補堂</span>`);
            if (lesson.status === 'ATTENDED') badges.push(`<span class="bg-emerald-500 text-white font-bold px-1.5 py-0.5 rounded text-[10px]">✓ 已上課</span>`);
            if (lesson.status === 'NOSHOW') badges.push(`<span class="bg-purple-500 text-white font-bold px-1.5 py-0.5 rounded text-[10px]">NS 缺席</span>`);
            if (lesson.status === 'LEAVE') {
                badges.push(`<span class="bg-rose-500 text-white font-bold px-1.5 py-0.5 rounded text-[10px]">已請假 (${lesson.leaveType})</span>`);
                badges.push(lesson.makeupLessonId
                    ? `<span class="bg-emerald-100 text-emerald-800 font-semibold px-1.5 py-0.5 rounded text-[10px]">已排補堂 → ${makeupInfoText(lesson)}</span>`
                    : `<span class="bg-amber-100 text-amber-800 font-semibold px-1.5 py-0.5 rounded text-[10px]">⏳ 待補堂</span>`);
            }
            return badges.join('');
        }

        function lessonBoxes(lesson) {
            const id = lesson.lessonId;
            // 兩步拆分：請假只選假別；補堂另按（可稍後從待補堂池再排）
            let boxes = '';
            if (lesson.status === 'SCHEDULED') {
                boxes += `
                    <div id="leaveBox_${id}" class="hidden pt-2 border-t border-slate-200 mt-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <span>假別:</span>
                            <select id="leaveType_${id}" class="p-1 border rounded bg-white">
                                <option value="L">L - 事假 (Leave)</option>
                                <option value="SL">SL - 病假 (Sick Leave)</option>
                                <option value="TL">TL - 導師請假 (Tutor Leave)</option>
                            </select>
                            <button onclick="confirmLeave('${id}')" class="px-2 py-1 bg-rose-600 text-white rounded font-bold">確認請假</button>
                            <button onclick="toggleLessonBox('leave','${id}')" class="px-2 py-1 bg-slate-200 text-slate-700 rounded">取消</button>
                            <span class="text-[10px] text-slate-400">補堂時間可稍後再定（請假後進入待補堂池）</span>
                        </div>
                    </div>`;
            }
            if (lesson.status === 'LEAVE' && !lesson.makeupLessonId) {
                boxes += `
                    <div id="makeupBox_${id}" class="hidden pt-2 border-t border-slate-200 mt-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <span>補堂日期:</span>
                            <input type="date" id="makeupDate_${id}" value="${lesson.date}" class="p-1 border rounded bg-white">
                            <span>時間:</span>
                            <input type="time" id="makeupTime_${id}" value="${lesson.time}" class="p-1 border rounded bg-white">
                            <button onclick="submitMakeup('${id}','makeupDate_${id}','makeupTime_${id}')" class="px-2 py-1 bg-emerald-600 text-white rounded font-bold">確認補堂</button>
                            <button onclick="toggleLessonBox('makeup','${id}')" class="px-2 py-1 bg-slate-200 text-slate-700 rounded">取消</button>
                        </div>
                    </div>`;
            }

            // 手動模式：每行出現直接改狀態控件（跳過流程限制、不觸發小組聯動）
            if (manualMode) {
                const opts = [
                    ['SCHEDULED', '已排課'], ['ATTENDED', '已上課'], ['NOSHOW', 'NS 缺席'],
                    ['LEAVE_L', '請假 L'], ['LEAVE_SL', '請假 SL'], ['LEAVE_TL', '請假 TL']
                ];
                const cur = lesson.status === 'LEAVE' ? `LEAVE_${lesson.leaveType || 'L'}` : lesson.status;
                boxes += `
                    <div class="pt-2 border-t border-dashed border-orange-300 mt-2 flex flex-wrap items-center gap-2">
                        <span class="text-orange-700 font-bold text-[10px]"><i class="fa-solid fa-wrench"></i> 手動</span>
                        <select id="manualStatus_${id}" class="p-1 border border-orange-300 rounded bg-white text-[11px]">
                            ${opts.map(([v, t]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`).join('')}
                        </select>
                        <button onclick="manualSetStatus('${id}')" class="px-2 py-1 bg-orange-600 hover:bg-orange-700 text-white rounded font-bold text-[10px]">套用</button>
                        <span class="text-[10px] text-orange-600/70">直接設定狀態，不做流程檢查、不聯動小組</span>
                    </div>`;
            }
            return boxes;
        }

        function lessonButtons(lesson) {
            const id = lesson.lessonId;
            const btns = [];
            if (lesson.status === 'SCHEDULED') {
                btns.push(`<button onclick="markLessonStatus('${id}','ATTENDED')" class="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold flex items-center gap-1" title="確認學生已上課"><i class="fa-solid fa-check"></i> 出席</button>`);
                btns.push(`<button onclick="markLessonStatus('${id}','NOSHOW')" class="px-2.5 py-1.5 bg-purple-100 hover:bg-purple-200 text-purple-800 rounded-lg font-semibold flex items-center gap-1" title="學生缺席 No Show"><i class="fa-solid fa-user-slash"></i> NS</button>`);
                btns.push(`<button onclick="toggleLessonBox('leave','${id}')" class="px-2.5 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-pen"></i> 請假</button>`);
                if (lesson.isMakeup) {
                    btns.push(`<button onclick="openMoveModalForMakeup('${id}')" class="px-2.5 py-1.5 bg-sky-100 hover:bg-sky-200 text-sky-800 rounded-lg font-semibold flex items-center gap-1" title="把此補堂改到別的日期／時間"><i class="fa-solid fa-arrows-rotate"></i> 改期</button>`);
                    btns.push(`<button onclick="cancelMakeupUI('${id}')" class="px-2.5 py-1.5 bg-rose-100 hover:bg-rose-200 text-rose-700 rounded-lg font-semibold flex items-center gap-1" title="取消此補堂，原請假課回到待補堂池"><i class="fa-solid fa-xmark"></i> 取消補堂</button>`);
                } else {
                    // 雙方提前約好改時間：課照上，只是換時段（不是請假，不產生補堂）
                    btns.push(`<button onclick="openLessonMoveModal('${id}')" class="px-2.5 py-1.5 bg-sky-100 hover:bg-sky-200 text-sky-800 rounded-lg font-semibold flex items-center gap-1" title="雙方約好把這一堂改到別的日期／時間（課照上，不算請假）"><i class="fa-solid fa-arrows-rotate"></i> 改期</button>`);
                }
            } else {
                if (lesson.status === 'LEAVE' && !lesson.makeupLessonId) {
                    btns.push(`<button onclick="toggleLessonBox('makeup','${id}')" class="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-calendar-plus"></i> 安排補堂</button>`);
                }
                if (lesson.status === 'LEAVE' && lesson.makeupLessonId) {
                    // 倒回捷徑：不必切月找補堂課，在請假原課行上直接改期／取消
                    btns.push(`<button onclick="openMoveModal('${id}')" class="px-2.5 py-1.5 bg-sky-100 hover:bg-sky-200 text-sky-800 rounded-lg font-semibold flex items-center gap-1" title="把已排的補堂改到別的日期／時間"><i class="fa-solid fa-arrows-rotate"></i> 改期補堂</button>`);
                    btns.push(`<button onclick="cancelMakeupUI('${lesson.makeupLessonId}')" class="px-2.5 py-1.5 bg-rose-100 hover:bg-rose-200 text-rose-700 rounded-lg font-semibold flex items-center gap-1" title="取消已排的補堂，此請假回到待補堂池"><i class="fa-solid fa-xmark"></i> 取消補堂</button>`);
                }
                btns.push(`<button onclick="markLessonStatus('${id}','SCHEDULED')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-semibold flex items-center gap-1" title="撤銷狀態，還原為已排課${lesson.status === 'LEAVE' && lesson.makeupLessonId ? '（會詢問是否一併取消補堂）' : ''}"><i class="fa-solid fa-rotate-left"></i> 還原</button>`);
            }
            if (lesson.status === 'LEAVE') {
                btns.push(`<button onclick="copyLessonMsg('leave', '${id}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-copy"></i> 複製請假</button>`);
                btns.push(`<button onclick="openWhatsAppMessage('${id}', 'leave')" class="px-2.5 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-lg font-semibold flex items-center gap-1" title="在 WhatsApp Web 預填請假訊息（與發送中心同一條目：點開即按設定標記已開啟／詢問／自動已發）"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>${lessonSendBadge(id, 'leave')}`);
            }
            // 改期過的常規課：可重發／複製改期通知
            if (!lesson.isMakeup && lesson.status !== 'LEAVE' && sendLog['MOVE_CONFIRM:' + id]) {
                btns.push(`<button onclick="copyLessonMsg('move', '${id}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-copy"></i> 複製改期</button>`);
                btns.push(`<button onclick="openWhatsAppMessage('${id}', 'move')" class="px-2.5 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-lg font-semibold flex items-center gap-1" title="在 WhatsApp Web 預填改期通知（與發送中心同一條目）"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>${lessonSendBadge(id, 'move')}`);
            }
            if (lesson.isMakeup && lesson.status !== 'LEAVE') {
                const mkType = sendLog['MOVE_CONFIRM:' + id] ? 'move' : 'makeup'; // 改期過（有改期通知條目）→ 用改期通知文案
                btns.push(`<button onclick="copyLessonMsg('${mkType}', '${id}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-copy"></i> ${mkType === 'move' ? '複製改期' : '複製補堂'}</button>`);
                btns.push(`<button onclick="openWhatsAppMessage('${id}', '${mkType}')" class="px-2.5 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-lg font-semibold flex items-center gap-1" title="在 WhatsApp Web 預填${mkType === 'move' ? '改期通知' : '補堂訊息'}（與發送中心同一條目：點開即按設定標記已開啟／詢問／自動已發）"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>${lessonSendBadge(id, mkType)}`);
            }
            return btns.join('');
        }

        function dateHeading(lesson) {
            const start = lessonStart(lesson);
            return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 (${getWeekdayName(start.getDay())})`;
        }

        // 一對一課堂卡片
        function renderLessonRow(lesson, isClash) {
            const title = GACSchedule.lessonTitle(lesson);
            const locationStr = getLocationText(lesson);

            let bgClass = "bg-sky-50/50 border-l-4 border-sky-500";
            if (lesson.status === 'ATTENDED') bgClass = "bg-emerald-50/40 border-l-4 border-emerald-500";
            if (lesson.isMakeup) bgClass = "bg-emerald-50/50 border-l-4 border-emerald-600";
            if (lesson.status === 'NOSHOW') bgClass = "bg-purple-50/50 border-l-4 border-purple-500";
            if (lesson.status === 'LEAVE') bgClass = "bg-rose-50/50 border-l-4 border-rose-500";
            if (isClash) bgClass = "bg-amber-50 border-l-4 border-amber-500 ring-1 ring-amber-300";

            return `
                <div class="${bgClass} p-3 rounded-r-xl border-y border-r border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
                    <div class="space-y-1 flex-1">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            ${lessonBadges(lesson, isClash)}
                            <span class="bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-semibold text-[10px]">${lesson.tutor}</span>
                            <strong class="text-slate-800">${dateHeading(lesson)}</strong>
                            <span class="text-sky-700 font-bold">${lesson.time}</span>
                            <span class="font-bold text-slate-900">${lesson.studentName}</span> (${lesson.studentId})
                            ${lesson.phone ? `<span class="text-slate-500 text-[11px]"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i> ${lesson.phone}</span>` : ''}
                        </div>
                        <div class="text-slate-500 text-[11px]">📅 ${title} ${locationStr ? `| 📍 地點: ${locationStr}` : ''} ${lesson.isMakeup ? `| ↩ 補 ${originDateText(lesson)} 的請假課` : ''} ${lesson.email ? `| ✉️ ${lesson.email}` : ''}</div>
                        ${lessonBoxes(lesson)}
                    </div>

                    <div class="flex items-center gap-1.5 flex-wrap self-end md:self-center md:justify-end md:max-w-[46%]">
                        ${lessonButtons(lesson)}
                    </div>
                </div>
            `;
        }

        // 小組課卡片：一個時段一張卡，成員逐列（各自徽章／展開框／按鈕），卡頭提供整組操作
        function renderGroupCard(cell, clashIds) {
            const first = cell.lessons[0];
            const n = cell.lessons.length;
            const anyClash = cell.lessons.some(l => clashIds.has(l.lessonId));
            const allLeave = cell.lessons.every(l => l.status === 'LEAVE');
            const scheduled = cell.lessons.filter(l => l.status === 'SCHEDULED');
            const idsCsv = scheduled.map(l => l.lessonId).join(',');
            let bgClass = 'bg-indigo-50/40 border-l-4 border-indigo-500';
            if (allLeave) bgClass = 'bg-rose-50/50 border-l-4 border-rose-500';
            if (anyClash) bgClass = 'bg-amber-50 border-l-4 border-amber-500 ring-1 ring-amber-300';
            const groupBtns = scheduled.length ? `
                <button onclick="groupMarkAll('ATTENDED','${idsCsv}')" class="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold flex items-center gap-1" title="把仍是已排課的成員全部標記出席"><i class="fa-solid fa-check-double"></i> 全組出席</button>
                <button onclick="groupTutorLeave('${idsCsv}')" class="px-2.5 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-lg font-semibold flex items-center gap-1" title="導師請假：全組成員一併標記 TL"><i class="fa-solid fa-user-slash"></i> 全組 TL 請假</button>` : '';
            const members = cell.lessons.map(l => `
                <div class="pt-2 border-t border-indigo-100 flex flex-col md:flex-row md:items-center justify-between gap-2">
                    <div class="flex-1 space-y-1">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="font-bold text-slate-900">${l.studentName}</span> <span class="text-slate-500">(${l.studentId})</span>
                            ${lessonBadges(l, clashIds.has(l.lessonId))}
                            ${l.isMakeup ? `<span class="text-slate-500 text-[11px]">↩ 補 ${originDateText(l)} 的請假課</span>` : ''}
                            ${l.phone ? `<span class="text-slate-500 text-[11px]"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i> ${l.phone}</span>` : ''}
                        </div>
                        ${lessonBoxes(l)}
                    </div>
                    <div class="flex items-center gap-1.5 flex-wrap self-end md:self-center md:justify-end">${lessonButtons(l)}</div>
                </div>`).join('');
            return `
                <div class="${bgClass} p-3 rounded-r-xl border-y border-r border-slate-200 text-xs space-y-1">
                    <div class="flex flex-col md:flex-row md:items-center justify-between gap-2">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="bg-indigo-600 text-white font-bold px-1.5 py-0.5 rounded text-[10px]"><i class="fa-solid fa-user-group"></i> 小組課 ×${n}</span>
                            ${anyClash ? '<span class="bg-amber-500 text-white font-bold px-1.5 py-0.5 rounded text-[10px]">⚠️ 撞堂重疊</span>' : ''}
                            <span class="bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-semibold text-[10px]">${first.tutor}</span>
                            <strong class="text-slate-800">${dateHeading(first)}</strong>
                            <span class="text-sky-700 font-bold">${first.time}</span>
                            <span class="text-slate-700">${first.groupName ? `<b>${first.groupName}</b> · ` : ''}${first.program} · ${first.level}（${first.classType}，${first.duration} 分鐘）</span>
                        </div>
                        <div class="flex items-center gap-1.5 flex-wrap self-end md:self-center">${groupBtns}</div>
                    </div>
                    ${members}
                </div>
            `;
        }

        // 整組操作：把仍是已排課的成員一次標記（出席／缺席）
        function groupMarkAll(to, idsCsv) {
            const ids = String(idsCsv || '').split(',').filter(Boolean);
            if (!ids.length) return;
            const label = to === 'ATTENDED' ? '已上課' : to;
            pushHistory(`全組標記「${label}」（${ids.length} 位）`);
            let n = 0;
            ids.forEach(id => { const r = GACLessonState.markStatus(lessonsByMonth, id, to); if (r.ok) n++; });
            persistLessons();
            renderAll();
            showToast(`✅ 已標記 ${n} 位成員為「${label}」`);
        }

        // 整組導師請假：全組成員標記 TL（與單人 TL 聯動同義，但直接從卡頭一鍵發起）
        function groupTutorLeave(idsCsv) {
            const ids = String(idsCsv || '').split(',').filter(Boolean);
            if (!ids.length) return;
            const first = GACLessonState.findLesson(lessonsByMonth, ids[0]);
            if (!first) return;
            const names = ids.map(id => { const f = GACLessonState.findLesson(lessonsByMonth, id); return f ? f.lesson.studentName : id; }).join('、');
            if (!confirm(`導師請假（TL）：${first.lesson.date} ${first.lesson.time} 全組 ${ids.length} 位成員一併標記請假？\n${names}`)) return;
            pushHistory(`全組導師請假 TL：${first.lesson.date} ${first.lesson.time}（${ids.length} 位）`);
            const done = [];
            ids.forEach(id => {
                const r = GACLessonState.markStatus(lessonsByMonth, id, 'LEAVE', { leaveType: 'TL' });
                if (r.ok) {
                    GACSendlog.ensureLessonEntry(sendLog, 'LEAVE_CONFIRM', r.lesson, new Date().toISOString());
                    done.push(id);
                }
            });
            if (!done.length) { dropLastHistory(); return; }
            persistLessons();
            renderAll();
            openMsgModal('leave', done);
        }

        // 月曆色塊樣式
        function lessonPillClass(lesson, isClash) {
            let pill = lesson.tutor === 'Instructor A' ? 'cal-pill-eric' : 'cal-pill-tony';
            if (lesson.isMakeup) pill = 'cal-pill-makeup';
            if (lesson.status === 'ATTENDED') pill = 'cal-pill-attended';
            if (lesson.status === 'NOSHOW') pill = 'cal-pill-noshow';
            if (lesson.status === 'LEAVE') pill = 'cal-pill-leave';
            if (isClash) pill = 'cal-pill-clash';
            return pill;
        }

        function renderMasterCalendarView() {
            const calContainer = document.getElementById('masterCalendarView');
            const batchMonthVal = currentMonthKey();
            if (!batchMonthVal) return;

            const monthLessons = sortedMonthLessons();
            const clashIds = GACSchedule.detectClashes(monthLessons);
            const [year, month] = batchMonthVal.split('-').map(Number);
            const firstDayIndex = new Date(year, month - 1, 1).getDay();
            const totalDaysInMonth = new Date(year, month, 0).getDate();

            let gridHtml = `
                <div class="grid grid-cols-7 gap-px bg-slate-200 border border-slate-200 rounded-xl overflow-hidden min-w-[700px]">
                    <div class="bg-slate-800 text-white text-center py-1.5 text-xs font-bold">日 (Sun)</div>
                    <div class="bg-slate-800 text-white text-center py-1.5 text-xs font-bold">一 (Mon)</div>
                    <div class="bg-slate-800 text-white text-center py-1.5 text-xs font-bold">二 (Tue)</div>
                    <div class="bg-slate-800 text-white text-center py-1.5 text-xs font-bold">三 (Wed)</div>
                    <div class="bg-slate-800 text-white text-center py-1.5 text-xs font-bold">四 (Thu)</div>
                    <div class="bg-slate-800 text-white text-center py-1.5 text-xs font-bold">五 (Fri)</div>
                    <div class="bg-slate-800 text-white text-center py-1.5 text-xs font-bold">六 (Sat)</div>
            `;

            for (let i = 0; i < firstDayIndex; i++) gridHtml += `<div class="bg-slate-50 min-h-[100px]"></div>`;

            for (let day = 1; day <= totalDaysInMonth; day++) {
                const dateString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const dayLessons = monthLessons.filter(l => l.date === dateString);

                gridHtml += `
                    <div class="bg-white p-1.5 min-h-[100px] flex flex-col space-y-1">
                        <div class="text-[11px] font-bold text-slate-500">${day}</div>
                `;

                // 小組課一個時段一個色塊（×人數，成員列在 title）
                filterCellsByScheduleFilters(GACSchedule.groupByCell(dayLessons)).forEach(cell => {
                    const lesson = cell.lessons[0];
                    const anyClash = cell.lessons.some(l => clashIds.has(l.lessonId));
                    const pillStyle = lessonPillClass(lesson, anyClash);
                    if (cell.isGroup) {
                        const names = cell.lessons.map(l => l.studentName).join('、');
                        gridHtml += `
                        <div onclick="openLessonModal('${jsStrAttr(cell.key)}')" class="${pillStyle} text-[10px] p-1 rounded leading-tight truncate cursor-pointer hover:ring-2 hover:ring-sky-400" title="點擊開啟操作 — ${lesson.time} ${lesson.program} 小組 ×${cell.lessons.length}（${lesson.tutor}）：${names}">
                            <strong>${lesson.time}</strong> 👥 ${lesson.program} ×${cell.lessons.length}
                        </div>`;
                        return;
                    }
                    gridHtml += `
                        <div onclick="openLessonModal('${jsStrAttr(cell.key)}')" class="${pillStyle} text-[10px] p-1 rounded leading-tight truncate cursor-pointer hover:ring-2 hover:ring-sky-400" title="點擊開啟操作 — ${lesson.time} ${lesson.studentName} (${lesson.tutor}) | Phone: ${lesson.phone}">
                            <strong>${lesson.time}</strong> ${lesson.isMakeup ? 'MU ' : ''}${lesson.studentName}
                        </div>
                    `;
                });

                gridHtml += `</div>`;
            }

            const totalCells = firstDayIndex + totalDaysInMonth;
            const remainingCells = (7 - (totalCells % 7)) % 7;
            for (let i = 0; i < remainingCells; i++) gridHtml += `<div class="bg-slate-50 min-h-[100px]"></div>`;

            gridHtml += `</div>`;
            calContainer.innerHTML = gridHtml;
        }

        function toggleLessonBox(kind, lessonId) {
            const box = document.getElementById(`${kind}Box_${lessonId}`);
            if (box) box.classList.toggle('hidden');
        }

        // 狀態機操作（lib/lessonState.js）：所有非法轉換由狀態機攔截並提示
        function markLessonStatus(lessonId, to) {
            const f0 = GACLessonState.findLesson(lessonsByMonth, lessonId);
            pushHistory(`課堂 → ${STATUS_LABEL[to] || to}：${f0 ? f0.lesson.studentName + ' ' + f0.lesson.date : lessonId}`);
            let res = GACLessonState.markStatus(lessonsByMonth, lessonId, to);
            if (!res.ok && res.code === 'HAS_MAKEUP') {
                // 一鍵倒回：還原「已排補堂的請假」時級聯取消補堂（原本硬攔截，補堂在別的月份很難找）
                const mk = GACLessonState.findLesson(lessonsByMonth, res.makeupLessonId);
                const mkInfo = mk ? `${mk.lesson.date} ${mk.lesson.time}` : res.makeupLessonId;
                if (!confirm(`此請假已排補堂（${mkInfo}）。\n要「一併取消該補堂」並還原為已排課嗎？`)) { dropLastHistory(); return; }
                const c = GACLessonState.cancelMakeup(lessonsByMonth, res.makeupLessonId);
                if (!c.ok) { dropLastHistory(); alert('⚠️ ' + c.error); return; }
                res = GACLessonState.markStatus(lessonsByMonth, lessonId, to);
            }
            if (!res.ok) { dropLastHistory(); alert('⚠️ ' + res.error); return; }
            persistLessons();
            renderAll();
        }

        // 兩步之一：標記請假。防誤觸：先彈確認框；TL（導師請假）為小組課時全組聯動（手動模式不聯動）。
        function confirmLeave(lessonId) {
            const sel = document.getElementById('leaveType_' + lessonId);
            const leaveType = sel ? sel.value : 'L';
            const found = GACLessonState.findLesson(lessonsByMonth, lessonId);
            if (!found) { alert('⚠️ 找不到課堂 ' + lessonId); return; }
            const me = found.lesson;
            let targets = [me];
            if (!manualMode && leaveType === 'TL') {
                targets = targets.concat(GACLessonState.groupSiblings(lessonsByMonth, lessonId)
                    .filter(s => s.status === 'SCHEDULED'));
            }
            const nameList = targets.map(t => `${t.studentName} (${t.studentId})`).join('、');
            const groupNote = targets.length > 1 ? `\n\n※ 小組課：導師請假對全組生效，將同時為以上 ${targets.length} 位學生請假。` : '';
            if (!confirm(`確定請假？\n學生：${nameList}\n課堂：${me.date} ${me.time}\n假別：${getLeaveText(leaveType)}${groupNote}`)) return;
            pushHistory(`請假 ${leaveType}：${nameList} ${me.date}`);
            const done = [];
            targets.forEach(t => {
                const res = GACLessonState.markStatus(lessonsByMonth, t.lessonId, 'LEAVE', { leaveType });
                if (res.ok) {
                    GACSendlog.ensureLessonEntry(sendLog, 'LEAVE_CONFIRM', t, new Date().toISOString());
                    done.push(t.lessonId);
                } else alert(`⚠️ ${t.studentName}：${res.error}`);
            });
            if (!done.length) { dropLastHistory(); return; }
            persistLessons();
            renderAll();
            openMsgModal('leave', done);
        }

        // 兩步之二：安排補堂（總表行內或待補堂池皆走此函數）。
        // 防誤觸：先彈確認框；小組防範：TL 補堂發散攔截 + 同組同待補順手同排（手動模式跳過小組邏輯）。
        function submitMakeup(lessonId, dateElId, timeElId) {
            const date = document.getElementById(dateElId)?.value;
            const time = document.getElementById(timeElId)?.value;
            if (!date || !time) {
                alert('請選擇補堂日期與時間！');
                return;
            }
            const foundOrigin = GACLessonState.findLesson(lessonsByMonth, lessonId);
            if (!foundOrigin) { alert('⚠️ 找不到課堂 ' + lessonId); return; }
            const origin = foundOrigin.lesson;
            if (!confirm(`確定安排補堂？\n學生：${origin.studentName} (${origin.studentId})\n原課：${origin.date} ${origin.time}\n補堂：${date} ${time}`)) return;
            if (!manualMode && origin.leaveType === 'TL') {
                // 防範機制：同組 TL 補堂已排在不同時段 → 攔截確認（TL 小組補堂通常應同一時段）
                const diverged = GACLessonState.groupSiblings(lessonsByMonth, lessonId)
                    .filter(s => s.status === 'LEAVE' && s.leaveType === 'TL' && s.makeupLessonId)
                    .map(s => ({ s, mk: GACLessonState.findLesson(lessonsByMonth, s.makeupLessonId) }))
                    .filter(x => x.mk && (x.mk.lesson.date !== date || x.mk.lesson.time !== time));
                if (diverged.length) {
                    const lines = diverged.map(x => `${x.s.studentName} → ${x.mk.lesson.date} ${x.mk.lesson.time}`).join('\n');
                    if (!confirm(`⚠️ 小組補堂時段不一致：\n${lines}\n\n導師請假（TL）的小組補堂通常應排在同一時段。\n仍要把 ${origin.studentName} 排在 ${date} ${time} 嗎？\n（建議按「取消」，改排成同一時段）`)) return;
                }
            }
            pushHistory(`安排補堂：${origin.studentName} ${date} ${time}`);
            let res = GACLessonState.scheduleMakeup(lessonsByMonth, lessonId, { date, time });
            if (!res.ok && res.code === 'DUPLICATE_MAKEUP') {
                // 防重複：已有補堂 → 顯示現有補堂資訊，讓用戶選擇保留或取消重排
                const ex = res.existingMakeup;
                const info = ex ? `${ex.date} ${ex.time}` : '（資料缺失）';
                if (!confirm(`此請假已排過補堂：${info}\n\n確定要「取消原補堂並重排」到 ${date} ${time} 嗎？\n（按「取消」則保留原補堂，放棄本次操作）`)) { dropLastHistory(); return; }
                res = GACLessonState.scheduleMakeup(lessonsByMonth, lessonId, { date, time }, { replaceExisting: true });
            }
            if (!res.ok) { dropLastHistory(); alert('⚠️ ' + res.error); return; }
            const scheduledIds = [res.makeup.lessonId];
            GACSendlog.ensureLessonEntry(sendLog, 'MAKEUP_CONFIRM', res.makeup, new Date().toISOString());
            if (!manualMode) {
                // 小組順手同排：同組成員同在待補堂池 → 提議一併排到同一時段
                const pendingSibs = GACLessonState.groupSiblings(lessonsByMonth, lessonId)
                    .filter(s => s.status === 'LEAVE' && !s.makeupLessonId);
                if (pendingSibs.length) {
                    const names = pendingSibs.map(s => `${s.studentName} (${s.studentId})`).join('、');
                    if (confirm(`同組學生 ${names} 亦在待補堂池。\n要一併排到 ${date} ${time} 嗎？\n（按「取消」則只排 ${origin.studentName}）`)) {
                        pendingSibs.forEach(s => {
                            const r2 = GACLessonState.scheduleMakeup(lessonsByMonth, s.lessonId, { date, time });
                            if (r2.ok) {
                                GACSendlog.ensureLessonEntry(sendLog, 'MAKEUP_CONFIRM', r2.makeup, new Date().toISOString());
                                scheduledIds.push(r2.makeup.lessonId);
                            } else alert(`⚠️ ${s.studentName}：${r2.error}`);
                        });
                    }
                }
            }
            persistLessons();
            renderAll();
            const note = date.slice(0, 7) !== currentMonthKey()
                ? `補堂不在目前檢視月份（切換到 ${date.slice(0, 7)} 可見）；如需倒回，原請假行上可直接「取消補堂」。`
                : '';
            openMsgModal('makeup', scheduledIds, note);
        }

        function cancelMakeupUI(makeupLessonId) {
            // 小組提醒：取消其中一人的補堂會讓小組補堂不一致（另一人仍保留原時段）
            const f = GACLessonState.findLesson(lessonsByMonth, makeupLessonId);
            let extra = '';
            if (f) {
                const sibs = GACLessonState.groupSiblings(lessonsByMonth, makeupLessonId)
                    .filter(s => s.isMakeup && s.status === 'SCHEDULED');
                if (sibs.length) {
                    extra = `\n\n注意：同組 ${sibs.map(s => s.studentName).join('、')} 的補堂仍保留在此時段，取消後小組將不一致（總表頂部會出現警告）。`;
                }
            }
            if (!confirm('確定要取消此補堂？其對應的請假課將回到待補堂池。' + extra)) return;
            pushHistory(`取消補堂：${f ? f.lesson.studentName + ' ' + f.lesson.date : makeupLessonId}`);
            const res = GACLessonState.cancelMakeup(lessonsByMonth, makeupLessonId);
            if (!res.ok) { dropLastHistory(); alert('⚠️ ' + res.error); return; }
            persistLessons();
            renderAll();
        }

        // 手動模式：跳過狀態機限制、不觸發小組聯動；用於修正誤操作。每次載入預設關閉（防誤觸）。
        function toggleManualMode() {
            manualMode = !manualMode;
            const btn = document.getElementById('manualModeBtn');
            if (btn) {
                btn.classList.toggle('bg-orange-600', manualMode);
                btn.classList.toggle('text-white', manualMode);
                btn.classList.toggle('bg-slate-100', !manualMode);
                btn.classList.toggle('text-slate-600', !manualMode);
            }
            renderAll();
        }

        function manualSetStatus(lessonId) {
            const sel = document.getElementById('manualStatus_' + lessonId);
            const found = GACLessonState.findLesson(lessonsByMonth, lessonId);
            if (!sel || !found) return;
            const v = sel.value;
            const to = v.indexOf('LEAVE') === 0 ? 'LEAVE' : v;
            const leaveType = v.indexOf('LEAVE') === 0 ? v.split('_')[1] : '';
            const label = (sel.options && sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].text) || v;
            const l = found.lesson;
            pushHistory(`手動改狀態：${l.studentName} ${l.date} → ${label}`);
            let res = GACLessonState.forceStatus(lessonsByMonth, lessonId, to, { leaveType });
            if (!res.ok && res.code === 'HAS_MAKEUP') {
                const mk = GACLessonState.findLesson(lessonsByMonth, res.makeupLessonId);
                const mkInfo = mk ? `${mk.lesson.date} ${mk.lesson.time}` : res.makeupLessonId;
                if (!confirm(`此請假已排補堂（${mkInfo}）。\n要「一併取消該補堂」再改狀態嗎？`)) { dropLastHistory(); return; }
                const c = GACLessonState.cancelMakeup(lessonsByMonth, res.makeupLessonId);
                if (!c.ok) { dropLastHistory(); alert('⚠️ ' + c.error); return; }
                res = GACLessonState.forceStatus(lessonsByMonth, lessonId, to, { leaveType });
            }
            if (!res.ok) { dropLastHistory(); alert('⚠️ ' + res.error); return; }
            persistLessons();
            renderAll();
        }

        // ===== 確認訊息彈窗：請假／補堂成功後自動彈出；小組課列出全部成員，逐一複製／WhatsApp =====
        function openMsgModal(type, lessonIds, note) {
            const modal = document.getElementById('msgModal');
            const body = document.getElementById('msgModalBody');
            if (!modal || !body) return;
            const lessons = (lessonIds || [])
                .map(id => GACLessonState.findLesson(lessonsByMonth, id))
                .filter(Boolean).map(f => f.lesson);
            if (!lessons.length) return;
            const isLeave = type === 'leave';
            document.getElementById('msgModalTitle').textContent = '📩 ' + ({ leave: '請假確認', makeup: '補堂確認', move: '改期通知' }[type] || '補堂確認') + '訊息';
            const parts = [];
            if (note) parts.push(`<div class="p-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-800">${note}</div>`);
            if (lessons.length > 1) parts.push(`<div class="p-2 bg-sky-50 border border-sky-200 rounded-lg text-sky-800 font-semibold"><i class="fa-solid fa-user-group mr-1"></i>小組課：共 ${lessons.length} 位學生，請逐一發送。</div>`);
            lessons.forEach(l => {
                const msg = lessonMsgByType(type, l);
                const copyFn = `copyLessonMsg('${type}', `;
                const wa = l.phone
                    ? `<button onclick="openWhatsAppMessage('${l.lessonId}', '${type}')" class="px-2.5 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-lg font-semibold"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>`
                    : `<span class="text-slate-400 italic">無電話，僅可複製</span>`;
                parts.push(`
                    <div class="border border-slate-200 rounded-xl p-3 space-y-2">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-bold text-slate-800">${l.studentName}</span>
                            <span class="text-slate-500">(${l.studentId})</span>
                            ${l.phone ? `<span class="text-slate-500"><i class="fa-solid fa-phone text-[10px]"></i> ${l.phone}</span>` : ''}
                        </div>
                        <div class="bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-700 whitespace-pre-wrap">${msg}</div>
                        <div class="flex items-center gap-1.5">
                            <button onclick="${copyFn}'${l.lessonId}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold"><i class="fa-solid fa-copy"></i> 複製</button>
                            ${wa}
                        </div>
                    </div>`);
            });
            body.innerHTML = parts.join('');
            modal.classList.remove('hidden');
        }

        function closeMsgModal() {
            const modal = document.getElementById('msgModal');
            if (modal) modal.classList.add('hidden');
        }

        // ===== 補堂改期彈窗：選新日期時間，一步調過去（内部＝取消舊補堂＋重排，鏈保持完好） =====
        let moveModalOriginId = null;
        let moveModalMode = 'makeup';   // 'makeup'＝改補堂（走補堂鏈）｜'lesson'＝改單堂常規課（只搬時間）
        let moveModalLessonId = null;

        function openMoveModal(originLessonId) {
            const f = GACLessonState.findLesson(lessonsByMonth, originLessonId);
            if (!f || !f.lesson.makeupLessonId) { alert('⚠️ 此請假沒有已排的補堂'); return; }
            const mk = GACLessonState.findLesson(lessonsByMonth, f.lesson.makeupLessonId);
            if (!mk) { alert('⚠️ 找不到補堂課 ' + f.lesson.makeupLessonId); return; }
            if (mk.lesson.status !== 'SCHEDULED') {
                alert(`⚠️ 補堂已標記為「${mk.lesson.status}」屬歷史紀錄，請先在該補堂課上「還原」再改期。`);
                return;
            }
            moveModalOriginId = originLessonId;
            moveModalMode = 'makeup';
            moveModalLessonId = null;
            setMoveModalTitle('補堂改期');
            document.getElementById('moveModalInfo').innerHTML =
                `${f.lesson.studentName} (${f.lesson.studentId})<br>原課：${f.lesson.date} ${f.lesson.time}<br>目前補堂：<b>${mk.lesson.date} ${mk.lesson.time}</b>`;
            document.getElementById('moveDate').value = mk.lesson.date;
            document.getElementById('moveTime').value = mk.lesson.time;
            document.getElementById('moveModal').classList.remove('hidden');
            markModalOpened('moveModal');
        }

        function openMoveModalForMakeup(makeupLessonId) {
            const prev = GACLessonState.allLessons(lessonsByMonth).find(l => l.makeupLessonId === makeupLessonId);
            if (!prev) { alert('⚠️ 找不到此補堂對應的請假課'); return; }
            openMoveModal(prev.lessonId);
        }

        // 單堂改期（常規課）：雙方約好換時段——課照上，不是請假、不產生補堂，只把這一堂的日期時間搬走。
        // 小組課整節一起搬（同時段仍是「已排課」的成員）；搬動前先檢查會不會與同一導師的其他課重疊。
        function openLessonMoveModal(lessonId) {
            const f = GACLessonState.findLesson(lessonsByMonth, lessonId);
            if (!f) { alert('⚠️ 找不到課堂 ' + lessonId); return; }
            const l = f.lesson;
            if (l.status !== 'SCHEDULED') { alert('⚠️ 只有「已排課」的課堂可以改期；已有結果的請先「還原」。'); return; }
            if (l.isMakeup) { openMoveModalForMakeup(lessonId); return; }
            moveModalMode = 'lesson';
            moveModalLessonId = lessonId;
            moveModalOriginId = null;
            setMoveModalTitle('課堂改期');
            const mates = lessonMoveTargets(l).filter(x => x.lessonId !== l.lessonId);
            const notes = [];
            if (mates.length) {
                notes.push('<div class="mt-1 text-indigo-700"><i class="fa-solid fa-user-group"></i> 小組課：此時段另 ' +
                    mates.length + ' 位學生（' + mates.map(x => escapeHtml(x.studentName)).join('、') + '）會一併改期。</div>');
            }
            if (l.gcalEventId) {
                notes.push('<div class="mt-1 text-amber-700"><i class="fa-solid fa-triangle-exclamation"></i> 這堂已推送到 Google Calendar：改期後請一併在 Calendar 改時間，否則下次同步會以 Calendar 為準改回來。</div>');
            }
            document.getElementById('moveModalInfo').innerHTML =
                escapeHtml(l.studentName) + ' (' + escapeHtml(l.studentId) + ')<br>目前時間：<b>' +
                l.date + ' ' + l.time + '</b>（' + l.duration + ' 分鐘）' + notes.join('');
            document.getElementById('moveDate').value = l.date;
            document.getElementById('moveTime').value = l.time;
            document.getElementById('moveModal').classList.remove('hidden');
            markModalOpened('moveModal');
        }

        function setMoveModalTitle(text) {
            const el = document.getElementById('moveModalTitle');
            if (el) el.innerHTML = '<i class="fa-solid fa-arrows-rotate text-sky-500 mr-1"></i>' + text;
        }

        // 一起搬的課：小組課＝同節仍是「已排課」的全體成員；個別課＝自己一堂
        function lessonMoveTargets(lesson) {
            if (!lesson.groupId) return [lesson];
            return [lesson].concat(GACLessonState.groupSiblings(lessonsByMonth, lesson.lessonId)
                .filter(s => s.status === 'SCHEDULED' && s.time === lesson.time));
        }

        // 改到新時段後會與同一導師的哪些課重疊（同組同時段不算撞）
        function moveClashNames(targets, date, time) {
            const moved = targets.map(t => Object.assign({}, t, { date: date, time: time }));
            const others = GACLessonState.allLessons(lessonsByMonth)
                .filter(l => !targets.some(t => t.lessonId === l.lessonId));
            const clash = GACSchedule.detectClashes(others.concat(moved));
            return others.filter(l => clash.has(l.lessonId)).map(l => l.studentName + ' ' + l.date + ' ' + l.time);
        }

        function submitLessonMove(date, time) {
            const f = GACLessonState.findLesson(lessonsByMonth, moveModalLessonId);
            if (!f) { closeMoveModal(); return; }
            const l = f.lesson;
            if (l.date === date && l.time === time) { alert('時間沒有變更。'); return; }
            const targets = lessonMoveTargets(l);
            const clashes = moveClashNames(targets, date, time);
            if (clashes.length && !confirm('⚠️ 改到 ' + date + ' ' + time + ' 會與同一導師的課堂重疊：\n' +
                clashes.join('\n') + '\n\n仍要改期嗎？')) return;
            pushHistory('課堂改期：' + l.studentName + ' ' + l.date + ' ' + l.time + ' → ' + date + ' ' + time +
                (targets.length > 1 ? '（小組 ' + targets.length + ' 位）' : ''));
            const nowIso = new Date().toISOString();
            const moved = [];
            targets.forEach(t => {
                const from = { date: t.date, time: t.time };
                const r = GACLessonState.moveLessonDateTime(lessonsByMonth, t.lessonId, date, time);
                if (r.ok) {
                    GACSendlog.ensureMoveEntry(sendLog, r.lesson, from, nowIso);
                    moved.push(t.lessonId);
                } else alert('⚠️ ' + t.studentName + '：' + r.error);
            });
            if (!moved.length) { dropLastHistory(); return; }
            closeMoveModal();
            persistLessons();
            renderAll();
            const note = date.slice(0, 7) !== currentMonthKey()
                ? '課堂已移到 ' + date.slice(0, 7) + '（切換月份可見）。' : '';
            openMsgModal('move', moved, note);
        }

        function closeMoveModal() {
            moveModalOriginId = null;
            moveModalLessonId = null;
            moveModalMode = 'makeup';
            const modal = document.getElementById('moveModal');
            if (modal) modal.classList.add('hidden');
        }

        function submitMoveModal() {
            const date = document.getElementById('moveDate')?.value;
            const time = document.getElementById('moveTime')?.value;
            if (!date || !time) { alert('請選擇新的日期與時間！'); return; }
            if (moveModalMode === 'lesson') { submitLessonMove(date, time); return; }
            const originId = moveModalOriginId;
            if (!originId) return;
            const f = GACLessonState.findLesson(lessonsByMonth, originId);
            if (!f || !f.lesson.makeupLessonId) { closeMoveModal(); return; }
            const origin = f.lesson;
            const oldMk = GACLessonState.findLesson(lessonsByMonth, origin.makeupLessonId);
            const oldSlot = oldMk ? { date: oldMk.lesson.date, time: oldMk.lesson.time } : null;
            if (oldSlot && oldSlot.date === date && oldSlot.time === time) { alert('時間沒有變更。'); return; }
            let targets = [origin];
            if (!manualMode && origin.leaveType === 'TL' && oldSlot) {
                // 小組一併改期：同組 TL 補堂在同一舊時段 → 提議整組一起搬
                const together = GACLessonState.groupSiblings(lessonsByMonth, originId)
                    .filter(s => s.status === 'LEAVE' && s.leaveType === 'TL' && s.makeupLessonId)
                    .map(s => ({ s, mk: GACLessonState.findLesson(lessonsByMonth, s.makeupLessonId) }))
                    .filter(x => x.mk && x.mk.lesson.status === 'SCHEDULED' &&
                        x.mk.lesson.date === oldSlot.date && x.mk.lesson.time === oldSlot.time);
                if (together.length) {
                    const names = together.map(x => `${x.s.studentName} (${x.s.studentId})`).join('、');
                    if (confirm(`同組學生 ${names} 的補堂也在 ${oldSlot.date} ${oldSlot.time}。\n要一併改期到 ${date} ${time} 嗎？\n（按「取消」則只改 ${origin.studentName}）`)) {
                        targets = targets.concat(together.map(x => x.s));
                    }
                }
                // 防範：改期後與沒跟著改的同組 TL 補堂不一致 → 攔截確認
                const targetIds = targets.map(t => t.lessonId);
                const diverged = GACLessonState.groupSiblings(lessonsByMonth, originId)
                    .filter(s => targetIds.indexOf(s.lessonId) === -1 &&
                        s.status === 'LEAVE' && s.leaveType === 'TL' && s.makeupLessonId)
                    .map(s => ({ s, mk: GACLessonState.findLesson(lessonsByMonth, s.makeupLessonId) }))
                    .filter(x => x.mk && (x.mk.lesson.date !== date || x.mk.lesson.time !== time));
                if (diverged.length) {
                    const lines = diverged.map(x => `${x.s.studentName} → ${x.mk.lesson.date} ${x.mk.lesson.time}`).join('\n');
                    if (!confirm(`⚠️ 改期後小組補堂時段將不一致：\n${lines}\n\n仍要繼續嗎？`)) return;
                }
            }
            pushHistory(`補堂改期：${origin.studentName} → ${date} ${time}`);
            const moved = [];
            let anyMove = false;
            const nowIso = new Date().toISOString();
            targets.forEach(t => {
                // 舊補堂時間已通知過（補堂確認或改期通知已發）→ 這次建「改期通知」；未通知過 → 仍是新的補堂確認
                const oldId = t.makeupLessonId;
                const oldMkF = oldId ? GACLessonState.findLesson(lessonsByMonth, oldId) : null;
                const from = oldMkF ? { date: oldMkF.lesson.date, time: oldMkF.lesson.time } : null;
                const told = !!oldId && ['MAKEUP_CONFIRM:', 'MOVE_CONFIRM:'].some(p => sendLog[p + oldId] && sendLog[p + oldId].status === 'SENT');
                const r = GACLessonState.scheduleMakeup(lessonsByMonth, t.lessonId, { date, time }, { replaceExisting: true });
                if (r.ok) {
                    // 舊補堂的 TODO 確認條目會被 syncSendlog 孤兒清理，這裡為新補堂建新條目
                    if (told && from) { GACSendlog.ensureMoveEntry(sendLog, r.makeup, from, nowIso); anyMove = true; }
                    else GACSendlog.ensureLessonEntry(sendLog, 'MAKEUP_CONFIRM', r.makeup, nowIso);
                    moved.push(r.makeup.lessonId);
                } else alert(`⚠️ ${t.studentName}：${r.error}`);
            });
            if (!moved.length) { dropLastHistory(); return; }
            closeMoveModal();
            persistLessons();
            renderAll();
            const note = date.slice(0, 7) !== currentMonthKey()
                ? `補堂不在目前檢視月份（切換到 ${date.slice(0, 7)} 可見）。` : '';
            openMsgModal(anyMove ? 'move' : 'makeup', moved, note);
        }

        // ===== 小組一致性警告橫幅（兜底偵測：任何路徑造成的不一致都會在這裡現形） =====
        function renderGroupWarnings() {
            const banner = document.getElementById('groupWarnBanner');
            if (!banner) return;
            const issues = GACLessonState.detectGroupInconsistencies(lessonsByMonth, currentMonthKey());
            banner.classList.toggle('hidden', issues.length === 0);
            banner.innerHTML = issues.map(iss => {
                if (iss.type === 'TL_PARTIAL') {
                    const tlNames = iss.tlLessons.map(l => `${l.studentName} (${l.studentId})`).join('、');
                    const otherNames = iss.others.map(l => `${l.studentName}（${groupStatusLabel(l)}）`).join('、');
                    return `<div><i class="fa-solid fa-user-group text-orange-500 mr-1"></i><b>${iss.date} ${iss.time} 小組不一致：</b>${tlNames} 已請導師假（TL），但同組 ${otherNames}。導師請假應影響全組——請為其補請 TL 假，或還原多請的假。</div>`;
                }
                const lines = iss.entries.map(e => `${e.origin.studentName} → ${e.makeup.date} ${e.makeup.time}`).join('；');
                return `<div><i class="fa-solid fa-code-branch text-orange-500 mr-1"></i><b>${iss.date} ${iss.time} 小組補堂時段發散：</b>${lines}。導師請假（TL）的補堂通常全組同一時段——可在請假行「改期補堂」對齊。</div>`;
            }).join('');
        }

        function groupStatusLabel(lesson) {
            if (lesson.status === 'SCHEDULED') return '仍為已排課';
            if (lesson.status === 'ATTENDED') return '已標為已上課';
            if (lesson.status === 'NOSHOW') return '已標為缺席';
            return lesson.status;
        }

        // 整週/整月批量確認出席（只確認今天含以前、仍是 SCHEDULED 的課）
        // 批量確認的範圍：目前的週次（或全月）＋導師／學生篩選；只到今天為止（未來的課不確認）
        function batchConfirmScope() {
            const monthKey = currentMonthKey();
            if (!monthKey) return null;
            const weekVal = document.getElementById('weekSelect')?.value || 'ALL';
            let from = monthKey + '-01', to = monthKey + '-31', label = '全月';
            if (weekVal !== 'ALL' && monthWeeksData && monthWeeksData[parseInt(weekVal)]) {
                const days = monthWeeksData[parseInt(weekVal)].filter(d => d !== null);
                from = days[0].dateString;
                to = days[days.length - 1].dateString;
                label = `第 ${parseInt(weekVal) + 1} 週`;
            }
            const f = scheduleFilterValues();
            return { monthKey, from, to, label, today: localDateStr(new Date()),
                opts: { maxDate: localDateStr(new Date()), filter: l => lessonMatchesScheduleFilters(l, f) } };
        }

        // 按鈕即狀態指示：可確認 N 堂就寫出來；沒有就停用，並說明是「都確認了」還是「只剩未來的課」
        function updateBatchConfirmBtn() {
            const btn = document.getElementById('batchConfirmBtn');
            if (!btn) return;
            const scope = batchConfirmScope();
            if (!scope) return;
            const n = GACLessonState.confirmableInRange(lessonsByMonth, scope.from, scope.to, scope.opts).length;
            // 同範圍但不限日期的待確認：用來分辨「都確認完了」與「只剩未來的課」
            const future = GACLessonState.confirmableInRange(lessonsByMonth, scope.from, scope.to,
                { filter: scope.opts.filter }).length - n;
            // 範圍內是否有任何課（不分狀態）：沒有課 ≠ 課都確認了
            const inRange = GACLessonState.allLessons(lessonsByMonth).filter(l =>
                l.date >= scope.from && l.date <= scope.to && scope.opts.filter(l)).length;
            btn.disabled = n === 0;
            btn.classList.toggle('opacity-40', n === 0);
            btn.classList.toggle('cursor-not-allowed', n === 0);
            let label, title;
            if (n > 0) {
                label = `批量確認出席（${n} 堂）`;
                title = `把${scope.label}${scheduleFilterLabel() ? '、' + scheduleFilterLabel() : ''}範圍內、今天（含）以前仍是「已排課」的 ${n} 堂標記為已上課`;
            } else if (!inRange) {
                label = '範圍內沒有課堂';
                title = '目前的週次／導師／學生篩選範圍內沒有任何課堂';
            } else if (future > 0) {
                label = `無待確認課堂（還有 ${future} 堂未到上課日）`;
                title = `此範圍內今天以前的課都已確認；另有 ${future} 堂日期還沒到，上完課那天再確認`;
            } else {
                label = '全部已確認出席';
                title = `此範圍內 ${inRange} 堂課都已有結果（已上課／請假／缺席），沒有待確認的`;
            }
            btn.innerHTML = `<i class="fa-solid fa-check-double"></i> ${label}`;
            btn.title = title;
        }

        function batchConfirmWeek() {
            const scope = batchConfirmScope();
            if (!scope) return;
            const fLabel = scheduleFilterLabel();
            const n = GACLessonState.confirmableInRange(lessonsByMonth, scope.from, scope.to, scope.opts).length;
            if (!n) { updateBatchConfirmBtn(); return; }
            if (!confirm(`將${scope.label}（${scope.from} ~ ${scope.to}）${fLabel ? '、' + fLabel : ''}範圍內、今天（含）以前仍是「已排課」的 ${n} 堂課全部標記為「已上課」？`)) return;
            pushHistory(`批量確認出席：${scope.label}${fLabel ? '、' + fLabel : ''}（${n} 堂）`);
            const res = GACLessonState.confirmScheduledInRange(lessonsByMonth, scope.from, scope.to, scope.opts);
            persistLessons();
            renderAll();
            showToast(`✅ 已批量確認 ${res.count} 堂為「已上課」`);
        }

        // 待補堂池：跨月列出所有「已請假未排補堂」的課，按等待天數降序
        function renderPendingPool() {
            const banner = document.getElementById('pendingPoolBanner');
            if (!banner) return;
            const pool = GACLessonState.pendingMakeups(lessonsByMonth, localDateStr(new Date()));
            document.getElementById('pendingPoolCount').textContent = pool.length;
            banner.classList.toggle('hidden', pool.length === 0);
            const list = document.getElementById('pendingPoolList');
            list.innerHTML = pool.map(({ lesson, waitingDays }) => {
                const id = lesson.lessonId;
                const waitHtml = waitingDays >= 0
                    ? `<span class="${waitingDays >= 14 ? 'text-rose-600 font-bold' : 'text-amber-700 font-semibold'}">已等待 ${waitingDays} 天</span>`
                    : `<span class="text-slate-500">課日未到（${lesson.date}）</span>`;
                return `
                    <div class="flex flex-col md:flex-row md:items-center justify-between gap-2 bg-white/80 border border-amber-200 rounded-lg p-2.5 text-xs">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-bold text-slate-800">${lesson.studentName}</span>
                            <span class="text-slate-500">(${lesson.studentId})</span>
                            <span class="text-slate-600">原課 ${lesson.date} ${lesson.time}</span>
                            <span class="bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded text-[10px] font-bold">${lesson.leaveType}</span>
                            ${lesson.isMakeup ? '<span class="bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded text-[10px] font-bold" title="此課本身是補堂課（鏈式請假）">MU 鏈</span>' : ''}
                            ${waitHtml}
                        </div>
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <input type="date" id="poolDate_${id}" class="p-1 border rounded bg-white">
                            <input type="time" id="poolTime_${id}" value="${lesson.time}" class="p-1 border rounded bg-white">
                            <button onclick="submitMakeup('${id}','poolDate_${id}','poolTime_${id}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold">排補堂</button>
                            ${lesson.phone ? `<button onclick="openWhatsAppMessage('${id}', 'leave')" class="px-2.5 py-1 bg-green-100 hover:bg-green-200 text-green-800 rounded font-semibold" title="WhatsApp 跟進"><i class="fa-brands fa-whatsapp"></i></button>` : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        function togglePendingPool() {
            const list = document.getElementById('pendingPoolList');
            const chevron = document.getElementById('pendingPoolChevron');
            list.classList.toggle('hidden');
            if (chevron) chevron.classList.toggle('fa-chevron-down');
            if (chevron) chevron.classList.toggle('fa-chevron-up');
        }

        function onBatchMonthChange() {
            // v2：切換月份只切換「檢視」，從 localStorage 讀該月資料，絕不自動重新生成（v1 會自動重生成導致狀態丟失）
            renderBatchCheckboxes();
            rebuildMonthContext();
            renderAll();
        }

        function renderStudentTable() {
            const tbody = document.getElementById('studentTableBody');
            const search = document.getElementById('dbSearch').value.toLowerCase().trim();
            tbody.innerHTML = '';

            studentDatabase.forEach((student, index) => {
                const myGroups = groupsOfStudent(student.id);
                const matchSearch = !search || 
                    student.name.toLowerCase().includes(search) || 
                    student.id.toLowerCase().includes(search) || 
                    (student.phone && student.phone.includes(search)) ||
                    (student.email && student.email.toLowerCase().includes(search)) ||
                    student.tutor.toLowerCase().includes(search) || 
                    student.program.toLowerCase().includes(search) ||
                    myGroups.some(g => g.name.toLowerCase().includes(search));

                if (!matchSearch) return;
                const hasSlot = hasIndividualSlot(student);
                // 報讀項目：個別課一行＋每個所屬小組一行（一人可同時多項）
                const enrollments = [];
                if (hasSlot) enrollments.push(`<div><span class="bg-sky-100 text-sky-800 px-1.5 py-0.5 rounded text-[10px] font-bold">個別</span> ${student.program} · ${student.level}（${student.type}）逢 ${getWeekdayName(student.weekday)} ${student.time} · ${student.tutor}</div>`);
                myGroups.forEach(g => enrollments.push(`<div><span class="bg-indigo-100 text-indigo-800 px-1.5 py-0.5 rounded text-[10px] font-bold"><i class="fa-solid fa-user-group"></i> 小組</span> <b>${g.name}</b>（×${(g.memberIds || []).length}）逢 ${getWeekdayName(g.weekday)} ${g.time} · ${g.tutor}</div>`));
                if (!enrollments.length) enrollments.push('<span class="text-amber-600">尚未報讀任何課程</span>');

                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-50 transition";
                tr.innerHTML = `
                    <td class="p-3 font-bold text-slate-800">${student.id}</td>
                    <td class="p-3 font-semibold text-slate-900">${student.name}</td>
                    <td class="p-3 font-mono text-slate-700">
                        ${student.phone ? `<a href="tel:${student.phone}" class="hover:text-sky-600 flex items-center gap-1"><i class="fa-solid fa-phone text-slate-400 text-[10px]"></i> ${student.phone}</a>` : '<span class="text-slate-300">-</span>'}
                    </td>
                    <td class="p-3 text-slate-600">
                        ${student.email ? `<a href="mailto:${student.email}" class="hover:text-sky-600 flex items-center gap-1"><i class="fa-solid fa-envelope text-slate-400 text-[10px]"></i> ${student.email}</a>` : '<span class="text-slate-300">-</span>'}
                    </td>
                    <td class="p-3">${hasSlot ? `${student.program} - ${student.level}` : '<span class="text-slate-400">—</span>'}</td>
                    <td class="p-3"><span class="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full text-[11px] font-medium">${hasSlot ? student.type : '只上小組'}</span></td>
                    <td class="p-3 font-medium text-sky-700">${student.tutor}</td>
                    <td class="p-3 font-medium space-y-1">${enrollments.join('')}</td>
                    <td class="p-3 text-right whitespace-nowrap">
                        <button onclick="scheduleStudentFromDb(${index})" class="text-sky-600 hover:text-sky-800 px-2 py-1 font-semibold hover:bg-sky-50 rounded-lg transition" title="調整常規時間／升班（含撞堂預覽）">
                            <i class="fa-solid fa-clock"></i> 改時間/升班
                        </button>
                        <button onclick="openStudentModal(${index})" class="text-amber-600 hover:text-amber-800 px-2 py-1 font-semibold hover:bg-amber-50 rounded-lg transition" title="編輯學生與電話電郵">
                            <i class="fa-solid fa-pen-to-square"></i> 編輯
                        </button>
                        <button onclick="deleteStudentFromDb(${index})" class="text-rose-600 hover:text-rose-800 px-2 py-1 font-semibold hover:bg-rose-50 rounded-lg transition" title="刪除學生">
                            <i class="fa-solid fa-trash"></i> 刪除
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            renderGroupTable();
        }

        // 學生名單庫下方的小組班清單（建立／編輯在 groupModal）
        function renderGroupTable() {
            const tbody = document.getElementById('groupTableBody');
            if (!tbody) return;
            const cnt = document.getElementById('groupCount');
            if (cnt) cnt.textContent = groupClasses.length;
            tbody.innerHTML = groupClasses.map(g => {
                const members = (g.memberIds || []).map(id => {
                    const s = studentDatabase.find(x => x.id === id);
                    return s ? `${s.name}` : `<span class="text-rose-500" title="學生資料已不存在">${id}</span>`;
                });
                return `<tr class="hover:bg-slate-50 transition">
                    <td class="p-3 font-bold text-slate-800">${g.id}</td>
                    <td class="p-3 font-semibold text-indigo-800"><i class="fa-solid fa-user-group text-indigo-400 mr-1"></i>${escapeHtml(g.name)}</td>
                    <td class="p-3">${escapeHtml(g.program || '')} ${g.level ? '- ' + escapeHtml(g.level) : ''}</td>
                    <td class="p-3 font-medium text-sky-700">${g.tutor}</td>
                    <td class="p-3 font-medium">逢 ${getWeekdayName(g.weekday)} ${g.time}（${g.duration || 60} 分鐘）</td>
                    <td class="p-3"><span class="font-bold">${members.length}</span> 人：${members.join('、') || '<span class="text-amber-600">尚無成員</span>'}</td>
                    <td class="p-3 text-right whitespace-nowrap">
                        <button onclick="openGroupModal('${g.id}')" class="text-amber-600 hover:text-amber-800 px-2 py-1 font-semibold hover:bg-amber-50 rounded-lg transition" title="編輯成員／時段／導師"><i class="fa-solid fa-pen-to-square"></i> 編輯</button>
                    </td>
                </tr>`;
            }).join('') || '<tr><td colspan="7" class="p-3 text-slate-400 italic">尚無小組班，按上方「+ 新增小組」建立。</td></tr>';
        }

        // 原「前往單獨排堂」跳第二頁籤；頁籤合併後直接開快速編輯彈窗
        function scheduleStudentFromDb(index) {
            openQuickEdit(index);
        }

        function deleteStudentFromDb(index) {
            const s = studentDatabase[index];
            if (confirm(`確定要刪除學生「${s.name} (${s.id})」嗎？`)) {
                pushHistory(`刪除學生：${s.name}（${s.id}）`);
                studentDatabase.splice(index, 1);
                groupClasses.forEach(g => { g.memberIds = (g.memberIds || []).filter(m => m !== s.id); });
                persistGroups();
                saveToLocalStorage();
                renderBatchCheckboxes();
                renderStudentTable();
            }
        }

        function openStudentModal(editIdx = -1) {
            const modal = document.getElementById('studentModal');
            const title = document.getElementById('modalTitle');
            document.getElementById('editStudentIndex').value = editIdx;
            let oldIdEl = document.getElementById('editStudentOldId');
            if (!oldIdEl) { oldIdEl = document.createElement('input'); oldIdEl.type = 'hidden'; oldIdEl.id = 'editStudentOldId'; modal.appendChild(oldIdEl); }
            oldIdEl.value = editIdx >= 0 ? studentDatabase[editIdx].id : '';

            if (editIdx >= 0) {
                const s = studentDatabase[editIdx];
                title.innerHTML = `<i class="fa-solid fa-user-pen text-amber-500"></i> 編輯學生資料 (ID: ${s.id})`;
                document.getElementById('modalId').value = s.id;
                document.getElementById('modalName').value = s.name;
                document.getElementById('modalPhone').value = s.phone || '';
                document.getElementById('modalEmail').value = s.email || '';
                populateTutorSelects();
                document.getElementById('modalTutor').value = s.tutor || (allTutorNames()[0] || '');
                document.getElementById('modalWeekday').value = hasIndividualSlot(s) ? s.weekday : '';
                document.getElementById('modalTime').value = s.time || '';
                // 費率欄位：舊資料的組合不在費率表時會被修正成第一個可選（儲存後即為修正值）
                renderStudentFeeSelects({ tutorLevel: s.tutorLevel || advancedTutor(s), program: s.program, level: s.level, type: s.type, duration: s.duration });
                renderModalGroups(s.id);
            } else {
                title.innerHTML = `<i class="fa-solid fa-user-plus text-emerald-500"></i> 新增學生資料`;
                document.getElementById('modalId').value = '';
                document.getElementById('modalName').value = '';
                document.getElementById('modalPhone').value = '';
                document.getElementById('modalEmail').value = '';
                populateTutorSelects();
                document.getElementById('modalTutor').value = allTutorNames()[0] || '';
                document.getElementById('modalWeekday').value = 1;
                document.getElementById('modalTime').value = '16:00';
                renderStudentFeeSelects({ tutorLevel: tutorTier(allTutorNames()[0]) || '普通導師', program: 'Pop Guitar', level: 'Elementary 初級', type: '一對一', duration: 45 });
                renderModalGroups(null);
            }

            modal.classList.remove('hidden');
            markModalOpened('studentModal');
        }

        // 學生弹窗內的「所屬小組」勾選（儲存時同步各小組的 memberIds）
        function renderModalGroups(studentId) {
            const box = document.getElementById('modalGroups');
            if (!box) return;
            box.innerHTML = groupClasses.map(g => `<label class="flex items-center gap-1.5 bg-white px-2 py-1 rounded-lg border border-slate-200 cursor-pointer">
                <input type="checkbox" class="modal-group-chk accent-indigo-600" value="${g.id}" ${studentId && (g.memberIds || []).indexOf(studentId) !== -1 ? 'checked' : ''}>
                <span><b>${g.name}</b> <span class="text-slate-400">${getWeekdayName(g.weekday)} ${g.time}</span></span></label>`).join('')
                || '<span class="text-slate-400 italic text-[11px]">尚無小組班（本頁右上「+ 新增小組」）</span>';
        }

        // ===== 學生表單費率連動：導師級別 → 課程 → 級別 → 上課形式 → 時長，只能選費率表有定價的組合；每堂學費唯讀自動帶出 =====
        // 資料來源 art-rate-data.js rateTable；查價／連動邏輯在 lib/rates.js（GACRates）。價格不落學生記錄，每次按組合查表。
        const FEE_SELECT_IDS = { tutorLevel: 'modalTutorLevel', program: 'modalProgram', level: 'modalLevel', type: 'modalType', duration: 'modalDuration' };

        function fillSelect(el, values, current, labelFn) {
            el.innerHTML = values.map(v => `<option value="${escapeHtml(String(v))}">${escapeHtml(labelFn ? labelFn(v) : String(v))}</option>`).join('');
            el.value = String(current);
        }

        function readFeeSelection() {
            const sel = {};
            Object.keys(FEE_SELECT_IDS).forEach(k => {
                const el = document.getElementById(FEE_SELECT_IDS[k]);
                sel[k] = el ? el.value : '';
            });
            return sel;
        }

        // initial 省略時讀取目前下拉值（onchange 路徑）；上游改變後下游自動修正為合法值
        function renderStudentFeeSelects(initial) {
            const res = GACRates.resolve(rateTable, initial || readFeeSelection());
            Object.keys(FEE_SELECT_IDS).forEach(k => {
                const el = document.getElementById(FEE_SELECT_IDS[k]);
                if (!el) return;
                const labelFn = k === 'type' ? GACRates.studentTypeToClassType : (k === 'duration' ? (v => `${v} 分鐘`) : null);
                fillSelect(el, res.options[k], res.sel[k], labelFn);
            });
            const rateEl = document.getElementById('modalRate');
            if (rateEl) rateEl.textContent = res.rate !== null ? `$${Number(res.rate).toLocaleString('en-US')} / 堂` : '—（費率表無此組合）';
            return res;
        }

        function closeStudentModal() {
            document.getElementById('studentModal').classList.add('hidden');
        }

        function saveStudentFromModal() {
            const editIdx = parseInt(document.getElementById('editStudentIndex').value);
            const id = document.getElementById('modalId').value.trim();
            const name = document.getElementById('modalName').value.trim();
            const phone = document.getElementById('modalPhone').value.trim();
            const email = document.getElementById('modalEmail').value.trim();
            const type = document.getElementById('modalType').value;
            const program = document.getElementById('modalProgram').value.trim();
            const level = document.getElementById('modalLevel').value.trim();
            const tutor = document.getElementById('modalTutor').value;
            const tutorLevel = document.getElementById('modalTutorLevel').value;
            const weekdayRaw = document.getElementById('modalWeekday').value;
            const weekday = weekdayRaw === '' ? null : parseInt(weekdayRaw); // null＝無個別課（只上小組）
            const time = weekday === null ? '' : document.getElementById('modalTime').value;
            const duration = parseInt(document.getElementById('modalDuration').value);
            const chosenGroups = [...document.querySelectorAll('.modal-group-chk')].filter(c => c.checked).map(c => c.value);

            if (!id || !name) {
                alert('請完整填寫學生 ID 與姓名！');
                return;
            }
            if (weekday !== null && !time) {
                alert('請填寫上課時間，或把常規星期選為「無個別課（只上小組）」！');
                return;
            }
            if (GACRates.findRate(rateTable, { tutorLevel, program, level, type, duration }) === null) {
                alert('費率表沒有這個組合（導師級別／課程／級別／授課形式／時長）的定價，請重新選擇。');
                return;
            }

            pushHistory(`${editIdx >= 0 ? '編輯' : '新增'}學生：${name}（${id}）`);
            if (editIdx >= 0) {
                // Update Existing Student
                const student = studentDatabase[editIdx];
                student.id = id;
                student.name = name;
                student.phone = phone;
                student.email = email;
                student.type = type;
                student.program = program;
                student.level = level;
                student.tutor = tutor;
                student.tutorLevel = tutorLevel;
                student.weekday = weekday;
                student.time = time;
                student.duration = duration;

                showToast(`✅ 已更新學生 ${name}（${id}）`);
            } else {
                // Add New Student
                studentDatabase.push({
                    id, name, phone, email, type, program, level, duration, tutor, tutorLevel, weekday, time,
                    effectiveMonth: "", futureWeekday: null, futureTime: ""
                });

                showToast(`✅ 已新增學生 ${name}（${id}）`);
            }

            // 同步小組成員：勾選的小組加入此學生、未勾選的移除（含改 id 的情況）
            const oldId = editIdx >= 0 ? (document.getElementById('editStudentOldId')?.value || id) : null;
            groupClasses.forEach(g => {
                g.memberIds = (g.memberIds || []).filter(m => m !== id && m !== oldId);
                if (chosenGroups.indexOf(g.id) !== -1) g.memberIds.push(id);
            });
            persistGroups();

            saveToLocalStorage();
            renderBatchCheckboxes();
            renderStudentTable();
            closeStudentModal();
        }

        // lesson → 匯出用事件（Date 在此重建；UID 用 lessonId 保證導入查重）
        function lessonToExportEvent(lesson) {
            return {
                title: GACSchedule.lessonTitle(lesson),
                studentId: lesson.studentId,
                studentName: lesson.studentName,
                tutor: lesson.tutor,
                phone: lesson.phone,
                email: lesson.email,
                start: lessonStart(lesson),
                end: lessonEnd(lesson),
                status: lesson.status,
                leaveType: lesson.leaveType,
                isMakeup: lesson.isMakeup,
                uid: `${lesson.lessonId}@guitaristic`,
                location: getLocationText(lesson)
            };
        }

        // 檔名的片段：去掉空白與檔名不能用的字元，保留中英數與連字號
        function icsNamePart(text) {
            return String(text || '').trim().replace(/\s+/g, '-').replace(/[\\/:*?"<>|]+/g, '').slice(0, 40);
        }

        // 導出檔名：Guitaristic_2026-09_Instructor-A.ics（有選學生／小組再多一段）
        function icsFileName(monthKey, f) {
            const parts = ['Guitaristic', monthKey || 'schedule'];
            parts.push(f.tutor !== 'ALL' ? icsNamePart(f.tutor) : 'All-Tutors');
            if (f.student !== 'ALL') {
                if (f.student.indexOf('G:') === 0) {
                    const g = findGroup(f.student.slice(2));
                    parts.push(icsNamePart(g ? g.name : f.student.slice(2)));
                } else {
                    const s = studentDatabase.find(x => x.id === f.student);
                    parts.push(icsNamePart(s ? s.id + '-' + s.name : f.student));
                }
            }
            return parts.filter(Boolean).join('_') + '.ics';
        }

        // 導出目前檢視月份的課；**只導出導師／學生篩選範圍內的課**，這樣檔名寫的導師才跟內容一致
        function downloadMasterICS() {
            const monthKey = currentMonthKey();
            const f = scheduleFilterValues();
            const lessons = sortedMonthLessons().filter(l => lessonMatchesScheduleFilters(l, f));
            if (lessons.length === 0) {
                alert(scheduleFilterLabel()
                    ? `目前篩選範圍（${scheduleFilterLabel()}）內沒有可匯出的課堂。\n取消篩選可匯出整月。`
                    : '目前沒有已生成的課堂可匯出！');
                return;
            }
            const name = icsFileName(monthKey, f);
            buildICSFile(lessons.map(lessonToExportEvent), name);
            showToast(`📅 已匯出 ${lessons.length} 堂（${scheduleFilterLabel() || '全部導師'}）→ ${name}`);
        }

        // Keep the original export function name available for existing links or bookmarks.
        function exportMasterICS() { downloadMasterICS(); }

        function buildICSFile(events, filename) {
            let icsContent = [
                "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Demo Music Academy//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"
            ];

            const formatICSDate = (d) => d.getFullYear() +
                String(d.getMonth() + 1).padStart(2, '0') +
                String(d.getDate()).padStart(2, '0') + 'T' +
                String(d.getHours()).padStart(2, '0') +
                String(d.getMinutes()).padStart(2, '0') + '00';

            events.forEach(ev => {
                let desc = "Demo Music Academy Lesson";
                if (ev.phone) desc += `\\nPhone: ${ev.phone}`;
                if (ev.email) desc += `\\nEmail: ${ev.email}`;

                // UID 必須存在且確定性：Google 依 UID 查重，重複導入同一檔案不會產生重複事件（P0-2）
                const uid = ev.uid || `${String(ev.title || 'event').replace(/[^A-Za-z0-9]/g, '')}-${formatICSDate(ev.start)}@guitaristic`;

                icsContent.push(
                    "BEGIN:VEVENT",
                    `UID:${uid}`,
                    `SUMMARY:${ev.title}`,
                    `DTSTART:${formatICSDate(ev.start)}`,
                    `DTEND:${formatICSDate(ev.end)}`,
                    `DESCRIPTION:${desc}`
                );
                if (ev.location) icsContent.push(`LOCATION:${ev.location}`);
                icsContent.push("STATUS:CONFIRMED", "END:VEVENT");
            });

            icsContent.push("END:VCALENDAR");

            const blob = new Blob([icsContent.join("\r\n")], { type: "text/calendar;charset=utf-8" });
            const link = document.createElement("a");
            link.href = window.URL.createObjectURL(blob);
            link.setAttribute("download", filename);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        // JSON 備份/還原（v2 全量：students + lessons + sendlog + settings；匯入帶 schema 版本檢查）
        function exportJSONDatabase() {
            const payload = GACStorage.buildExportPayload({
                students: studentDatabase, groups: groupClasses, lessons: lessonsByMonth, sendlog: sendLog, settings: appSettings,
                tutors: tutorsList, rateOverrides: rateOverrides
            });
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 2));
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute("href", dataStr);
            downloadAnchor.setAttribute("download", `Guitaristic_Full_Backup_${new Date().toISOString().slice(0,10)}.json`);
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
        }

        // 套用已解析的匯入內容（全量或舊版僅學生）。回傳是否實際套用。
        function applyImportedPayload(res) {
            if (res.legacy) {
                if (!confirm('偵測到舊版備份（僅含學生名單）。\n將取代現有學生名單；課表／發送紀錄／設定不受影響。繼續？')) return false;
                pushHistory('還原備份：舊版學生名單');
                studentDatabase = res.students;
                gacStore.saveStudents(studentDatabase);
            } else {
                if (!confirm('全量還原將「覆蓋」現有的：學生名單、課表（含狀態與補堂鏈）、發送紀錄、設定。\n建議先按「全量備份」保存現狀。確定還原？')) return false;
                pushHistory('還原備份：全量');
                studentDatabase = res.students;
                groupClasses = res.groups || [];
                lessonsByMonth = res.lessons;
                sendLog = res.sendlog;
                appSettings = Object.assign({}, GACStorage.DEFAULT_SETTINGS, res.settings);
                if (Array.isArray(res.tutors) && res.tutors.length) { tutorsList = res.tutors; persistTutors(); } // v2 備份無名單 → 保留現有
                rateOverrides = (res.rateOverrides && typeof res.rateOverrides === 'object') ? res.rateOverrides : {};
                applyRateOverridesToTable();
                persistRateOverrides();
                gacStore.saveStudents(studentDatabase);
                persistGroups();
                gacStore.saveLessons(lessonsByMonth);
                gacStore.saveSendlog(sendLog);
                gacStore.saveSettings(appSettings);
            }
            renderBatchCheckboxes();
            renderStudentTable();
            populateTutorSelects();
            renderTutorManagementList();
            renderRateTableEditor();
            rebuildMonthContext();
            loadSettingsForm();
            renderAll();
            return true;
        }

        function importJSONDatabase(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            const fileReader = new FileReader();
            fileReader.onload = function(e) {
                const res = GACStorage.parseImportPayload(e.target.result);
                if (!res.ok) { alert('⚠️ ' + res.error); return; }
                if (applyImportedPayload(res)) {
                    showToast(res.legacy ? '✅ 已匯入學生名單（舊版格式）' : '✅ 全量還原完成（學生／小組／課表／發送紀錄／設定）');
                }
            };
            fileReader.readAsText(file);
            event.target.value = ''; // 清空 input，允許重複選同一檔案
        }

        function resetToDefaultData() {
            if (confirm('確定要恢復預設學生名單（含預設小組班）嗎？')) {
                pushHistory('恢復預設學生名單與小組班');
                studentDatabase = [...defaultStudents];
                groupClasses = (typeof defaultGroups !== 'undefined' ? defaultGroups : []).map(g => Object.assign({}, g, { memberIds: (g.memberIds || []).slice() }));
                persistGroups();
                saveToLocalStorage();
                renderBatchCheckboxes();
                renderStudentTable();
                showToast('✅ 已恢復預設學生名單與小組班');
            }
        }

        // ===== 課堂訊息（請假確認／補堂確認／改期通知）：文案在設定頁「訊息模板」，留空用預設；顯示時才組成 =====
        function msgTpl(key) {
            const c = (typeof appSettings !== 'undefined' && appSettings) || {};
            return c[key] || GACStorage.DEFAULT_SETTINGS[key];
        }

        function dateLabel(dateStr) {
            const p = String(dateStr || '').split('-').map(Number);
            return p.length === 3 && p[0] ? `${p[0]}年${p[1]}月${p[2]}日` : String(dateStr || '');
        }

        function weekdayOfDate(dateStr) {
            const p = String(dateStr || '').split('-').map(Number);
            return p.length === 3 && p[0] ? getWeekdayName(new Date(p[0], p[1] - 1, p[2]).getDay()) : '—';
        }

        // {date}＝2026年9月16日 {weekday}＝星期三 {time} {name} {id} {tutor} {program} {level}
        function lessonVars(lesson) {
            return {
                date: dateLabel(lesson.date), weekday: weekdayOfDate(lesson.date), time: lesson.time || '',
                name: lesson.studentName || lesson.studentId || '', id: lesson.studentId || '',
                tutor: lesson.tutor || '', program: lesson.program || '', level: lesson.level || ''
            };
        }

        function leaveMsgFor(lesson) { return GACSendlog.fillTemplate(msgTpl('tplLeave'), lessonVars(lesson)); }
        function makeupMsgFor(lesson) { return GACSendlog.fillTemplate(msgTpl('tplMakeup'), lessonVars(lesson)); }

        // 改期通知：{fromDate}/{fromWeekday}/{fromTime} 來自條目快照（改期前），{date}/{time} 讀課堂現值
        function moveMsgFor(entry, lesson) {
            const v = lessonVars(lesson);
            v.fromDate = dateLabel(entry.fromDate); v.fromWeekday = weekdayOfDate(entry.fromDate); v.fromTime = entry.fromTime || '';
            return GACSendlog.fillTemplate(msgTpl('tplMove'), v);
        }

        // 訊息弹窗／WhatsApp 用：type 'leave' | 'makeup' | 'move'（改期用該課的 MOVE_CONFIRM 條目；沒有則退回補堂確認）
        function lessonMsgByType(type, lesson) {
            if (type === 'leave') return leaveMsgFor(lesson);
            if (type === 'move') {
                const e = sendLog['MOVE_CONFIRM:' + lesson.lessonId];
                return e ? moveMsgFor(e, lesson) : makeupMsgFor(lesson);
            }
            return makeupMsgFor(lesson);
        }

        function copyLessonMsg(type, lessonId) {
            const found = GACLessonState.findLesson(lessonsByMonth, lessonId);
            if (found) copyToClipboard(lessonMsgByType(type, found.lesson));
        }

        // 學費訊息模板（文案常量，方便修改；{month}=yyyy年m月、{m}=月份數字、{name}=學生）
        // 每個報讀項目（個別課／各小組）一段明細：日期 逢星期／時間起訖／級別／上課形式／導師／每堂學費／堂數／合共；
        // 多於一項時最後加「總額」。金額以條目的 amount 為準（手改過的金額照樣反映在訊息裡）。
        // 開頭／總額／結尾三段可在設定頁「訊息模板」改；預設值在 lib/storage.js DEFAULT_SETTINGS
        function tuitionTpl() {
            return { header: msgTpl('tplTuitionHeader'), total: msgTpl('tplTuitionTotal'), footer: msgTpl('tplTuitionFooter') };
        }

        function tuitionMoney(n) { return '$' + Number(n || 0).toLocaleString('en-US'); }

        // 上課形式顯示名：學生資料的「一對一」「2人小組」／小組課的「5人小組」→ 學費單用語
        function tuitionClassTypeLabel(t) {
            const s = String(t || '');
            if (/Individual|一對一/.test(s)) return '一對一個別授課 Individual';
            const m = /^(\d+(?:-\d+)?)人小組/.exec(s);
            return m ? `${m[1]}人小組授課` : s;
        }

        function tuitionItemLines(it, subtotal) {
            const lines = [];
            const dayOf = d => String(Number(String(d).split('-')[2]));
            if (it.weekday !== null && it.weekday !== undefined && it.time) {
                lines.push(`日期：${(it.dates || []).map(dayOf).join(', ')} 逢${getWeekdayName(it.weekday)}`);
                lines.push(`時間：${it.time}-${it.endTime}（${it.duration} mins）`);
            } else {
                // 同一項目內時段不一（如某堂經 Calendar 改時）或舊條目無明細：逐堂列「月/日 時間」
                lines.push('日期：' + (it.dates || []).map((d, i) => {
                    const p = String(d).split('-');
                    return `${Number(p[1])}/${Number(p[2])} ${(it.times || [])[i] || ''}`.trim();
                }).join('、'));
            }
            if (it.program || it.level) lines.push(`級別：${[it.program, it.level].filter(Boolean).join(' ')}`);
            if (it.classType) lines.push(`上課形式：${tuitionClassTypeLabel(it.classType)}${it.groupName ? `（${it.groupName}）` : ''}`);
            if (it.tutor) lines.push(`導師：${it.tutor}`);
            if (it.rate !== null && it.rate !== undefined) lines.push(`每堂學費：${tuitionMoney(it.rate)}`);
            lines.push(`堂數：${it.count} 堂`);
            lines.push(`合共：${tuitionMoney(subtotal)}`);
            return lines.join('\n');
        }

        function tuitionMsgFor(entry) {
            const parts = String(entry.month || '').split('-').map(Number);
            const monthLabel = parts.length === 2 ? `${parts[0]}年${parts[1]}月` : entry.month;
            const m = parts.length === 2 ? String(parts[1]) : String(entry.month || '');
            // 舊條目（生成時尚無明細）：以日期／堂數／金額組一段
            const items = (entry.items && entry.items.length) ? entry.items
                : [{ dates: entry.dates || [], count: entry.count, subtotal: entry.amount, weekday: null, rate: null }];
            const single = items.length === 1;
            const blocks = items.map(it => tuitionItemLines(it, single ? entry.amount : it.subtotal));
            const T = tuitionTpl();
            const vars = { month: monthLabel, m: m, name: entry.studentName || entry.studentId, id: entry.studentId || '', amount: tuitionMoney(entry.amount) };
            const out = [GACSendlog.fillTemplate(T.header, vars)];
            out.push(blocks.join('\n\n'));
            if (!single) out.push(GACSendlog.fillTemplate(T.total, vars));
            if (T.footer && T.footer.trim()) out.push(GACSendlog.fillTemplate(T.footer, vars));
            // 尾段（設定頁）：FPS ID／附註／學員守則連結，填了才出現
            const cfg = (typeof appSettings !== 'undefined' && appSettings) || {};
            const tail = [];
            if (cfg.fpsId) tail.push(`FPS 轉數快 ID：${cfg.fpsId}`);
            if (cfg.feeNotice) tail.push(cfg.feeNotice);
            if (cfg.infoUrl) tail.push(`學員守則及請假須知，請瀏覽：${cfg.infoUrl}`);
            if (tail.length) out.push(tail.join('\n'));
            return out.join('\n\n');
        }

        // 發送中心卡片的堂數標籤：多個報讀項目時逐項列（個別課 4 堂＋樂理 Grade 5 小組 4 堂）
        function tuitionCountLabel(e) {
            return (e.items && e.items.length > 1)
                ? e.items.map(it => `${it.groupName || '個別課'} ${it.count} 堂`).join('＋')
                : `${e.count} 堂`;
        }

        // 發送中心條目 → 訊息文字（學費按模板；自定義用建立時定稿的快照；請假/補堂重用課堂訊息）
        function sendlogMsgFor(entry) {
            if (entry.type === 'TUITION') return tuitionMsgFor(entry);
            if (entry.type === 'CUSTOM') return entry.message || '';
            if (DERIVED_TYPES.has(entry.type)) return derivedMsgFor(entry);
            const f = GACLessonState.findLesson(lessonsByMonth, entry.lessonId);
            if (!f) return '（原課堂已不存在，此條目僅留作歷史紀錄）';
            if (entry.type === 'MOVE_CONFIRM') return moveMsgFor(entry, f.lesson);
            return entry.type === 'LEAVE_CONFIRM' ? leaveMsgFor(f.lesson) : makeupMsgFor(f.lesson);
        }

        // ===== 發送中心：雙欄（待發送/已發送），按月獨立。開 WhatsApp 不會自動移欄，必須手動標記已發 =====
        const SEND_TYPE_META = {
            TUITION: { label: '學費', cls: 'bg-emerald-100 text-emerald-700' },
            LEAVE_CONFIRM: { label: '請假確認', cls: 'bg-amber-100 text-amber-700' },
            MAKEUP_CONFIRM: { label: '補堂確認', cls: 'bg-sky-100 text-sky-700' },
            MOVE_CONFIRM: { label: '改期通知', cls: 'bg-orange-100 text-orange-700' },
            CUSTOM: { label: '自定義', cls: 'bg-violet-100 text-violet-700' },
            PAY_REMIND: { label: '催繳', cls: 'bg-rose-100 text-rose-700' },
            RECEIPT: { label: '收款確認', cls: 'bg-teal-100 text-teal-700' }
        };

        // ===== 催繳／收款確認：由學費條目的繳費狀態派生（lib/sendlog.js syncDerived），每次渲染同步 =====
        const DERIVED_TYPES = new Set(['PAY_REMIND', 'RECEIPT']);

        function derivedCfg() {
            const cfg = (typeof appSettings !== 'undefined' && appSettings) || {};
            const D = GACStorage.DEFAULT_SETTINGS;
            return {
                remindAuto: cfg.remindAuto !== false, remindDays: Number(cfg.remindDays) > 0 ? Number(cfg.remindDays) : D.remindDays,
                receiptAuto: cfg.receiptAuto !== false,
                remindMsg: cfg.remindMsg || D.remindMsg, receiptMsg: cfg.receiptMsg || D.receiptMsg, fpsId: cfg.fpsId || ''
            };
        }

        // 幂等；有增減才落盤。不拍快照——派生條目由學費條目狀態決定，撤銷學費操作後重新渲染會自行對齊
        function syncDerivedEntries() {
            const c = derivedCfg();
            const r = GACSendlog.syncDerived(sendLog, { now: new Date().toISOString(), remindAuto: c.remindAuto, remindDays: c.remindDays, receiptAuto: c.receiptAuto });
            if (r.created.length || r.removed.length) persistSendlog();
            return r;
        }

        // 模板＋學費條目現值即時組成（部分繳交後「未繳」金額隨之更新）
        function derivedMsgFor(entry) {
            const t = sendLog[entry.tuitionKey];
            if (!t) return '（原學費條目已不存在，此條目僅留作歷史紀錄）';
            const c = derivedCfg();
            return GACSendlog.fillTemplate(entry.type === 'RECEIPT' ? c.receiptMsg : c.remindMsg,
                GACSendlog.paymentVars(t, { methodNames: payMethodNames(), fpsId: c.fpsId }));
        }

        // 催繳／收款確認卡片的資訊列：對應學費條目的應收／已收／未繳與繳費徽章
        function derivedInfoRow(e) {
            if (!DERIVED_TYPES.has(e.type)) return '';
            const t = sendLog[e.tuitionKey];
            if (!t) return '<div class="text-slate-400 italic">原學費條目已不存在</div>';
            const due = Number(t.amount) || 0, got = t.paid ? (Number(t.paidAmount) || 0) : 0;
            const sentOn = t.sentAt ? String(t.sentAt).slice(0, 10) : '';
            const info = e.type === 'PAY_REMIND'
                ? `<span>學費單${sentOn ? ' ' + sentOn + ' 發出' : ''} · 應收 ${tuitionMoney(due)} · 已收 ${tuitionMoney(got)} · <b class="text-rose-600">未繳 ${tuitionMoney(Math.max(0, due - got))}</b></span>`
                : `<span>學費單 ${t.month}</span>`;
            return `<div class="flex items-center gap-2 flex-wrap text-slate-500">${info} ${paymentBadge(t)}</div>`;
        }

        // 「不用發」：刪除派生條目並記下略過（學費單移回待發／取消已繳後會重置，見 lib）
        function sendDismissDerived(key) {
            const e = sendLog[key];
            if (!e || !DERIVED_TYPES.has(e.type)) return;
            const label = (SEND_TYPE_META[e.type] || { label: e.type }).label;
            if (!confirm(`${e.studentName || e.studentId} 的「${label}」這次不用發？\n（刪除此條目；該學生此月不會再自動建立）`)) return;
            pushHistory(`不用發${label}：${e.studentName || e.studentId} ${e.month}`);
            GACSendlog.dismissDerived(sendLog, key);
            persistSendlog();
            renderSendCenter();
            renderPaymentTab();
        }

        // 訊息內文預設收起（整欄太長）：收起時只顯示首行摘要；個別條目的開合記在 Map，頁首可一鍵全部展開／收起
        const sendMsgOpen = new Map();
        let sendMsgDefaultOpen = false;

        function sendMsgIsOpen(key) {
            return sendMsgOpen.has(key) ? sendMsgOpen.get(key) : sendMsgDefaultOpen;
        }

        function toggleSendMsg(key) {
            sendMsgOpen.set(key, !sendMsgIsOpen(key));
            renderSendCenter();
        }

        // 一鍵全部：改預設值並清掉個別覆寫
        function sendMsgSetAll(open) {
            sendMsgDefaultOpen = !!open;
            sendMsgOpen.clear();
            renderSendCenter();
        }

        function toggleSendMsgAll() { sendMsgSetAll(!sendMsgDefaultOpen); }

        function sendMsgBlock(e, msg) {
            const open = sendMsgIsOpen(e.key);
            const key = jsStrAttr(e.key);
            const lines = String(msg || '').split('\n').filter(x => x.trim());
            const first = lines[0] || '（無內容）';
            const preview = first.length > 40 ? first.slice(0, 40) + '…' : first;
            return `<div class="bg-slate-50 border border-slate-200 rounded-lg">
                    <button onclick="toggleSendMsg('${key}')" class="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-slate-100 rounded-lg" title="${open ? '收起訊息內文' : '展開訊息內文'}">
                        <i class="fa-solid fa-chevron-${open ? 'down' : 'right'} text-slate-400 text-[10px] shrink-0"></i>
                        <span class="font-semibold text-slate-600 shrink-0">訊息</span>
                        ${open ? '' : `<span class="text-slate-500 truncate">${escapeHtml(preview)}</span>${lines.length > 1 ? `<span class="text-slate-400 shrink-0">· ${lines.length} 行</span>` : ''}`}
                    </button>
                    ${open ? `<div class="px-2 pb-2 pt-1.5 border-t border-slate-200 text-slate-700 whitespace-pre-wrap">${escapeHtml(msg)}</div>` : ''}
                </div>`;
        }

        // 已發送欄學費卡片的繳費小表單：未繳清預設展開、已繳清收起；用戶手動切換後以此表為準（key → 開/關）
        const sendPayFormOpen = new Map();

        function sendPayFormIsOpen(e) {
            return sendPayFormOpen.has(e.key) ? sendPayFormOpen.get(e.key) : GACSendlog.paymentStatus(e) !== 'paid';
        }

        function toggleSendPayForm(key) {
            const e = sendLog[key];
            if (!e) return;
            sendPayFormOpen.set(key, !sendPayFormIsOpen(e));
            renderSendCenter();
        }

        function sendPayToggleBtn(e) {
            const open = sendPayFormIsOpen(e);
            const label = open ? '收起' : (GACSendlog.paymentStatus(e) === 'paid' ? '修改繳費' : '登記繳費');
            return `<button onclick="toggleSendPayForm('${e.key}')" class="ml-auto px-2 py-0.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-600 text-[10px] font-semibold" title="在此登記繳費（與「出席與繳費」同一筆紀錄）"><i class="fa-solid fa-${open ? 'chevron-up' : 'sack-dollar'}"></i> ${label}</button>`;
        }

        // 付款方式下拉（發送中心卡片與繳費表共用）
        function payMethodSelectHtml(e, cls) {
            const names = payMethodNames();
            return `<select onchange="payUpdate('${e.key}', { payMethod: this.value })" class="${cls}"><option value="">—</option>` +
                names.map((m, i) => `<option value="${i + 1}" ${String(e.payMethod || '') === String(i + 1) ? 'selected' : ''}>${i + 1}. ${escapeHtml(m)}</option>`).join('') + '</select>';
        }

        // 已發送欄學費卡片的繳費小表單：已繳／實收／付款方式／日期／收據，改動即存（同一條目，繳費表同步）
        function sendPayFormHtml(e) {
            if (!sendPayFormIsOpen(e)) return '';
            const k = e.key;
            const inp = 'px-1.5 py-1 border border-slate-300 rounded-lg bg-white text-[11px]';
            return `<div class="flex items-center gap-x-3 gap-y-1.5 flex-wrap bg-purple-50/60 border border-purple-100 rounded-lg px-2.5 py-1.5">
                       <label class="flex items-center gap-1 text-slate-600">實收 <input type="number" min="0" value="${Number(e.paidAmount) || 0}" onchange="payUpdate('${k}', { paidAmount: this.value })" class="${inp} w-20 text-right" title="實收金額；選了付款方式而此欄為 0 會自動填整額"></label>
                       <label class="flex items-center gap-1 text-slate-600">方式 ${payMethodSelectHtml(e, inp)}</label>
                       <label class="flex items-center gap-1 text-slate-600">日期 <input type="date" value="${e.payDate || ''}" onchange="payUpdate('${k}', { payDate: this.value })" class="${inp}"></label>
                       <label class="flex items-center gap-1 cursor-pointer text-slate-600"><input type="checkbox" ${e.receipt ? 'checked' : ''} onchange="payUpdate('${k}', { receipt: this.checked })" class="w-3.5 h-3.5 accent-sky-600" title="已發收據"> 收據</label>
                   </div>`;
        }

        function sendCenterMonth() {
            const el = document.getElementById('sendMonth');
            return (el && el.value) || currentMonthKey();
        }

        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, c =>
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        // 舊條目沒有 batchId 欄位（只藏在 key CUSTOM:<batchId>:<studentId> 裡）→ 從 key 補回
        function customBatchId(e) {
            return e.batchId || String(e.key || '').split(':')[1] || '';
        }

        // 類別下拉只列「本月實際存在」的類別；自定義按批次名稱列二級子分類（optgroup）。
        // 選中的類別若在本月已不存在（換月／被清掉）→ 回退「全部」。回傳生效的篩選值。
        function rebuildSendTypeOptions(entries) {
            const sel = document.getElementById('sendTypeFilter');
            if (!sel) return 'ALL';
            const prev = sel.value || 'ALL';
            const present = new Set(entries.map(e => e.type));
            const batches = new Map(); // batchId → title（保持建立順序）
            entries.forEach(e => {
                if (e.type !== 'CUSTOM') return;
                const bid = customBatchId(e);
                if (!batches.has(bid)) batches.set(bid, e.title || '未命名群發');
            });
            let html = '<option value="ALL">全部類別</option>';
            // 學費之下多兩個繳費狀態子篩選（未繳清＝未繳＋部分；已繳清），只列本月實際有的
            const payStates = new Set(entries.filter(e => e.type === 'TUITION').map(e => (GACSendlog.paymentStatus(e) === 'paid' ? 'paid' : 'due')));
            [['TUITION', '學費（全部）'], ['TUITION:due', '學費 · 未繳清'], ['TUITION:paid', '學費 · 已繳清'], ['LEAVE_CONFIRM', '請假確認'], ['MAKEUP_CONFIRM', '補堂確認'], ['MOVE_CONFIRM', '改期通知'], ['PAY_REMIND', '催繳'], ['RECEIPT', '收款確認']].forEach(([v, label]) => {
                const ok = v.indexOf('TUITION:') === 0 ? payStates.has(v.slice(8)) : present.has(v);
                if (ok) html += `<option value="${v}">${label}</option>`;
            });
            if (batches.size) {
                html += '<optgroup label="自定義">';
                if (batches.size > 1) html += '<option value="CUSTOM">全部自定義</option>';
                batches.forEach((title, bid) => {
                    html += `<option value="CUSTOM:${escapeHtml(bid)}">${escapeHtml(title)}</option>`;
                });
                html += '</optgroup>';
            }
            sel.innerHTML = html;
            sel.value = prev;
            if (sel.value !== prev) sel.value = 'ALL'; // 原選項已不存在
            return sel.value || 'ALL';
        }

        // 電話以學生資料庫現值優先（條目中的 phone 是建立時的快照，可能已更新）
        function sendEntryPhone(entry) {
            const stu = studentDatabase.find(s => s.id === entry.studentId);
            return (stu && stu.phone) || entry.phone || '';
        }

        function sendEntryCard(e, sent) {
            // 自定義條目的標籤帶批次名稱（「自定義：調整學費」），與類別下拉的二級分類對應
            const meta = e.type === 'CUSTOM'
                ? { label: '自定義：' + escapeHtml(e.title || '未命名群發'), cls: 'bg-violet-100 text-violet-700' }
                : (SEND_TYPE_META[e.type] || { label: e.type, cls: 'bg-slate-100 text-slate-600' });
            const phone = sendEntryPhone(e);
            const msg = sendlogMsgFor(e);
            const amountRow = e.type === 'TUITION'
                ? `<div class="flex items-center gap-2 flex-wrap">
                       <span class="text-slate-500 font-medium">金額 HK$</span>
                       <input type="number" min="0" value="${e.amount}" ${sent ? 'disabled' : ''}
                           onchange="sendSetAmount('${e.key}', this.value)"
                           class="w-24 px-2 py-1 border border-slate-300 rounded-lg ${sent ? 'bg-slate-100 text-slate-400' : ''}">
                       <span class="text-slate-400">（${tuitionCountLabel(e)}）</span>
                       ${e.amountEdited ? '<span class="text-amber-600 font-semibold" title="金額已手改，重新生成課表不會覆蓋"><i class="fa-solid fa-pen"></i> 已手改</span>' : ''}
                       ${paymentBadge(e)}
                       ${sent ? sendPayToggleBtn(e) : ''}
                   </div>
                   ${sent ? sendPayFormHtml(e) : ''}`
                : derivedInfoRow(e);
            const waBtn = phone
                ? `<button onclick="sendWhatsApp('${e.key}')" class="px-2.5 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-lg font-semibold" title="打開 WhatsApp 預填訊息（不會自動移到已發送，發完請點「標記已發」）"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>`
                : `<button disabled class="px-2.5 py-1.5 bg-slate-100 text-slate-400 rounded-lg font-semibold cursor-not-allowed" title="此學生沒有電話號碼，僅可複製或手動已發"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>`;
            const waOpened = !sent && e.waOpenedAt;
            // 自定義條目由群發手動建立、無課堂掛鉤，允許在待發送欄直接刪除（其他類型由系統管理，不提供刪除）
            const delBtn = e.type === 'CUSTOM'
                ? `<button onclick="sendDeleteEntry('${e.key}')" class="px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg font-semibold" title="刪除此自定義條目"><i class="fa-solid fa-trash-can"></i></button>`
                : (DERIVED_TYPES.has(e.type)
                    ? `<button onclick="sendDismissDerived('${e.key}')" class="px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg font-semibold" title="這次不用發（刪除此條目；該學生此月不會再自動建立）"><i class="fa-solid fa-ban"></i> 不用發</button>`
                    : '');
            const actions = sent
                ? `<button onclick="sendMarkUnsent('${e.key}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold" title="移回待發送（發錯了想重發）"><i class="fa-solid fa-rotate-left"></i> 移回待發</button>`
                : `<button onclick="sendCopy('${e.key}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold"><i class="fa-solid fa-copy"></i> 複製</button>
                   ${waBtn}
                   ${delBtn}
                   <span class="ml-auto pl-3 flex items-center gap-1.5">
                       <button onclick="sendMarkSent('${e.key}', 'wa_link')" class="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold${waOpened ? ' ring-2 ring-emerald-300' : ''}" title="已用 WhatsApp 發出 → 移到已發送"><i class="fa-solid fa-check"></i> 標記已發</button>
                       <button onclick="sendMarkSent('${e.key}', 'manual')" class="px-2.5 py-1.5 bg-slate-600 hover:bg-slate-700 text-white rounded-lg font-semibold" title="不經 WhatsApp（如面談／電話已通知）→ 直接移到已發送">手動已發</button>
                   </span>`;
            const sentInfo = sent
                ? `<span class="text-[10px] text-slate-400">已發於 ${String(e.sentAt || '').replace('T', ' ').slice(0, 16)} · ${e.method === 'manual' ? '手動' : 'WhatsApp'}</span>`
                : (waOpened
                    ? `<span class="px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-semibold" title="已開啟過 WhatsApp（${String(e.waOpenedAt).replace('T', ' ').slice(0, 16)}）——瀏覽器無法確認是否真的送出，若已送出請按「標記已發」"><i class="fa-brands fa-whatsapp"></i> 已開啟，未標記</span>`
                    : '');
            return `
                <div class="border border-slate-200 rounded-xl p-3 space-y-2 text-xs ${sent ? 'bg-slate-50/60' : 'bg-white'}">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="px-1.5 py-0.5 rounded ${meta.cls} font-bold text-[10px]">${meta.label}</span>
                        <span class="font-bold text-slate-800">${e.studentName || e.studentId}</span>
                        <span class="text-slate-500">(${e.studentId})</span>
                        ${phone ? `<span class="text-slate-500"><i class="fa-solid fa-phone text-[10px]"></i> ${phone}</span>` : '<span class="text-slate-400 italic">無電話</span>'}
                        ${sentInfo}
                    </div>
                    ${amountRow}
                    ${sendMsgBlock(e, msg)}
                    <div class="flex items-center gap-1.5 flex-wrap">${actions}</div>
                </div>`;
        }

        // ===== 數據分析：月份 KPI／各導師／各課程／狀態分佈（純計算 lib/analytics.js；Chart.js 圖表，離線退回文字長條）=====
        let analyticsCharts = {};

        function analyticsMonth() {
            const el = document.getElementById('anaMonth');
            return (el && el.value) || currentMonthKey() || localDateStr(new Date()).slice(0, 7);
        }

        function renderAnalytics() {
            const table = document.getElementById('anaTutorTable');
            if (!table) return;
            const monthKey = analyticsMonth();
            const st = GACAnalytics.monthStats(lessonsByMonth, monthKey, {
                rateFn: rateForLesson,
                payNoShow: !appSettings || appSettings.payNoShow !== false,
                tuitionEntries: GACSendlog.tuitionByMonth(sendLog, monthKey)
            });
            const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            const pctText = v => (v === null ? '—' : v + '%');
            setText('anaKpiTuitionDue', tuitionMoney(st.tuitionDue));
            setText('anaKpiTuitionPaid', tuitionMoney(st.tuitionPaid));
            setText('anaKpiRevenue', tuitionMoney(st.revenue));
            setText('anaKpiSessions', String(st.sessions));
            setText('anaKpiHours', String(st.tutorHours));
            setText('anaKpiAttendance', pctText(st.attendanceRate));
            setText('anaKpiNoShow', pctText(st.noShowRate));
            setText('anaKpiLeave', pctText(st.leaveRate));
            setText('anaKpiPending', String(st.pendingMakeups));
            setText('anaKpiUnconfirmed', String(st.unconfirmed));
            const empty = document.getElementById('anaEmpty');
            if (empty) empty.classList.toggle('hidden', st.lessons > 0);
            table.innerHTML = st.byTutor.length
                ? st.byTutor.map(t => `<tr><td class="p-2 font-bold">${escapeHtml(t.tutor)}</td><td class="p-2 text-center">${t.sessions}</td><td class="p-2 text-center">${t.hours}</td><td class="p-2 text-center">${t.lessons}</td><td class="p-2 text-center">${t.students}</td><td class="p-2 text-right font-semibold">${tuitionMoney(t.revenue)}</td></tr>`).join('')
                : '<tr><td colspan="6" class="p-4 text-center text-slate-400">此月沒有課堂</td></tr>';
            renderAnalyticsCharts(st);
            return st;
        }

        function renderAnalyticsCharts(st) {
            const tutors = st.byTutor.map(t => t.tutor);
            const specs = [
                { id: 'chartSessionsByTutor', type: 'bar', labels: tutors, data: st.byTutor.map(t => t.sessions), label: '節數', colors: '#0ea5e9' },
                { id: 'chartRevenueByTutor', type: 'bar', labels: tutors, data: st.byTutor.map(t => t.revenue), label: '課值', colors: '#f59e0b' },
                { id: 'chartStatus', type: 'doughnut', labels: ['已上課', '已排課', '請假', '缺席'],
                  data: [st.status.ATTENDED, st.status.SCHEDULED, st.status.LEAVE, st.status.NOSHOW], colors: ['#10b981', '#0ea5e9', '#f43f5e', '#a855f7'] },
                { id: 'chartByProgram', type: 'bar', labels: st.byProgram.map(p => p.program), data: st.byProgram.map(p => p.lessons), label: '堂數', colors: '#8b5cf6' }
            ];
            const hasChart = typeof Chart !== 'undefined';
            specs.forEach(spec => {
                const canvas = document.getElementById(spec.id);
                const fallback = document.getElementById(spec.id + 'Fallback');
                if (!canvas) return;
                if (!hasChart) {
                    // CDN 未載入（離線／被擋）：文字長條
                    canvas.classList.add('hidden');
                    if (!fallback) return;
                    fallback.classList.remove('hidden');
                    const max = Math.max(1, ...spec.data);
                    fallback.innerHTML = spec.labels.map((lb, i) => {
                        const color = Array.isArray(spec.colors) ? spec.colors[i % spec.colors.length] : spec.colors;
                        return `<div class="flex items-center gap-2"><span class="w-28 truncate text-slate-600">${escapeHtml(String(lb))}</span><div class="flex-1 bg-slate-100 rounded h-3"><div class="h-3 rounded" style="width:${Math.round(spec.data[i] / max * 100)}%;background:${color}"></div></div><span class="w-16 text-right font-semibold">${spec.data[i]}</span></div>`;
                    }).join('') || '<div class="text-slate-400">—</div>';
                    return;
                }
                canvas.classList.remove('hidden');
                if (fallback) fallback.classList.add('hidden');
                if (analyticsCharts[spec.id]) analyticsCharts[spec.id].destroy();
                analyticsCharts[spec.id] = new Chart(canvas, {
                    type: spec.type,
                    data: { labels: spec.labels, datasets: [{ label: spec.label || '', data: spec.data, backgroundColor: spec.colors }] },
                    options: spec.type === 'doughnut'
                        ? { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } }
                        : { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
                });
            });
        }

        // ===== 出席與繳費：每位學生一行（本月堂數／出席／應收／學費單已發／繳費記錄）=====
        // 資料源：發送中心的 TUITION 條目（單一事實來源，繳費欄位掛在條目上）＋當月課堂狀態。
        function paymentMonth() {
            const el = document.getElementById('payMonth');
            return (el && el.value) || currentMonthKey() || localDateStr(new Date()).slice(0, 7);
        }

        function payMethodNames() {
            const pm = appSettings && appSettings.payMethods;
            return (Array.isArray(pm) && pm.length) ? pm : GACStorage.DEFAULT_SETTINGS.payMethods;
        }

        function paymentBadge(e) {
            const st = GACSendlog.paymentStatus(e);
            if (st === 'unpaid') {
                // 填了金額卻沒選付款方式：不算收到錢，明說原因免得以為系統沒記住
                return Number(e.paidAmount) > 0
                    ? '<span class="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-300 text-amber-800 font-semibold text-[10px]" title="已填實收金額但未選付款方式——未選之前一律當未繳">未繳 · 待選付款方式</span>'
                    : '<span class="px-1.5 py-0.5 rounded bg-rose-50 border border-rose-200 text-rose-700 font-semibold text-[10px]">未繳</span>';
            }
            const names = payMethodNames();
            const m = parseInt(e.payMethod, 10);
            const how = m >= 1 && m <= names.length ? ` · ${names[m - 1]}` : '';
            const cls = st === 'paid' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-800';
            return `<span class="px-1.5 py-0.5 rounded border ${cls} font-semibold text-[10px]">${st === 'paid' ? '已繳清' : '部分繳交'} ${tuitionMoney(e.paidAmount)}${how}${e.payDate ? ' · ' + e.payDate : ''}</span>`;
        }

        function paymentRowsFor(monthKey) {
            const lessons = lessonsByMonth[monthKey] || [];
            const byStudent = new Map(GACSendlog.tuitionByMonth(sendLog, monthKey).map(e => [e.studentId, e]));
            const ids = new Set([...byStudent.keys()].concat(lessons.map(l => l.studentId)));
            const rows = [];
            studentDatabase.forEach(s => {
                if (!ids.has(s.id)) return;
                const mine = lessons.filter(l => l.studentId === s.id);
                const stat = k => mine.filter(l => l.status === k).length;
                const entry = byStudent.get(s.id) || null;
                rows.push({
                    student: s, entry: entry, count: mine.filter(l => !l.isMakeup).length,
                    attended: stat('ATTENDED'), leave: stat('LEAVE'), noshow: stat('NOSHOW'),
                    rates: entry ? (entry.items || []).map(it => it.rate).filter(r => r !== null && r !== undefined) : []
                });
            });
            return rows;
        }

        function renderPaymentTab() {
            const body = document.getElementById('paymentTableBody');
            if (!body) return;
            syncDerivedEntries();
            const monthKey = paymentMonth();
            const tSel = document.getElementById('payTutorFilter');
            const prevT = (tSel && tSel.value) || 'ALL';
            const tutors = allTutorNames().slice().sort();
            if (tSel) {
                tSel.innerHTML = '<option value="ALL">所有導師</option>' + tutors.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
                tSel.value = tutors.includes(prevT) ? prevT : 'ALL';
            }
            const tutorF = (tSel && tSel.value) || 'ALL';
            const qEl = document.getElementById('paySearch');
            const q = ((qEl && qEl.value) || '').toLowerCase().trim();
            let rows = paymentRowsFor(monthKey);
            if (tutorF !== 'ALL') rows = rows.filter(r => r.student.tutor === tutorF || (r.entry && (r.entry.items || []).some(it => it.tutor === tutorF)));
            if (q) rows = rows.filter(r => String(r.student.id).toLowerCase().includes(q) || String(r.student.name).toLowerCase().includes(q));
            const entries = rows.map(r => r.entry).filter(Boolean);
            const totals = GACSendlog.paymentTotals(entries);
            const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            setText('payKpiDue', tuitionMoney(totals.due));
            setText('payKpiPaid', tuitionMoney(totals.paid));
            setText('payKpiOutstanding', tuitionMoney(totals.outstanding));
            setText('payKpiUnsent', String(entries.filter(e => e.status !== 'SENT').length));
            setText('payKpiAbsent', String(rows.reduce((s, r) => s + r.noshow, 0)));
            if (!rows.length) {
                body.innerHTML = `<tr><td colspan="12" class="p-6 text-center text-slate-400 text-xs">📭 ${monthKey} 尚未生成課表，或沒有符合篩選的學生。到「總課表」生成後，學費條目會出現在這裡。</td></tr>`;
                return;
            }
            body.innerHTML = rows.map(paymentRowHtml).join('');
        }

        function paymentRowHtml(r) {
            const s = r.student, e = r.entry;
            const who = `<td class="p-2.5 whitespace-nowrap"><b>${escapeHtml(s.id)}</b> ${escapeHtml(s.name)}</td><td class="p-2.5 text-slate-600">${escapeHtml(s.tutor)}</td>`;
            const attCell = `<span class="text-emerald-700 font-semibold">${r.attended}</span> / <span class="text-rose-600 font-semibold">${r.leave}</span> / <span class="text-purple-700 font-semibold">${r.noshow}</span>`;
            if (!e) {
                return `<tr class="hover:bg-slate-50">${who}<td class="p-2.5 text-right text-slate-400">—</td><td class="p-2.5 text-center">${r.count}</td><td class="p-2.5 text-center whitespace-nowrap">${attCell}</td><td class="p-2.5 text-slate-400 italic" colspan="7">此月尚無學費條目（到總課表按「生成」）</td></tr>`;
            }
            const k = e.key;
            const sent = e.status === 'SENT';
            const st = GACSendlog.paymentStatus(e);
            const badge = st === 'paid' ? '<span class="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold text-[10px]">已繳清</span>'
                : st === 'partial' ? '<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[10px]">部分</span>'
                : (Number(e.paidAmount) > 0
                    ? '<span class="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-300 text-amber-800 font-bold text-[10px]" title="已填實收金額但未選付款方式——未選之前一律當未繳">未繳 · 待選付款方式</span>'
                    : '<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold text-[10px]">未繳</span>');
            const methodSel = payMethodSelectHtml(e, 'px-1.5 py-1 border border-slate-300 rounded-lg bg-white text-[11px]');
            const rm = sendLog[GACSendlog.remindKey(e.studentId, e.month)];
            const remindNote = !rm ? '' : (rm.status === 'SENT'
                ? `<div class="text-[10px] text-slate-500" title="催繳已於 ${String(rm.sentAt || '').slice(0, 10)} 發出">催繳已發</div>`
                : '<div class="text-[10px] text-rose-600 font-semibold" title="催繳訊息已在發送中心「待發送」">催繳待發</div>');
            const rc = sendLog[GACSendlog.receiptKey(e.studentId, e.month)];
            const receiptNote = !rc ? '' : (rc.status === 'SENT'
                ? '<div class="text-[10px] text-slate-500" title="收款確認訊息已發出">確認已發</div>'
                : '<div class="text-[10px] text-amber-600 font-semibold" title="收款確認訊息已在發送中心「待發送」">確認待發</div>');
            const phone = sendEntryPhone(e);
            // 未發：預填學費單；已發：只打開對話不預填——人手複核訊息是否真的送出／對方有否回覆
            const waBtn = !phone ? ''
                : (!sent
                    ? `<button onclick="sendWhatsApp('${k}'); renderPaymentTab()" class="ml-1 px-1.5 py-0.5 bg-green-100 hover:bg-green-200 text-green-800 rounded font-semibold" title="開 WhatsApp 預填學費單（發完請勾已發送）"><i class="fa-brands fa-whatsapp"></i></button>`
                    : `<button onclick="openWhatsAppChat('${k}')" class="ml-1 px-1.5 py-0.5 bg-slate-100 hover:bg-green-100 text-green-700 rounded font-semibold" title="已發送——打開對話（不預填訊息），人手複核"><i class="fa-brands fa-whatsapp"></i></button>`);
            return `<tr class="hover:bg-slate-50 ${st === 'paid' ? 'bg-emerald-50/30' : ''}">
                ${who}
                <td class="p-2.5 text-right whitespace-nowrap">${r.rates.length ? r.rates.map(x => tuitionMoney(x)).join('<br>') : '—'}</td>
                <td class="p-2.5 text-center" title="${escapeHtml(tuitionCountLabel(e))}">${e.count}</td>
                <td class="p-2.5 text-center whitespace-nowrap">${attCell}</td>
                <td class="p-2.5 text-right font-bold whitespace-nowrap">${tuitionMoney(e.amount)}${e.amountEdited ? ' <i class="fa-solid fa-pen text-amber-500" title="金額已手改（發送中心可改）"></i>' : ''}</td>
                <td class="p-2.5 text-center whitespace-nowrap"><input type="checkbox" ${sent ? 'checked' : ''} onchange="paySetSent('${k}', this.checked)" class="w-4 h-4 accent-emerald-600" title="學費單已發送（與發送中心同步；勾＝手動已發，取消＝移回待發）">${waBtn}${remindNote}</td>
                <td class="p-2.5 text-center whitespace-nowrap">${badge}${receiptNote}</td>
                <td class="p-2.5 text-right"><input type="number" min="0" value="${Number(e.paidAmount) || 0}" onchange="payUpdate('${k}', { paidAmount: this.value })" class="w-20 px-1.5 py-1 border border-slate-300 rounded-lg text-right" title="實收金額（改動即更新已繳狀態）"></td>
                <td class="p-2.5">${methodSel}</td>
                <td class="p-2.5 whitespace-nowrap"><input type="date" value="${e.payDate || ''}" onchange="payUpdate('${k}', { payDate: this.value })" class="px-1.5 py-1 border border-slate-300 rounded-lg text-[11px]">${(Number(e.paidAmount) || 0) || e.payMethod ? `<button onclick="payUpdate('${k}', { clearPayment: true })" class="ml-1 px-1.5 py-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded" title="清除這筆繳費紀錄（實收與付款方式歸零，回到未繳）"><i class="fa-solid fa-eraser"></i></button>` : ''}</td>
                <td class="p-2.5 text-right whitespace-nowrap"><button onclick="payPreview('${k}')" class="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold" title="查看／複製學費單"><i class="fa-solid fa-file-invoice"></i></button></td>
            </tr>`;
        }

        function payUpdate(key, fields) {
            const e0 = sendLog[key];
            if (!e0) return;
            pushHistory(`繳費記錄：${e0.studentName || e0.studentId} ${e0.month}`);
            GACSendlog.setPayment(sendLog, key, fields, localDateStr(new Date()));
            persistSendlog();
            renderPaymentTab();
            renderSendCenter();
        }

        // 「已發送」勾選＝發送中心的手動已發；取消＝移回待發（同一條目，兩頁同步）
        function paySetSent(key, on) {
            const e0 = sendLog[key];
            if (!e0) return;
            pushHistory(`學費單${on ? '標記已發' : '移回待發'}：${e0.studentName || e0.studentId} ${e0.month}`);
            if (on) GACSendlog.markSent(sendLog, key, 'manual', new Date().toISOString());
            else GACSendlog.markUnsent(sendLog, key);
            persistSendlog();
            renderPaymentTab();
            renderSendCenter();
        }

        // 學費單預覽：借用訊息弹窗，附複製／WhatsApp
        function payPreview(key) {
            const e = sendLog[key];
            const modal = document.getElementById('msgModal');
            const body = document.getElementById('msgModalBody');
            if (!e || !modal || !body) return;
            const phone = sendEntryPhone(e);
            document.getElementById('msgModalTitle').textContent = `📩 學費單 — ${e.studentName || e.studentId}（${e.month}）`;
            body.innerHTML = `
                <div class="bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-700 whitespace-pre-wrap">${escapeHtml(sendlogMsgFor(e))}</div>
                <div class="flex items-center gap-1.5">
                    <button onclick="sendCopy('${key}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold"><i class="fa-solid fa-copy"></i> 複製</button>
                    ${phone
                        ? `<button onclick="sendWhatsApp('${key}'); closeMsgModal(); renderPaymentTab()" class="px-2.5 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-lg font-semibold"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>`
                        : '<span class="text-slate-400 italic">無電話，僅可複製</span>'}
                    ${e.status === 'SENT' ? '<span class="ml-auto text-[10px] text-emerald-700 font-semibold">已發送</span>' : `<button onclick="paySetSent('${key}', true); closeMsgModal()" class="ml-auto px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold"><i class="fa-solid fa-check"></i> 標記已發</button>`}
                </div>`;
            modal.classList.remove('hidden');
        }

        function renderSendCenter() {
            const todoList = document.getElementById('sendTodoList');
            const sentList = document.getElementById('sendSentList');
            if (!todoList || !sentList) return;
            syncDerivedEntries();
            const cols = GACSendlog.listByMonth(sendLog, sendCenterMonth());
            const typeFilter = rebuildSendTypeOptions(cols.todo.concat(cols.sent));
            const byType = e => {
                if (typeFilter === 'ALL') return true;
                if (typeFilter.indexOf('CUSTOM:') === 0) {
                    return e.type === 'CUSTOM' && customBatchId(e) === typeFilter.slice(7);
                }
                if (typeFilter.indexOf('TUITION:') === 0) {
                    if (e.type !== 'TUITION') return false;
                    const paid = GACSendlog.paymentStatus(e) === 'paid';
                    return typeFilter === 'TUITION:paid' ? paid : !paid;
                }
                return e.type === typeFilter;
            };
            const todo = cols.todo.filter(byType);
            const sent = cols.sent.filter(byType);
            let filterLabel = '';
            if (typeFilter.indexOf('CUSTOM:') === 0) {
                const hit = cols.todo.concat(cols.sent).find(e => e.type === 'CUSTOM' && customBatchId(e) === typeFilter.slice(7));
                filterLabel = '自定義：' + escapeHtml((hit && hit.title) || '未命名群發');
            } else if (typeFilter === 'CUSTOM') {
                filterLabel = '全部自定義';
            } else if (typeFilter.indexOf('TUITION:') === 0) {
                filterLabel = typeFilter === 'TUITION:paid' ? '學費 · 已繳清' : '學費 · 未繳清';
            } else if (typeFilter !== 'ALL') {
                filterLabel = (SEND_TYPE_META[typeFilter] || { label: typeFilter }).label;
            }
            const filterNote = filterLabel ? `（目前只顯示「${filterLabel}」，切回「全部類別」可見其他）` : '';
            // 「刪除此批」鈕只在篩選到自定義時出現（某一批或全部自定義）
            const batchBtn = document.getElementById('sendBatchDeleteBtn');
            if (batchBtn) {
                const isCustom = typeFilter.indexOf('CUSTOM') === 0;
                batchBtn.classList.toggle('hidden', !isCustom);
                if (isCustom) {
                    batchBtn.innerHTML = `<i class="fa-solid fa-trash-can"></i> ${typeFilter === 'CUSTOM' ? '刪除全部自定義' : '刪除此批'}`;
                }
            }
            todoList.innerHTML = todo.map(e => sendEntryCard(e, false)).join('')
                || `<div class="text-slate-400 text-xs italic p-3">此月份沒有待發送項目${filterNote}。生成課表／標記請假／安排補堂會自動產生對應條目。</div>`;
            sentList.innerHTML = sent.map(e => sendEntryCard(e, true)).join('')
                || `<div class="text-slate-400 text-xs italic p-3">此月份還沒有已發送紀錄${filterNote}。</div>`;
            const msgTgl = document.getElementById('sendMsgToggleAll');
            if (msgTgl) msgTgl.innerHTML = sendMsgDefaultOpen
                ? '<i class="fa-solid fa-chevron-right"></i> 收起全部訊息'
                : '<i class="fa-solid fa-chevron-down"></i> 展開全部訊息';
            const todoCountEl = document.getElementById('sendTodoCount');
            const sentCountEl = document.getElementById('sendSentCount');
            if (todoCountEl) todoCountEl.textContent = todo.length;
            if (sentCountEl) sentCountEl.textContent = sent.length;
            // 已發送欄的學費之中未繳清（未繳＋部分）的筆數：「發了但錢未到」
            const unpaidEl = document.getElementById('sendSentUnpaid');
            if (unpaidEl) {
                const due = sent.filter(e => e.type === 'TUITION' && GACSendlog.paymentStatus(e) !== 'paid').length;
                unpaidEl.textContent = due ? `${due} 筆學費未繳清` : '';
                unpaidEl.classList.toggle('hidden', due === 0);
            }
            // 頁籤紅點徽章：所有月份 TODO 總數
            const badge = document.getElementById('sendTabBadge');
            if (badge) {
                const total = Object.keys(sendLog).filter(k => sendLog[k] && sendLog[k].status === 'TODO').length;
                badge.textContent = total;
                badge.classList.toggle('hidden', total === 0);
            }
        }

        function sendSetAmount(key, value) {
            const e0 = sendLog[key];
            if (!e0) return;
            pushHistory(`手改學費金額：${e0.studentName || e0.studentId} ${e0.month} → $${value}`);
            GACSendlog.setAmount(sendLog, key, value);
            persistSendlog();
            renderSendCenter();
            renderPaymentTab();
        }

        function sendMarkSent(key, method) {
            const e0 = sendLog[key];
            if (!e0) return;
            pushHistory(`標記已發：${e0.studentName || e0.studentId}（${(SEND_TYPE_META[e0.type] || { label: e0.type }).label}）`);
            GACSendlog.markSent(sendLog, key, method, new Date().toISOString());
            persistSendlog();
            renderSendCenter();
            renderPaymentTab();
        }

        function sendMarkUnsent(key) {
            const e0 = sendLog[key];
            if (!e0) return;
            pushHistory(`移回待發：${e0.studentName || e0.studentId}（${(SEND_TYPE_META[e0.type] || { label: e0.type }).label}）`);
            GACSendlog.markUnsent(sendLog, key);
            persistSendlog();
            renderSendCenter();
            renderPaymentTab();
        }

        function sendCopy(key) {
            const e = sendLog[key];
            if (e) copyToClipboard(sendlogMsgFor(e));
        }

        // 只打開對話、不預填訊息、不改任何狀態：已發送後人手複核用
        function openWhatsAppChat(key) {
            const e = sendLog[key];
            if (!e) return;
            const phone = getWhatsAppPhone(sendEntryPhone(e));
            if (!phone) { alert('此學生沒有可用的 WhatsApp 電話號碼。'); return; }
            window.open(`https://web.whatsapp.com/send?phone=${phone}`, '_blank', 'noopener');
        }

        function sendWhatsApp(key) {
            const e = sendLog[key];
            if (!e) return;
            const phone = getWhatsAppPhone(sendEntryPhone(e));
            if (!phone) { alert('此學生沒有可用的 WhatsApp 電話號碼。'); return; }
            const url = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(sendlogMsgFor(e))}`;
            window.open(url, '_blank', 'noopener');
            // 瀏覽器無法得知訊息在 WhatsApp 裡是否真的送出（跨域），「點開→已發送」的對應由設定決定：
            //   confirm（預設）＝標記已開啟＋切回頁面時詢問；badge＝只標記；auto＝點開即移已發送（可移回撤銷）
            const mode = appSettings.waSentMode || 'confirm';
            if (mode === 'auto') {
                pushHistory(`標記已發（WhatsApp 自動）：${e.studentName || e.studentId}`);
                GACSendlog.markSent(sendLog, key, 'wa_link', new Date().toISOString());
            } else {
                GACSendlog.markWaOpened(sendLog, key, new Date().toISOString());
                if (mode === 'confirm' && pendingWaConfirmKeys.indexOf(key) === -1) {
                    pendingWaConfirmKeys.push(key);
                }
            }
            persistSendlog();
            renderSendCenter();
        }

        // 批量刪除自定義：刪掉目前篩選的整批群發（某 batchId）或本月全部自定義，含已發送紀錄。
        // 其他類別（學費/請假/補堂確認）由系統按課堂管理，不提供批刪。
        function sendDeleteCustomBatch() {
            const typeFilter = document.getElementById('sendTypeFilter')?.value || 'ALL';
            if (typeFilter.indexOf('CUSTOM') !== 0) return;
            const monthKey = sendCenterMonth();
            const bid = typeFilter.indexOf('CUSTOM:') === 0 ? typeFilter.slice(7) : null;
            const hits = Object.keys(sendLog).map(k => sendLog[k]).filter(e =>
                e && e.type === 'CUSTOM' && e.month === monthKey && (!bid || customBatchId(e) === bid));
            if (!hits.length) { alert('目前篩選下沒有可刪除的自定義條目。'); return; }
            const what = bid ? `群發「${hits[0].title || '未命名群發'}」` : `${monthKey} 的全部自定義訊息`;
            const sentCount = hits.filter(e => e.status === 'SENT').length;
            if (!confirm(`批量刪除${what}：共 ${hits.length} 筆` +
                (sentCount ? `（含 ${sentCount} 筆已發送的紀錄）` : '') +
                `。\n只刪發送中心的條目，不影響課表或其他資料。不可還原，確定刪除？`)) return;
            pushHistory(`批量刪除自定義：${what}（${hits.length} 筆）`);
            hits.forEach(e => { delete sendLog[e.key]; });
            persistSendlog();
            renderSendCenter();
            showToast(`✅ 已刪除 ${hits.length} 筆自定義條目`);
        }

        // 刪除自定義條目（僅 CUSTOM：群發手動建立、無課堂掛鉤；其他類型由系統管理不可刪）
        function sendDeleteEntry(key) {
            const e = sendLog[key];
            if (!e || e.type !== 'CUSTOM') return;
            if (!confirm(`刪除 ${e.studentName || e.studentId} 的自定義條目？\n（只刪除此發送紀錄，不影響其他資料）`)) return;
            pushHistory(`刪除自定義條目：${e.studentName || e.studentId}`);
            delete sendLog[key];
            persistSendlog();
            renderSendCenter();
        }

        // ===== 自定義群發：自訂訊息（{name}/{id} 佔位符），按導師篩選勾選學生，批量加入待發送欄 =====
        function openBroadcastModal() {
            document.getElementById('bcTitle').value = '';
            document.getElementById('bcMonth').value = sendCenterMonth();
            const tutors = allTutorNames();
            document.getElementById('bcTutor').innerHTML =
                '<option value="ALL">所有導師</option>' + tutors.map(t => `<option value="${t}">${t}</option>`).join('');
            renderBroadcastList();
            document.getElementById('broadcastModal').classList.remove('hidden');
            markModalOpened('broadcastModal');
        }

        function closeBroadcastModal() {
            document.getElementById('broadcastModal').classList.add('hidden');
        }

        function renderBroadcastList() {
            const tutor = document.getElementById('bcTutor').value || 'ALL';
            const list = document.getElementById('bcList');
            const rows = [];
            studentDatabase.forEach((s, idx) => {
                if (tutor !== 'ALL' && s.tutor !== tutor) return;
                rows.push(`
                    <label class="flex items-center gap-2 bg-white p-2 rounded-lg border border-slate-200 cursor-pointer hover:border-violet-300 transition">
                        <input type="checkbox" value="${idx}" checked class="accent-violet-600 rounded">
                        <span class="truncate"><b>${s.id}</b> ${s.name} <span class="text-slate-400">· ${s.tutor}</span>
                        ${s.phone ? '' : '<span class="text-amber-600 font-semibold">（無電話，僅可複製）</span>'}</span>
                    </label>`);
            });
            list.innerHTML = rows.join('') || '<span class="text-slate-400 italic">此導師沒有學生。</span>';
            document.getElementById('bcCount').textContent = `符合篩選：${rows.length} 位學生（預設全勾）`;
        }

        function bcSetAll(checked) {
            document.querySelectorAll('#bcList input[type="checkbox"]').forEach(chk => { chk.checked = checked; });
        }

        function applyBroadcast() {
            const title = document.getElementById('bcTitle').value.trim() || '未命名群發';
            const msg = document.getElementById('bcMessage').value.trim();
            const monthKey = document.getElementById('bcMonth').value;
            if (!msg) { alert('請先輸入訊息內容！'); return; }
            if (!monthKey) { alert('請選擇歸屬月份！'); return; }
            const chosen = [...document.querySelectorAll('#bcList input[type="checkbox"]')]
                .filter(chk => chk.checked)
                .map(chk => studentDatabase[parseInt(chk.value)])
                .filter(Boolean);
            if (!chosen.length) { alert('請至少勾選一位學生！'); return; }
            // batchId 用建立時刻，同月多次群發互不覆蓋；{name}/{id} 在此按學生解析定稿
            pushHistory(`建立群發：${title}（${chosen.length} 位）`);
            const now = new Date();
            const batchId = now.toISOString().replace(/\D/g, '').slice(0, 14);
            chosen.forEach(s => {
                GACSendlog.addCustomEntry(sendLog, {
                    batchId: batchId, title: title,
                    studentId: s.id, studentName: s.name, phone: s.phone || '',
                    monthKey: monthKey,
                    message: msg.split('{name}').join(s.name).split('{id}').join(s.id),
                    now: now.toISOString()
                });
            });
            persistSendlog();
            const sendMonthEl = document.getElementById('sendMonth');
            if (sendMonthEl) sendMonthEl.value = monthKey;
            const typeSel = document.getElementById('sendTypeFilter');
            if (typeSel) typeSel.value = 'CUSTOM:' + batchId; // 建完直接聚焦到這批（rebuild 會確認有效）
            renderSendCenter();
            closeBroadcastModal();
            showToast(`✅ 已建立群發「${title}」：${chosen.length} 位學生（${monthKey}）\n待發送欄已切到此類別；建錯可整批刪除`);
        }

        // waSentMode='confirm'：從 WhatsApp 分頁切回本頁時，逐條詢問剛才開啟的訊息是否已發出。
        // 先清空佇列再詢問——confirm 對話框本身會觸發 focus 事件，避免重入重複詢問。
        function handleWaReturnConfirm() {
            if (typeof document !== 'undefined' && document.hidden) return;
            if (!pendingWaConfirmKeys.length) return;
            const keys = pendingWaConfirmKeys.slice();
            pendingWaConfirmKeys.length = 0;
            let changed = false;
            keys.forEach(key => {
                const e = sendLog[key];
                if (!e || e.status !== 'TODO') return;
                const meta = SEND_TYPE_META[e.type] || { label: e.type };
                if (confirm(`剛才開啟的 WhatsApp——${e.studentName || e.studentId} 的「${meta.label}」訊息——已經發出了嗎？\n\n確定＝移到「已發送」\n取消＝留在待發送（條目已標記「已開啟」，可稍後手動標記）`)) {
                    pushHistory(`標記已發（WhatsApp 確認）：${e.studentName || e.studentId}`);
                    GACSendlog.markSent(sendLog, key, 'wa_link', new Date().toISOString());
                    changed = true;
                }
            });
            if (changed) {
                persistSendlog();
                renderSendCenter();
            }
        }

        // ===== 導師管理（gac_tutors_v3）：名單驅動所有導師下拉；等級＝查價用的導師級別 =====
        function tutorTier(name) {
            const t = tutorsList.find(x => x.name === name);
            return t ? t.tier : null;
        }

        // 名單 ∪ 學生／小組上仍在用的名字（刪掉導師後舊資料照常顯示）
        function allTutorNames() {
            const names = tutorsList.map(t => t.name);
            studentDatabase.forEach(s => { if (s.tutor && names.indexOf(s.tutor) === -1) names.push(s.tutor); });
            groupClasses.forEach(g => { if (g.tutor && names.indexOf(g.tutor) === -1) names.push(g.tutor); });
            return names;
        }

        function tutorOptionsHtml(names) {
            return names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
        }

        // 常駐的兩個下拉：排課篩選（保留「所有導師」首項）、學生弹窗；小組／群發／總表篩選／繳費篩選在各自渲染時重建
        function populateTutorSelects() {
            const names = allTutorNames();
            const f = document.getElementById('filterTutor');
            if (f) {
                const cur = f.value || 'ALL';
                f.innerHTML = '<option value="ALL">所有導師 (All Tutors)</option>' + tutorOptionsHtml(names);
                f.value = names.indexOf(cur) !== -1 ? cur : 'ALL';
            }
            const m = document.getElementById('modalTutor');
            if (m) {
                const cur = m.value;
                m.innerHTML = tutorOptionsHtml(names);
                m.value = names.indexOf(cur) !== -1 ? cur : (names[0] || '');
            }
        }

        function persistTutors() { gacStore.saveTutors(tutorsList); }

        function renderTutorManagementList() {
            const box = document.getElementById('tutorManagementList');
            if (!box) return;
            box.innerHTML = tutorsList.length ? tutorsList.map(t => {
                const n = studentDatabase.filter(s => s.tutor === t.name).length + groupClasses.filter(g => g.tutor === t.name).length;
                return `<div class="flex items-center justify-between gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                    <span><b class="text-slate-800">${escapeHtml(t.name)}</b> <span class="text-slate-400">· ${n} 位學生／小組</span></span>
                    <div class="flex items-center gap-2">
                        <select onchange="updateTutorTier('${jsStrAttr(t.name)}', this.value)" class="p-1.5 border border-slate-300 rounded-lg bg-white">
                            <option value="普通導師" ${t.tier === '普通導師' ? 'selected' : ''}>普通導師</option>
                            <option value="資深導師" ${t.tier === '資深導師' ? 'selected' : ''}>資深導師</option>
                        </select>
                        <button onclick="deleteTutor('${jsStrAttr(t.name)}')" class="text-rose-600 hover:text-rose-800 px-2 py-1.5 hover:bg-rose-50 rounded-lg" title="刪除導師"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>`;
            }).join('') : '<div class="text-center py-4 text-slate-400 text-xs">尚未新增任何導師。</div>';
        }

        function addTutor() {
            const name = (document.getElementById('newTutorName').value || '').trim();
            const tier = document.getElementById('newTutorTier').value === '資深導師' ? '資深導師' : '普通導師';
            if (!name) { alert('請輸入導師名稱！'); return; }
            if (tutorsList.some(t => t.name === name)) { alert('此導師名稱已存在！'); return; }
            pushHistory(`新增導師：${name}（${tier}）`);
            tutorsList.push({ name: name, tier: tier });
            persistTutors();
            document.getElementById('newTutorName').value = '';
            afterTutorsChanged();
            showToast(`✅ 已新增導師 ${name}（${tier}）`);
        }

        function updateTutorTier(name, tier) {
            const t = tutorsList.find(x => x.name === name);
            if (!t || t.tier === tier) return;
            pushHistory(`導師等級：${name} → ${tier}`);
            t.tier = tier;
            persistTutors();
            afterTutorsChanged();
            showToast(`✅ ${name} 的定價等級改為 ${tier}（已登記學生的導師級別不變，逐一編輯可更新）`);
        }

        function deleteTutor(name) {
            const inUse = studentDatabase.filter(s => s.tutor === name).length + groupClasses.filter(g => g.tutor === name).length;
            if (!confirm(inUse
                ? `「${name}」仍有 ${inUse} 位學生／小組使用，確定刪除？\n（他們記錄上的導師名稱不會改動，只是名單裡不再列出）`
                : `確定刪除導師「${name}」？`)) return;
            pushHistory(`刪除導師：${name}`);
            tutorsList = tutorsList.filter(t => t.name !== name);
            persistTutors();
            afterTutorsChanged();
        }

        function afterTutorsChanged() {
            populateTutorSelects();
            renderTutorManagementList();
            renderTutorCalendarList();
            renderBatchCheckboxes();
        }

        // ===== 導師日曆 ID（設定 → Google Calendar）：同步時逐一讀取各導師的日曆，存在導師名單上，改動即存 =====
        function renderTutorCalendarList() {
            const box = document.getElementById('tutorCalendarList');
            if (!box) return;
            const inp = 'flex-1 min-w-0 px-2 py-1.5 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-sky-500 focus:outline-none';
            box.innerHTML = tutorsList.length ? tutorsList.map(t => `<div class="flex items-center gap-2 p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                    <span class="font-bold text-slate-800 w-28 shrink-0 truncate">${escapeHtml(t.name)}</span>
                    <input type="text" value="${escapeHtml(t.calendarId || '')}" onchange="updateTutorCalendar('${jsStrAttr(t.name)}', 'calendarId', this.value)" placeholder="留空＝用預設日曆（xxx@group.calendar.google.com）" class="${inp}">
                </div>`).join('') : '<div class="text-center py-3 text-slate-400 text-xs">尚未新增任何導師（在「導師管理」新增）。</div>';
        }

        function updateTutorCalendar(name, field, value) {
            if (field !== 'calendarId') return;
            const t = tutorsList.find(x => x.name === name);
            const v = String(value || '').trim();
            if (!t || (t.calendarId || '') === v) return;
            pushHistory(`導師日曆 ID：${name}`);
            t.calendarId = v;
            persistTutors();
            renderTutorCalendarList();
            showToast(`✅ 已更新 ${name} 的日曆 ID`);
        }

        // 學生／小組表單：選導師 → 自動帶出其等級（仍可手動改）
        function onModalTutorChange() {
            const tier = tutorTier(document.getElementById('modalTutor').value);
            const sel = readFeeSelection();
            if (tier) sel.tutorLevel = tier;
            renderStudentFeeSelects(sel);
        }

        function onGroupTutorChange() {
            const tier = tutorTier(document.getElementById('gmTutor').value);
            if (tier) document.getElementById('gmTutorLevel').value = tier;
        }

        // ===== 收費標準表（gac_rate_overrides_v3）：設定頁改價，就地套用到 rateTable，即時生效 =====
        function applyRateOverridesToTable() { GACRates.applyOverrides(rateTable, rateOverrides); }
        function persistRateOverrides() { gacStore.saveRateOverrides(rateOverrides); }

        function renderRateTableEditor() {
            const body = document.getElementById('rateTableEditorBody');
            if (!body) return;
            const tierSel = document.getElementById('rateEditTier');
            const progSel = document.getElementById('rateEditProgram');
            const programs = [...new Set(rateTable.map(r => r.instrument))];
            const curP = progSel.value;
            progSel.innerHTML = programs.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
            progSel.value = programs.indexOf(curP) !== -1 ? curP : programs[0];
            const tier = tierSel.value || '資深導師';
            const program = progSel.value;
            const rows = rateTable.filter(r => r.tutor === tier && r.instrument === program);
            const cnt = document.getElementById('rateOverrideCount');
            if (cnt) { const n = Object.keys(rateOverrides).length; cnt.textContent = n ? `已改價 ${n} 項` : '全部為預設價'; }
            body.innerHTML = rows.map(r => {
                const key = GACRates.overrideKey(r);
                const changed = rateOverrides[key] !== undefined;
                return `<tr class="${changed ? 'bg-amber-50/60' : ''}">
                    <td class="p-2 font-semibold">${escapeHtml(r.grade)}</td>
                    <td class="p-2 text-slate-600">${escapeHtml(r.classType)}</td>
                    <td class="p-2 text-center">${r.duration} 分鐘</td>
                    <td class="p-2 text-right"><input type="number" min="0" value="${r.rate}" data-key="${escapeHtml(key)}" onchange="handleRateTableEdit(this)" class="w-24 text-right p-1.5 border ${changed ? 'border-amber-400' : 'border-slate-300'} rounded-lg"${changed ? ` title="預設 $${r.baseRate}"` : ''}></td>
                    <td class="p-2 text-right">${changed ? `<button onclick="resetRateRow('${jsStrAttr(key)}')" class="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-semibold" title="還原預設 $${r.baseRate}">還原</button>` : ''}</td>
                </tr>`;
            }).join('') || '<tr><td colspan="5" class="p-4 text-center text-slate-400">此組合暫無收費資料。</td></tr>';
        }

        function handleRateTableEdit(input) {
            const key = input.dataset ? input.dataset.key : input.getAttribute('data-key');
            const row = rateTable.find(r => GACRates.overrideKey(r) === key);
            if (!row) return;
            const v = Number(input.value);
            if (!(v >= 0)) { alert('請輸入有效金額'); input.value = row.rate; return; }
            if (v === row.rate) return;
            pushHistory(`改價：${row.tutor} ${row.instrument} ${row.grade} ${row.classType} ${row.duration}分 → $${v}`);
            if (v === row.baseRate) delete rateOverrides[key]; else rateOverrides[key] = v;
            applyRateOverridesToTable();
            persistRateOverrides();
            afterRatesChanged();
        }

        function resetRateRow(key) {
            const row = rateTable.find(r => GACRates.overrideKey(r) === key);
            if (!row || rateOverrides[key] === undefined) return;
            pushHistory(`還原預設價：${row.tutor} ${row.instrument} ${row.grade} ${row.classType} ${row.duration}分`);
            delete rateOverrides[key];
            applyRateOverridesToTable();
            persistRateOverrides();
            afterRatesChanged();
        }

        function afterRatesChanged() {
            renderRateTableEditor();
            renderAll(); // 薪酬／分析／繳費顯示按新價；學費條目金額要重新「生成」才更新
        }

        // ===== 設定頁模組摺疊：開合狀態只存本機 gac_settings_open（UI 便利，不入備份；預設全部收起）=====
        // 順序＝頁面順序：常用的在前，「一般」與危險區殿後
        const SETTINGS_MODULES = ['gcal', 'fee', 'templates', 'tutors', 'rates', 'backup', 'general', 'danger'];

        function settingsOpenSet() {
            try {
                const v = JSON.parse(localStorage.getItem('gac_settings_open') || 'null');
                if (Array.isArray(v)) return new Set(v);
            } catch (e) { /* 無法讀取就用預設 */ }
            return new Set();
        }

        function saveSettingsOpenSet(set) {
            try { localStorage.setItem('gac_settings_open', JSON.stringify([...set])); } catch (e) { /* ignore */ }
        }

        function applySettingsModules() {
            const open = settingsOpenSet();
            SETTINGS_MODULES.forEach(id => {
                const body = document.getElementById('smod_' + id);
                const chev = document.getElementById('smodChev_' + id);
                if (body) body.classList.toggle('hidden', !open.has(id));
                if (chev) chev.classList.toggle('rotate-180', open.has(id));
            });
        }

        function toggleSettingsModule(id) {
            const open = settingsOpenSet();
            if (open.has(id)) open.delete(id); else open.add(id);
            saveSettingsOpenSet(open);
            applySettingsModules();
        }

        function openSettingsModule(id) {
            const open = settingsOpenSet();
            open.add(id);
            saveSettingsOpenSet(open);
            applySettingsModules();
        }

        // 訊息模板欄位：設定頁 textarea id → 設定鍵（還原預設／載入／儲存共用）
        const TPL_FIELDS = {
            tuitionHeader: ['setTplTuitionHeader', 'tplTuitionHeader'], tuitionTotal: ['setTplTuitionTotal', 'tplTuitionTotal'],
            tuitionFooter: ['setTplTuitionFooter', 'tplTuitionFooter'], leave: ['setTplLeave', 'tplLeave'],
            makeup: ['setTplMakeup', 'tplMakeup'], move: ['setTplMove', 'tplMove'],
            remind: ['setRemindMsg', 'remindMsg'], receipt: ['setReceiptMsg', 'receiptMsg']
        };

        // ===== 設定頁（gac_settings_v2）=====
        function loadSettingsForm() {
            const chk = document.getElementById('setPayNoShow');
            if (!chk) return;
            chk.checked = appSettings.payNoShow !== false;
            document.getElementById('setWaSentMode').value = appSettings.waSentMode || 'confirm';
            document.getElementById('setGcalClientId').value = appSettings.gcalClientId || '';
            document.getElementById('setGcalCalendarId').value = appSettings.gcalCalendarId || 'primary';
            document.getElementById('setGcalWrite').checked = appSettings.gcalWrite !== false;
            document.getElementById('setFpsId').value = appSettings.fpsId || '';
            document.getElementById('setInfoUrl').value = appSettings.infoUrl || '';
            document.getElementById('setFeeNotice').value = appSettings.feeNotice || '';
            renderPayMethodsEditor(payMethodNames());
            const c = derivedCfg();
            document.getElementById('setRemindAuto').checked = c.remindAuto;
            document.getElementById('setRemindDays').value = c.remindDays;
            document.getElementById('setReceiptAuto').checked = c.receiptAuto;
            Object.keys(TPL_FIELDS).forEach(k => {
                const el = document.getElementById(TPL_FIELDS[k][0]);
                if (el) el.value = msgTpl(TPL_FIELDS[k][1]);
            });
        }

        // 付款方式清單：編號＝陣列位置＋1，對應繳費紀錄的 payMethod；改名不影響既有紀錄，只能刪最後一個（避免編號前移對不上）
        function renderPayMethodsEditor(list) {
            const box = document.getElementById('payMethodsEditor');
            if (!box) return;
            const names = (Array.isArray(list) && list.length) ? list : GACStorage.DEFAULT_SETTINGS.payMethods;
            box.innerHTML = names.map((m, i) => `<div class="flex items-center gap-1">
                    <span class="text-xs text-slate-500 w-4 text-right">${i + 1}.</span>
                    <input type="text" class="pay-method-input flex-1 min-w-0 px-2 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-sky-500 focus:outline-none" value="${escapeHtml(m)}" placeholder="方式 ${i + 1}">
                    ${i === names.length - 1 && names.length > 1 ? '<button type="button" onclick="removeLastPayMethod()" class="px-1 text-rose-500 hover:text-rose-700" title="刪除最後一個"><i class="fa-solid fa-xmark"></i></button>' : ''}
                </div>`).join('');
        }

        // 回 null＝編輯器不在畫面上（保留原設定）；空白名稱補「方式 N」
        function readPayMethodsEditor() {
            const inputs = [...document.querySelectorAll('#payMethodsEditor .pay-method-input')];
            if (!inputs.length) return null;
            return inputs.map((el, i) => String(el.value || '').trim() || `方式 ${i + 1}`);
        }

        function addPayMethodRow() {
            renderPayMethodsEditor((readPayMethodsEditor() || payMethodNames()).concat(['']));
        }

        function removeLastPayMethod() {
            const list = readPayMethodsEditor() || payMethodNames().slice();
            if (list.length > 1) list.pop();
            renderPayMethodsEditor(list);
        }

        function resetMsgTemplate(which) {
            const f = TPL_FIELDS[which];
            if (!f) return;
            const el = document.getElementById(f[0]);
            if (el) el.value = GACStorage.DEFAULT_SETTINGS[f[1]];
        }

        function saveSettingsForm() {
            appSettings.payNoShow = document.getElementById('setPayNoShow').checked;
            appSettings.waSentMode = document.getElementById('setWaSentMode').value || 'confirm';
            appSettings.gcalClientId = document.getElementById('setGcalClientId').value.trim();
            appSettings.gcalCalendarId = document.getElementById('setGcalCalendarId').value.trim() || 'primary';
            appSettings.gcalWrite = !!document.getElementById('setGcalWrite').checked;
            appSettings.fpsId = document.getElementById('setFpsId').value.trim();
            appSettings.infoUrl = document.getElementById('setInfoUrl').value.trim();
            appSettings.feeNotice = document.getElementById('setFeeNotice').value.trim();
            const pm = readPayMethodsEditor();
            if (pm && pm.length) appSettings.payMethods = pm; // 讀不到編輯器（畫面未渲染）時保留原值
            appSettings.remindAuto = !!document.getElementById('setRemindAuto').checked;
            appSettings.remindDays = Math.max(1, parseInt(document.getElementById('setRemindDays').value, 10) || GACStorage.DEFAULT_SETTINGS.remindDays);
            appSettings.receiptAuto = !!document.getElementById('setReceiptAuto').checked;
            Object.keys(TPL_FIELDS).forEach(k => {
                const el = document.getElementById(TPL_FIELDS[k][0]);
                if (el) appSettings[TPL_FIELDS[k][1]] = String(el.value || '').trim() || GACStorage.DEFAULT_SETTINGS[TPL_FIELDS[k][1]];
            });
            gacStore.saveSettings(appSettings);
            if (typeof applyGcalModeUi === 'function') applyGcalModeUi();
            renderPaymentTab();
            renderSendCenter(); // 催繳／收款確認的自動開關與天數、訊息模板改了要重新組訊息
            const hints = document.querySelectorAll('.settings-saved-hint');
            hints.forEach(h => h.classList.remove('hidden'));
            setTimeout(() => hints.forEach(h => h.classList.add('hidden')), 2000);
        }

        function copyLeaveMsgMaster(lessonId) {
            const found = GACLessonState.findLesson(lessonsByMonth, lessonId);
            if (found) copyToClipboard(leaveMsgFor(found.lesson));
        }

        function copyMakeupMsgMaster(lessonId) {
            const found = GACLessonState.findLesson(lessonsByMonth, lessonId);
            if (found) copyToClipboard(makeupMsgFor(found.lesson));
        }

        function getWhatsAppPhone(phone) {
            const digits = String(phone || '').replace(/\D/g, '');
            if (!digits) return '';
            if (digits.startsWith('00')) return digits.slice(2);
            if (digits.startsWith('852')) return digits;
            return `852${digits.replace(/^0/, '')}`;
        }

        function openWhatsAppMessage(lessonId, messageType) {
            const found = GACLessonState.findLesson(lessonsByMonth, lessonId);
            if (!found) return;
            const lesson = found.lesson;
            // 有對應的發送中心條目 → 走同一條路（開 WhatsApp＋按 waSentMode 標記已開啟／切回詢問／自動已發），兩邊狀態一致
            const key = lessonEntryKey(lessonId, messageType);
            if (sendLog[key]) {
                sendWhatsApp(key);
                renderMasterScheduleList(); // 列上的「已開啟／✓ 已發」徽章
                return;
            }
            const phone = getWhatsAppPhone(lesson.phone);
            if (!phone) {
                alert('此學生沒有可用的 WhatsApp 電話號碼。');
                return;
            }

            const message = lessonMsgByType(messageType, lesson);
            const whatsappUrl = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`;
            window.open(whatsappUrl, '_blank', 'noopener');
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('📋 已複製訊息');
            });
        }

        // 日曆 LOCATION 狀態碼（art-rate-data.js CALENDAR_STATUS_CODES 契約：L/SL/TL/MU/NS）
        function getLocationText(lesson) {
            if (lesson.status === 'LEAVE') return lesson.leaveType || 'L';
            if (lesson.status === 'NOSHOW') return 'NS';
            if (lesson.isMakeup) return 'MU';
            return '';
        }

        function getLeaveText(type) {
            switch(type) {
                case 'L': return '事假 Leave';
                case 'SL': return '病假 Sick Leave';
                case 'TL': return '導師請假 Tutor Leave';
                default: return type;
            }
        }

        function getWeekdayName(day) {
            if (day === null || day === undefined || day === '') return '—';
            return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][Number(day)] || '—';
        }

