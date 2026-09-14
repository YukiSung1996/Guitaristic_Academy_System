window.onload = function() {
            const stored = localStorage.getItem('demo_music_academy_students_v1');
            if (stored) {
                try {
                    studentDatabase = JSON.parse(stored);
                } catch(e) {
                    studentDatabase = [...defaultStudents];
                }
            } else {
                studentDatabase = [...defaultStudents];
                saveToLocalStorage();
            }

            const todayStr = new Date().toISOString().slice(0, 7) + "-01";
            document.getElementById('startDateOverride').value = todayStr;

            populateSelectOptions();
            renderBatchCheckboxes();
            renderStudentTable();
            updateDashboardKPIs();
        };

        function saveToLocalStorage() {
            localStorage.setItem('demo_music_academy_students_v1', JSON.stringify(studentDatabase));
            updateDashboardKPIs();
        }

        // Navigation Tab Switching
        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

            document.getElementById(tabId).classList.remove('hidden');
            document.getElementById(`tab_${tabId}`).classList.add('active');

            if (tabId === 'databaseTab') {
                renderStudentTable();
            }
        }

        function getStudentScheduleForMonth(student, targetMonthStr) {
            if (student.effectiveMonth && targetMonthStr >= student.effectiveMonth && student.futureWeekday !== null) {
                return { weekday: student.futureWeekday, time: student.futureTime, isFuture: true };
            }
            return { weekday: student.weekday, time: student.time, isFuture: false };
        }

        function populateSelectOptions() {
            const select = document.getElementById('studentSelect');
            select.innerHTML = '<option value="">-- 請選擇學生或班際課程 --</option>';

            const groupOptGroup = document.createElement('optgroup');
            groupOptGroup.label = '🎓 班際課程 Group Courses';
            groupCourses.forEach((course, index) => {
                const opt = document.createElement('option');
                opt.value = `GROUP_${index}`;
                opt.textContent = `${course.name} [${course.duration} mins, ${course.totalLessons} 堂]`;
                groupOptGroup.appendChild(opt);
            });
            select.appendChild(groupOptGroup);

            const tutors = [...new Set(studentDatabase.map(s => s.tutor))];
            tutors.forEach(tutorName => {
                const group = document.createElement('optgroup');
                group.label = `👨‍🏫 導師：${tutorName}`;
                studentDatabase.forEach((student, index) => {
                    if (student.tutor === tutorName) {
                        const opt = document.createElement('option');
                        opt.value = `STUDENT_${index}`;
                        opt.textContent = `${student.id} - ${student.name} (${student.program})`;
                        group.appendChild(opt);
                    }
                });
                select.appendChild(group);
            });
            const tutorFilter = document.getElementById('singleStudentTutorFilter');
            if (tutorFilter) {
                tutorFilter.innerHTML = '<option value="ALL">全部導師</option>' + tutors.map(tutor => `<option value="${tutor}">${tutor}</option>`).join('');
            }
            renderSingleStudentPicker();
        }

        function renderSingleStudentPicker() {
            const picker = document.getElementById('singleStudentPicker');
            if (!picker) return;
            const selectedValue = document.getElementById('studentSelect')?.value || '';
            const search = (document.getElementById('singleStudentSearch')?.value || '').trim().toLowerCase();
            const tutor = document.getElementById('singleStudentTutorFilter')?.value || 'ALL';
            const allItems = [
                ...groupCourses.map((course, index) => ({
                    value: `GROUP_${index}`,
                    label: course.name,
                    detail: `${course.duration} 分鐘 · ${course.totalLessons} 堂 · ${course.tutor}`,
                    tutor: course.tutor,
                    search: `${course.id} ${course.name} ${course.program} ${course.tutor}`.toLowerCase(),
                    group: true
                })),
                ...studentDatabase.map((student, index) => ({
                    value: `STUDENT_${index}`,
                    label: `${student.id} ${student.name}`,
                    detail: `${student.tutor} · ${getWeekdayName(student.weekday)} ${student.time}`,
                    tutor: student.tutor,
                    search: `${student.id} ${student.name} ${student.phone || ''} ${student.email || ''} ${student.program}`.toLowerCase(),
                    group: false
                }))
            ];
            const items = allItems.filter(item => (tutor === 'ALL' || item.tutor === tutor) && (!search || item.search.includes(search)));
            picker.innerHTML = items.map(item => `<label class="single-student-option ${item.group ? 'group-option' : ''}"><input type="checkbox" value="${item.value}" ${item.value === selectedValue ? 'checked' : ''} onchange="selectSingleStudent(this)"><span><strong>${item.label}</strong><small>${item.detail}</small></span></label>`).join('') || '<span class="text-xs text-slate-500">沒有符合的學生或班際課程。</span>';
            const selection = document.getElementById('singleStudentSelection');
            if (selection) selection.textContent = selectedValue ? `已選：${allItems.find(item => item.value === selectedValue)?.label || '目前項目'}` : '尚未選擇學生或班際課程。';
        }

        function selectSingleStudent(input) {
            document.querySelectorAll('#singleStudentPicker input[type="checkbox"]').forEach(item => { item.checked = item === input; });
            const select = document.getElementById('studentSelect');
            select.value = input.checked ? input.value : '';
            loadStudentData();
            renderSingleStudentPicker();
        }

        function updateDashboardKPIs() {
            document.getElementById('statTotalStudents').textContent = studentDatabase.length;
            document.getElementById('statTotalLessons').textContent = masterScheduleEvents.length;

            const makeupCount = masterScheduleEvents.filter(e => e.status === 'MAKEUP' || e.status === 'LEAVE').length;
            document.getElementById('statMakeupCount').textContent = makeupCount;

            const clashCount = masterScheduleEvents.filter(e => e.isClash).length;
            document.getElementById('statClashCount').textContent = clashCount;

            const banner = document.getElementById('clashWarningBanner');
            if (clashCount > 0) {
                banner.classList.remove('hidden');
            } else {
                banner.classList.add('hidden');
            }
        }

        function getFullDatesFromStart(startDateStr, weekday, totalLessons) {
            const dates = [];
            let [y, m, d] = startDateStr.split('-').map(Number);
            let dateObj = new Date(y, m - 1, d);

            while (dateObj.getDay() !== weekday) {
                dateObj.setDate(dateObj.getDate() + 1);
            }

            if (totalLessons) {
                while (dates.length < totalLessons) {
                    const cy = dateObj.getFullYear();
                    const cm = String(dateObj.getMonth() + 1).padStart(2, '0');
                    const cd = String(dateObj.getDate()).padStart(2, '0');
                    dates.push(`${cy}-${cm}-${cd}`);
                    dateObj.setDate(dateObj.getDate() + 7);
                }
            } else {
                const targetMonth = dateObj.getMonth();
                const targetYear = dateObj.getFullYear();
                while (dateObj.getMonth() === targetMonth && dateObj.getFullYear() === targetYear) {
                    if (dateObj.getDay() === weekday) {
                        const cy = dateObj.getFullYear();
                        const cm = String(dateObj.getMonth() + 1).padStart(2, '0');
                        const cd = String(dateObj.getDate()).padStart(2, '0');
                        dates.push(`${cy}-${cm}-${cd}`);
                    }
                    dateObj.setDate(dateObj.getDate() + 1);
                }
            }
            return dates.join(', ');
        }

        function autoCalculateDays(forceResetFromDb = false) {
            const selectVal = document.getElementById('studentSelect').value;
            const targetMonthVal = document.getElementById('targetMonth').value;
            const startDateInput = document.getElementById('startDateOverride').value;

            if (forceResetFromDb && selectVal.startsWith('STUDENT_')) {
                const idx = parseInt(selectVal.replace('STUDENT_', ''));
                const s = studentDatabase[idx];
                const sched = getStudentScheduleForMonth(s, targetMonthVal);
                document.getElementById('dayOfWeek').value = sched.weekday;
                document.getElementById('startTime').value = sched.time;
            }

            const dayOfWeek = parseInt(document.getElementById('dayOfWeek').value);
            if (!startDateInput || isNaN(dayOfWeek)) return;

            if (selectVal.startsWith('GROUP_')) {
                const groupIdx = parseInt(selectVal.replace('GROUP_', ''));
                const gc = groupCourses[groupIdx];
                document.getElementById('customDays').value = getFullDatesFromStart(startDateInput, dayOfWeek, gc.totalLessons);
            } else {
                document.getElementById('customDays').value = getFullDatesFromStart(startDateInput, dayOfWeek, null);
            }
        }

        function loadStudentData() {
            const selectVal = document.getElementById('studentSelect').value;
            const deleteBtn = document.getElementById('deleteBtn');
            const saveTimeBtn = document.getElementById('saveTimeBtn');
            const noticeBox = document.getElementById('studentStatusNotice');
            const targetMonthInput = document.getElementById('targetMonth');

            if (selectVal === "") {
                clearForm();
                return;
            }

            if (selectVal.startsWith('GROUP_')) {
                const groupIdx = parseInt(selectVal.replace('GROUP_', ''));
                const gc = groupCourses[groupIdx];

                document.getElementById('studentId').value = gc.id;
                document.getElementById('studentName').value = gc.name;
                document.getElementById('studentPhone').value = gc.phone || '-';
                document.getElementById('studentEmail').value = gc.email || '-';
                document.getElementById('tutor').value = gc.tutor;
                document.getElementById('levelFormat').value = `${gc.program} - ${gc.level}`;
                document.getElementById('dayOfWeek').value = gc.weekday;
                document.getElementById('startTime').value = gc.time;
                document.getElementById('duration').value = gc.duration;

                deleteBtn.classList.add('hidden');
                saveTimeBtn.classList.add('hidden');
                
                noticeBox.classList.remove('hidden');
                noticeBox.innerHTML = `🎓 <strong>班際課程：</strong> ${gc.name} (${gc.totalLessons} 堂, ${gc.duration}分鐘)`;
                autoCalculateDays(false);
                return;
            }

            const idx = parseInt(selectVal.replace('STUDENT_', ''));
            const s = studentDatabase[idx];
            const targetMonthVal = targetMonthInput.value;
            const currentSched = getStudentScheduleForMonth(s, targetMonthVal);

            document.getElementById('studentId').value = s.id;
            document.getElementById('studentName').value = s.name;
            document.getElementById('studentPhone').value = s.phone || '';
            document.getElementById('studentEmail').value = s.email || '';
            document.getElementById('tutor').value = s.tutor;
            document.getElementById('levelFormat').value = `${s.program} - ${s.level} (${s.type})`;
            document.getElementById('dayOfWeek').value = currentSched.weekday;
            document.getElementById('startTime').value = currentSched.time;
            document.getElementById('duration').value = s.duration;

            if (s.effectiveMonth) {
                document.getElementById('effectiveMonth').value = s.effectiveMonth;
                noticeBox.classList.remove('hidden');
                noticeBox.innerHTML = `💡 <strong>歷史/新時間備忘：</strong> 原逢 ${getWeekdayName(s.weekday)} ${s.time} ➔ 由 <strong>${s.effectiveMonth}</strong> 起改為 逢 ${getWeekdayName(s.futureWeekday)} ${s.futureTime}`;
            } else {
                document.getElementById('effectiveMonth').value = targetMonthVal;
                noticeBox.classList.add('hidden');
            }

            deleteBtn.classList.remove('hidden');
            saveTimeBtn.classList.remove('hidden');
            autoCalculateDays(false);
        }

        function deleteCurrentStudent() {
            const selectVal = document.getElementById('studentSelect').value;
            if (!selectVal.startsWith('STUDENT_')) return;
            const idx = parseInt(selectVal.replace('STUDENT_', ''));
            deleteStudentFromDb(idx);
            clearForm();
        }

        function onTargetMonthChange() {
            const targetMonthVal = document.getElementById('targetMonth').value;
            document.getElementById('startDateOverride').value = targetMonthVal + "-01";
            document.getElementById('effectiveMonth').value = targetMonthVal;
            autoCalculateDays(true);
        }

        function updateStudentTimeConfig() {
            const selectVal = document.getElementById('studentSelect').value;
            if (!selectVal.startsWith('STUDENT_')) {
                alert('請先選擇要變更時間的常規學生！');
                return;
            }

            const idx = parseInt(selectVal.replace('STUDENT_', ''));
            const selectedWeekday = parseInt(document.getElementById('dayOfWeek').value);
            const selectedTime = document.getElementById('startTime').value;
            const effMonth = document.getElementById('effectiveMonth').value;

            if (!selectedTime || !effMonth) {
                alert('請完整選擇「上課時間」與「生效月份」！');
                return;
            }

            const s = studentDatabase[idx];
            s.phone = document.getElementById('studentPhone').value.trim();
            s.email = document.getElementById('studentEmail').value.trim();
            s.effectiveMonth = effMonth;
            s.futureWeekday = selectedWeekday;
            s.futureTime = selectedTime;

            saveToLocalStorage();
            populateSelectOptions();
            renderBatchCheckboxes();

            document.getElementById('studentSelect').value = `STUDENT_${idx}`;
            loadStudentData();

            alert(`✅ 已成功保存「${s.name}」的時間與聯絡變更！\n• ${effMonth} 起生效新時間`);
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
                const div = document.createElement('div');
                div.className = 'flex items-center space-x-2 text-xs bg-white p-2 rounded-lg border border-slate-200 hover:border-sky-300 transition';

                div.innerHTML = `
                    <input type="checkbox" class="batch-student-chk accent-sky-600 rounded" value="${index}" id="batch_chk_${index}" checked>
                    <label for="batch_chk_${index}" class="cursor-pointer font-medium truncate flex-1">
                        <span class="font-bold text-slate-800">${student.id}</span> ${student.name}
                        <span class="text-sky-600 font-semibold">(${getWeekdayName(sched.weekday)} ${sched.time})</span>
                    </label>
                `;
                grid.appendChild(div);
            });
        }

        function selectAllStudents(checked) {
            document.querySelectorAll('.batch-student-chk').forEach(chk => chk.checked = checked);
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

        function generateMasterSchedule() {
            const batchMonthVal = document.getElementById('batchMonth').value;
            if (!batchMonthVal) return;

            const [year, month] = batchMonthVal.split('-').map(Number);
            const checkboxes = document.querySelectorAll('.batch-student-chk:checked');
            
            if (checkboxes.length === 0) {
                alert('請至少勾選一名常規學生！');
                return;
            }

            masterScheduleEvents = [];

            checkboxes.forEach(chk => {
                const student = studentDatabase[parseInt(chk.value)];
                const sched = getStudentScheduleForMonth(student, batchMonthVal);
                const days = getMonthDaysForWeekday(year, month, sched.weekday);
                const formattedMonthYear = `${String(month).padStart(2, '0')}/${year}`;
                const totalRegular = days.length;

                days.forEach((day, idx) => {
                    const lessonNum = idx + 1;
                    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const [lHours, lMinutes] = sched.time.split(':').map(Number);
                    const startDateTime = new Date(year, month - 1, day, lHours, lMinutes, 0);
                    const endDateTime = new Date(startDateTime.getTime() + student.duration * 60000);

                    const title = `${student.id} ${student.name}([${lessonNum}/${totalRegular}] ${formattedMonthYear})`;

                    masterScheduleEvents.push({
                        id: `${student.id}_${idx}_${dateStr}`,
                        studentId: student.id,
                        studentName: student.name,
                        phone: student.phone || '',
                        email: student.email || '',
                        lessonNum: lessonNum,
                        totalRegular: totalRegular,
                        monthYearStr: formattedMonthYear,
                        tutor: student.tutor,
                        levelFormat: `${student.program} - ${student.level} (${student.type})`,
                        dateStr: dateStr,
                        timeStr: sched.time,
                        duration: student.duration,
                        start: startDateTime,
                        end: endDateTime,
                        status: 'NORMAL',
                        leaveType: '',
                        isClash: false,
                        title: title
                    });
                });
            });

            // Run Clash Detector
            detectScheduleClashes();

            buildMonthWeeksData(year, month);
            sortAndRenderMasterSchedule();
            updateDashboardKPIs();
        }

        // Clash Detection Logic: Checks if tutor has overlapping timeslots
        function detectScheduleClashes() {
            for (let i = 0; i < masterScheduleEvents.length; i++) {
                masterScheduleEvents[i].isClash = false;
            }

            for (let i = 0; i < masterScheduleEvents.length; i++) {
                for (let j = i + 1; j < masterScheduleEvents.length; j++) {
                    const e1 = masterScheduleEvents[i];
                    const e2 = masterScheduleEvents[j];

                    if (e1.tutor === e2.tutor && e1.dateStr === e2.dateStr && e1.status !== 'LEAVE' && e2.status !== 'LEAVE') {
                        // Check time overlap: start1 < end2 AND start2 < end1
                        if (e1.start < e2.end && e2.start < e1.end) {
                            e1.isClash = true;
                            e2.isClash = true;
                        }
                    }
                }
            }
        }

        function sortAndRenderMasterSchedule() {
            masterScheduleEvents.sort((a, b) => a.start - b.start);
            renderMasterScheduleList();
            renderMasterCalendarView();
            renderMasterWeekView();
        }

        function switchView(mode) {
            currentViewMode = mode;
            const listEl = document.getElementById('masterScheduleList');
            const calEl = document.getElementById('masterCalendarView');
            const weekEl = document.getElementById('masterWeekView');

            listEl.classList.add('hidden');
            calEl.classList.add('hidden');
            weekEl.classList.add('hidden');

            document.querySelectorAll('#masterScheduleWrapper .inline-flex button').forEach(b => b.classList.remove('bg-white', 'text-sky-600', 'shadow-sm'));

            if (mode === 'calendar') {
                calEl.classList.remove('hidden');
                document.getElementById('btnCalView').classList.add('bg-white', 'text-sky-600', 'shadow-sm');
            } else if (mode === 'week') {
                weekEl.classList.remove('hidden');
                document.getElementById('btnWeekView').classList.add('bg-white', 'text-sky-600', 'shadow-sm');
                renderMasterWeekView();
            } else {
                listEl.classList.remove('hidden');
                document.getElementById('btnListView').classList.add('bg-white', 'text-sky-600', 'shadow-sm');
                renderMasterScheduleList();
            }
        }

        function onWeekSelectChange() {
            if (currentViewMode === 'week') {
                renderMasterWeekView();
            } else if (currentViewMode === 'list') {
                renderMasterScheduleList();
            }
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
            weekSelect.innerHTML = '<option value="ALL">所有週次 (全月份)</option>';

            monthWeeksData.forEach((w, idx) => {
                const validDays = w.filter(d => d !== null);
                const startStr = validDays[0].dateString;
                const endStr = validDays[validDays.length - 1].dateString;

                const option = document.createElement('option');
                option.value = idx;
                option.textContent = `第 ${idx + 1} 週 (${startStr.slice(5)} ~ ${endStr.slice(5)})`;
                weekSelect.appendChild(option);
            });
        }

        function renderMasterScheduleList() {
            const listContainer = document.getElementById('masterScheduleList');
            listContainer.innerHTML = '';

            const weekVal = document.getElementById('weekSelect').value;
            let filteredEvents = [...masterScheduleEvents];

            if (weekVal !== 'ALL' && monthWeeksData && monthWeeksData[parseInt(weekVal)]) {
                const selectedWeekDays = monthWeeksData[parseInt(weekVal)].filter(d => d !== null);
                const startDateStr = selectedWeekDays[0].dateString;
                const endDateStr = selectedWeekDays[selectedWeekDays.length - 1].dateString;
                filteredEvents = filteredEvents.filter(ev => ev.dateStr >= startDateStr && ev.dateStr <= endDateStr);
            }

            if (filteredEvents.length === 0) {
                listContainer.innerHTML = `<div class="text-center py-8 text-slate-400 text-xs">⚠️ 所選範圍內無排定課堂。</div>`;
                return;
            }

            filteredEvents.forEach((ev) => {
                const originalIndex = masterScheduleEvents.findIndex(e => e.id === ev.id);
                const formatISO = (d) => d.getFullYear() +
                    String(d.getMonth() + 1).padStart(2, '0') +
                    String(d.getDate()).padStart(2, '0') + 'T' +
                    String(d.getHours()).padStart(2, '0') +
                    String(d.getMinutes()).padStart(2, '0') + '00';

                let details = `導師：${ev.tutor}\n級別：${ev.levelFormat}`;
                if (ev.phone) details += `\n電話：${ev.phone}`;
                if (ev.email) details += `\n電郵：${ev.email}`;
                if (ev.status === 'MAKEUP') details += `\n備註：Make up class`;
                if (ev.status === 'LEAVE') details += `\n狀態：請假取消 [${getLeaveText(ev.leaveType)}]`;

                const locationStr = getLocationText(ev.status, ev.leaveType);
                const gcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(ev.title)}&dates=${formatISO(ev.start)}/${formatISO(ev.end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent(locationStr)}`;

                let bgClass = "bg-sky-50/50 border-l-4 border-sky-500";
                if (ev.status === 'LEAVE') bgClass = "bg-rose-50/50 border-l-4 border-rose-500";
                if (ev.status === 'MAKEUP') bgClass = "bg-emerald-50/50 border-l-4 border-emerald-500";
                if (ev.isClash) bgClass = "bg-amber-50 border-l-4 border-amber-500 ring-1 ring-amber-300";

                const itemHtml = `
                    <div class="${bgClass} p-3 rounded-r-xl border-y border-r border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
                        <div class="space-y-1 flex-1">
                            <div class="flex items-center gap-1.5 flex-wrap">
                                ${ev.isClash ? `<span class="bg-amber-500 text-white font-bold px-1.5 py-0.5 rounded text-[10px]">⚠️ 撞堂重疊</span>` : ''}
                                ${ev.status === 'LEAVE' ? `<span class="bg-rose-500 text-white font-bold px-1.5 py-0.5 rounded text-[10px]">已請假 (${ev.leaveType})</span>` : ''}
                                ${ev.status === 'MAKEUP' ? `<span class="bg-emerald-600 text-white font-bold px-1.5 py-0.5 rounded text-[10px]">MU 補堂</span>` : ''}
                                <span class="bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-semibold text-[10px]">${ev.tutor}</span>
                                <strong class="text-slate-800">${ev.start.getFullYear()}年${ev.start.getMonth()+1}月${ev.start.getDate()}日 (${getWeekdayName(ev.start.getDay())})</strong>
                                <span class="text-sky-700 font-bold">${ev.timeStr}</span>
                                <span class="font-bold text-slate-900">${ev.studentName}</span> (${ev.studentId})
                                ${ev.phone ? `<span class="text-slate-500 text-[11px]"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i> ${ev.phone}</span>` : ''}
                            </div>
                            <div class="text-slate-500 text-[11px]">📅 ${ev.title} ${locationStr ? `| 📍 地點: ${locationStr}` : ''} ${ev.email ? `| ✉️ ${ev.email}` : ''}</div>

                            <!-- Reschedule Box -->
                            <div id="masterRescheduleBox_${originalIndex}" class="hidden pt-2 border-t border-slate-200 mt-2 space-y-2">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span>假別:</span>
                                    <select id="masterLeaveType_${originalIndex}" class="p-1 border rounded bg-white">
                                        <option value="L">L - 事假 (Leave)</option>
                                        <option value="SL">SL - 病假 (Sick Leave)</option>
                                        <option value="TL">TL - 導師請假 (Tutor Leave)</option>
                                    </select>
                                    <span>補堂日期:</span>
                                    <input type="date" id="masterNewDate_${originalIndex}" value="${ev.dateStr}" class="p-1 border rounded bg-white">
                                    <span>時間:</span>
                                    <input type="time" id="masterNewTime_${originalIndex}" value="${ev.timeStr}" class="p-1 border rounded bg-white">
                                    <button onclick="saveMasterReschedule(${originalIndex})" class="px-2 py-1 bg-emerald-600 text-white rounded font-bold">確認補堂</button>
                                    <button onclick="toggleMasterRescheduleBox(${originalIndex})" class="px-2 py-1 bg-slate-200 text-slate-700 rounded">取消</button>
                                </div>
                            </div>
                        </div>

                        <div class="flex items-center gap-1.5 self-end md:self-center">
                            ${ev.status === 'LEAVE' ? `<button onclick="copyLeaveMsgMaster(${originalIndex})" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-copy"></i> 複製請假</button><button onclick="openWhatsAppMessage(${originalIndex}, 'leave')" class="px-2.5 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-lg font-semibold flex items-center gap-1" title="在 WhatsApp Web 預填請假訊息"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>` : ''}
                            ${ev.status === 'MAKEUP' ? `<button onclick="copyMakeupMsgMaster(${originalIndex})" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-copy"></i> 複製補堂</button><button onclick="openWhatsAppMessage(${originalIndex}, 'makeup')" class="px-2.5 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-lg font-semibold flex items-center gap-1" title="在 WhatsApp Web 預填補堂訊息"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>` : ''}
                            ${ev.status === 'NORMAL' ? `<button onclick="toggleMasterRescheduleBox(${originalIndex})" class="px-2.5 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-pen"></i> 請假/調堂</button>` : ''}
                            <a href="${gcalUrl}" target="_blank" class="px-2.5 py-1.5 ${ev.status === 'LEAVE' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'} text-white rounded-lg font-semibold flex items-center gap-1">
                                <i class="fa-solid fa-calendar-plus"></i> ${ev.status === 'LEAVE' ? '請假紀錄' : '+ Calendar'}
                            </a>
                        </div>
                    </div>
                `;
                listContainer.innerHTML += itemHtml;
            });
        }

        function renderMasterCalendarView() {
            const calContainer = document.getElementById('masterCalendarView');
            const batchMonthVal = document.getElementById('batchMonth').value;
            if (!batchMonthVal) return;

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
                const dayEvents = masterScheduleEvents.filter(e => e.dateStr === dateString);

                gridHtml += `
                    <div class="bg-white p-1.5 min-h-[100px] flex flex-col space-y-1">
                        <div class="text-[11px] font-bold text-slate-500">${day}</div>
                `;

                dayEvents.forEach(ev => {
                    let pillStyle = ev.tutor === 'Instructor A' ? 'cal-pill-eric' : 'cal-pill-tony';
                    if (ev.status === 'LEAVE') pillStyle = 'cal-pill-leave';
                    if (ev.status === 'MAKEUP') pillStyle = 'cal-pill-makeup';
                    if (ev.isClash) pillStyle = 'cal-pill-clash';

                    gridHtml += `
                        <div class="${pillStyle} text-[10px] p-1 rounded leading-tight truncate" title="${ev.timeStr} ${ev.studentName} (${ev.tutor}) | Phone: ${ev.phone}">
                            <strong>${ev.timeStr}</strong> ${ev.studentName}
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

        function renderMasterWeekView() {
            const weekContainer = document.getElementById('masterWeekView');
            const weekVal = document.getElementById('weekSelect').value;
            const weekIdx = weekVal === 'ALL' ? 0 : parseInt(weekVal || 0);

            if (!monthWeeksData || !monthWeeksData[weekIdx]) return;

            const selectedWeekDays = monthWeeksData[weekIdx];

            let gridHtml = `
                <div class="grid grid-cols-7 gap-px bg-slate-200 border border-slate-200 rounded-xl overflow-hidden min-w-[750px]">
                    <div class="bg-slate-800 text-white text-center py-2 text-xs font-bold">日 (Sun)</div>
                    <div class="bg-slate-800 text-white text-center py-2 text-xs font-bold">一 (Mon)</div>
                    <div class="bg-slate-800 text-white text-center py-2 text-xs font-bold">二 (Tue)</div>
                    <div class="bg-slate-800 text-white text-center py-2 text-xs font-bold">三 (Wed)</div>
                    <div class="bg-slate-800 text-white text-center py-2 text-xs font-bold">四 (Thu)</div>
                    <div class="bg-slate-800 text-white text-center py-2 text-xs font-bold">五 (Fri)</div>
                    <div class="bg-slate-800 text-white text-center py-2 text-xs font-bold">六 (Sat)</div>
            `;

            selectedWeekDays.forEach(dayObj => {
                if (!dayObj) {
                    gridHtml += `<div class="bg-slate-50 min-h-[180px]"></div>`;
                } else {
                    const dayEvents = masterScheduleEvents.filter(e => e.dateStr === dayObj.dateString);
                    gridHtml += `
                        <div class="bg-white p-2 min-h-[180px] flex flex-col space-y-1">
                            <div class="text-xs font-bold text-slate-600 border-b pb-1 mb-1">${dayObj.dateString.slice(5)}</div>
                    `;

                    dayEvents.forEach(ev => {
                        let pillStyle = ev.tutor === 'Instructor A' ? 'cal-pill-eric' : 'cal-pill-tony';
                        if (ev.status === 'LEAVE') pillStyle = 'cal-pill-leave';
                        if (ev.status === 'MAKEUP') pillStyle = 'cal-pill-makeup';
                        if (ev.isClash) pillStyle = 'cal-pill-clash';

                        gridHtml += `
                            <div class="${pillStyle} text-[10px] p-1.5 rounded leading-snug" title="${ev.timeStr} ${ev.studentName} (${ev.phone})">
                                <div class="font-bold">${ev.timeStr} ${ev.studentName}</div>
                                <div class="text-[9px] opacity-75">${ev.tutor} ${ev.phone ? `| 📞 ${ev.phone}` : ''}</div>
                            </div>
                        `;
                    });

                    gridHtml += `</div>`;
                }
            });

            gridHtml += `</div>`;
            weekContainer.innerHTML = gridHtml;
        }

        function toggleMasterRescheduleBox(index) {
            const box = document.getElementById(`masterRescheduleBox_${index}`);
            box.classList.toggle('hidden');
        }

        function saveMasterReschedule(index) {
            const leaveType = document.getElementById(`masterLeaveType_${index}`).value;
            const newDate = document.getElementById(`masterNewDate_${index}`).value;
            const newTime = document.getElementById(`masterNewTime_${index}`).value;

            if (!newDate || !newTime) {
                alert('請選擇補堂日期與時間！');
                return;
            }

            const targetEv = masterScheduleEvents[index];
            targetEv.status = 'LEAVE';
            targetEv.leaveType = leaveType;

            const [y, m, d] = newDate.split('-').map(Number);
            const [h, min] = newTime.split(':').map(Number);
            const startDateTime = new Date(y, m - 1, d, h, min, 0);
            const endDateTime = new Date(startDateTime.getTime() + targetEv.duration * 60000);

            masterScheduleEvents.push({
                id: `${targetEv.studentId}_MU_${Date.now()}`,
                studentId: targetEv.studentId,
                studentName: targetEv.studentName,
                phone: targetEv.phone,
                email: targetEv.email,
                lessonNum: targetEv.lessonNum,
                totalRegular: targetEv.totalRegular,
                monthYearStr: targetEv.monthYearStr,
                tutor: targetEv.tutor,
                levelFormat: targetEv.levelFormat,
                dateStr: newDate,
                timeStr: newTime,
                duration: targetEv.duration,
                start: startDateTime,
                end: endDateTime,
                status: 'MAKEUP',
                leaveType: '',
                makeupForEvent: targetEv,
                title: targetEv.title
            });

            detectScheduleClashes();
            sortAndRenderMasterSchedule();
            updateDashboardKPIs();
        }

        function onBatchMonthChange() {
            renderBatchCheckboxes();
            if (masterScheduleEvents.length > 0) generateMasterSchedule();
        }

        function renderStudentTable() {
            const tbody = document.getElementById('studentTableBody');
            const search = document.getElementById('dbSearch').value.toLowerCase().trim();
            tbody.innerHTML = '';

            studentDatabase.forEach((student, index) => {
                const matchSearch = !search || 
                    student.name.toLowerCase().includes(search) || 
                    student.id.toLowerCase().includes(search) || 
                    (student.phone && student.phone.includes(search)) ||
                    (student.email && student.email.toLowerCase().includes(search)) ||
                    student.tutor.toLowerCase().includes(search) || 
                    student.program.toLowerCase().includes(search);

                if (!matchSearch) return;

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
                    <td class="p-3">${student.program} - ${student.level}</td>
                    <td class="p-3"><span class="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full text-[11px] font-medium">${student.type}</span></td>
                    <td class="p-3 font-medium text-sky-700">${student.tutor}</td>
                    <td class="p-3 font-medium">逢 ${getWeekdayName(student.weekday)} ${student.time}</td>
                    <td class="p-3 text-right whitespace-nowrap">
                        <button onclick="scheduleStudentFromDb(${index})" class="text-sky-600 hover:text-sky-800 px-2 py-1 font-semibold hover:bg-sky-50 rounded-lg transition" title="前往單獨排堂">
                            <i class="fa-solid fa-calendar-days"></i> 排堂
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
        }

        function scheduleStudentFromDb(index) {
            switchTab('studentTab');
            document.getElementById('studentSelect').value = `STUDENT_${index}`;
            loadStudentData();
        }

        function deleteStudentFromDb(index) {
            const s = studentDatabase[index];
            if (confirm(`確定要刪除學生「${s.name} (${s.id})」嗎？`)) {
                studentDatabase.splice(index, 1);
                saveToLocalStorage();
                populateSelectOptions();
                renderBatchCheckboxes();
                renderStudentTable();
            }
        }

        function openStudentModal(editIdx = -1) {
            const modal = document.getElementById('studentModal');
            const title = document.getElementById('modalTitle');
            document.getElementById('editStudentIndex').value = editIdx;

            if (editIdx >= 0) {
                const s = studentDatabase[editIdx];
                title.innerHTML = `<i class="fa-solid fa-user-pen text-amber-500"></i> 編輯學生資料 (ID: ${s.id})`;
                document.getElementById('modalId').value = s.id;
                document.getElementById('modalName').value = s.name;
                document.getElementById('modalPhone').value = s.phone || '';
                document.getElementById('modalEmail').value = s.email || '';
                document.getElementById('modalType').value = s.type || '一對一';
                document.getElementById('modalProgram').value = s.program || '';
                document.getElementById('modalLevel').value = s.level || '';
                document.getElementById('modalTutor').value = s.tutor || 'Instructor A';
                document.getElementById('modalWeekday').value = s.weekday !== undefined ? s.weekday : 1;
                document.getElementById('modalTime').value = s.time || '16:00';
                document.getElementById('modalDuration').value = s.duration || 45;
            } else {
                title.innerHTML = `<i class="fa-solid fa-user-plus text-emerald-500"></i> 新增學生資料`;
                document.getElementById('modalId').value = '';
                document.getElementById('modalName').value = '';
                document.getElementById('modalPhone').value = '';
                document.getElementById('modalEmail').value = '';
                document.getElementById('modalType').value = '一對一';
                document.getElementById('modalProgram').value = '';
                document.getElementById('modalLevel').value = '';
                document.getElementById('modalTutor').value = 'Instructor A';
                document.getElementById('modalWeekday').value = 1;
                document.getElementById('modalTime').value = '16:00';
                document.getElementById('modalDuration').value = 45;
            }

            modal.classList.remove('hidden');
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
            const weekday = parseInt(document.getElementById('modalWeekday').value);
            const time = document.getElementById('modalTime').value;
            const duration = parseInt(document.getElementById('modalDuration').value);

            if (!id || !name) {
                alert('請完整填寫學生 ID 與姓名！');
                return;
            }

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
                student.weekday = weekday;
                student.time = time;
                student.duration = duration;

                alert(`已成功更新學生: ${name} (${id})`);
            } else {
                // Add New Student
                studentDatabase.push({
                    id, name, phone, email, type, program, level, duration, tutor, weekday, time,
                    effectiveMonth: "", futureWeekday: null, futureTime: ""
                });

                alert(`已新增學生: ${name} (${id})`);
            }

            saveToLocalStorage();
            populateSelectOptions();
            renderBatchCheckboxes();
            renderStudentTable();
            closeStudentModal();
        }

        function clearForm() {
            document.getElementById('studentId').value = '';
            document.getElementById('studentName').value = '';
            document.getElementById('studentPhone').value = '';
            document.getElementById('studentEmail').value = '';
            document.getElementById('startTime').value = '';
            document.getElementById('customDays').value = '';
            document.getElementById('deleteBtn').classList.add('hidden');
            document.getElementById('saveTimeBtn').classList.add('hidden');
            document.getElementById('resultCard').classList.add('hidden');
            document.getElementById('studentStatusNotice').classList.add('hidden');
        }

        function generateSchedule() {
            const studentId = document.getElementById('studentId').value.trim();
            const studentName = document.getElementById('studentName').value.trim();
            const targetMonthVal = document.getElementById('targetMonth').value;
            const startTime = document.getElementById('startTime').value;
            const customDaysInput = document.getElementById('customDays').value.trim();

            if (!studentId || !studentName || !startTime || !customDaysInput) {
                alert('請完整填寫學生資料與日期！');
                return;
            }

            const parsedDates = parseCustomDates(customDaysInput, targetMonthVal);
            generatedLessons = parsedDates.map((dObj, idx) => ({
                lessonNum: idx + 1,
                date: `${dObj.year}-${String(dObj.month).padStart(2, '0')}-${String(dObj.day).padStart(2, '0')}`,
                time: startTime,
                status: 'NORMAL',
                leaveType: '',
                makeupForIndex: null
            }));

            renderSingleScheduleList();
            document.getElementById('resultCard').classList.remove('hidden');
        }

        function parseCustomDates(inputStr, defaultMonthStr) {
            const items = inputStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
            const result = [];

            items.forEach(item => {
                if (item.includes('-')) {
                    const parts = item.split('-').map(Number);
                    if (parts.length === 3) result.push({ year: parts[0], month: parts[1], day: parts[2] });
                } else {
                    const d = parseInt(item);
                    if (!isNaN(d) && defaultMonthStr) {
                        const [y, m] = defaultMonthStr.split('-').map(Number);
                        result.push({ year: y, month: m, day: d });
                    }
                }
            });
            return result;
        }

        function renderSingleScheduleList() {
            const listContainer = document.getElementById('scheduleList');
            const studentId = document.getElementById('studentId').value.trim();
            const studentName = document.getElementById('studentName').value.trim();
            const phone = document.getElementById('studentPhone').value.trim();
            const email = document.getElementById('studentEmail').value.trim();
            const tutor = document.getElementById('tutor').value;
            const levelFormat = document.getElementById('levelFormat').value.trim();
            const duration = parseInt(document.getElementById('duration').value);

            listContainer.innerHTML = '';
            const totalRegular = generatedLessons.filter(l => l.status !== 'MAKEUP').length;

            generatedLessons.forEach((lesson) => {
                const [lYear, lMonth, lDay] = lesson.date.split('-').map(Number);
                const title = `${studentId} ${studentName}([${lesson.lessonNum}/${totalRegular}] ${String(lMonth).padStart(2, '0')}/${lYear})`;

                const [lHours, lMinutes] = lesson.time.split(':').map(Number);
                const startDateTime = new Date(lYear, lMonth - 1, lDay, lHours, lMinutes, 0);
                const endDateTime = new Date(startDateTime.getTime() + duration * 60000);
                const calendarUrl = buildGoogleCalendarUrl(
                    title,
                    startDateTime,
                    endDateTime,
                    `導師：${tutor}\n級別：${levelFormat}${phone ? `\n電話：${phone}` : ''}${email ? `\n電郵：${email}` : ''}`
                );

                const itemHtml = `
                    <div class="bg-slate-50 border p-3 rounded-xl flex flex-col md:flex-row md:justify-between md:items-center gap-3 text-xs">
                        <div>
                            <strong class="text-slate-800">${title}</strong>
                            <div class="text-slate-500 mt-0.5">${lesson.date} (${getWeekdayName(startDateTime.getDay())}) ${lesson.time} [${tutor} - ${levelFormat}]</div>
                            ${(phone || email) ? `<div class="text-[11px] text-slate-400 mt-0.5">${phone ? `📞 ${phone}` : ''} ${email ? `✉️ ${email}` : ''}</div>` : ''}
                        </div>
                        <div class="flex items-center gap-1.5 self-end md:self-center">
                            ${phone ? `<button onclick="openWhatsAppLesson(${generatedLessons.indexOf(lesson)})" class="px-2.5 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded-lg font-semibold flex items-center gap-1"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>` : ''}
                            <a href="${calendarUrl}" target="_blank" rel="noopener" class="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-calendar-plus"></i> + Calendar</a>
                        </div>
                    </div>
                `;
                listContainer.innerHTML += itemHtml;
            });
        }

        function buildGoogleCalendarUrl(title, start, end, details) {
            const formatISO = (date) => date.getFullYear() +
                String(date.getMonth() + 1).padStart(2, '0') +
                String(date.getDate()).padStart(2, '0') + 'T' +
                String(date.getHours()).padStart(2, '0') +
                String(date.getMinutes()).padStart(2, '0') + '00';
            return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${formatISO(start)}/${formatISO(end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent('')}`;
        }

        function openWhatsAppLesson(index) {
            const lesson = generatedLessons[index];
            const phone = getWhatsAppPhone(document.getElementById('studentPhone').value.trim());
            if (!phone) {
                alert('此學生沒有可用的 WhatsApp 電話號碼。');
                return;
            }

            const studentName = document.getElementById('studentName').value.trim();
            const [year, month, day] = lesson.date.split('-').map(Number);
            const message = `你好，已確認 ${studentName} 於 ${year}年${month}月${day}日 (${getWeekdayName(new Date(year, month - 1, day).getDay())}) ${lesson.time} 上課，謝謝！`;
            const whatsappUrl = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`;
            window.open(whatsappUrl, '_blank', 'noopener');
        }

        function openGoogleCalendarEvents(events) {
            if (!events.length) {
                alert('目前沒有已生成的課堂可加入 Google Calendar！');
                return;
            }
            events.forEach((event, index) => {
                const title = event.title || `${event.studentId} ${event.studentName}`;
                const details = `導師：${event.tutor || ''}${event.phone ? `\n電話：${event.phone}` : ''}${event.email ? `\n電郵：${event.email}` : ''}${event.status === 'LEAVE' ? '\n狀態：請假' : event.status === 'MAKEUP' ? '\n狀態：補堂' : ''}`;
                const url = buildGoogleCalendarUrl(title, event.start, event.end, details);
                window.open(url, '_blank', 'noopener');
            });
            if (events.length > 1) alert(`已開啟 ${events.length} 個 Google Calendar 建立頁面，請逐一確認儲存。`);
        }

        function openMasterGoogleCalendar() {
            if (masterScheduleEvents.length === 0) {
                alert('目前沒有已生成的課堂可加入 Google Calendar！');
                return;
            }
            openGoogleCalendarEvents(masterScheduleEvents);
        }

        function openSingleGoogleCalendar() {
            if (generatedLessons.length === 0) {
                alert('請先生成個人或班際課堂。');
                return;
            }
            const studentId = document.getElementById('studentId').value.trim();
            const studentName = document.getElementById('studentName').value.trim();
            const phone = document.getElementById('studentPhone').value.trim();
            const email = document.getElementById('studentEmail').value.trim();
            const duration = parseInt(document.getElementById('duration').value);

            const events = generatedLessons.map(l => {
                const [y, m, d] = l.date.split('-').map(Number);
                const [h, min] = l.time.split(':').map(Number);
                const start = new Date(y, m - 1, d, h, min, 0);
                const end = new Date(start.getTime() + duration * 60000);
                return {
                    title: `${studentId} ${studentName}`,
                    phone, email,
                    start, end,
                    status: l.status,
                    leaveType: l.leaveType
                };
            });

            openGoogleCalendarEvents(events);
        }

        function downloadMasterICS() {
            if (masterScheduleEvents.length === 0) {
                alert('目前沒有已生成的課堂可匯出！');
                return;
            }
            buildICSFile(masterScheduleEvents, `Guitaristic_Academy_${document.getElementById('batchMonth').value || 'schedule'}.ics`);
        }

        function downloadSingleICS() {
            if (generatedLessons.length === 0) {
                alert('請先生成個人或班際課堂。');
                return;
            }
            const studentId = document.getElementById('studentId').value.trim();
            const studentName = document.getElementById('studentName').value.trim();
            const phone = document.getElementById('studentPhone').value.trim();
            const email = document.getElementById('studentEmail').value.trim();
            const duration = parseInt(document.getElementById('duration').value);
            const events = generatedLessons.map(lesson => {
                const [year, month, day] = lesson.date.split('-').map(Number);
                const [hours, minutes] = lesson.time.split(':').map(Number);
                const start = new Date(year, month - 1, day, hours, minutes, 0);
                return {title: `${studentId} ${studentName}`, phone, email, start, end: new Date(start.getTime() + duration * 60000), status: lesson.status};
            });
            const filename = `${studentId || 'student'}_${studentName || 'schedule'}_schedule.ics`.replace(/[\\/:*?"<>|]/g, '_');
            buildICSFile(events, filename);
        }

        // Keep the original export function names available for existing links or bookmarks.
        function exportMasterICS() { downloadMasterICS(); }
        function exportSingleICS() { downloadSingleICS(); }

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

                icsContent.push(
                    "BEGIN:VEVENT",
                    `SUMMARY:${ev.title}`,
                    `DTSTART:${formatICSDate(ev.start)}`,
                    `DTEND:${formatICSDate(ev.end)}`,
                    `DESCRIPTION:${desc}`,
                    "STATUS:CONFIRMED",
                    "END:VEVENT"
                );
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

        // JSON Backup/Restore
        function exportJSONDatabase() {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(studentDatabase, null, 2));
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute("href", dataStr);
            downloadAnchor.setAttribute("download", `Demo_Music_Academy_Students_Backup_${new Date().toISOString().slice(0,10)}.json`);
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
        }

        function importJSONDatabase(event) {
            const fileReader = new FileReader();
            fileReader.onload = function(e) {
                try {
                    const importedData = JSON.parse(e.target.result);
                    if (Array.isArray(importedData)) {
                        studentDatabase = importedData;
                        saveToLocalStorage();
                        populateSelectOptions();
                        renderBatchCheckboxes();
                        renderStudentTable();
                        alert('✅ 已成功匯入資料庫！');
                    }
                } catch(err) {
                    alert('⚠️ 無效的 JSON 檔案格式！');
                }
            };
            fileReader.readAsText(event.target.files[0]);
        }

        function resetToDefaultData() {
            if (confirm('確定要恢復預設學生名單嗎？')) {
                studentDatabase = [...defaultStudents];
                saveToLocalStorage();
                populateSelectOptions();
                renderBatchCheckboxes();
                renderStudentTable();
                alert('已恢復預設資料庫！');
            }
        }

        function copyLeaveMsgMaster(index) {
            const ev = masterScheduleEvents[index];
            const msg = `已確認 ${ev.start.getFullYear()}年${ev.start.getMonth()+1}月${ev.start.getDate()}日 (${getWeekdayName(ev.start.getDay())}) 的課堂請假。`;
            copyToClipboard(msg);
        }

        function copyMakeupMsgMaster(index) {
            const ev = masterScheduleEvents[index];
            const msg = `已確認 ${ev.start.getFullYear()}年${ev.start.getMonth()+1}月${ev.start.getDate()}日 (${getWeekdayName(ev.start.getDay())}) ${ev.timeStr} 進行補課。`;
            copyToClipboard(msg);
        }

        function getWhatsAppPhone(phone) {
            const digits = String(phone || '').replace(/\D/g, '');
            if (!digits) return '';
            if (digits.startsWith('00')) return digits.slice(2);
            if (digits.startsWith('852')) return digits;
            return `852${digits.replace(/^0/, '')}`;
        }

        function openWhatsAppMessage(index, messageType) {
            const ev = masterScheduleEvents[index];
            const phone = getWhatsAppPhone(ev.phone);
            if (!phone) {
                alert('此學生沒有可用的 WhatsApp 電話號碼。');
                return;
            }

            const message = messageType === 'leave'
                ? `已確認 ${ev.start.getFullYear()}年${ev.start.getMonth()+1}月${ev.start.getDate()}日 (${getWeekdayName(ev.start.getDay())}) 的課堂請假。`
                : `已確認 ${ev.start.getFullYear()}年${ev.start.getMonth()+1}月${ev.start.getDate()}日 (${getWeekdayName(ev.start.getDay())}) ${ev.timeStr} 進行補課。`;
            const whatsappUrl = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`;
            window.open(whatsappUrl, '_blank', 'noopener');
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert(`已複製訊息：\n"${text}"`);
            });
        }

        function getLocationText(status, leaveType) {
            if (status === 'MAKEUP') return 'MU';
            if (status === 'LEAVE') return leaveType;
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
            return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][day];
        }

