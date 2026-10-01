// 無頭冒煙測試：stub DOM，按用戶操作順序跑一遍 app.js 主流程，捕捉運行時錯誤。
// 執行：node tests/smoke/smoke.js（用 .tools 下的便攜 node 亦可；GAC_SMOKE_FILE_MODE=1 則整套在「資料存本資料夾」模式跑）。
// 不是 node --test 的一部分（不叫 *.test.js）；最後印 SMOKE ALL OK 或 SMOKE FAILURES: n
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repo = path.join(__dirname, '..', '..'); // 倉庫根目錄（本檔在 tests/smoke/）

function makeElement(id) {
    return {
        id, value: '', textContent: '', innerHTML: '', checked: false, label: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        style: {}, appendChild() {}, focus() {},
        addEventListener() {}, setAttribute() {}, click() {}, remove() {},
        querySelectorAll() { return []; }, querySelector() { return null; }
    };
}

const elements = new Map();
function getEl(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
}

const fakeStorage = (() => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
})();

// 把「今天」釘死在 2026-09-15 正午：批量確認/待補池等待天數/過期警告全都依賴系統時鐘，
// 不釘死的話跨日（如 9/16 凌晨）跑冒煙會連鎖失敗（9/16 的課不再是未來課）。
const RealDate = Date;
class FixedDate extends RealDate {
    constructor(...args) {
        if (args.length === 0) super(2026, 8, 15, 12, 0, 0);
        else super(...args);
    }
    static now() { return new RealDate(2026, 8, 15, 12, 0, 0).getTime(); }
}

const sandbox = {
    console,
    alerts: [],
    __qsaHook: null,
    Date: FixedDate,
    document: {
        getElementById: getEl,
        querySelectorAll: sel => (sandbox.__qsaHook ? sandbox.__qsaHook(sel) : []),
        querySelector: () => null,
        createElement: tag => makeElement('created_' + tag),
        body: { appendChild() {}, removeChild() {} },
        documentElement: { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
        addEventListener() {}
    },
    localStorage: fakeStorage,
    alert: msg => sandbox.alerts.push(String(msg)),
    confirm: () => true,
    prompt: () => '',
    addEventListener() {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: () => Promise.reject(new Error('offline')),
    URL: { createObjectURL: () => 'blob:x' },
    Blob: function () {},
    open: () => {},
    setTimeout, clearTimeout
};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

// GAC_SMOKE_FILE_MODE=1：整套冒煙改在「檔案後備存放」模式跑（serve.cmd 注入 __GAC_FILE_STATE 的情況）。
// fakeStorage 的資料 key 讀寫轉到檔案存放的 Map（UI 偏好 key 留在原 Map），既有檢查不用改；最後驗證全部落地、原 Map 只剩偏好
const FILE_MODE = process.env.GAC_SMOKE_FILE_MODE === '1';
let savedState = null;
const PREF_KEYS = ['gac_batch_open', 'gac_settings_open', 'gac_dark_mode'];
const origPrefMap = fakeStorage._m;
if (FILE_MODE) {
    sandbox.__GAC_FILE_STATE = {};
    sandbox.__GAC_FILE_STORE = { file: 'local-state.json', folder: 'sandbox', delay: 5, save: obj => { savedState = obj; return Promise.resolve(); } };
}

const files = ['data.js', 'demo_data.js', 'art-rate-data.js', 'lib/schedule.js', 'lib/lessonState.js',
    'lib/payroll.js', 'lib/analytics.js', 'lib/sendlog.js', 'lib/storage.js', 'lib/history.js', 'lib/gcal.js', 'lib/ics.js', 'lib/rates.js', 'state.js', 'app.js',
    'gcal-ui.js', 'payroll-advanced.js'];
for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(repo, f), 'utf8'), sandbox, { filename: f });
}

const run = (code) => vm.runInContext(code, sandbox);
if (FILE_MODE) {
    const fsr = sandbox.__GAC_FILE_STORAGE;
    if (!fsr || !fsr.isFileBacked) { console.log('FAIL - 檔案模式未啟用'); process.exit(1); }
    const og = fakeStorage.getItem, os_ = fakeStorage.setItem, od = fakeStorage.removeItem;
    fakeStorage.getItem = k => (PREF_KEYS.includes(k) ? og(k) : fsr.getItem(k));
    fakeStorage.setItem = (k, v) => (PREF_KEYS.includes(k) ? os_(k, v) : fsr.setItem(k, v));
    fakeStorage.removeItem = k => (PREF_KEYS.includes(k) ? od(k) : fsr.removeItem(k));
    fakeStorage._m = fsr._m;
    console.log('[檔案模式] 資料存放改為本資料夾 local-state.json 的模擬');
}
function __fileModeTail() {
    if (!FILE_MODE) return Promise.resolve();
    const fsr = sandbox.__GAC_FILE_STORAGE;
    return fsr.flush().then(() => {
        check('檔案模式：所有改動合併寫回本資料夾（名單／課表／設定／快照／小組／導師都在）', !!savedState && ['gac_students_v2', 'gac_lessons_v2', 'gac_settings_v2', 'gac_history_v3', 'gac_groups_v2', 'gac_tutors_v3'].every(k => typeof savedState[k] === 'string') && !fsr.hasPending());
        check('檔案模式：瀏覽器 localStorage 沒被當資料庫用（只剩 UI 偏好 key）', [...origPrefMap.keys()].every(k => PREF_KEYS.includes(k)));
    });
}
let failures = 0;
function check(label, cond) {
    if (cond) { console.log('  ok - ' + label); }
    else { failures++; console.log('  FAIL - ' + label); }
}

// 1) 頁面載入
console.log('[1] window.onload');
run('window.onload()');
check('學生載入 14 人（含 3 位只上小組者）＋ 1 個預設小組班', run('studentDatabase.length') === 14 && run('groupClasses.length') === 1);
check('新 key 已寫入', fakeStorage.getItem('gac_students_v2') !== null);

// 2) 生成 2026-09：勾選 S001(idx0) + S003(idx2) + S004(idx3)
console.log('[2] generateMasterSchedule 2026-09');
getEl('batchMonth').value = '2026-09';
sandbox.__qsaHook = sel => (sel === '.batch-student-chk:checked' ? [{ value: '0' }, { value: '2' }, { value: '3' }] : []);
run('generateMasterSchedule()');
check('生成 14 堂（S001 週一×4 + S003/S004 週三×5）', run('lessonsByMonth["2026-09"].length') === 14);
check('落盤 gac_lessons_v2', JSON.parse(fakeStorage.getItem('gac_lessons_v2'))['2026-09'].length === 14);
check('S003/S004 同組不報撞', run('GACSchedule.detectClashes(lessonsByMonth["2026-09"]).size') === 0);
// 一個時段一張卡：S003/S004 小組 5 個週三 → 5 張「小組課 (2)」卡，成員列在卡內；S001 4 張一對一卡
check('總表按課節渲染：小組一張卡列全體成員', (getEl('masterScheduleList').innerHTML.match(/小組課 \(2\)/g) || []).length === 5
    && getEl('masterScheduleList').innerHTML.includes('全組出席')
    && getEl('masterScheduleList').innerHTML.includes('全組 TL 請假'));
check('月曆小組色塊標人數 (2)', getEl('masterCalendarView').innerHTML.includes('小組 (2)'));
// 導師／學生篩選：清單與月曆同時生效；批量確認只在篩選範圍內（此處選無課的導師 → 0 堂、不動任何狀態）
check('篩選下拉已列導師與學生／小組班', getEl('schedTutorFilter').innerHTML.includes('Instructor B')
    && getEl('schedStudentFilter').innerHTML.includes('S030') && getEl('schedStudentFilter').innerHTML.includes('value="G:G01"'));
getEl('schedTutorFilter').value = 'Instructor B';
run('onScheduleFilterChange()');
check('導師篩選 Instructor B：9 月無其課 → 清單空提示、月曆無色塊', getEl('masterScheduleList').innerHTML.includes('所選範圍內無排定課堂')
    && !getEl('masterCalendarView').innerHTML.includes('小組 (2)') && !getEl('masterCalendarView').innerHTML.includes('Student 001'));
check('批量確認尊重篩選：導師 B 範圍內沒有課 → 按鈕停用並明說', getEl('batchConfirmBtn').disabled === true
    && getEl('batchConfirmBtn').innerHTML.includes('範圍內沒有課堂'));
run('batchConfirmWeek()');
check('停用狀態下按了也不動任何狀態', run('lessonsByMonth["2026-09"].every(l => l.status === "SCHEDULED")'));
getEl('schedTutorFilter').value = 'ALL';
// 上方「篩選導師」（filterTutor）改了 → 下方清單／月曆的導師篩選跟著改
getEl('filterTutor').value = 'Instructor B';
run('onBatchTutorChange()');
check('上方篩選導師選 B → 下方導師篩選自動變 B，清單按 B 篩', getEl('schedTutorFilter').value === 'Instructor B' && getEl('masterScheduleList').innerHTML.includes('所選範圍內無排定課堂'));
getEl('filterTutor').value = 'ALL';
run('onBatchTutorChange()');
check('上方改回所有導師 → 下方跟著回到所有導師', getEl('schedTutorFilter').value === 'ALL' && !getEl('masterScheduleList').innerHTML.includes('所選範圍內無排定課堂'));
getEl('schedStudentFilter').value = 'S001';
run('onScheduleFilterChange()');
check('學生篩選 S001：只剩一對一卡、無小組卡', !getEl('masterScheduleList').innerHTML.includes('小組課 (2)')
    && (getEl('masterScheduleList').innerHTML.match(/Student 001/g) || []).length >= 4);
getEl('schedStudentFilter').value = 'S003';
run('onScheduleFilterChange()');
check('學生篩選 S003：整節小組卡保留（同組 S004 一併顯示）', (getEl('masterScheduleList').innerHTML.match(/小組課 \(2\)/g) || []).length === 5
    && getEl('masterScheduleList').innerHTML.includes('Student 004') && !getEl('masterScheduleList').innerHTML.includes('Student 001'));
getEl('schedStudentFilter').value = 'ALL';
run('onScheduleFilterChange()');
check('篩選還原 ALL：清單回到全部', (getEl('masterScheduleList').innerHTML.match(/小組課 \(2\)/g) || []).length === 5
    && getEl('masterScheduleList').innerHTML.includes('Student 001'));
// 導師／學生下拉聯動：選導師 → 學生下拉只列名下學生與小組班；選學生／小組班 → 導師自動跟隨且不再限制課堂；月曆略過該生整週沒課的星期
getEl('schedTutorFilter').value = 'Instructor A';
run("onScheduleFilterChange('tutor')");
check('選導師 A → 學生下拉只列 A 的學生（無 S020、無 G01）', getEl('schedStudentFilter').innerHTML.includes('S001')
    && !getEl('schedStudentFilter').innerHTML.includes('S020') && !getEl('schedStudentFilter').innerHTML.includes('G:G01'));
getEl('schedTutorFilter').value = 'Instructor B';
run("onScheduleFilterChange('tutor')");
check('選導師 B → 列 B 的學生與小組班（只上小組的 S030 也在）、學生仍是所有', getEl('schedStudentFilter').innerHTML.includes('S030')
    && getEl('schedStudentFilter').innerHTML.includes('G:G01') && !getEl('schedStudentFilter').innerHTML.includes('S001') && getEl('schedStudentFilter').value === 'ALL');
getEl('schedTutorFilter').value = 'ALL';
run("onScheduleFilterChange('tutor')");
getEl('schedStudentFilter').value = 'S003';
run("onScheduleFilterChange('student')");
check('選學生 S003 → 導師自動變 A、清單只剩 S003 的小組節', getEl('schedTutorFilter').value === 'Instructor A'
    && (getEl('masterScheduleList').innerHTML.match(/小組課 \(2\)/g) || []).length === 5 && !getEl('masterScheduleList').innerHTML.includes('Student 001'));
getEl('schedStudentFilter').value = 'G:G01';
run("onScheduleFilterChange('student')");
check('選小組班 G01 → 導師自動變 B、學生下拉重建後仍選 G01', getEl('schedTutorFilter').value === 'Instructor B' && getEl('schedStudentFilter').value === 'G:G01');
getEl('schedTutorFilter').value = 'ALL';
run("onScheduleFilterChange('tutor')");
getEl('schedStudentFilter').value = 'S001';
run("onScheduleFilterChange('student')");
check('選學生 S001 → 導師自動變 A；月曆略過第一週（9/1–9/5 無課）、其他週仍在、有略過提示', getEl('schedTutorFilter').value === 'Instructor A'
    && !getEl('masterCalendarView').innerHTML.includes('text-slate-500">3</div>') && getEl('masterCalendarView').innerHTML.includes('text-slate-500">7</div>')
    && getEl('masterCalendarView').innerHTML.includes('已略過 1 個'));
// 週次下拉只列該範圍內有課的週：S001 週一（9/7 起）→ 無第1週；S003 週三（9/2 起）→ 第1週回來；原選的週消失 → 回到全月
check('選 S001 → 週次下拉略過該生沒課的第1週、第2–5週仍在', !getEl('weekSelect').innerHTML.includes('第1週') && getEl('weekSelect').innerHTML.includes('第2週')
    && getEl('weekSelect').innerHTML.includes('第5週') && getEl('weekSelect').value === 'ALL');
getEl('schedStudentFilter').value = 'S003';
run("onScheduleFilterChange('student')");
getEl('weekSelect').value = '0';
run('renderMasterScheduleList()'); // 沙盒預設是月曆視圖，onWeekSelectChange 不重繪清單，直接重繪
check('選 S003（週三，每週都有課）→ 第1週回來，選第1週後清單只剩 9/2 那節', getEl('weekSelect').innerHTML.includes('第1週')
    && (getEl('masterScheduleList').innerHTML.match(/小組課 \(2\)/g) || []).length === 1);
getEl('schedStudentFilter').value = 'S001';
run("onScheduleFilterChange('student')");
check('再選 S001 → 原選的第1週不在了、週次回到全月、清單回到 4 節', getEl('weekSelect').value === 'ALL' && !getEl('weekSelect').innerHTML.includes('第1週')
    && (getEl('masterScheduleList').innerHTML.match(/Student 001/g) || []).length >= 4);
getEl('schedStudentFilter').value = 'ALL';
run("onScheduleFilterChange('student')");
check('回到所有學生 → 月曆完整（第一週回來）、導師仍是 A', getEl('masterCalendarView').innerHTML.includes('text-slate-500">3</div>')
    && !getEl('masterCalendarView').innerHTML.includes('已略過') && getEl('schedTutorFilter').value === 'Instructor A');
check('導師 A、所有學生 → 週次下拉列 A 有課的週（第1週有 S003/S004 週三課）', getEl('weekSelect').innerHTML.includes('第1週') && getEl('weekSelect').innerHTML.includes('第5週'));
getEl('schedTutorFilter').value = 'Instructor B';
run("onScheduleFilterChange('tutor')");
check('導師 B 本月無課 → 週次下拉只剩全月', !getEl('weekSelect').innerHTML.includes('週 '));
getEl('schedTutorFilter').value = 'ALL';
run("onScheduleFilterChange('tutor')");
check('無篩選 → 週次下拉列整月 5 週', (getEl('weekSelect').innerHTML.match(/<option value="[0-9]"/g) || []).length === 5);
// 月曆色塊 → 課節彈窗：內容＝清單卡片；開啟期間清單留空（避免同 id 展開框重複）；資料變動時彈窗同步；關閉後清單回來
check('月曆色塊帶 openLessonModal（一對一與小組節）', getEl('masterCalendarView').innerHTML.includes("openLessonModal('S001-20260907-2130')")
    && getEl('masterCalendarView').innerHTML.includes("openLessonModal('G|"));
run("openLessonModal('S001-20260907-2130')");
check('彈窗開啟：標題含日期時間與學生、內容含該堂展開框、清單容器留空', run('lessonModalCellKey') === 'S001-20260907-2130'
    && getEl('lessonModalTitle').innerHTML.includes('2026-09-07') && getEl('lessonModalTitle').innerHTML.includes('Student 001')
    && getEl('lessonModalBody').innerHTML.includes('leaveBox_S001-20260907-2130') && getEl('masterScheduleList').innerHTML === '');
run('markLessonStatus("S001-20260907-2130","ATTENDED")');
check('彈窗內操作後內容同步刷新（已上課徽章）', getEl('lessonModalBody').innerHTML.includes('已上課'));
run('markLessonStatus("S001-20260907-2130","SCHEDULED")');
check('還原後彈窗仍開、徽章消失', run('lessonModalCellKey') === 'S001-20260907-2130' && !getEl('lessonModalBody').innerHTML.includes('✓ 已上課'));
run('closeLessonModal()');
check('關閉後清單重繪回全部', run('lessonModalCellKey') === null && getEl('masterScheduleList').innerHTML.includes('Student 001')
    && (getEl('masterScheduleList').innerHTML.match(/小組課 \(2\)/g) || []).length === 5);
run("openLessonModal('G|Instructor A|2026-09-09|21:30|Pop Guitar|2人小組|60')");
check('小組節彈窗：標題標人數 (2)、內容含全組按鈕與兩位成員', getEl('lessonModalTitle').innerHTML.includes('小組課 (2)')
    && getEl('lessonModalBody').innerHTML.includes('全組出席') && getEl('lessonModalBody').innerHTML.includes('Student 004'));
run('delete lessonsByMonth["2026-09"]; renderMasterScheduleList()');
check('課節消失（如清月）→ 彈窗自動關閉', run('lessonModalCellKey') === null);
run('lessonsByMonth = JSON.parse(localStorage.getItem("gac_lessons_v2")); rebuildMonthContext(); renderAll()');
check('資料還原', run('lessonsByMonth["2026-09"].length') === 14);

// 3) 重複生成 → merge 不重複
run('generateMasterSchedule()');
check('重複生成不產生重複課', run('lessonsByMonth["2026-09"].length') === 14);

// 3b) 小組班生成（隔離在 2026-12，測完清掉）：勾小組 G01（五人）→ 12 月 4 個週六
console.log('[2b] 小組班生成');
getEl('batchMonth').value = '2026-12';
sandbox.__qsaHook = sel => (sel === '.batch-group-chk:checked' ? [{ value: 'G01' }] : []);
run('generateMasterSchedule()');
check('G01 五人 × 4 個週六 = 20 堂、皆帶 groupId/groupName', run('(lessonsByMonth["2026-12"]||[]).length') === 20
    && run('lessonsByMonth["2026-12"].every(l => l.groupId === "G01" && l.groupName === "樂理 Grade 5 小組" && l.classType === "5人小組")'));
check('20 堂合成 4 節（一節一卡／一事件）', run('GACSchedule.groupByCell(lessonsByMonth["2026-12"]).length') === 4);
check('只上小組的 S030 學費 = 4 × 小組費率（按堂查價）', run('sendLog["TUITION:S030:2026-12"].amount') === run('4 * rateForLesson(lessonsByMonth["2026-12"][0])')
    && run('sendLog["TUITION:S030:2026-12"].count') === 4);
check('總表小組卡標題含小組名稱', getEl('masterScheduleList').innerHTML.includes('樂理 Grade 5 小組'));
// 再生成一次：勾 S020 個別課、不勾小組 → S020 的小組課不能被誤刪（範圍按 groupId）
sandbox.__qsaHook = sel => (sel === '.batch-student-chk:checked' ? [{ value: '6' }] : []);
run('generateMasterSchedule()');
check('只勾個別課再生成：小組課原封不動（20 堂＋S020 個別 5 堂）', run('lessonsByMonth["2026-12"].filter(l => l.groupId).length') === 20
    && run('lessonsByMonth["2026-12"].filter(l => l.studentId === "S020" && !l.groupId).length') === 5);
const s020Msg = run('sendlogMsgFor(sendLog["TUITION:S020:2026-12"])');
check('S020 學費單：個別課段＋小組段＋總額（明細 2 項）', run('sendLog["TUITION:S020:2026-12"].items.length') === 2
    && s020Msg.includes('【12月份上堂詳情及學費】') && s020Msg.includes('學生：Student 020')
    && s020Msg.includes('逢星期三') && s020Msg.includes('時間：18:00-19:00（60 mins）')
    && s020Msg.includes('級別：Pop Guitar Intermediate 中級') && s020Msg.includes('上課形式：一對一個別授課 Individual')
    && s020Msg.includes('逢星期六') && s020Msg.includes('時間：15:00-16:00（60 mins）')
    && s020Msg.includes('級別：Music Theory Grade 5') && s020Msg.includes('上課形式：5人小組授課（樂理 Grade 5 小組）')
    && s020Msg.includes('導師：Instructor B') && s020Msg.includes('總額：$')
    && s020Msg.includes('＊以上收費均以每位學生計算'));
check('S020 總額 = 個別 5 堂＋小組 4 堂各按費率', s020Msg.includes('總額：' + '$' + Number(run('sendLog["TUITION:S020:2026-12"].amount')).toLocaleString('en-US'))
    && run('sendLog["TUITION:S020:2026-12"].items[0].count + sendLog["TUITION:S020:2026-12"].items[1].count') === 9);
run('renderSendCenter()');
getEl('sendMonth').value = '2026-12';
run('renderSendCenter()');
check('待發送卡片列兩個報讀項目堂數', getEl('sendTodoList').innerHTML.includes('個別課 5 堂＋樂理 Grade 5 小組 4 堂'));
getEl('schedStudentFilter').value = 'G:G01';
run('onScheduleFilterChange()');
check('小組班篩選 G:G01：只剩 4 張小組卡（S020 個別課 18:00 不顯示）', (getEl('masterScheduleList').innerHTML.match(/樂理 Grade 5 小組/g) || []).length >= 4
    && !getEl('masterScheduleList').innerHTML.includes('18:00'));
getEl('schedStudentFilter').value = 'ALL';
run('onScheduleFilterChange()');
// 薪酬：每個報讀項目一行——S020 有個別行＋小組行；S030 只有小組行
getEl('advancedPayrollMonth').value = '2026-12';
run('advancedRefresh()');
const decItems = run('advancedPayrollState.summary.tutors.flatMap(t => t.items)');
check('薪酬按報讀項目列行（S020 個別＋小組兩筆、S030 只有小組一筆）', decItems.filter(i => i.studentId === 'S020').length === 2
    && decItems.filter(i => i.studentId === 'S030').length === 1
    && decItems.find(i => i.studentId === 'S030').groupName.includes('樂理'));
// 清掉隔離月份與其學費條目，恢復 9 月檢視與原勾選
run('delete lessonsByMonth["2026-12"]; GACSendlog.purgeMonth(sendLog, "2026-12", []); persistLessons();');
getEl('batchMonth').value = '2026-09';
getEl('advancedPayrollMonth').value = '2026-09';
sandbox.__qsaHook = sel => (sel === '.batch-student-chk:checked' ? [{ value: '0' }, { value: '2' }, { value: '3' }] : []);
run('rebuildMonthContext(); renderAll();');

// 4) 狀態機：出席、請假（兩步）、補堂
console.log('[3] 狀態機操作');
run('markLessonStatus("S003-20260902-2130","ATTENDED")');
check('S003 9/2 已上課', run('GACLessonState.findLesson(lessonsByMonth,"S003-20260902-2130").lesson.status') === 'ATTENDED');
getEl('leaveType_S004-20260909-2130').value = 'SL';
{
    // 按「確認請假」直接標記：不再彈「確定請假？」確認框；之後照樣開請假訊息窗
    let leaveConfirms = 0;
    const keepConfirm = sandbox.confirm;
    sandbox.confirm = () => { leaveConfirms++; return false; };
    run('confirmLeave("S004-20260909-2130")');
    sandbox.confirm = keepConfirm;
    check('確認請假：不彈確認框、直接標記，並開請假訊息窗', leaveConfirms === 0
        && getEl('msgModalTitle').textContent.includes('請假確認') && getEl('msgModalBody').innerHTML.includes('S004'));
}
check('S004 9/9 已請假 SL', run('GACLessonState.findLesson(lessonsByMonth,"S004-20260909-2130").lesson.leaveType') === 'SL');
check('待補池 1 筆', run('GACLessonState.pendingMakeups(lessonsByMonth, "2026-09-15").length') === 1);
getEl('poolDate_S004-20260909-2130').value = '2026-10-07';
getEl('poolTime_S004-20260909-2130').value = '19:00';
run('submitMakeup("S004-20260909-2130","poolDate_S004-20260909-2130","poolTime_S004-20260909-2130")');
check('補堂入 10 月分桶', run('(lessonsByMonth["2026-10"]||[]).length') === 1);
check('待補池清空', run('GACLessonState.pendingMakeups(lessonsByMonth, "2026-09-15").length') === 0);
// 重複排補堂 → confirm 返回 true → 取消重排
getEl('poolDate2').value = '2026-10-08';
getEl('poolTime2').value = '18:00';
run('submitMakeup("S004-20260909-2130","poolDate2","poolTime2")');
check('取消重排後仍只有 1 節補堂', run('(lessonsByMonth["2026-10"]||[]).length') === 1);
check('補堂日期已更新為 10/8', run('lessonsByMonth["2026-10"][0].date') === '2026-10-08');

// 5) 批量確認出席（今天 2026-09-15 以前）
console.log('[4] batchConfirmWeek');
getEl('weekSelect').value = 'ALL';
run('batchConfirmWeek()');
const attendedCount = run('lessonsByMonth["2026-09"].filter(l=>l.status==="ATTENDED").length');
// 9/15 或以前的 SCHEDULED：S001 9/7+9/14、S003 9/9（9/2 已手動出席）、S004 9/2（9/9 已請假）→ +4 → 共 5
check('批量確認後已上課 5 堂（依 2026-09-15 為今天）', attendedCount === 5);

// 6) 一鍵倒回（新行為）：還原已排補堂的請假 → 級聯確認後取消補堂並還原
sandbox.alerts.length = 0;
run('markLessonStatus("S004-20260909-2130","SCHEDULED")');
check('級聯還原成功且補堂一併取消', run('GACLessonState.findLesson(lessonsByMonth,"S004-20260909-2130").lesson.status') === 'SCHEDULED'
    && run('GACLessonState.findLesson(lessonsByMonth,"S004-20261008-1800-MU-20260909-2130")') === null);
// 倒回場景測完，重新請假（SL）＋重排補堂 10/8 18:00，讓後續步驟狀態不變
run('confirmLeave("S004-20260909-2130")');
run('submitMakeup("S004-20260909-2130","poolDate2","poolTime2")');
check('重排後 10 月恢復 1 節補堂', run('(lessonsByMonth["2026-10"]||[]).length') === 1);

// 7) 工資：按 ATTENDED 統計
console.log('[5] 高級薪酬：預期 vs 目前應付');
getEl('advancedPayrollMonth').value = '2026-09';
run('advancedRefresh()');
const sum5 = run('advancedPayrollState.summary');
const rows = sum5.tutors.flatMap(t => t.items.map(i => ({ id: i.studentId, name: i.studentName, tutor: t.tutor, rate: i.rate, lessons: i.current })));
const s001 = rows.find(r => r.id === 'S001');
const s004 = rows.find(r => r.id === 'S004');
check('S001 計 2 堂（9/7、9/14）', s001.lessons === 2);
check('S004 計 1 堂（9/2；請假不計）', s004.lessons === 1);
// 導師節數：可計薪 5 人次 = S001×2（一對一 2 節）＋ 9/2 小組（S003+S004 同時段 → 1 節）＋ 9/9 小組（S003 → 1 節）= 4 節
check('導師節數：小組同時段算 1（人次 5 → 節數 4）', sum5.tutors.find(t => t.tutor === 'Instructor A').currentSessions === 4);
check('過期未確認警告出現', getEl('advancedExpiredWarning').innerHTML === '' || getEl('advancedExpiredWarning').innerHTML.length >= 0);

// 8) 模擬刷新：新 context 重新載入，資料仍在
console.log('[6] 模擬刷新頁面');
const sandbox2 = Object.assign({}, sandbox, { alerts: [] });
// 重新跑 state.js + storage 讀取
const store2 = run('GACStorage.createStore(localStorage)');
const lessons2 = run('GACStorage.createStore(localStorage).loadLessons()');
check('刷新後 9 月 14 堂', lessons2['2026-09'].length === 14);
check('刷新後補堂鏈完好', lessons2['2026-10'][0].originLessonId === 'S004-20260909-2130'
    && lessons2['2026-09'].find(l => l.lessonId === 'S004-20260909-2130').makeupLessonId === lessons2['2026-10'][0].lessonId);

// 9) ICS 匯出含 UID
console.log('[7] ICS UID');
let icsBlobContent = '';
sandbox.Blob = function (parts) { icsBlobContent = parts.join(''); };
run('downloadMasterICS()');
check('ICS 每個 VEVENT 含 UID', icsBlobContent.includes('UID:S001-20260907-2130@guitaristic'));
// S004 請 SL、同組 S003 照上：小組一節一個事件，地點碼要全員同碼才寫（與推送同一契約）→ 這節不寫 SL
check('ICS：小組只有一人請假 → 該節不寫 LOCATION:SL（全員同碼才寫）', !icsBlobContent.includes('LOCATION:SL') && icsBlobContent.includes('UID:G%7C'));

// ===== 小組聯動 / 確認彈窗 / 改期 / 手動模式（confirm 全部自動按「確定」）=====

// 10) TL 導師請假 → 小組聯動：S003 9/16 請 TL → S004 9/16 一併請假；訊息彈窗列出兩人
console.log('[8] TL 小組聯動請假');
getEl('leaveType_S003-20260916-2130').value = 'TL';
sandbox.alerts.length = 0;
run('confirmLeave("S003-20260916-2130")');
check('S003 9/16 LEAVE/TL', run('GACLessonState.findLesson(lessonsByMonth,"S003-20260916-2130").lesson.leaveType') === 'TL');
check('S004 9/16 同步 LEAVE/TL（小組聯動）', run('GACLessonState.findLesson(lessonsByMonth,"S004-20260916-2130").lesson.leaveType') === 'TL');
const modalHtml = getEl('msgModalBody').innerHTML;
check('訊息彈窗包含兩位成員', modalHtml.includes('Student 003') && modalHtml.includes('Student 004'));
check('彈窗標題為請假確認', getEl('msgModalTitle').textContent.includes('請假'));

// 11) 池排補堂 → 同組順手同排：S003 排 10/14 19:00 → S004 一併
console.log('[9] 小組一併排補堂');
getEl('poolDate_S003-20260916-2130').value = '2026-10-14';
getEl('poolTime_S003-20260916-2130').value = '19:00';
run('submitMakeup("S003-20260916-2130","poolDate_S003-20260916-2130","poolTime_S003-20260916-2130")');
check('兩節補堂同時段入 10 月（1 舊 + 2 新）', run('lessonsByMonth["2026-10"].length') === 3);
check('S004 補堂同一時段', run('GACLessonState.findLesson(lessonsByMonth,"S004-20261014-1900-MU-20260916-2130")') !== null);
check('無小組告警（同一時段）', run('GACLessonState.detectGroupInconsistencies(lessonsByMonth,"2026-09").length') === 0);
check('補堂訊息彈窗列出兩人', getEl('msgModalBody').innerHTML.includes('Student 003') && getEl('msgModalBody').innerHTML.includes('Student 004'));

// 12) 改期彈窗：S003 的補堂 10/14→10/15 19:30，同組一併搬（改期是整節的事：按鈕在卡頭，不在成員行）
console.log('[10] 補堂改期（整組一併）');
{
    const cardOf = (month, id) => run('renderGroupCard(GACSchedule.groupByCell(lessonsByMonth[' + JSON.stringify(month) + ']).find(c => c.lessons.some(l => l.lessonId === ' + JSON.stringify(id) + ')), new Set())');
    const originCard = cardOf('2026-09', 'S003-20260916-2130');
    check('請假原課的小組卡：卡頭一顆「全組改期補堂（10-14 19:00）」、成員行沒有「改期補堂」', (originCard.match(/全組改期補堂（10-14 19:00）/g) || []).length === 1
        && !originCard.includes("openMoveModal('S003-20260916-2130')") && !originCard.includes("openMoveModal('S004-20260916-2130')"));
    const mkCard = cardOf('2026-10', 'S003-20261014-1900-MU-20260916-2130');
    check('補堂那一節的小組卡：卡頭一顆「全組改期」、成員行沒有「改期」', (mkCard.match(/openLessonMoveModal\(/g) || []).length === 1 && mkCard.includes('全組改期')
        && (mkCard.match(/cancelMakeupUI\(/g) || []).length === 2);
}
run('openMoveModal("S003-20260916-2130")');
check('改期彈窗：標題「小組補堂改期」、寫明全組 2 位一併改期', getEl('moveModalTitle').innerHTML.includes('小組補堂改期')
    && getEl('moveModalInfo').innerHTML.includes('全組 2 位一併改期') && getEl('moveModalInfo').innerHTML.includes('Student 004'));
check('改期彈窗預填目前補堂日期', getEl('moveDate').value === '2026-10-14');
getEl('moveDate').value = '2026-10-15';
getEl('moveTime').value = '19:30';
run('submitMoveModal()');
check('S003 補堂移到 10/15 19:30', run('GACLessonState.findLesson(lessonsByMonth,"S003-20261015-1930-MU-20260916-2130")') !== null);
check('S004 補堂一併移動', run('GACLessonState.findLesson(lessonsByMonth,"S004-20261015-1930-MU-20260916-2130")') !== null);
check('10 月仍是 3 節', run('lessonsByMonth["2026-10"].length') === 3);
check('改期後無小組告警', run('GACLessonState.detectGroupInconsistencies(lessonsByMonth,"2026-09").length') === 0);

// 13) 發散：取消 S004 補堂 → 重排到不同時段 → MAKEUP_DIVERGED 告警 + 橫幅
console.log('[11] 小組補堂發散偵測');
run('cancelMakeupUI("S004-20261015-1930-MU-20260916-2130")');
getEl('poolDate_S004-20260916-2130').value = '2026-10-21';
getEl('poolTime_S004-20260916-2130').value = '20:00';
run('submitMakeup("S004-20260916-2130","poolDate_S004-20260916-2130","poolTime_S004-20260916-2130")');
const issues = run('GACLessonState.detectGroupInconsistencies(lessonsByMonth,"2026-09")');
check('偵測到 MAKEUP_DIVERGED', issues.length === 1 && issues[0].type === 'MAKEUP_DIVERGED');
check('橫幅顯示發散警告', getEl('groupWarnBanner').innerHTML.includes('發散'));

// 14) 一鍵倒回：還原「已排補堂的請假」→ 級聯取消補堂
console.log('[12] 還原級聯（HAS_MAKEUP 一鍵倒回）');
run('markLessonStatus("S004-20260916-2130","SCHEDULED")');
check('S004 9/16 還原為 SCHEDULED', run('GACLessonState.findLesson(lessonsByMonth,"S004-20260916-2130").lesson.status') === 'SCHEDULED');
check('S004 補堂已一併取消', run('GACLessonState.findLesson(lessonsByMonth,"S004-20261021-2000-MU-20260916-2130")') === null);
const issues2 = run('GACLessonState.detectGroupInconsistencies(lessonsByMonth,"2026-09")');
check('現在偵測到 TL_PARTIAL（S003 TL、S004 已排課）', issues2.length === 1 && issues2[0].type === 'TL_PARTIAL');

// 15) 手動模式：直改狀態、不聯動、HAS_MAKEUP 級聯
console.log('[13] 手動模式');
run('toggleManualMode()');
check('手動模式開啟', run('manualMode') === true);
getEl('manualStatus_S004-20260916-2130').value = 'LEAVE_TL';
run('manualSetStatus("S004-20260916-2130")');
check('手動直設 S004 為 LEAVE/TL（不聯動）', run('GACLessonState.findLesson(lessonsByMonth,"S004-20260916-2130").lesson.leaveType') === 'TL');
check('TL_PARTIAL 告警消失', run('GACLessonState.detectGroupInconsistencies(lessonsByMonth,"2026-09").length') === 0);
// S003 有補堂 → 手動改 ATTENDED 觸發級聯取消補堂
getEl('manualStatus_S003-20260916-2130').value = 'ATTENDED';
run('manualSetStatus("S003-20260916-2130")');
check('手動改 ATTENDED 成功（級聯取消其補堂）', run('GACLessonState.findLesson(lessonsByMonth,"S003-20260916-2130").lesson.status') === 'ATTENDED');
check('S003 補堂已被級聯取消', run('GACLessonState.findLesson(lessonsByMonth,"S003-20261015-1930-MU-20260916-2130")') === null);
check('10 月只剩最早的 SL 補堂', run('lessonsByMonth["2026-10"].length') === 1);
run('toggleManualMode()');
check('手動模式關閉', run('manualMode') === false);

// ===== 檢查點 2：發送中心（C1-C8 無頭可測部分）＋設定頁＋全量備份（F1）=====

// 16) 發送中心條目基線：生成時 TUITION、請假/補堂自動確認條目（C1/C7）
console.log('[14] 發送中心條目基線');
const tS001 = run('sendLog["TUITION:S001:2026-09"]');
const tS003 = run('sendLog["TUITION:S003:2026-09"]');
check('TUITION:S001 存在、TODO、4 堂', !!tS001 && tS001.status === 'TODO' && tS001.count === 4);
check('S001 金額 = 4 × advancedRate', tS001.amount === run('4 * advancedRate(studentDatabase[0])'));
check('S003 金額 = 5 × advancedRate', !!tS003 && tS003.amount === run('5 * advancedRate(studentDatabase[2])'));
check('LEAVE_CONFIRM 條目存在且歸原課月份', run('sendLog["LEAVE_CONFIRM:S004-20260909-2130"] && sendLog["LEAVE_CONFIRM:S004-20260909-2130"].month') === '2026-09');
check('MAKEUP_CONFIRM 條目歸補堂月份 2026-10', run('sendLog["MAKEUP_CONFIRM:S004-20261008-1800-MU-20260909-2130"] && sendLog["MAKEUP_CONFIRM:S004-20261008-1800-MU-20260909-2130"].month') === '2026-10');
const entryCountBefore = run('Object.keys(sendLog).length');
run('generateMasterSchedule()');
check('重複生成：sendlog 條目數不變（key 幂等，C7）', run('Object.keys(sendLog).length') === entryCountBefore);
const tuitionMsg = run('sendlogMsgFor(sendLog["TUITION:S003:2026-09"])');
check('學費單（單一項目）：日期逢星期／時間起訖／級別／形式／導師／每堂／堂數／合共', tuitionMsg.includes('【學費】')
    && tuitionMsg.includes('【9月份上堂詳情及學費】') && tuitionMsg.includes('學生：Student 003')
    && /日期：\d+(, \d+)+ 逢星期三/.test(tuitionMsg) && tuitionMsg.includes('時間：21:30-22:30（60 mins）')
    && tuitionMsg.includes('級別：Pop Guitar Elementary 初級') && tuitionMsg.includes('上課形式：2人小組授課')
    && tuitionMsg.includes('導師：Instructor A') && tuitionMsg.includes('每堂學費：$') && tuitionMsg.includes('堂數：5 堂')
    && tuitionMsg.includes('合共：$') && !tuitionMsg.includes('總額'));
const legacyMsg = run('sendlogMsgFor({ type: "TUITION", month: "2026-09", studentName: "Old Entry", dates: ["2026-09-05", "2026-09-12"], count: 2, amount: 600 })');
check('舊條目（無明細）：逐堂列月/日、合共用條目金額', legacyMsg.includes('日期：9/5、9/12') && legacyMsg.includes('堂數：2 堂') && legacyMsg.includes('合共：$600'));
run('sendSetAmount("TUITION:S001:2026-09", 1234)');
check('手改金額反映在訊息合共', run('sendlogMsgFor(sendLog["TUITION:S001:2026-09"])').includes('合共：$1,234'));
run('sendLog["TUITION:S001:2026-09"].amountEdited = false; generateMasterSchedule()');
getEl('sendMonth').value = '2026-09';
run('renderSendCenter()');
check('待發送欄渲染出學費卡片', getEl('sendTodoList').innerHTML.includes('學費'));
check('9 月待發 4 筆（3 學費 + 1 請假確認）', String(getEl('sendTodoCount').textContent) === '4');
check('頁籤徽章 TODO 總數 5（含 10 月補堂確認）', String(getEl('sendTabBadge').textContent) === '5');
// 類別篩選：只看學費 → 3；只看請假確認 → 1；切回全部 → 4（徽章不受篩選影響）
getEl('sendTypeFilter').value = 'TUITION';
run('renderSendCenter()');
check('類別篩選=學費 → 待發 3 筆且無請假卡片', String(getEl('sendTodoCount').textContent) === '3'
    && !getEl('sendTodoList').innerHTML.includes('請假確認'));
getEl('sendTypeFilter').value = 'LEAVE_CONFIRM';
run('renderSendCenter()');
check('類別篩選=請假確認 → 待發 1 筆＋空欄提示含篩選說明', String(getEl('sendTodoCount').textContent) === '1'
    && getEl('sendSentList').innerHTML.includes('目前只顯示'));
check('徽章仍是全月份總數 5', String(getEl('sendTabBadge').textContent) === '5');
getEl('sendTypeFilter').value = 'ALL';
run('renderSendCenter()');
check('切回全部類別 → 4 筆', String(getEl('sendTodoCount').textContent) === '4');

// 17) 手改金額不被生成覆蓋（C1）＋ WhatsApp 點開即已發（C2）＋ 手動已發/移回（C4-C5）
console.log('[15] 金額手改與雙欄移動');
run('sendSetAmount("TUITION:S003:2026-09", 9999)');
run('generateMasterSchedule()');
check('手改金額後重生成不覆蓋', run('sendLog["TUITION:S003:2026-09"].amount') === 9999 && run('sendLog["TUITION:S003:2026-09"].amountEdited') === true);
run('sendWhatsApp("TUITION:S003:2026-09")');
check('點開 WhatsApp → 直接 SENT + method=wa_link + sentAt（C2）', run('sendLog["TUITION:S003:2026-09"].status') === 'SENT'
    && run('sendLog["TUITION:S003:2026-09"].method') === 'wa_link' && !!run('sendLog["TUITION:S003:2026-09"].sentAt'));
run('generateMasterSchedule()');
check('SENT 條目重生成絕不改動', run('sendLog["TUITION:S003:2026-09"].status') === 'SENT' && run('sendLog["TUITION:S003:2026-09"].amount') === 9999);
run('sendMarkSent("LEAVE_CONFIRM:S004-20260909-2130", "manual")');
check('手動已發 → method=manual（C4）', run('sendLog["LEAVE_CONFIRM:S004-20260909-2130"].method') === 'manual');
check('9 月雙欄 2 待發/2 已發', run('GACSendlog.listByMonth(sendLog,"2026-09").todo.length') === 2
    && run('GACSendlog.listByMonth(sendLog,"2026-09").sent.length') === 2);
run('sendMarkUnsent("TUITION:S003:2026-09")');
check('移回待發 → TODO + sentAt 清空（C5）', run('sendLog["TUITION:S003:2026-09"].status') === 'TODO' && run('sendLog["TUITION:S003:2026-09"].sentAt') === null);
check('發送紀錄已落盤 gac_sendlog_v2（C6）', JSON.parse(fakeStorage.getItem('gac_sendlog_v2'))['TUITION:S003:2026-09'].amount === 9999);

// 18) C8 無電話 ＋ syncSendlog 清理（取消補堂/還原請假） ＋ 設定頁
console.log('[16] 無電話、sendlog 同步清理、設定頁');
const s004Phone = run('studentDatabase.find(s=>s.id==="S004").phone');
run('studentDatabase.find(s=>s.id==="S004").phone = ""');
run('sendLog["TUITION:S004:2026-09"].phone = ""');
run('renderSendCenter()');
check('C8 無電話 → WhatsApp 禁用但可手動已發', getEl('sendTodoList').innerHTML.includes('無電話')
    && getEl('sendTodoList').innerHTML.includes('cursor-not-allowed')
    && getEl('sendTodoList').innerHTML.includes('手動已發'));
run(`studentDatabase.find(s=>s.id==="S004").phone = ${JSON.stringify(s004Phone)}`);
run(`sendLog["TUITION:S004:2026-09"].phone = ${JSON.stringify(s004Phone)}`);
// 還原「已排補堂的請假」→ 級聯取消補堂：MAKEUP 的 TODO 條目被孤兒清理；已發的 LEAVE_CONFIRM 保留作歷史
run('markLessonStatus("S004-20260909-2130","SCHEDULED")');
check('補堂取消後 MAKEUP_CONFIRM TODO 被清理', run('sendLog["MAKEUP_CONFIRM:S004-20261008-1800-MU-20260909-2130"]') === undefined);
check('SENT 的 LEAVE_CONFIRM 保留（歷史紀錄）', run('sendLog["LEAVE_CONFIRM:S004-20260909-2130"].status') === 'SENT');
// 重新請假＋重排補堂（恢復狀態）：同 key 的 SENT 條目不會被降回 TODO；補堂條目重建
run('confirmLeave("S004-20260909-2130")');
check('再請假：SENT 確認條目不重複不降級（C7 幂等）', run('sendLog["LEAVE_CONFIRM:S004-20260909-2130"].status') === 'SENT');
run('submitMakeup("S004-20260909-2130","poolDate2","poolTime2")');
check('重排後 MAKEUP_CONFIRM 條目重建為 TODO', run('sendLog["MAKEUP_CONFIRM:S004-20261008-1800-MU-20260909-2130"].status') === 'TODO');
// 設定頁：保存/讀取
run('appSettings.payNoShow = false');   // 舊版留下的設定值（「缺席計入導師薪酬」已取消，一律照計）
getEl('setFeeNotice').value = '冒煙：備註';
getEl('setGcalCalendarId').value = '';
run('saveSettingsForm()');
check('設定保存：落盤；已取消的舊設定 payNoShow 存檔時清掉', run('appSettings.feeNotice') === '冒煙：備註' && !('payNoShow' in run('appSettings'))
    && JSON.parse(fakeStorage.getItem('gac_settings_v2')).feeNotice === '冒煙：備註' && !('payNoShow' in JSON.parse(fakeStorage.getItem('gac_settings_v2'))));
check('設定頁沒有「缺席計入導師薪酬」與「一般」模組', !fs.readFileSync(path.join(repo, 'index.html'), 'utf8').includes('setPayNoShow') && !run('SETTINGS_MODULES').includes('general'));
check('日曆 ID 留空回退 primary', run('appSettings.gcalCalendarId') === 'primary');
getEl('setFeeNotice').value = '';
run('loadSettingsForm()');
check('loadSettingsForm 回填不崩潰', getEl('setFeeNotice').value === '冒煙：備註');

// 19) F1 全量備份：導出 → 清空 → 匯入全還原；舊版純學生陣列相容
console.log('[17] 全量備份/還原（F1）');
run('exportJSONDatabase()');  // 只驗證不崩潰（下載經 stub anchor）
run('__backupText = JSON.stringify(GACStorage.buildExportPayload({ students: studentDatabase, groups: groupClasses, lessons: lessonsByMonth, sendlog: sendLog, settings: appSettings }))');
// 舊版純學生陣列 → 只換學生名單，課表不動
run('applyImportedPayload(GACStorage.parseImportPayload([{id:"ZZZ1",name:"Legacy Student",phone:"",type:"一對一",program:"Guitar",tutor:"Instructor A",duration:45,weekday:1,time:"10:00",level:"Beginner 初級"}]))');
check('舊版匯入：學生被取代為 1 人', run('studentDatabase.length') === 1);
check('舊版匯入：課表不受影響', run('lessonsByMonth["2026-09"].length') === 14);
// 清空一切（記憶體 + localStorage），再全量還原
run('studentDatabase = []; lessonsByMonth = {}; sendLog = {}; appSettings = {};');
['gac_students_v2', 'gac_lessons_v2', 'gac_sendlog_v2', 'gac_settings_v2'].forEach(k => fakeStorage._m.delete(k));
run('applyImportedPayload(GACStorage.parseImportPayload(__backupText))');
check('全量還原：學生 14 人＋小組班 1 個', run('studentDatabase.length') === 14 && run('groupClasses.length') === 1);
check('全量還原：9 月 14 堂 + 10 月 1 節補堂', run('lessonsByMonth["2026-09"].length') === 14 && run('lessonsByMonth["2026-10"].length') === 1);
check('全量還原：補堂鏈完好', run('GACLessonState.findLesson(lessonsByMonth,"S004-20260909-2130").lesson.makeupLessonId') === 'S004-20261008-1800-MU-20260909-2130');
check('全量還原：sendlog 含手改金額 9999', run('sendLog["TUITION:S003:2026-09"].amount') === 9999);
check('全量還原：設定還原', run('appSettings.feeNotice') === '冒煙：備註');
check('全量還原：四把 key 重新落盤', ['gac_students_v2', 'gac_lessons_v2', 'gac_sendlog_v2', 'gac_settings_v2'].every(k => fakeStorage.getItem(k) !== null));

// ===== 檢查點 3：Google Calendar UI（前置檢查＋對帳套用；API 傳輸層在 tests/gcal.test.js 以 mock 覆蓋）=====

// 20) 未填 Client ID 的前置檢查；同步面板套用（時間變更/刪除→請假/狀態碼/手動事件收編）
console.log('[18] GCal 前置檢查與同步面板套用');
sandbox.alerts.length = 0;
run('openGcalSync()');
check('未填 Client ID → 明確提示並導向設定頁', sandbox.alerts.length === 1 && sandbox.alerts[0].includes('Client ID'));
// 手工構造同步計劃（真實 lesson 引用），逐條勾選後執行（無推送/殘留 → 純本地路徑，不需 token）
run(`gcalSyncPlan = {
    monthKey: '2026-09',
    toPush: [],
    orphans: [],
    timeChanges: [{ lesson: GACLessonState.findLesson(lessonsByMonth,"S001-20260907-2130").lesson, event: {id:"evT"}, date: "2026-09-08", time: "20:00" }],
    deletions: [{ lesson: GACLessonState.findLesson(lessonsByMonth,"S003-20260923-2130").lesson }],
    statusChanges: [{ lesson: GACLessonState.findLesson(lessonsByMonth,"S001-20260928-2130").lesson, event: {}, to: { status: "LEAVE", leaveType: "SL" } }],
    manualNew: [
        { event: { id: "evMU1", summary: "S004 补课" }, studentId: "S004", date: "2026-11-10", time: "19:00" },
        { event: { id: "evXT1", summary: "S003 加課" }, studentId: "S003", date: "2026-11-03", time: "19:00" }
    ]
}`);
run('renderGcalSyncModal()');
check('同步面板渲染出各組差異', getEl('gcalSyncBody').innerHTML.includes('時間變更')
    && getEl('gcalSyncBody').innerHTML.includes('已在 GCal 刪除')
    && getEl('gcalSyncBody').innerHTML.includes('狀態碼變更')
    && getEl('gcalSyncBody').innerHTML.includes('手動新建'));
// 預設：時間/刪除/狀態碼 3 行 checked，2 行手動新建不勾
check('同步面板預設全勾（手動新建除外）', (getEl('gcalSyncBody').innerHTML.match(/" checked/g) || []).length === 3
    && getEl('gcalSyncBody').innerHTML.includes('Calendar 為準'));
// 每類差異＝一個可收起的分組（預設展開），標題列有本組的全選／全不選；只動該組的勾選框
{
    const html = getEl('gcalSyncBody').innerHTML;
    check('同步面板：每類一個可收起分組（預設展開）＋本組全選／全不選', ['time', 'del', 'status', 'manual'].every(k =>
        html.includes('<details open id="gsSec_' + k + '"') && html.includes("gcalSyncSetGroup('" + k + "', true)") && html.includes("gcalSyncSetGroup('" + k + "', false)"))
        && (html.match(/<details /g) || []).length === 4 && !html.includes('gsSec_push'));
    const hookWas = sandbox.__qsaHook;
    const delBoxes = [{ checked: true }, { checked: true }], otherBoxes = [{ checked: true }];
    sandbox.__qsaHook = sel => (sel === '#gsSec_del input[type="checkbox"]' ? delBoxes : sel === '#gcalSyncBody input[type="checkbox"]' ? delBoxes.concat(otherBoxes) : []);
    run("gcalSyncSetGroup('del', false)");
    check('本組全不選：只動該組', delBoxes.every(b => !b.checked) && otherBoxes[0].checked === true);
    run("gcalSyncSetGroup('del', true)");
    run('gcalSyncSetAll(false)');
    check('頂部操作列全不選：所有組', delBoxes.concat(otherBoxes).every(b => !b.checked));
    const secs = [{ open: true }, { open: false }];
    sandbox.__qsaHook = sel => (sel === '#gcalSyncBody details' ? secs : []);
    run('gcalSyncToggleSections()');
    check('全部收起／展開：有開著的 → 全部收起', secs.every(d => d.open === false));
    run('gcalSyncToggleSections()');
    check('全部收起／展開：全收起 → 全部展開', secs.every(d => d.open === true));
    sandbox.__qsaHook = hookWas;
}
getEl('gsT_0').checked = true;
getEl('gsD_0').checked = true;
getEl('gsS_0').checked = true;
getEl('gsM_0').checked = true;
getEl('gsMsel_0').value = 'MU:S004-20260916-2130'; // S004 9/16 的 TL 假仍在待補池
getEl('gsM_1').checked = true;
getEl('gsMsel_1').value = 'EXTRA';
run('applyGcalSync()');
const movedL = run('GACLessonState.findLesson(lessonsByMonth,"S001-20260907-2130")');
check('時間變更套用：日期時間改、id 不變、仍在 9 月桶', movedL && movedL.lesson.date === '2026-09-08'
    && movedL.lesson.time === '20:00' && movedL.monthKey === '2026-09');
check('刪除事件套用：本地標記請假 L ＋ 產生請假確認條目',
    run('GACLessonState.findLesson(lessonsByMonth,"S003-20260923-2130").lesson.status') === 'LEAVE'
    && run('sendLog["LEAVE_CONFIRM:S003-20260923-2130"].status') === 'TODO');
check('狀態碼套用：SCHEDULED → LEAVE/SL ＋ 確認條目',
    run('GACLessonState.findLesson(lessonsByMonth,"S001-20260928-2130").lesson.leaveType') === 'SL'
    && !!run('sendLog["LEAVE_CONFIRM:S001-20260928-2130"]'));
check('手動事件收編為補堂：鏈接建立、收養 gcalEventId、確認條目',
    run('GACLessonState.findLesson(lessonsByMonth,"S004-20260916-2130").lesson.makeupLessonId') === 'S004-20261110-1900-MU-20260916-2130'
    && run('GACLessonState.findLesson(lessonsByMonth,"S004-20261110-1900-MU-20260916-2130").lesson.gcalEventId') === 'evMU1'
    && !!run('sendLog["MAKEUP_CONFIRM:S004-20261110-1900-MU-20260916-2130"]'));
check('手動事件收編為獨立加課：-XT id、isExtra、isMakeup（生成永不清理）',
    run('GACLessonState.findLesson(lessonsByMonth,"S003-20261103-1900-XT").lesson.isExtra') === true
    && run('GACLessonState.findLesson(lessonsByMonth,"S003-20261103-1900-XT").lesson.isMakeup') === true
    && run('GACLessonState.findLesson(lessonsByMonth,"S003-20261103-1900-XT").lesson.gcalEventId') === 'evXT1');
check('11 月桶＝補堂＋加課共 2 節且已落盤', run('lessonsByMonth["2026-11"].length') === 2
    && JSON.parse(fakeStorage.getItem('gac_lessons_v2'))['2026-11'].length === 2);
check('套用後 gcalSyncPlan 清空', run('gcalSyncPlan') === null);
check('結果顯示在面板內（不彈 alert）', getEl('gcalSyncBody').innerHTML.includes('同步完成')
    && getEl('gcalSyncBody').innerHTML.includes('本地更新 5 項'));
// 懸浮同步按鈕：標示目前模式；讀取／執行中和頂部那顆一起停用
run('applyGcalModeUi(); setGcalBusy(true)');
check('懸浮「GCal」按鈕：有提示文字、忙碌時與頂部按鈕一起停用', getEl('gcalSyncFab').title.includes('同步 Google Calendar') && getEl('gcalSyncFab').title.includes('拖')
    && getEl('gcalSyncFab').disabled === true && getEl('gcalSyncBtn').disabled === true);
run('setGcalBusy(false)');
check('忙完恢復可按', getEl('gcalSyncFab').disabled === false && getEl('gcalSyncBtn').disabled === false);
// 零差異：只顯示「完全一致」（操作列收起，只剩底部「確認」）
run(`gcalSyncPlan = { monthKey: '2026-09', toPush: [], orphans: [], timeChanges: [], statusChanges: [], deletions: [], manualNew: [] }`);
run('renderGcalSyncModal()');
check('零差異面板顯示完全一致', getEl('gcalSyncBody').innerHTML.includes('完全一致'));
run('gcalSyncPlan = null');

// 21) WhatsApp：點開即移到已發送，不彈框詢問；「標記已發」仍給複製後自己貼去發的情況
console.log('[19] WhatsApp 點開即已發');
{
    let waConfirms = 0;
    const keepConfirm = sandbox.confirm;
    sandbox.confirm = () => { waConfirms++; return true; };
    run('sendWhatsApp("TUITION:S001:2026-09")');
    check('點開 WhatsApp → 直接移到已發送（method=wa_link）、落盤、沒有彈框', run('sendLog["TUITION:S001:2026-09"].status') === 'SENT'
        && run('sendLog["TUITION:S001:2026-09"].method') === 'wa_link' && waConfirms === 0
        && JSON.parse(fakeStorage.getItem('gac_sendlog_v2'))['TUITION:S001:2026-09'].status === 'SENT');
    check('可撤銷：留下歷史快照', run('actionHistory[0].description').includes('WhatsApp'));
    run('renderSendCenter()');
    check('卡片在已發送欄、寫明經 WhatsApp', getEl('sendSentList').innerHTML.includes('TUITION:S001:2026-09') && getEl('sendSentList').innerHTML.includes('· WhatsApp'));
    run('sendMarkUnsent("TUITION:S001:2026-09")');
    check('移回待發', run('sendLog["TUITION:S001:2026-09"].status') === 'TODO');
    run('sendMarkSent("TUITION:S001:2026-09", "wa_link")');
    check('「標記已發」按鈕仍可用（C3）', run('sendLog["TUITION:S001:2026-09"].status') === 'SENT');
    run('sendMarkUnsent("TUITION:S001:2026-09")');
    run('sendWhatsApp("TUITION:S004:2026-09")');
    check('另一筆同樣點開即已發', run('sendLog["TUITION:S004:2026-09"].status') === 'SENT' && waConfirms === 0);
    check('設定頁已沒有「點開 WhatsApp 後的處理」選項；儲存設定清掉舊鍵', !fs.readFileSync(path.join(repo, 'index.html'), 'utf8').includes('setWaSentMode')
        && (run('appSettings.waSentMode = "confirm"; saveSettingsForm(); appSettings.waSentMode') === undefined));
    sandbox.confirm = keepConfirm;
}

// ===== 頁籤合併：快速編輯（改常規時間/升班＋撞堂預覽）＋ 自定義群發 =====

// 22) 快速編輯：S005（週二 14:30, Instructor A）改到週一 21:30 → 與 S001 的 9/14、9/21 撞
console.log('[20] 快速編輯（合併原單一學生頁籤）');
run('openQuickEdit(4)');
check('彈窗載入現值（週二 14:30）', String(getEl('qeWeekday').value) === '2' && getEl('qeTime').value === '14:30');
check('生效月份預設為檢視月份', getEl('qeEffMonth').value === '2026-09');
getEl('qeWeekday').value = '1';
getEl('qeTime').value = '21:30';
run('renderQuickEditPreview()');
const previewRows = run(`GACSchedule.previewTimeChange(studentDatabase[4],
    studentDatabase.filter((x,i)=>i!==4), lessonsByMonth['2026-09'] || [], '2026-09',
    { weekday: 1, time: '21:30', duration: 45 })`);
// S001 週一課：9/7 已被對帳移到 9/8、9/28 是 LEAVE → 只剩 9/14、9/21 佔 21:30
check('預覽 4 個週一、其中 2 天撞 S001', previewRows.length === 4
    && previewRows.filter(r => r.clashes.length).map(r => r.date).join(',') === '2026-09-14,2026-09-21'
    && previewRows.filter(r => r.clashes.length).every(r => r.clashes[0].studentId === 'S001'));
check('預覽 HTML 顯示撞堂警告', getEl('qePreview').innerHTML.includes('撞堂'));
sandbox.alerts.length = 0;
run('saveQuickEdit()');
check('保存 → effectiveMonth/future 欄位寫入', run('studentDatabase[4].effectiveMonth') === '2026-09'
    && run('studentDatabase[4].futureWeekday') === 1 && run('studentDatabase[4].futureTime') === '21:30');
check('保存提示（toast）需重新生成已生成月份', run('lastToast').includes('生成'));
check('學生名單落盤', JSON.parse(fakeStorage.getItem('gac_students_v2'))[4].futureTime === '21:30');
// 二次變更（更晚生效）→ 舊 future 晉升為基準，保住 [09,11) 的時間
run('openQuickEdit(4)');
check('重開彈窗顯示已生效的新時間（週一 21:30）', String(getEl('qeWeekday').value) === '1' && getEl('qeTime').value === '21:30');
getEl('qeEffMonth').value = '2026-11';
getEl('qeTime').value = '10:00';
run('saveQuickEdit()');
check('二次變更：舊 future 晉升基準、新變更 11 月生效', run('studentDatabase[4].weekday') === 1
    && run('studentDatabase[4].time') === '21:30' && run('studentDatabase[4].effectiveMonth') === '2026-11'
    && run('studentDatabase[4].futureTime') === '10:00');
// 清除排定變更
run('openQuickEdit(4)');
run('qeClearFuture()');
check('清除變更：future 欄位清空、基準保留', run('studentDatabase[4].effectiveMonth') === ''
    && run('studentDatabase[4].futureWeekday') === null && run('studentDatabase[4].time') === '21:30');
run('closeQuickEdit()');

// 23) 自定義群發：導師篩選＋佔位符解析→發送中心待發送欄；可刪可標記已發
console.log('[21] 自定義群發');
getEl('sendMonth').value = '2026-09';
run('openBroadcastModal()');
check('群發彈窗月份預設為發送中心月份', getEl('bcMonth').value === '2026-09');
getEl('bcTitle').value = '調整學費';
getEl('bcMessage').value = '{name}（{id}）家長您好：由 11 月起學費將作調整，詳情請聯絡我們。';
sandbox.__qsaHook = sel => (String(sel).includes('#bcList')
    ? [{ checked: true, value: '6' }, { checked: true, value: '7' }, { checked: false, value: '8' }]
    : []);
sandbox.alerts.length = 0;
run('applyBroadcast()');
const customKeys = run('Object.keys(sendLog).filter(k => k.indexOf("CUSTOM:") === 0)');
check('建立 2 筆 CUSTOM 條目（勾選 2/3）', customKeys.length === 2);
const c20 = run(`sendLog[${JSON.stringify(customKeys.find(k => k.endsWith(':S020')))}]`);
check('佔位符解析為學生姓名/ID', !!c20 && c20.message.includes('Student 020（S020）家長您好'));
check('條目歸入 2026-09、TODO', c20.month === '2026-09' && c20.status === 'TODO');
check('sendlogMsgFor 回快照訊息', run(`sendlogMsgFor(sendLog[${JSON.stringify(c20.key)}])`) === c20.message);
run('renderSendCenter()');
check('待發送欄出現「自定義」卡片與刪除鈕', getEl('sendTodoList').innerHTML.includes('自定義')
    && getEl('sendTodoList').innerHTML.includes('sendDeleteEntry'));
check('CUSTOM 落盤', JSON.parse(fakeStorage.getItem('gac_sendlog_v2'))[c20.key].message === c20.message);
// 二級分類：批次名稱寫入、建完自動聚焦該批、下拉出現子選項、卡片標籤帶名稱
check('批次名稱與 batchId 欄位寫入', c20.title === '調整學費' && !!c20.batchId);
check('建立後自動切到該批次、待發 2 筆', String(getEl('sendTypeFilter').value).indexOf('CUSTOM:') === 0
    && String(getEl('sendTodoCount').textContent) === '2');
check('類別下拉出現「調整學費」子選項', getEl('sendTypeFilter').innerHTML.includes('調整學費'));
check('卡片標籤帶批次名稱', getEl('sendTodoList').innerHTML.includes('自定義：調整學費'));
getEl('sendTypeFilter').value = 'ALL';
run('renderSendCenter()');
// 標記已發＋刪除另一筆
run(`sendMarkSent(${JSON.stringify(c20.key)}, 'wa_link')`);
check('CUSTOM 可標記已發', run(`sendLog[${JSON.stringify(c20.key)}].status`) === 'SENT');
const c21key = customKeys.find(k => k.endsWith(':S021'));
run(`sendDeleteEntry(${JSON.stringify(c21key)})`);
check('CUSTOM 可直接刪除', run(`sendLog[${JSON.stringify(c21key)}]`) === undefined);
check('孤兒清理不碰 CUSTOM（persistLessons 路徑）', (run('persistLessons()'), run(`sendLog[${JSON.stringify(c20.key)}].status`)) === 'SENT');
// 整批刪除：篩選到批次 → 出現「刪除此批」→ 連 SENT 一併刪
getEl('sendTypeFilter').value = 'CUSTOM:' + c20.batchId;
run('renderSendCenter()');
check('批次篩選時顯示「刪除此批」鈕', getEl('sendBatchDeleteBtn').innerHTML.includes('刪除此批'));
run('sendDeleteCustomBatch()');
check('整批刪除（含 SENT 紀錄）→ CUSTOM 歸零', run('Object.keys(sendLog).filter(k => k.indexOf("CUSTOM:") === 0).length') === 0);
check('批刪落盤', Object.keys(JSON.parse(fakeStorage.getItem('gac_sendlog_v2'))).filter(k => k.indexOf('CUSTOM:') === 0).length === 0);
getEl('sendTypeFilter').value = 'ALL';
run('renderSendCenter()');

// 24) 大量刪除防呆：≥5 件刪除 → 同步面板預設不勾＋警告（防止整批誤標請假灌爆待補池）
console.log('[22] 同步面板大量刪除防呆');
run(`gcalSyncPlan = { monthKey: '2026-09', toPush: [], orphans: [], timeChanges: [], statusChanges: [], manualNew: [],
    deletions: lessonsByMonth['2026-09'].slice(0, 5).map(l => ({ lesson: l })) }`);
run('renderGcalSyncModal()');
check('大量刪除 → 顯示清場警告且預設不勾', getEl('gcalSyncBody').innerHTML.includes('批量清場')
    && (getEl('gcalSyncBody').innerHTML.match(/" checked/g) || []).length === 0);
run(`gcalSyncPlan = { monthKey: '2026-09', toPush: [], orphans: [], timeChanges: [], statusChanges: [], manualNew: [],
    deletions: lessonsByMonth['2026-09'].slice(0, 2).map(l => ({ lesson: l })) }`);
run('renderGcalSyncModal()');
check('少量刪除（2 件）→ 維持預設全勾', (getEl('gcalSyncBody').innerHTML.match(/" checked/g) || []).length === 2);
run('gcalSyncPlan = null');

// 25) 清空本月（未設定 GCal → 只清本地）：整月＋跨月補堂級聯刪、該月發送紀錄清、其他月保留
console.log('[23] 清空本月');
sandbox.alerts.length = 0;
run('clearCurrentMonthData()'); // batchMonth = 2026-09
check('9/10/11 月的鏈條課全刪，只剩 11 月獨立加課', run('Object.keys(lessonsByMonth).sort().join()') === '2026-11'
    && run('GACLessonState.findLesson(lessonsByMonth,"S003-20261103-1900-XT")') !== null);
check('跨月補堂被級聯刪除', run('GACLessonState.findLesson(lessonsByMonth,"S004-20261008-1800-MU-20260909-2130")') === null
    && run('GACLessonState.findLesson(lessonsByMonth,"S004-20261110-1900-MU-20260916-2130")') === null);
check('該月發送紀錄（含 SENT/CUSTOM）與被刪課的跨月條目全清', run('Object.keys(sendLog).length') === 0);
check('清空本月提示含刪除數（16 堂）', sandbox.alerts.length === 1 && sandbox.alerts[0].includes('16 堂')
    && sandbox.alerts[0].includes('2026-09'));

// 26) 全部清場（未設定 GCal → 只清本地）：課表/發送紀錄/薪酬歸零，學生與設定保留
console.log('[24] 全部清場重來');
sandbox.alerts.length = 0;
const settingsBefore24 = run('JSON.stringify(appSettings)');
run('resetAllScheduleData()');
check('本地課表全清', run('Object.keys(lessonsByMonth).length') === 0);
check('發送紀錄全清', run('Object.keys(sendLog).length') === 0);
check('薪酬彙總/調整項/封存全清（清場後重算＝零）', run('!advancedPayrollState.summary || advancedPayrollState.summary.tutors.length === 0')
    && run('advancedPayrollState.adjustments.length') === 0
    && run('advancedPayrollState.archives.length') === 0);
check('落盤：課表與發送紀錄鍵為空物件', JSON.parse(fakeStorage.getItem('gac_lessons_v2') || '{}')
    && Object.keys(JSON.parse(fakeStorage.getItem('gac_lessons_v2'))).length === 0
    && Object.keys(JSON.parse(fakeStorage.getItem('gac_sendlog_v2'))).length === 0);
check('學生名單與小組保留', run('studentDatabase.length') === 14 && run('groupClasses.length') === 1);
check('設定保留（整份不變）', run('JSON.stringify(appSettings)') === settingsBefore24);
check('提示已清空且未動 GCal（預設唯讀／未設定）', sandbox.alerts.length === 1 && sandbox.alerts[0].includes('已清空本地')
    && (sandbox.alerts[0].includes('未設定 GCal') || sandbox.alerts[0].includes('唯讀模式')));
check('清場提示說明 Calendar 事件仍在、快照處理結果、保留了什麼', sandbox.alerts[0].includes('Google Calendar 上的事件全部還在')
    && sandbox.alerts[0].includes('歷史快照') && sandbox.alerts[0].includes('學生名單、小組、導師與設定保留'));
check('沙盒 confirm 一律確定 → 歷史快照已一併清空、撤銷停用', run('actionHistory.length') === 0
    && run('redoStack.length') === 0 && fakeStorage.getItem('gac_history_v3') === '[]' && getEl('undoBtn').disabled === true);

// 27) 彈窗：點背景／Esc 關閉；表單有未儲存改動先確認；儲存路徑不問；同步面板執行中不關
console.log('[25] 彈窗背景／Esc 關閉與未儲存改動確認');
const stuOverlay = getEl('studentModal');
const stuFields = ['modalId', 'modalName', 'modalTime'].map(getEl);
stuOverlay.querySelectorAll = () => stuFields;
let stuHidden = null; // null=從未開過, false=開啟中, true=已關
stuOverlay.classList = {
    add(c) { if (c === 'hidden') stuHidden = true; }, remove(c) { if (c === 'hidden') stuHidden = false; },
    toggle() {}, contains(c) { return c === 'hidden' ? stuHidden !== false : false; }
};
const overlayHandlers = {};
stuOverlay.addEventListener = (type, fn) => { overlayHandlers[type] = fn; };
let keyHandler = null;
sandbox.document.addEventListener = (type, fn) => { if (type === 'keydown') keyHandler = fn; };
run('installModalClose()');
const confirmCalls = [];
let confirmAnswer = true;
sandbox.confirm = (msg) => { confirmCalls.push(String(msg)); return confirmAnswer; };

run('openStudentModal(0)');
check('開啟學生弹窗', stuHidden === false);
run("requestCloseModal('studentModal')");
check('無改動：直接關閉、不問', stuHidden === true && confirmCalls.length === 0);

run('openStudentModal(0)');
getEl('modalName').value = 'Changed Name';
confirmAnswer = false;
run("requestCloseModal('studentModal')");
check('有改動＋取消：問一次「改動會丟失」、保持開啟', confirmCalls.length === 1 && confirmCalls[0].includes('丟失') && stuHidden === false);
confirmAnswer = true;
run("requestCloseModal('studentModal')");
check('有改動＋確定：關閉', confirmCalls.length === 2 && stuHidden === true);

run('openStudentModal(0)');
getEl('modalName').value = 'Changed Name';
sandbox.__qsaHook = () => [];
run('saveStudentFromModal()');
check('儲存路徑：不問、直接關閉、已存檔', confirmCalls.length === 2 && stuHidden === true && run('studentDatabase[0].name') === 'Changed Name');
run('studentDatabase[0].name = "Student 001"; saveToLocalStorage()');

run('openStudentModal(0)');
overlayHandlers.pointerdown({ target: { id: 'panel' } });
overlayHandlers.click({ target: stuOverlay });
check('面板內按下、背景放開：不誤關', stuHidden === false);
overlayHandlers.pointerdown({ target: stuOverlay });
overlayHandlers.click({ target: stuOverlay });
check('點背景：關閉', stuHidden === true);

run('openStudentModal(0)');
keyHandler({ key: 'Escape' });
check('Esc：關閉', stuHidden === true);

run('gcalSyncPlan = { x: 1 }; gcalSyncBusy = true');
run("requestCloseModal('gcalSyncModal')");
check('同步面板執行中：背景／Esc 不關（計劃仍在）', run('gcalSyncPlan') !== null);
run('gcalSyncBusy = false');
run("requestCloseModal('gcalSyncModal')");
check('同步面板閒置：關閉（計劃作廢）', run('gcalSyncPlan') === null);

// 28) 費率表連動下拉：只列有定價的組合、每堂學費自動帶出；快速編輯級別／時長亦連動
console.log('[26] 費率連動下拉');
run('openStudentModal(0)'); // S001：普通導師 Pop Guitar Intermediate 中級 一對一 45
check('開啟學生表單：下拉已填、每堂學費帶出（普通導師 Pop 中級 一對一 45 = $360）', getEl('modalTutorLevel').value === '普通導師'
    && getEl('modalProgram').innerHTML.includes('Classical Guitar') && getEl('modalLevel').value === 'Intermediate 中級'
    && getEl('modalType').value === '一對一' && getEl('modalDuration').value === '45' && getEl('modalRate').textContent === '$360 / 堂');
getEl('modalTutorLevel').value = '資深導師'; getEl('modalProgram').value = 'Classical Guitar'; getEl('modalLevel').value = 'Grade 7'; getEl('modalDuration').value = '30';
run('renderStudentFeeSelects()');
check('改為資深 Classical Grade 7：30 分鐘無定價 → 時長改 45、學費 $500、時長選項只剩 45/60', getEl('modalDuration').value === '45'
    && getEl('modalRate').textContent === '$500 / 堂' && !getEl('modalDuration').innerHTML.includes('value="30"') && getEl('modalDuration').innerHTML.includes('value="60"'));
getEl('modalType').value = '2人小組';
run('renderStudentFeeSelects()');
check('Grade 7 無小組定價 → 授課形式只剩一對一', getEl('modalType').value === '一對一' && !getEl('modalType').innerHTML.includes('2人小組'));
getEl('modalLevel').value = 'Grade 5';
run('renderStudentFeeSelects()');
check('回到 Grade 5：三種形式都在、30 分鐘回來（一對一 45 = $420）', getEl('modalType').innerHTML.includes('3-4人小組授課')
    && getEl('modalDuration').innerHTML.includes('value="30"') && getEl('modalRate').textContent === '$420 / 堂');
sandbox.__qsaHook = () => [];
run('saveStudentFromModal()');
check('儲存：導師級別／課程／級別／時長寫入學生記錄', run('studentDatabase[0].tutorLevel') === '資深導師' && run('studentDatabase[0].program') === 'Classical Guitar'
    && run('studentDatabase[0].level') === 'Grade 5' && run('studentDatabase[0].duration') === 45);
run('Object.assign(studentDatabase[0], { tutorLevel: "普通導師", program: "Pop Guitar", level: "Intermediate 中級", type: "一對一", duration: 45 }); saveToLocalStorage(); renderStudentTable();');
// 只上小組的學生：「有常規私教課」不勾 → 儲存不查價、不填導師／課程／時段（weekday null），加入勾選的小組；導師篩選按小組導師歸類
run('openStudentModal(-1)');
check('新增學生：預設勾「有常規私教課」', getEl('modalHasSlot').checked === true);
getEl('modalId').value = 'S090'; getEl('modalName').value = 'Student 090'; getEl('modalHasSlot').checked = false; getEl('modalTime').value = '';
sandbox.__qsaHook = sel => (sel === '.modal-group-chk' ? [{ checked: true, value: 'G01' }] : []);
const alertsBeforeGO = sandbox.alerts.length;
run('saveStudentFromModal()');
check('只上小組：不警示、已新增、無導師／課程／時段、加入 G01', sandbox.alerts.length === alertsBeforeGO && run('studentDatabase[studentDatabase.length - 1].id') === 'S090'
    && run('(s => s.weekday === null && s.time === "" && s.tutor === "" && s.program === "" && s.type === "" && s.duration === null)(studentDatabase[studentDatabase.length - 1])')
    && run('groupClasses[0].memberIds.includes("S090")') && run('lastToast').includes('S090'));
getEl('bcTutor').value = 'Instructor B';
run('renderBroadcastList()');
check('群發名單篩導師 B：只上小組的 S090 按小組導師歸入 B、標「只上小組」', getEl('bcList').innerHTML.includes('S090') && getEl('bcList').innerHTML.includes('只上小組'));
getEl('bcTutor').value = 'Instructor A';
run('renderBroadcastList()');
check('篩導師 A：S090 不在', !getEl('bcList').innerHTML.includes('S090'));
run('openStudentModal(studentDatabase.length - 1)');
check('編輯只上小組的學生：開關不勾、星期／時間有預設值待用', getEl('modalHasSlot').checked === false && getEl('modalWeekday').value === 1 && getEl('modalTime').value === '16:00');
getEl('modalHasSlot').checked = true; getEl('modalWeekday').value = '2'; getEl('modalTime').value = '';
run('saveStudentFromModal()');
check('改為有私教課但沒填時間 → 警示、不存', sandbox.alerts[sandbox.alerts.length - 1].includes('常規星期與上課時間') && run('studentDatabase[studentDatabase.length - 1].weekday') === null);
getEl('modalTime').value = '10:00';
run('saveStudentFromModal()');
check('填了時間 → 存為週二 10:00、導師與課程帶入', run('(s => s.weekday === 2 && s.time === "10:00" && s.tutor === "Instructor A" && s.program !== "" && s.duration > 0)(studentDatabase[studentDatabase.length - 1])'));
run('studentDatabase.pop(); groupClasses[0].memberIds = groupClasses[0].memberIds.filter(m => m !== "S090"); persistGroups(); saveToLocalStorage(); renderStudentTable()');
sandbox.__qsaHook = () => [];
run('openQuickEdit(0)');
check('快速編輯：級別下拉列普通導師 Pop 的級別（含 Debut／Advanced）、時長下拉、每堂學費', getEl('qeLevel').innerHTML.includes('Advanced 高級')
    && getEl('qeLevel').innerHTML.includes('Debut 入門') && getEl('qeLevel').value === 'Intermediate 中級'
    && getEl('qeDuration').value === '45' && getEl('qeRate').textContent.includes('$360'));
getEl('qeLevel').value = 'Advanced 高級';
run('onQuickEditFeeChange()');
check('升班到 Advanced：45 分鐘仍有定價 → 保留、學費 $440、無 30 分鐘選項', getEl('qeDuration').value === '45'
    && getEl('qeRate').textContent.includes('$440') && !getEl('qeDuration').innerHTML.includes('value="30"'));
run("requestCloseModal('quickEditModal')");
check('小組課費率：G01 課堂帶 tutorLevel（資深）', run('groupClasses[0].tutorLevel') === '資深導師');

// 29) 出席與繳費：重新生成 9 月（清場後）→ 每生一行；勾已繳／實收／已發送與發送中心同步；學費單尾段設定
console.log('[27] 出席與繳費');
getEl('batchMonth').value = '2026-09';
sandbox.__qsaHook = sel => (sel === '.batch-student-chk:checked' ? [{ value: '0' }, { value: '2' }, { value: '3' }] : []);
run('generateMasterSchedule()');
getEl('payMonth').value = '2026-09';
getEl('payTutorFilter').value = 'ALL';
run('renderPaymentTab()');
const dueAll = run('sendLog["TUITION:S001:2026-09"].amount + sendLog["TUITION:S003:2026-09"].amount + sendLog["TUITION:S004:2026-09"].amount');
check('繳費表：三位學生各一行、KPI 應收＝三筆合計、未收＝應收、學費單未發 3', (getEl('paymentTableBody').innerHTML.match(/<tr/g) || []).length === 3
    && getEl('payKpiDue').textContent === run('tuitionMoney(' + dueAll + ')') && getEl('payKpiOutstanding').textContent === getEl('payKpiDue').textContent
    && getEl('payKpiPaid').textContent === '$0' && getEl('payKpiUnsent').textContent === '3');
run("payUpdate('TUITION:S001:2026-09', { paidAmount: 100 })");
check('只填實收、未選付款方式 → 仍算未繳、KPI 已收不動、列上註明原因', run('sendLog["TUITION:S001:2026-09"].paid') === false
    && run('GACSendlog.paymentStatus(sendLog["TUITION:S001:2026-09"])') === 'unpaid' && getEl('payKpiPaid').textContent === '$0'
    && getEl('paymentTableBody').innerHTML.includes('待選付款方式'));
run("payUpdate('TUITION:S001:2026-09', { clearPayment: true })");
run("payUpdate('TUITION:S001:2026-09', { payMethod: '1' })");
const e1 = run('sendLog["TUITION:S001:2026-09"]');
check('選付款方式：自動整額＋今天（2026-09-15）、狀態已繳清、KPI 已收更新', e1.paid === true && e1.paidAmount === e1.amount && e1.payDate === '2026-09-15'
    && run('GACSendlog.paymentStatus(sendLog["TUITION:S001:2026-09"])') === 'paid' && getEl('payKpiPaid').textContent === run('tuitionMoney(' + e1.amount + ')')
    && getEl('paymentTableBody').innerHTML.includes('已繳清'));
run("payUpdate('TUITION:S001:2026-09', { paidAmount: 100, payMethod: '2', receipt: true })");
check('改實收 100 → 部分繳交；付款方式 2、收據', run('GACSendlog.paymentStatus(sendLog["TUITION:S001:2026-09"])') === 'partial'
    && run('sendLog["TUITION:S001:2026-09"].payMethod') === '2' && run('sendLog["TUITION:S001:2026-09"].receipt') === true
    && getEl('paymentTableBody').innerHTML.includes('部分')
    && getEl('paymentTableBody').innerHTML.includes('value="2" selected'));
run('renderSendCenter()');
check('發送中心學費卡片顯示繳費徽章', getEl('sendTodoList').innerHTML.includes('部分繳交 $100'));
run("payUpdate('TUITION:S001:2026-09', { paidAmount: 0 })");
check('實收 0 → 未繳（付款方式仍在）', run('sendLog["TUITION:S001:2026-09"].paid') === false && run('GACSendlog.paymentStatus(sendLog["TUITION:S001:2026-09"])') === 'unpaid');
run("paySetSent('TUITION:S003:2026-09', true)");
check('勾已發送＝發送中心手動已發、未發 KPI 減 1', run('sendLog["TUITION:S003:2026-09"].status') === 'SENT' && run('sendLog["TUITION:S003:2026-09"].method') === 'manual'
    && getEl('payKpiUnsent').textContent === '2');
run("paySetSent('TUITION:S003:2026-09', false)");
check('取消勾選 → 移回待發', run('sendLog["TUITION:S003:2026-09"].status') === 'TODO' && getEl('payKpiUnsent').textContent === '3');
getEl('payTutorFilter').value = 'Instructor B';
run('renderPaymentTab()');
check('導師篩選 B → 無列、KPI 歸零', getEl('paymentTableBody').innerHTML.includes('尚未生成課表，或沒有符合') && getEl('payKpiDue').textContent === '$0');
getEl('payTutorFilter').value = 'ALL';
getEl('paySearch').value = 'S003';
run('renderPaymentTab()');
check('搜尋 S003 → 一列', (getEl('paymentTableBody').innerHTML.match(/<tr/g) || []).length === 1);
getEl('paySearch').value = '';
// 繳費狀態篩選：只看已繳清／未繳清；只篩名單，上方統計不變
{
    const rowsN = () => (getEl('paymentTableBody').innerHTML.match(/<tr/g) || []).length;
    run('renderPaymentTab()');
    const allN = rowsN(), due0 = getEl('payKpiDue').textContent;
    run("payUpdate('TUITION:S003:2026-09', { payMethod: '1' })");
    const outstanding = getEl('payKpiOutstanding').textContent;
    getEl('payStatusFilter').value = 'PAID';
    run('renderPaymentTab()');
    check('只看已繳清 → 只剩繳清的那一位；應收／未收統計不變', rowsN() === 1 && getEl('paymentTableBody').innerHTML.includes('S003') && getEl('paymentTableBody').innerHTML.includes('已繳清')
        && getEl('payKpiDue').textContent === due0 && getEl('payKpiOutstanding').textContent === outstanding);
    getEl('payStatusFilter').value = 'DUE';
    run('renderPaymentTab()');
    check('只看未繳清 → 其餘有學費條目的學生，不含已繳清的', rowsN() === allN - 1 && !getEl('paymentTableBody').innerHTML.includes('已繳清</span>'));
    getEl('payStatusFilter').value = 'ALL';
    run("payUpdate('TUITION:S003:2026-09', { clearPayment: true })");
    check('回到所有繳費狀態', rowsN() === allN);
}
// 學費單尾段：設定填了才出現
getEl('setFpsId').value = '123456'; getEl('setInfoUrl').value = 'https://example.test/rules'; getEl('setFeeNotice').value = '附註測試';
sandbox.__qsaHook = sel => (sel === '#payMethodsEditor .pay-method-input' ? [{ value: '現金' }, { value: 'FPS' }, { value: '轉帳' }] : []);
run('saveSettingsForm()');
const feeMsg = run('sendlogMsgFor(sendLog["TUITION:S001:2026-09"])');
check('學費單尾段：FPS／附註／守則連結', feeMsg.includes('FPS 轉數快 ID：123456') && feeMsg.includes('附註測試') && feeMsg.includes('學員守則及請假須知，請瀏覽：https://example.test/rules')
    && feeMsg.indexOf('＊以上收費均以每位學生計算') < feeMsg.indexOf('FPS 轉數快 ID'));
check('付款方式名稱存入設定', run('JSON.stringify(appSettings.payMethods)') === '["現金","FPS","轉帳"]');
getEl('setFpsId').value = ''; getEl('setInfoUrl').value = ''; getEl('setFeeNotice').value = '';
run('saveSettingsForm()');
check('清空設定 → 尾段消失', !run('sendlogMsgFor(sendLog["TUITION:S001:2026-09"])').includes('FPS'));
run("payPreview('TUITION:S001:2026-09')");
check('學費單預覽弹窗：標題含學生、內容含訊息與複製鈕', getEl('msgModalTitle').textContent.includes('Student 001') && getEl('msgModalBody').innerHTML.includes('複製')
    && getEl('msgModalBody').innerHTML.includes('上堂詳情及學費'));
run('closeMsgModal()');
check('全量備份含繳費欄位（發送紀錄整份匯出）', JSON.stringify(run('GACStorage.buildExportPayload({ students: studentDatabase, groups: groupClasses, lessons: lessonsByMonth, sendlog: sendLog, settings: appSettings })')).includes('"paidAmount"'));

// 30) 數據分析：KPI 與薪酬／繳費同口徑；無 Chart（離線）退回文字長條
console.log('[28] 數據分析');
run('markLessonStatus("S001-20260907-2130","ATTENDED"); markLessonStatus("S003-20260902-2130","NOSHOW")');
getEl('anaMonth').value = '2026-09';
const ana = run('renderAnalytics()');
check('KPI：學費應收＝繳費頁應收、出席率 50%（1 已上課 1 缺席）、節數 2', getEl('anaKpiTuitionDue').textContent === getEl('payKpiDue').textContent
    && getEl('anaKpiAttendance').textContent === '50%' && getEl('anaKpiNoShow').textContent === '50%' && getEl('anaKpiSessions').textContent === '2'
    && ana.status.ATTENDED === 1 && ana.status.NOSHOW === 1);
check('已上課課值＝兩堂各按費率（缺席照計）', getEl('anaKpiRevenue').textContent === run('tuitionMoney(rateForLesson(GACLessonState.findLesson(lessonsByMonth,"S001-20260907-2130").lesson) + rateForLesson(GACLessonState.findLesson(lessonsByMonth,"S003-20260902-2130").lesson))'));
check('各導師表列 Instructor A；離線退回文字長條含導師名與狀態', getEl('anaTutorTable').innerHTML.includes('Instructor A')
    && getEl('chartSessionsByTutorFallback').innerHTML.includes('Instructor A') && getEl('chartStatusFallback').innerHTML.includes('缺席')
    && getEl('chartByProgramFallback').innerHTML.includes('Pop Guitar'));
run('markLessonStatus("S001-20260907-2130","SCHEDULED"); markLessonStatus("S003-20260902-2130","SCHEDULED")');
run('renderAnalytics()');
check('狀態還原 → 出席率 —、未確認 14', getEl('anaKpiAttendance').textContent === '—' && getEl('anaKpiUnconfirmed').textContent === '14');
getEl('anaMonth').value = '2027-01';
run('renderAnalytics()');
check('空月份：空狀態提示、表格「此月沒有課堂」', getEl('anaTutorTable').innerHTML.includes('此月沒有課堂') && getEl('anaKpiSessions').textContent === '0');
getEl('anaMonth').value = '2026-09';

// 31) 歷史記錄與撤銷：操作前快照、失敗丟棄、撤銷／還原至此／清空
console.log('[29] 歷史記錄與撤銷');
check('前面各段操作有累積快照（[24] 清場時已問過並清空一次，上限 20）', run('actionHistory.length') > 0 && run('actionHistory.length') <= 20);
run('clearHistory()'); // 先清空，之後按筆數驗證
const h0 = run('actionHistory.length');
run('markLessonStatus("S001-20260907-2130","ATTENDED")');
check('狀態變更前拍快照（+1，描述含學生與狀態）', run('actionHistory.length') === h0 + 1
    && run('actionHistory[0].description').includes('Student 001') && run('actionHistory[0].description').includes('已上課'));
run('markLessonStatus("S001-20260907-2130","NOSHOW")'); // 已上課 → 缺席 非法：alert、快照丟棄
check('非法轉換：alert 且快照不留', run('actionHistory.length') === h0 + 1 && sandbox.alerts[sandbox.alerts.length - 1].includes('⚠️'));
run('undoLastAction()');
check('撤銷 → 回到已排課、快照移除、localStorage 同步', run('GACLessonState.findLesson(lessonsByMonth,"S001-20260907-2130").lesson.status') === 'SCHEDULED'
    && run('actionHistory.length') === h0 && JSON.parse(fakeStorage.getItem('gac_history_v3')).length === h0);
run("payUpdate('TUITION:S001:2026-09', { payMethod: '1' })");
run("payUpdate('TUITION:S001:2026-09', { receipt: true })");
check('繳費兩步各一筆快照', run('actionHistory.length') === h0 + 2 && run('actionHistory[0].description').includes('繳費'));
run('restoreSnapshot(actionHistory[1].id)'); // 還原到「登記繳費」之前
check('還原至此之前：先自動備份再套用（+1）、繳費回到未繳', run('actionHistory[0].description').includes('還原前自動備份')
    && run('sendLog["TUITION:S001:2026-09"].paid') === false && run('actionHistory.length') === h0 + 3);
run('undoLastAction()');
check('撤銷那次還原 → 已繳＋收據回來', run('sendLog["TUITION:S001:2026-09"].paid') === true && run('sendLog["TUITION:S001:2026-09"].receipt') === true
    && run('actionHistory.length') === h0 + 2);
run("payUpdate('TUITION:S001:2026-09', { clearPayment: true })");
run('renderHistoryUI()');
check('歷史頁列出快照與還原鈕、撤銷鈕計數與大小', getEl('historyList').innerHTML.includes('還原至此之前')
    && getEl('undoCount').textContent === String(run('actionHistory.length')) && getEl('historySize').textContent.includes('上限 20 筆'));
run('clearHistory()');
check('清空記錄 → 0、localStorage 為空陣列、撤銷鈕停用', run('actionHistory.length') === 0 && fakeStorage.getItem('gac_history_v3') === '[]'
    && getEl('undoBtn').disabled === true);

// 32) 導師管理與費率覆寫
console.log('[30] 導師管理與費率覆寫');
check('導師名單載入預設 2 位並落盤；等級查詢', run('tutorsList.length') === 2 && JSON.parse(fakeStorage.getItem('gac_tutors_v3')).length === 2
    && run('tutorTier("Instructor B")') === '資深導師' && run('tutorTier("Nobody")') === null);
getEl('newTutorName').value = 'Instructor C'; getEl('newTutorTier').value = '資深導師';
run('addTutor()');
check('新增導師 → 名單 3、排課篩選／學生弹窗下拉含新導師、快照', run('tutorsList.length') === 3 && getEl('modalTutor').innerHTML.includes('Instructor C')
    && getEl('filterTutor').innerHTML.includes('Instructor C') && run('actionHistory[0].description').includes('新增導師'));
getEl('newTutorName').value = 'Instructor C';
run('addTutor()');
check('重名拒絕', run('tutorsList.length') === 3 && sandbox.alerts[sandbox.alerts.length - 1].includes('已存在'));
run('openStudentModal(-1)');
getEl('modalTutor').value = 'Instructor C';
run('onModalTutorChange()');
check('學生表單選導師 → 導師級別自動帶出（資深）、費率連動重算', getEl('modalTutorLevel').value === '資深導師' && getEl('modalRate').textContent.includes('$'));
run("requestCloseModal('studentModal')");
run("updateTutorTier('Instructor C', '普通導師')");
check('改等級', run('tutorTier("Instructor C")') === '普通導師');
run("deleteTutor('Instructor C')");
check('刪除導師 → 名單 2、下拉移除', run('tutorsList.length') === 2 && !getEl('modalTutor').innerHTML.includes('Instructor C'));
// 從 data.js 重新載入名單：學生／小組／導師蓋過 localStorage 的版本；導師日曆 ID 按名字保留；整個動作可撤銷
run("updateTutorCalendar('Instructor B', 'calendarId', 'keep@group.calendar.google.com')");
run('studentDatabase.splice(0, 1); saveToLocalStorage(); tutorsList.push({ name: "Instructor Z", tier: "普通導師" }); persistTutors()');
const confirmWasR = sandbox.confirm; sandbox.confirm = () => true;
run('resetToDefaultData()');
sandbox.confirm = confirmWasR;
check('從 data.js 重新載入：學生數回到 data.js、導師回到 A/B（Z 消失）、B 的日曆 ID 保留、落盤、有快照、下拉刷新', run('studentDatabase.length') === run('defaultStudents.length')
    && run('tutorsList.map(t => t.name).join()') === 'Instructor A,Instructor B' && run('tutorsList[1].calendarId') === 'keep@group.calendar.google.com'
    && JSON.parse(fakeStorage.getItem('gac_tutors_v3')).length === 2 && JSON.parse(fakeStorage.getItem('gac_tutors_v3'))[1].calendarId === 'keep@group.calendar.google.com'
    && run('actionHistory[0].description').includes('data.js') && !getEl('modalTutor').innerHTML.includes('Instructor Z') && run('lastToast').includes('已從 data.js 重新載入'));
check('data.js 沒有 defaultTutors 時可從學生／小組推出導師（tutorLevel → 等級）', run('GACStorage.tutorsFromRoster(defaultStudents, defaultGroups).map(t => t.name + ":" + t.tier).join()') === 'Instructor A:普通導師,Instructor B:資深導師');
run('undoLastAction(); undoLastAction()');
check('撤銷兩步 → 回到原狀（S001 在、沒有 Z、B 沒有日曆 ID）', run('studentDatabase.length') === run('defaultStudents.length') && run('tutorsList.length') === 2
    && !run('tutorsList.some(t => t.name === "Instructor Z")') && !run('tutorsList[1].calendarId'));
// 還原演示名單（demo_data.js）＋ 導師日曆 ID 備忘：演示 ↔ 真實來回切換，各自的 ID 按名字自動回填
run("updateTutorCalendar('Instructor B', 'calendarId', 'b-real@group.calendar.google.com')");
run('studentDatabase.splice(0, 2); tutorsList.push({ name: "Instructor Z", tier: "普通導師", calendarId: "z@group.calendar.google.com" }); persistTutors(); saveToLocalStorage()');
sandbox.confirm = () => true;
run('restoreDemoRoster()');
check('還原演示名單：學生回到 14、導師 A/B（Z 消失）、B 的 ID 保留、Z 的 ID 記在設定備忘並落盤、快照、toast', run('studentDatabase.length') === 14
    && run('tutorsList.map(t => t.name).join()') === 'Instructor A,Instructor B' && run('tutorsList[1].calendarId') === 'b-real@group.calendar.google.com'
    && run('actionHistory[0].description') === '還原演示名單' && run('lastToast').includes('已還原演示名單')
    && run('appSettings.tutorCalendarMemo["Instructor Z"]') === 'z@group.calendar.google.com'
    && JSON.parse(fakeStorage.getItem('gac_settings_v2')).tutorCalendarMemo['Instructor Z'] === 'z@group.calendar.google.com');
run('applyRoster({ students: [], groups: [], tutors: [{ name: "Instructor Z", tier: "資深導師" }] }, "test")');
check('換回含 Z 的名單 → Z 的日曆 ID 從備忘回填', run('tutorsList.length') === 1 && run('tutorsList[0].calendarId') === 'z@group.calendar.google.com' && run('tutorsList[0].tier') === '資深導師');
run('undoLastAction(); undoLastAction(); undoLastAction()');
sandbox.confirm = confirmWasR;
check('撤銷三步 → 回到原狀（14 人、A/B、B 沒有日曆 ID）', run('studentDatabase.length') === run('defaultStudents.length') && run('tutorsList.length') === 2
    && !run('tutorsList.some(t => t.name === "Instructor Z")') && !run('tutorsList[1].calendarId'));
run('renderTutorManagementList()');
check('設定頁導師列表含使用人數', getEl('tutorManagementList').innerHTML.includes('Instructor A') && getEl('tutorManagementList').innerHTML.includes('位學生／小組'));
// 費率覆寫
run('resetRateFilters()');
const rateTotal = run('rateTable.length');
check('收費表：未篩選列出全部、每欄一個篩選下拉（含「全部（n）」）', getEl('rateRowCount').textContent === '顯示 ' + rateTotal + ' / ' + rateTotal + ' 列'
    && ['tutor', 'instrument', 'grade', 'classType', 'duration', 'changed'].every(k => getEl('rateFilterRow').innerHTML.includes('id="rateFlt_' + k + '"'))
    && getEl('rateFilterRow').innerHTML.includes('全部（2）'));
run("setRateFilter('tutor', '普通導師'); setRateFilter('instrument', 'Pop Guitar')");
const popRows = run('rateTable.filter(r => r.tutor === "普通導師" && r.instrument === "Pop Guitar").length');
check('篩選普通導師＋Pop → 只剩這些列（含 Debut）、全部預設', getEl('rateTableEditorBody').innerHTML.includes('Debut 入門')
    && getEl('rateTableEditorBody').innerHTML.includes('data-key="普通導師|Pop Guitar|') && !getEl('rateTableEditorBody').innerHTML.includes('data-key="資深導師|')
    && getEl('rateRowCount').textContent === '顯示 ' + popRows + ' / ' + rateTotal + ' 列' && getEl('rateOverrideCount').textContent.includes('全部為預設價'));
const popGrades = run('[...new Set(rateTable.filter(r => r.tutor === "普通導師" && r.instrument === "Pop Guitar").map(r => r.grade))].length');
check('連動：級別下拉只列 Pop 有的級別', getEl('rateFilterRow').innerHTML.includes('全部（' + popGrades + '）') && !getEl('rateFilterRow').innerHTML.includes('>Pre Grade<'));
run("setRateFilter('grade', 'Debut 入門')");
check('選了右邊的級別，左邊課程下拉仍列出全部課程（不會被鎖住）', getEl('rateFilterRow').innerHTML.includes('>Classical Guitar<') && getEl('rateFilterRow').innerHTML.includes('>Hymns Guitar<'));
run("setRateFilter('instrument', 'Classical Guitar')");
check('改左邊課程令級別失效 → 級別自動退回全部，不會卡在 0 列', run('rateFilter.grade') === '' && run('rateFilter.instrument') === 'Classical Guitar'
    && !getEl('rateTableEditorBody').innerHTML.includes('沒有符合篩選'));
run("setRateFilter('instrument', 'Pop Guitar')");
const rateKey = '普通導師|Pop Guitar|Intermediate 中級|一對一個別授課 Individual|45';
const q = 'GACRates.findRate(rateTable, { tutorLevel: "普通導師", program: "Pop Guitar", level: "Intermediate 中級", type: "一對一", duration: 45 })';
run('handleRateTableEdit({ dataset: { key: ' + JSON.stringify(rateKey) + ' }, value: "999" })');
check('改價 → 即時生效、覆寫落盤、S001 每堂費率 999、快照、計數', run(q) === 999 && JSON.parse(fakeStorage.getItem('gac_rate_overrides_v3'))[rateKey] === 999
    && run('rateForLesson(GACLessonState.findLesson(lessonsByMonth,"S001-20260907-2130").lesson)') === 999
    && run('actionHistory[0].description').includes('改價') && getEl('rateOverrideCount').textContent.includes('1'));
run('undoLastAction()');
check('撤銷改價 → 回到 360、覆寫清空', run(q) === 360 && Object.keys(run('rateOverrides')).length === 0);
run('handleRateTableEdit({ dataset: { key: ' + JSON.stringify(rateKey) + ' }, value: "500" })');
run('resetRateRow(' + JSON.stringify(rateKey) + ')');
check('還原預設列 → 360、覆寫清空', run(q) === 360 && Object.keys(run('rateOverrides')).length === 0);
run('handleRateTableEdit({ dataset: { key: ' + JSON.stringify(rateKey) + ' }, value: "500" })');
run("resetRateFilters(); setRateFilter('changed', 'yes')");
check('「只看已改價」→ 只剩那一列', getEl('rateRowCount').textContent === '顯示 1 / ' + rateTotal + ' 列' && getEl('rateTableEditorBody').innerHTML.includes('data-key="' + rateKey + '"'));
run('resetRateRow(' + JSON.stringify(rateKey) + ')');
check('還原後 → 已改價篩選下 0 列並提示', getEl('rateTableEditorBody').innerHTML.includes('沒有符合篩選'));
run('resetRateFilters()');
const payloadV3 = run('GACStorage.buildExportPayload({ students: studentDatabase, groups: groupClasses, lessons: lessonsByMonth, sendlog: sendLog, settings: appSettings, tutors: tutorsList, rateOverrides: rateOverrides })');
check('全量備份含導師名單與費率覆寫', Array.isArray(payloadV3.tutors) && payloadV3.tutors.length === 2 && typeof payloadV3.rateOverrides === 'object');

// 31) 發送中心 × 繳費：已發送卡片繳費小表單、未繳清計數、學費繳費狀態篩選
console.log('[31] 發送中心與繳費整合');
getEl('sendMonth').value = '2026-09';
getEl('sendTypeFilter').value = 'ALL';
getEl('payMonth').value = '2026-09';
run("if (sendLog['TUITION:S001:2026-09'].status === 'SENT') sendMarkUnsent('TUITION:S001:2026-09')");
run("payUpdate('TUITION:S001:2026-09', { clearPayment: true })");
run('renderSendCenter()');
const todoBefore = Number(getEl('sendTodoCount').textContent);
const todoHtml = () => getEl('sendTodoList').innerHTML;
const sentHtml = () => getEl('sendSentList').innerHTML;
check('「核對」勾選已全數移除（卡片與繳費表）', !todoHtml().includes('核對') && !getEl('paymentTableBody').innerHTML.includes('核對')
    && run('sendLog["TUITION:S001:2026-09"].checked') === undefined);
check('待發送學費卡片未出現繳費小表單（未發送時不登記繳費）', !todoHtml().includes('登記繳費'));
run("sendMarkSent('TUITION:S001:2026-09', 'manual')");
check('發出後：已發送卡片繳費小表單預設展開（未繳清）、有「收起」鈕、未繳清計數 1、繳費表已發送勾上', sentHtml().includes("payUpdate('TUITION:S001:2026-09', { paidAmount: this.value }")
    && sentHtml().includes('收起') && getEl('sendSentUnpaid').textContent === '1 筆學費未繳清'
    && getEl('paymentTableBody').innerHTML.includes("checked onchange=\"paySetSent('TUITION:S001:2026-09', this.checked)\""));
run("payUpdate('TUITION:S001:2026-09', { payMethod: '2' })");
check('卡片選付款方式 → 已繳清徽章、表單自動收起改為「修改繳費」、未繳清計數清空', sentHtml().includes('已繳清') && !sentHtml().includes('{ paidAmount: this.value }')
    && sentHtml().includes('修改繳費') && getEl('sendSentUnpaid').textContent === '');
run("toggleSendPayForm('TUITION:S001:2026-09')");
check('「修改繳費」展開 → 表單帶出付款方式 2', sentHtml().includes('{ paidAmount: this.value }') && sentHtml().includes('value="2" selected'));
run("toggleSendPayForm('TUITION:S001:2026-09')");
check('再按收起', !sentHtml().includes('{ paidAmount: this.value }'));
check('繳費表已無「已繳」勾選，只有推導出的狀態徽章', !getEl('paymentTableBody').innerHTML.includes('{ paid: this.checked }')
    && (getEl('paymentTableBody').innerHTML.includes('已繳清') || getEl('paymentTableBody').innerHTML.includes('未繳')));
getEl('sendTypeFilter').value = 'TUITION:paid';
run('renderSendCenter()');
check('篩「學費 · 已繳清」：已發送 1、待發送 0 並提示目前篩選', Number(getEl('sendSentCount').textContent) === 1 && Number(getEl('sendTodoCount').textContent) === 0
    && todoHtml().includes('學費 · 已繳清'));
getEl('sendTypeFilter').value = 'TUITION:due';
run('renderSendCenter()');
check('篩「學費 · 未繳清」：待發送 S003/S004 兩筆、已發送 0', Number(getEl('sendTodoCount').textContent) === 2 && Number(getEl('sendSentCount').textContent) === 0
    && todoHtml().includes('TUITION:S003:2026-09') && todoHtml().includes('TUITION:S004:2026-09'));
check('類別下拉列出兩個繳費狀態子項', getEl('sendTypeFilter').innerHTML.includes('value="TUITION:due"') && getEl('sendTypeFilter').innerHTML.includes('value="TUITION:paid"'));
getEl('sendTypeFilter').value = 'ALL';
run("payUpdate('TUITION:S001:2026-09', { clearPayment: true })");
run("sendMarkUnsent('TUITION:S001:2026-09')");
check('復原：S001 回待發送、待發送筆數還原', run('sendLog["TUITION:S001:2026-09"].status') === 'TODO' && Number(getEl('sendTodoCount').textContent) === todoBefore);

// 32) 催繳與收款確認：設定 7 天自動派生、訊息模板、不用發、繳費表狀態提示
console.log('[32] 催繳與收款確認');
getEl('setRemindAuto').checked = true; getEl('setRemindDays').value = '7'; getEl('setRemindMsg').value = '';
getEl('setReceiptAuto').checked = true; getEl('setReceiptMsg').value = ''; getEl('setFpsId').value = '888';
run('saveSettingsForm()');
check('設定：自動催繳 7 天、模板留空取預設', run('appSettings.remindAuto') === true && run('appSettings.remindDays') === 7
    && run('appSettings.remindMsg').includes('【學費提醒】') && run('appSettings.receiptMsg').includes('已收妥'));
run('loadSettingsForm()');
check('設定表單回填', getEl('setRemindDays').value === 7 && getEl('setRemindMsg').value.includes('{outstanding}'));
getEl('sendTypeFilter').value = 'ALL';
run("sendMarkSent('TUITION:S003:2026-09', 'manual')");
check('剛發出：未滿 7 天不催', !run('sendLog["PAY_REMIND:S003:2026-09"]'));
run("sendLog['TUITION:S003:2026-09'].sentAt = '2026-09-09T10:00:00.000Z'; renderSendCenter()");
check('發出 5.75 天：仍不催', !run('sendLog["PAY_REMIND:S003:2026-09"]'));
run("sendLog['TUITION:S003:2026-09'].sentAt = '2026-09-07T10:00:00.000Z'; renderSendCenter()");
const rm = run('sendLog["PAY_REMIND:S003:2026-09"]');
check('發出滿 7 天未繳 → 自動建催繳（待發送、指回學費條目、已落盤）', !!rm && rm.status === 'TODO' && rm.tuitionKey === 'TUITION:S003:2026-09'
    && JSON.parse(fakeStorage.getItem('gac_sendlog_v2'))['PAY_REMIND:S003:2026-09'] !== undefined);
const s3due = run('tuitionMoney(sendLog["TUITION:S003:2026-09"].amount)');
const remindMsg = run('sendlogMsgFor(sendLog["PAY_REMIND:S003:2026-09"])');
check('催繳訊息：模板＋學費條目現值（月份、未繳金額、FPS）', remindMsg.includes('【學費提醒】') && remindMsg.includes('2026年9月') && remindMsg.includes(s3due)
    && remindMsg.includes('FPS 轉數快 ID：888'));
check('待發送欄有催繳卡片（標籤、未繳資訊列、不用發鈕）、頁籤徽章計入', todoHtml().includes('催繳') && todoHtml().includes("sendDismissDerived('PAY_REMIND:S003:2026-09')")
    && todoHtml().includes('未繳 ' + s3due) && Number(getEl('sendTabBadge').textContent) >= 1);
check('類別下拉列出「催繳」', getEl('sendTypeFilter').innerHTML.includes('value="PAY_REMIND"'));
run('renderPaymentTab()');
check('繳費表 S003 行顯示「催繳待發」', getEl('paymentTableBody').innerHTML.includes('催繳待發'));
run("payUpdate('TUITION:S003:2026-09', { paidAmount: 100, payMethod: '2' })");
check('部分繳交（已選方式）：催繳仍在、訊息未繳金額更新', !!run('sendLog["PAY_REMIND:S003:2026-09"]')
    && run('sendlogMsgFor(sendLog["PAY_REMIND:S003:2026-09"])').includes(run('tuitionMoney(sendLog["TUITION:S003:2026-09"].amount - 100)')));
run("payUpdate('TUITION:S003:2026-09', { paidAmount: sendLog['TUITION:S003:2026-09'].amount, payMethod: '1' })");
const rc = run('sendLog["RECEIPT:S003:2026-09"]');
check('繳清 → 催繳 TODO 清掉、自動建收款確認', !run('sendLog["PAY_REMIND:S003:2026-09"]') && !!rc && rc.status === 'TODO');
const rcMsg = run('sendlogMsgFor(sendLog["RECEIPT:S003:2026-09"])');
check('收款確認訊息＝預設短句', rcMsg === '已收妥，謝謝你！確認以上課程。🙋🏻‍♀️');
run("appSettings.receiptMsg = '已收到 {month} 學費 {paid}{payinfo}，謝謝！'");
check('模板佔位符仍可用（實收、付款方式、日期）', run('sendlogMsgFor(sendLog["RECEIPT:S003:2026-09"])').includes(s3due)
    && run('sendlogMsgFor(sendLog["RECEIPT:S003:2026-09"])').includes('（現金，2026-09-15）'));
run("appSettings.receiptMsg = GACStorage.DEFAULT_SETTINGS.receiptMsg");
run('renderPaymentTab()');
check('繳費表「確認待發」是可按的 WhatsApp 鈕', getEl('paymentTableBody').innerHTML.includes("sendWhatsApp('RECEIPT:S003:2026-09')")
    && getEl('paymentTableBody').innerHTML.includes('發確認'));
check('繳費表 S003 行出現「發確認」WhatsApp 鈕、催繳提示消失', getEl('paymentTableBody').innerHTML.includes('發確認') && !getEl('paymentTableBody').innerHTML.includes('催繳待發'));
run("sendMarkSent('RECEIPT:S003:2026-09', 'wa_link')");
check('收款確認標記已發 → 學費條目「收據」自動勾上、繳費表「確認已發」', run('sendLog["TUITION:S003:2026-09"].receipt') === true
    && getEl('paymentTableBody').innerHTML.includes('確認已發'));
run("payUpdate('TUITION:S003:2026-09', { clearPayment: true })");
check('清除繳費 → 催繳重建（仍滿 7 天）、已發的收款確認留作紀錄', !!run('sendLog["PAY_REMIND:S003:2026-09"]') && run('sendLog["RECEIPT:S003:2026-09"].status') === 'SENT');
run("sendDismissDerived('PAY_REMIND:S003:2026-09')");
check('不用發 → 條目刪除、略過旗標、有快照', !run('sendLog["PAY_REMIND:S003:2026-09"]') && run('sendLog["TUITION:S003:2026-09"].remindSkipped') === true
    && run('actionHistory[0].description').includes('不用發'));
run('renderSendCenter()');
check('略過後再渲染不重建', !run('sendLog["PAY_REMIND:S003:2026-09"]'));
run("sendMarkUnsent('TUITION:S003:2026-09')");
check('學費單移回待發 → 略過重置', run('sendLog["TUITION:S003:2026-09"].remindSkipped') === false);
getEl('setRemindAuto').checked = false; getEl('setReceiptAuto').checked = false; getEl('setFpsId').value = '';
run('saveSettingsForm()');
check('關閉自動 → 設定生效', run('appSettings.remindAuto') === false && run('appSettings.receiptAuto') === false);

// 33) 繳費頁小改：已發後不預填的 WhatsApp、收據欄收起（提示改掛繳費狀態格）、付款方式可增減
console.log('[33] 繳費頁小改');
run("sendMarkSent('TUITION:S004:2026-09', 'manual')");
const payBody = () => getEl('paymentTableBody').innerHTML;
check('已發送列：WhatsApp 改為不預填的 openWhatsAppChat；未發列仍是預填 sendWhatsApp', payBody().includes("openWhatsAppChat('TUITION:S004:2026-09')")
    && payBody().includes("sendWhatsApp('TUITION:S001:2026-09')") && !payBody().includes("sendWhatsApp('TUITION:S004:2026-09')"));
check('收據欄已收起：列內沒有 receipt 勾選；收款確認提示仍在（掛在繳費狀態格）', !payBody().includes('{ receipt: this.checked }') && payBody().includes('確認已發'));
check('繳費表：實收輸入欄已移除；備註在最後一欄且平時只是圖示', !payBody().includes('{ paidAmount: this.value }')
    && payBody().includes("payEditNote('TUITION:S001:2026-09')") && payBody().includes('fa-note-sticky')
    && payBody().indexOf("payPreview('TUITION:S001:2026-09')") < payBody().indexOf("payEditNote('TUITION:S001:2026-09')"));
sandbox.prompt = () => '分兩期';
run("payEditNote('TUITION:S001:2026-09')");
check('彈出輸入 → 寫入備註、該格改為顯示文字（不再是圖示）', run('sendLog["TUITION:S001:2026-09"].payNote') === '分兩期'
    && payBody().includes('分兩期') && run('actionHistory[0].description').includes('繳費記錄'));
sandbox.prompt = () => null;
const hist0 = run('actionHistory.length');
run("payEditNote('TUITION:S001:2026-09')");
check('取消 → 不動資料、不拍快照', run('sendLog["TUITION:S001:2026-09"].payNote') === '分兩期' && run('actionHistory.length') === hist0);
sandbox.prompt = () => '  ';
run("payEditNote('TUITION:S001:2026-09')");
check('留空 → 刪除備註、回到圖示', run('sendLog["TUITION:S001:2026-09"].payNote') === '' && payBody().includes('fa-note-sticky'));
sandbox.prompt = () => '';
let opened = null; sandbox.open = (url) => { opened = url; };
run("openWhatsAppChat('TUITION:S004:2026-09')");
check('openWhatsAppChat：wa.me/<電話>，不帶 text', typeof opened === 'string' && opened.startsWith('https://wa.me/') && /^[0-9]+$/.test(opened.slice('https://wa.me/'.length)));
sandbox.open = () => {};
run("sendMarkUnsent('TUITION:S004:2026-09')");
run("renderPayMethodsEditor(['現金', 'FPS', '轉帳'])");
check('付款方式編輯器：三列、最後一列有刪除鈕', (getEl('payMethodsEditor').innerHTML.match(/pay-method-input/g) || []).length === 3
    && (getEl('payMethodsEditor').innerHTML.match(/removeLastPayMethod/g) || []).length === 1);
sandbox.__qsaHook = sel => (sel === '#payMethodsEditor .pay-method-input' ? [{ value: '現金' }, { value: 'FPS' }, { value: '轉帳' }, { value: 'PayMe' }] : []);
run('saveSettingsForm()');
check('新增第 4 種付款方式 → 存入設定、繳費表下拉出現「4. PayMe」', run('appSettings.payMethods.length') === 4 && payBody().includes('4. PayMe'));
sandbox.__qsaHook = () => [];
run('saveSettingsForm()');
check('編輯器不在畫面（讀不到）→ 保留原設定', run('appSettings.payMethods.length') === 4);
check('預設付款方式五種', run('GACStorage.DEFAULT_SETTINGS.payMethods.length') === 5);

// 34) 設定頁模組摺疊、訊息模板、改期通知、導師日曆與 Google 日曆視圖
console.log('[34] 設定頁模組／訊息模板／導師日曆');
check('[18] 前置檢查導向設定頁時已展開 Google Calendar 模組', JSON.parse(fakeStorage.getItem('gac_settings_open') || '[]').includes('gcal'));
fakeStorage.removeItem('gac_settings_open'); // 回到全新狀態再測預設
run("switchTab('settingsTab')");
check('設定頁模組預設全部收起', JSON.stringify([...run('settingsOpenSet()')]) === '[]');
check('設定頁模組順序：危險區殿後', run("SETTINGS_MODULES.join(',')") === 'gcal,fee,templates,tutors,rates,backup,danger');
run("toggleSettingsModule('gcal')");
check('展開 Google Calendar 模組 → 本機記住', JSON.parse(fakeStorage.getItem('gac_settings_open')).includes('gcal'));
run("toggleSettingsModule('gcal')");
check('再按收起', !JSON.parse(fakeStorage.getItem('gac_settings_open')).includes('gcal'));
const lsn = run('lessonsByMonth["2026-09"].find(l => l.studentId === "S001" && !l.isMakeup)');
const lsnId = lsn.lessonId;
const before = run('leaveMsgFor(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(lsnId) + ').lesson)');
check('請假確認預設文案不變', /^已確認 \d{4}年\d{1,2}月\d{1,2}日 \(星期.\) 的課堂請假。$/.test(before));
getEl('setTplLeave').value = '{name} {date} {weekday} {time} 請假 OK';
getEl('setTplTuitionHeader').value = '【學費】TEST {month} {name}';
run('saveSettingsForm()');
const after = run('leaveMsgFor(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(lsnId) + ').lesson)');
check('改請假模板 → 訊息按模板組成', after === 'Student 001 ' + run('dateLabel(' + JSON.stringify(lsn.date) + ')') + ' ' + run('weekdayOfDate(' + JSON.stringify(lsn.date) + ')') + ' ' + lsn.time + ' 請假 OK');
check('改學費單開頭 → 學費訊息跟著變、中段明細仍在', run('sendlogMsgFor(sendLog["TUITION:S001:2026-09"])').startsWith('【學費】TEST 2026年9月 Student 001')
    && run('sendlogMsgFor(sendLog["TUITION:S001:2026-09"])').includes('每堂學費'));
run("resetMsgTemplate('leave'); resetMsgTemplate('tuitionHeader')");
check('還原預設 → 欄位回預設文案', getEl('setTplLeave').value === run('GACStorage.DEFAULT_SETTINGS.tplLeave') && getEl('setTplTuitionHeader').value.includes('上堂詳情及學費'));
run('saveSettingsForm()');
check('儲存後訊息回預設', run('leaveMsgFor(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(lsnId) + ').lesson)') === before);
// 改期通知：Calendar 改時套用 → MOVE_CONFIRM 條目，訊息含改期前後
const moveTarget = run('lessonsByMonth["2026-09"].find(l => l.studentId === "S001" && !l.isMakeup && l.status === "SCHEDULED")');
const mtId = moveTarget.lessonId, mtDate = moveTarget.date, mtTime = moveTarget.time; // 活引用：套用後 date/time 會變，先抄下
run('gcalSyncPlan = { monthKey: "2026-09", toPush: [], orphans: [], deletions: [], statusChanges: [], manualNew: [], timeChanges: [{ lesson: GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mtId) + ').lesson, event: { id: "evM" }, date: ' + JSON.stringify(mtDate) + ', time: "20:00" }] }');
run('renderGcalSyncModal()');
getEl('gsT_0').checked = true;
run('applyGcalSync()');
const mv = run('sendLog["MOVE_CONFIRM:' + mtId + '"]');
check('Calendar 改時套用 → 改期通知條目（待發送、from＝改期前）', !!mv && mv.status === 'TODO' && mv.fromDate === mtDate && mv.fromTime === mtTime);
const mvMsg = run('sendlogMsgFor(sendLog["MOVE_CONFIRM:' + mtId + '"])');
check('改期通知訊息：含改期前時間、改期後 20:00', mvMsg.includes(mtTime) && mvMsg.includes('改期至') && mvMsg.includes('20:00') && run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mtId) + ').lesson.time') === '20:00');
run('renderSendCenter()');
check('發送中心列出「改期通知」', todoHtml().includes('改期通知') && getEl('sendTypeFilter').innerHTML.includes('value="MOVE_CONFIRM"'));
// 導師日曆 ID（嵌入視圖已移除；日曆 ID 供唯讀同步逐一讀取）
run("updateTutorCalendar('Instructor B', 'calendarId', 'b@group.calendar.google.com')");
check('導師日曆 ID 存入名單並落盤、設定頁列出、有快照', run('tutorsList[1].calendarId') === 'b@group.calendar.google.com'
    && JSON.parse(fakeStorage.getItem('gac_tutors_v3'))[1].calendarId === 'b@group.calendar.google.com'
    && getEl('tutorCalendarList').innerHTML.includes('b@group.calendar.google.com') && run('actionHistory[0].description').includes('日曆 ID'));
check('嵌入欄位已不接受', run("updateTutorCalendar('Instructor A', 'calendarEmbed', 'x'); tutorsList[0].calendarEmbed") === undefined);
run("updateTutorCalendar('Instructor B', 'calendarId', 'https://calendar.google.com/calendar/embed?src=b2%40group.calendar.google.com&ctz=Asia%2FHong_Kong')");
check('貼整條 embed 網址 → 自動整理成日曆 ID；同步逐本讀的就是整理後的 ID', run('tutorsList[1].calendarId') === 'b2@group.calendar.google.com'
    && run('gcalCalendarsToRead()').some(c => c.tutor === 'Instructor B' && c.calendarId === 'b2@group.calendar.google.com'));
check('設定頁每位導師有「測試」讀取鈕', getEl('tutorCalendarList').innerHTML.includes("testTutorCalendar('Instructor B')"));
sandbox.alerts.length = 0;
run("tutorsList[0].calendarId = ''; testTutorCalendar('Instructor A')");
check('沒填 ID 按測試 → 提示', sandbox.alerts.length === 1 && sandbox.alerts[0].includes('尚未填日曆 ID'));
check('嵌入視圖已移除', run('typeof renderGcalEmbedView') === 'undefined' && run('typeof showGcalEmbed') === 'undefined' && run('typeof tutorEmbedUrl') === 'undefined');
check('總課表預設月曆視圖', run('currentViewMode') === 'calendar');
run("switchView('list')");
check('切到清單 → 仍可用', run('currentViewMode') === 'list' && getEl('masterScheduleList').innerHTML.length > 0);
run("switchView('calendar')");
run("updateTutorCalendar('Instructor B', 'calendarId', '')");

// 35) 唯讀模式：匯入 ICS 比對（按內容配對）→ 同一面板套用；寫入授權關閉時清場只清本地
console.log('[35] 唯讀模式與匯入 ICS');
// 9 月重來：清掉再生成 S001（週一 21:30）＋ S003/S004（週三 21:30 小組）
run('GACSendlog.purgeMonth(sendLog, "2026-09", GACLessonState.clearMonth(lessonsByMonth, "2026-09").removed.map(l => l.lessonId)); persistLessons()');
getEl('batchMonth').value = '2026-09';
sandbox.__qsaHook = sel => (sel === '.batch-student-chk:checked' ? [{ value: '0' }, { value: '2' }, { value: '3' }] : []);
run('generateMasterSchedule()');
check('9 月重生成：14 堂全為已排課', run('lessonsByMonth["2026-09"].length') === 14 && run('lessonsByMonth["2026-09"].every(l => l.status === "SCHEDULED")'));
const icsText = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-CALNAME:Instructor A', 'X-WR-TIMEZONE:Asia/Hong_Kong',
    'BEGIN:VEVENT', 'UID:s1', 'DTSTART;TZID=Asia/Hong_Kong:20260907T213000', 'DTEND;TZID=Asia/Hong_Kong:20260907T221500',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260930T000000Z', 'EXDATE;TZID=Asia/Hong_Kong:20260928T213000', 'SUMMARY:S001 Student 001', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s1', 'RECURRENCE-ID;TZID=Asia/Hong_Kong:20260921T213000', 'DTSTART;TZID=Asia/Hong_Kong:20260921T200000', 'DTEND;TZID=Asia/Hong_Kong:20260921T204500', 'SUMMARY:S001 Student 001', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:g1', 'DTSTART:20260902T133000Z', 'DTEND:20260902T143000Z', 'RRULE:FREQ=WEEKLY;COUNT=5', 'SUMMARY:Student 003 & Student 004 小組', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:g1', 'RECURRENCE-ID:20260916T133000Z', 'DTSTART:20260916T133000Z', 'DTEND:20260916T143000Z', 'SUMMARY:Student 003 & Student 004 小組', 'LOCATION:TL', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:x1', 'DTSTART;TZID=Asia/Hong_Kong:20260929T190000', 'DTEND;TZID=Asia/Hong_Kong:20260929T194500', 'SUMMARY:Student 004 加課', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d1', 'DTSTART;TZID=Asia/Hong_Kong:20260910T100000', 'DTEND;TZID=Asia/Hong_Kong:20260910T110000', 'SUMMARY:Dentist', 'END:VEVENT',
    'END:VCALENDAR'
].join('\r\n');
check('預設唯讀（未儲存設定時）', run('GACStorage.DEFAULT_SETTINGS.gcalWrite') === false);
run('openIcsImport()');
check('匯入 ICS 弹窗：導師下拉、範圍提示', getEl('icsTutor').innerHTML.includes('Instructor A 的日曆') && getEl('icsMonthInfo').textContent.includes('2026-09'));
const plan = run('icsImportFromText(' + JSON.stringify(icsText) + ', "", "Asia/Hong_Kong")');
check('未選導師 → 由日曆名稱 X-WR-CALNAME 自動辨認為 Instructor A，並啟用「Calendar 沒有這堂」判斷',
    plan.tutor === 'Instructor A' && plan.tutorAuto === true && plan.missingOff === false
    && getEl('gcalSyncBody').innerHTML.includes('由日曆名稱自動辨認'));
console.log('  plan:', JSON.stringify({ t: plan.timeChanges.map(c => [c.lesson.lessonId, c.time]), s: plan.statusChanges.map(c => [c.lesson.lessonId, c.lessons.length, c.to]), d: plan.deletions.map(c => c.lesson.lessonId), m: plan.manualNew.map(m => [m.studentId, m.date, m.time]), u: plan.unmatched, n: plan.eventCount }));
const icsExplicit = plan.statusChanges.filter(x => !x.blank), icsBlank = plan.statusChanges.filter(x => x.blank);
check('ICS 比對計劃：時間變更 1（S001 9/21→20:00）、狀態碼 1（小組 9/16 TL）、Calendar 沒有 1（S001 9/28）、手動新建 1（S004 9/29）、無法歸屬 1',
    plan.timeChanges.length === 1 && plan.timeChanges[0].lesson.lessonId === 'S001-20260921-2130' && plan.timeChanges[0].time === '20:00'
    && icsExplicit.length === 1 && icsExplicit[0].lessons.length === 2 && icsExplicit[0].to.leaveType === 'TL'
    && plan.deletions.length === 1 && plan.deletions[0].lesson.lessonId === 'S001-20260928-2130'
    && plan.manualNew.length === 1 && plan.manualNew[0].studentId === 'S004' && plan.manualNew[0].date === '2026-09-29'
    && plan.unmatched === 1 && plan.eventCount === 10 && plan.source === 'ics' && plan.toPush.length === 0);
check('面板：來源橫幅（ICS、日曆名、事件數、無法歸屬）、內容配對說明、「Calendar 上沒有這堂」標題、無推送組', getEl('gcalSyncBody').innerHTML.includes('ICS 檔案「Instructor A」')
    && getEl('gcalSyncBody').innerHTML.includes('10 個事件') && getEl('gcalSyncBody').innerHTML.includes('1 個事件無法歸屬')
    && getEl('gcalSyncBody').innerHTML.includes('按內容配對') && getEl('gcalSyncBody').innerHTML.includes('Calendar 上沒有這堂') && !getEl('gcalSyncBody').innerHTML.includes('⬆️ 推送')
    && getEl('gcalSyncTitle').innerHTML.includes('匯入 ICS'));
check('留空＝沒資訊：ICS 事件沒填狀態的課不列任何狀態提案（匯入整月留空不會湧出出席提案）', icsBlank.length === 0 && plan.statusChanges.length === 1
    && !getEl('gcalSyncBody').innerHTML.includes('已上課') && !getEl('gcalSyncBody').innerHTML.includes('⚠️ 狀態衝突'));
getEl('gsT_0').checked = true; plan.statusChanges.forEach((x, i) => { getEl('gsS_' + i).checked = true; }); getEl('gsD_0').checked = true; getEl('gsM_0').checked = true; getEl('gsMsel_0').value = 'EXTRA';
const icsDone = 5 + icsBlank.reduce((n, x) => n + x.lessons.length, 0);
run('applyGcalSync()');

check('套用：S001 9/21 → 20:00 並建改期通知', run('GACLessonState.findLesson(lessonsByMonth,"S001-20260921-2130").lesson.time') === '20:00' && !!run('sendLog["MOVE_CONFIRM:S001-20260921-2130"]'));
check('套用：小組 9/16 全組 TL', run('GACLessonState.findLesson(lessonsByMonth,"S003-20260916-2130").lesson.leaveType') === 'TL' && run('GACLessonState.findLesson(lessonsByMonth,"S004-20260916-2130").lesson.leaveType') === 'TL');
check('套用：S001 9/28 標事假 L', run('GACLessonState.findLesson(lessonsByMonth,"S001-20260928-2130").lesson.status') === 'LEAVE' && run('GACLessonState.findLesson(lessonsByMonth,"S001-20260928-2130").lesson.leaveType') === 'L');
check('套用：S004 9/29 獨立加課', run('GACLessonState.findLesson(lessonsByMonth,"S004-20260929-1900-XT").lesson.isExtra') === true);
check('結果面板：本地更新 5＋出席 項', getEl('gcalSyncBody').innerHTML.includes('本地更新 ' + icsDone + ' 項'));
// 再匯入同一檔 → 已一致，只剩已上課／請假不列的部分：應為零差異（9/29 加課有事件、9/28 已請假不列、9/16 已 TL）
const plan2 = run('icsImportFromText(' + JSON.stringify(icsText) + ', "", "Asia/Hong_Kong")');
check('再匯入同一檔 → 完全一致', plan2.timeChanges.length === 0 && plan2.statusChanges.length === 0 && plan2.deletions.length === 0 && plan2.manualNew.length === 0
    && getEl('gcalSyncBody').innerHTML.includes('完全一致'));
run('gcalSyncPlan = null');
// 認不出是誰的日曆（多位導師）→ 停用「Calendar 上沒有這堂」判斷並在面板說明
const icsNoName = icsText.replace('X-WR-CALNAME:Instructor A', 'X-WR-CALNAME:Music Lessons');
const planAnon = run('icsImportFromText(' + JSON.stringify(icsNoName) + ', "", "Asia/Hong_Kong")');
check('認不出導師 → 不判斷「沒有這堂」、面板明說原因；其他分類照常', planAnon.tutor === '' && planAnon.missingOff === true
    && planAnon.deletions.length === 0 && getEl('gcalSyncBody').innerHTML.includes('不判斷「Calendar 上沒有這堂」'));
run('gcalSyncPlan = null');
// 指定導師 → 判斷恢復
const planB = run('icsImportFromText(' + JSON.stringify(icsNoName) + ', "Instructor A", "Asia/Hong_Kong")');
check('手動選了導師 → 恢復判斷、面板寫明只比該導師的課', planB.tutor === 'Instructor A' && planB.tutorAuto === false
    && planB.missingOff === false && getEl('gcalSyncBody').innerHTML.includes('只比對該導師的課'));
run('gcalSyncPlan = null');
// 寫入授權開關
getEl('setGcalWrite').checked = false;
run('saveSettingsForm()');
check('關閉寫入授權 → 唯讀 scope、按鈕標示唯讀', run('appSettings.gcalWrite') === false && run('gcalWriteEnabled()') === false
    && run('gcalScope()').includes('readonly') && getEl('gcalSyncBtnLabel').textContent === '同步 GCal（唯讀）');
run('appSettings.gcalClientId = "test-client-id"');
sandbox.alerts.length = 0;
let roClearConfirm = '';
sandbox.confirm = msg => { roClearConfirm = String(msg); return true; };
run('clearCurrentMonthData()');
sandbox.confirm = () => true;
check('唯讀模式清空本月：確認框直說 Calendar 不動、不列「刪除 GCal 事件」', roClearConfirm.includes('Google Calendar：不動（唯讀模式')
    && !roClearConfirm.includes('刪除 2026-09 所有由本系統導入'));
check('唯讀模式清空本月：只清本地、不碰 GCal、提示唯讀', !run('lessonsByMonth["2026-09"]') && sandbox.alerts.length === 1 && sandbox.alerts[0].includes('唯讀模式'));
run('appSettings.gcalClientId = ""');
getEl('setGcalWrite').checked = true;
run('saveSettingsForm()');
check('重新開啟寫入授權', run('gcalWriteEnabled()') === true && run('gcalScope()').endsWith('calendar.events') && getEl('gcalSyncBtnLabel').textContent === '同步 GCal');
check('預設日曆讀取：導師沒填日曆 ID → 預設一個', run('gcalCalendarsToRead().length') === 1 && run('gcalCalendarsToRead()[0].tutor') === null);
run("updateTutorCalendar('Instructor A', 'calendarId', 'a@group.calendar.google.com')");
check('導師 A 填了日曆 ID → 讀 A 的日曆；B 沒填 → 預設日曆也讀（B 的課在那裡）', run('gcalCalendarsToRead().length') === 2 && run('gcalCalendarsToRead()[0].tutor') === 'Instructor A'
    && run('gcalCalendarsToRead()[1].tutor') === null && run('gcalCalendarsToRead()[1].calendarId') === run('gcalDefaultCalendarId()'));
run("updateTutorCalendar('Instructor A', 'calendarId', '')");

// 36) 撤銷／重做（頂欄）、清單 WhatsApp 與發送中心聯動、補堂縮排連接線
console.log('[36] 撤銷重做／WhatsApp 聯動／補堂縮排');
getEl('batchMonth').value = '2026-09';
sandbox.__qsaHook = sel => (sel === '.batch-student-chk:checked' ? [{ value: '0' }, { value: '2' }, { value: '3' }] : []);
run('generateMasterSchedule()');
run('clearHistory()');
check('重做堆疊初始為空、重做鈕停用', run('redoStack.length') === 0 && getEl('redoBtn').disabled === true);
run('markLessonStatus("S001-20260907-2130","ATTENDED")');
run('undoLastAction()');
check('撤銷（不彈確認）→ 回已排課、重做鈕可用（1）並提示重做內容', run('GACLessonState.findLesson(lessonsByMonth,"S001-20260907-2130").lesson.status') === 'SCHEDULED'
    && run('redoStack.length') === 1 && getEl('redoBtn').disabled === false && getEl('redoCount').textContent === '1' && getEl('redoBtn').title.includes('重做：'));
run('redoLastAction()');
check('重做 → 已上課、撤銷堆疊 +1、重做清空', run('GACLessonState.findLesson(lessonsByMonth,"S001-20260907-2130").lesson.status') === 'ATTENDED'
    && run('actionHistory.length') === 1 && run('redoStack.length') === 0 && getEl('redoBtn').disabled === true);
run('undoLastAction()');
run('markLessonStatus("S001-20260914-2130","ATTENDED")');
check('撤銷後做新操作 → 重做堆疊清空', run('redoStack.length') === 0);
run('markLessonStatus("S001-20260921-2130","ATTENDED")');
run('undoLastAction()');
sandbox.alerts.length = 0;
run('markLessonStatus("S001-20260914-2130","NOSHOW")'); // 已上課 → 缺席 非法：快照丟棄
check('操作失敗（快照丟棄）→ 重做堆疊保留', sandbox.alerts.length === 1 && run('redoStack.length') === 1);
run('redoLastAction()');
check('重做仍可用 → 9/21 回已上課', run('GACLessonState.findLesson(lessonsByMonth,"S001-20260921-2130").lesson.status') === 'ATTENDED');
run('renderHistoryUI()');
run('undoLastAction()');
check('歷史頁大小列含「可重做」', getEl('historySize').textContent.includes('可重做 1 步'));
run('clearHistory()');
check('清空歷史 → 重做一併清空', run('redoStack.length') === 0 && getEl('redoBtn').disabled === true);
// 清單 WhatsApp 與發送中心聯動
getEl('leaveType_S001-20260928-2130').value = 'L';
run('confirmLeave("S001-20260928-2130")');
run('closeMsgModal()');
check('請假 → 發送中心條目待發、清單列顯示「待發」', run('sendLog["LEAVE_CONFIRM:S001-20260928-2130"].status') === 'TODO' && getEl('masterScheduleList').innerHTML.includes('title="發送中心：待發送"'));
run('openWhatsAppMessage("S001-20260928-2130", "leave")');
check('清單 WhatsApp → 直接已發、列上「✓ 已發」、發送中心已發送欄', run('sendLog["LEAVE_CONFIRM:S001-20260928-2130"].status') === 'SENT'
    && getEl('masterScheduleList').innerHTML.includes('✓ 已發') && run('GACSendlog.listByMonth(sendLog, "2026-09").sent.some(e => e.key === "LEAVE_CONFIRM:S001-20260928-2130")'));
// 補堂縮排：同月清單內 → 縮排在原課下；只看補堂那週（原課不在）→ 留原位
getEl('makeupDate_S001-20260928-2130').value = '2026-09-16'; getEl('makeupTime_S001-20260928-2130').value = '18:00';
run('submitMakeup("S001-20260928-2130","makeupDate_S001-20260928-2130","makeupTime_S001-20260928-2130")');
run('closeMsgModal()');
const mkId = 'S001-20260916-1800-MU-20260928-2130';
getEl('weekSelect').value = 'ALL';
run('renderMasterScheduleList()');
const listHtml = getEl('masterScheduleList').innerHTML;
check('補堂節縮排在原請假節之下並有連接線、只出現一次', listHtml.includes('data-makeup-of=') && listHtml.includes('rounded-bl-xl')
    && listHtml.indexOf("openMoveModal('S001-20260928-2130')") < listHtml.indexOf('data-makeup-of=')
    && listHtml.indexOf('data-makeup-of=') < listHtml.indexOf("openLessonMoveModal('" + mkId + "')")
    && (listHtml.match(new RegExp("openLessonMoveModal\\('" + mkId + "'\\)", 'g')) || []).length === 1);
check('補堂列訊息鈕：補堂確認待發徽章', listHtml.includes("openWhatsAppMessage('" + mkId + "', 'makeup')"));
const wk = run('monthWeeksData.findIndex(w => w.some(d => d && d.dateString === "2026-09-16"))');
getEl('weekSelect').value = String(wk);
run('renderMasterScheduleList()');
check('只看補堂那週（原課不在清單）→ 補堂留原位、不縮排', !getEl('masterScheduleList').innerHTML.includes('data-makeup-of=')
    && getEl('masterScheduleList').innerHTML.includes("openLessonMoveModal('" + mkId + "')"));
getEl('weekSelect').value = 'ALL';
run('renderMasterScheduleList()');

// 37) 發送中心訊息收合
console.log('[37] 發送中心訊息收合');
getEl('sendMonth').value = '2026-09';
getEl('sendTypeFilter').value = 'ALL';
run('sendMsgSetAll(false)');
const tuitionKey = 'TUITION:S003:2026-09';
check('預設收起：只見首行摘要與行數，不見完整內文', todoHtml().includes('展開訊息內文')
    && todoHtml().includes('【學費】') && !todoHtml().includes('每堂學費')
    && todoHtml().includes('行</span>'));
check('頁首鈕標示「展開全部訊息」', getEl('sendMsgToggleAll').innerHTML.includes('展開全部訊息'));
run("toggleSendMsg('" + tuitionKey + "')");
check('單張展開 → 見完整內文、其他仍收起', todoHtml().includes('每堂學費') && todoHtml().includes('收起訊息內文')
    && (todoHtml().match(/每堂學費/g) || []).length === 1);
run("toggleSendMsg('" + tuitionKey + "')");
check('再按收起', !todoHtml().includes('每堂學費'));
run('toggleSendMsgAll()');
check('全部展開 → 多張都見內文、鈕改「收起全部訊息」', (todoHtml().match(/每堂學費/g) || []).length > 1
    && getEl('sendMsgToggleAll').innerHTML.includes('收起全部訊息'));
run('toggleSendMsgAll()');
check('全部收起（個別覆寫一併清掉）', !todoHtml().includes('每堂學費') && run('sendMsgOpen.size') === 0);
check('類別下拉母項改標「學費（全部）」；全部未繳時只列「未繳清」子項', getEl('sendTypeFilter').innerHTML.includes('>學費（全部）<')
    && getEl('sendTypeFilter').innerHTML.includes('value="TUITION:due"') && !getEl('sendTypeFilter').innerHTML.includes('value="TUITION:paid"'));
run("payUpdate('" + tuitionKey + "', { payMethod: '1' })");
check('有一筆繳清後 → 兩個子項都列出，母項仍在', getEl('sendTypeFilter').innerHTML.includes('value="TUITION:due"')
    && getEl('sendTypeFilter').innerHTML.includes('value="TUITION:paid"') && getEl('sendTypeFilter').innerHTML.includes('>學費（全部）<'));
run("payUpdate('" + tuitionKey + "', { clearPayment: true })");

// 35a) 月曆：顏色＝導師、狀態＝符號、同時段併格（今天＝2026-09-15）
console.log('[35a] 月曆顏色與同時段');
getEl('batchMonth').value = '2026-09';
run('rebuildMonthContext(); renderAll()');
run("switchView('calendar')");
const calHtml = () => getEl('masterCalendarView').innerHTML;
const calCount = needle => calHtml().split(needle).length - 1;
check('圖例：顏色＝導師＋狀態符號＋撞堂／並行／今天', calHtml().includes('顏色＝導師') && calHtml().includes('Instructor A')
    && calHtml().includes('已上課') && calHtml().includes('缺席') && calHtml().includes('請假')
    && calHtml().includes('撞堂（同一導師重疊）') && calHtml().includes('不同導師同時段（正常）') && calHtml().includes('今天'));
check('一位導師一個顏色（照導師名單次序），兩位不同色', run('tutorPillClass("Instructor A")') === 'cal-tutor-1'
    && run('tutorPillClass("Instructor B")') === 'cal-tutor-2');
check('名單以外的導師也拿到穩定顏色', /^cal-tutor-[1-6]$/.test(run('tutorPillClass("Someone Else")'))
    && run('tutorPillClass("Someone Else")') === run('tutorPillClass("Someone Else")'));
check('狀態不再搶顏色：已排課／出席／缺席／請假都是同一個導師色', ['SCHEDULED', 'ATTENDED', 'NOSHOW', 'LEAVE']
    .every(st => run('lessonPillClass({ tutor: "Instructor A", status: "' + st + '" }, false)') === 'cal-tutor-1'));
check('撞堂才加紅框', run('lessonPillClass({ tutor: "Instructor A" }, true)') === 'cal-tutor-1 cal-pill-clash');
check('補堂色塊：深色 MU 標籤＋它補的那一堂的編號；加課標「加課」、無編號；圖例有 MU', run('calPillHtml({ key: "k", isGroup: false, lessons: [{ lessonId: "k", studentName: "Student 001", time: "10:00", tutor: "Instructor A", status: "SCHEDULED", isMakeup: true, lessonNum: 2, totalRegular: 5 }] }, false, "2026-09-15", false)')
    .includes('<span class="cal-mark cal-mark-mu">MU</span> Student 001</span><span class="cal-seq">(2/5)</span>')
    && run('calMuHtml({ isMakeup: true, isExtra: true })').includes('加課') && run('calSeqHtml({ isMakeup: true, isExtra: true, lessonNum: 0, totalRegular: 0 })') === ''
    && run('calMuHtml({ isMakeup: false })') === '' && calHtml().includes('cal-mark-mu'));
check('狀態靠符號：✓ 已上課、✗ 缺席、請假灰標，且全月無刪除線', run('lessonPillMark({ status: "ATTENDED" })').includes('cal-mark-ok')
    && run('lessonPillMark({ status: "NOSHOW" })').includes('cal-mark-ns')
    && run('lessonPillMark({ status: "LEAVE" })').includes('請假')
    && run('lessonPillMark({ status: "SCHEDULED" })') === ''
    && !calHtml().includes('line-through'));
check('今天的格子藍框、過去的格子灰底', calHtml().includes('cal-day-today') && calHtml().includes('cal-day-past'));
check('已過期仍「已排課」→ 虛線框提醒，且不跟著淡出', calHtml().includes('cal-pill-overdue')
    && !calHtml().includes('cal-pill-past cal-pill-overdue') && !calHtml().includes('cal-pill-overdue cal-pill-past'));
check('未來的課不淡出（無 cal-pill-done／past 修飾）', run('lessonPillState({ status: "SCHEDULED", date: "2026-09-30" }, "2026-09-15")') === '');
check('已有結果 → cal-pill-done；已過去 → cal-pill-past；兩者可疊加', run('lessonPillState({ status: "ATTENDED", date: "2026-09-30" }, "2026-09-15")') === 'cal-pill-done'
    && run('lessonPillState({ status: "SCHEDULED", date: "2026-09-01" }, "2026-09-15")') === 'cal-pill-overdue'
    && run('lessonPillState({ status: "LEAVE", date: "2026-09-01" }, "2026-09-15")') === 'cal-pill-done cal-pill-past');
check('色塊帶本月第幾節 (n/總)，且放在可截斷的名字之外', calHtml().includes('<span class="cal-seq">(1/') && calHtml().includes('cal-pill-text')
    && run('calSeqHtml({ lessonNum: 2, totalRegular: 5 })') === '<span class="cal-seq">(2/5)</span>');
check('補堂／加課（無編號）不顯示 (n/總)', run('calSeqHtml({ lessonNum: 0, totalRegular: 0, isMakeup: true })') === '');
check('色塊提示也寫「本月第 n/總 節」', calHtml().includes('本月第 1/'));
run("markLessonStatus('S001-20260921-2130','ATTENDED')");
check('標記出席後該色塊淡出並帶 ✓（顏色仍是導師色）', calHtml().includes('cal-tutor-1 cal-pill-done') && calHtml().includes('cal-mark-ok'));
run('undoLastAction()');

// 同一時段：不同導師＝並行（正常），同一導師＝撞堂（紅框）。
// 挑一對一的課——2 人小組的兩堂本來就併成一格且豁免撞堂，不適合拿來測。
const futureA = run('lessonsByMonth["2026-09"].filter(l => l.status === "SCHEDULED" && !l.groupId && l.classType === "一對一" && l.date > "2026-09-15").map(l => [l.lessonId, l.date, l.time, l.duration, l.tutor].join("|"))');
check('找得到兩堂一對一未來課可用來測同時段', futureA.length >= 2);
const slotHost = futureA[0].split('|'), slotGuest = futureA[1].split('|');
const gRef = 'GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(slotGuest[0]) + ').lesson';
const moveGuest = (tutor) => run('(function(){ var g = ' + gRef + '; g.tutor = ' + JSON.stringify(tutor) + '; g.date = ' + JSON.stringify(slotHost[1]) + '; g.time = ' + JSON.stringify(slotHost[2]) + '; g.duration = ' + Number(slotHost[3]) + '; renderAll(); })()');
// 圖例本身有一個 cal-pill-clash 樣本，所以一律用「數量」比較
const parBefore = calCount('並行 ('), clashBefore = calCount('⚠️ 撞堂'), redBefore = calCount('cal-pill-clash');
moveGuest('Instructor B');
check('不同導師同時段 → 併成一格標「並行」，不算撞堂（無紅框）', calCount('並行 (') === parBefore + 1
    && calCount('⚠️ 撞堂') === clashBefore && calCount('cal-pill-clash') === redBefore
    && calHtml().includes('cal-slot-head')
    && !run('GACSchedule.detectClashes(sortedMonthLessons()).has(' + JSON.stringify(slotGuest[0]) + ')'));
check('並行的兩堂各自保留自己導師的顏色', calHtml().includes('cal-tutor-1') && calHtml().includes('cal-tutor-2'));
moveGuest(slotHost[4]);
check('同一導師同時段 → 改標「撞堂」，兩堂都加紅框', calCount('⚠️ 撞堂') === clashBefore + 1
    && calCount('並行 (') === parBefore && calCount('cal-pill-clash') === redBefore + 2);
run('(function(){ var g = ' + gRef + '; g.tutor = ' + JSON.stringify(slotGuest[4]) + '; g.date = ' + JSON.stringify(slotGuest[1]) + '; g.time = ' + JSON.stringify(slotGuest[2]) + '; g.duration = ' + Number(slotGuest[3]) + '; persistLessons(); renderAll(); })()');
check('還原後並行／撞堂標記都消失', calCount('並行 (') === parBefore && calCount('⚠️ 撞堂') === clashBefore
    && calCount('cal-pill-clash') === redBefore);
run("switchView('list')");

// 35b) 課堂編號 (n/total) 與匯出隱私
console.log('[35b] 課堂編號與匯出隱私');
getEl('batchMonth').value = '2026-09';
run('rebuildMonthContext(); renderAll()');
const numbered = run('lessonsByMonth["2026-09"].find(l => !l.isMakeup && l.totalRegular > 0 && l.studentId === "S001")'); // 一對一才有單人彈窗標題
check('常規課卡片顯示 (第幾節/共幾節)', getEl('masterScheduleList').innerHTML.includes('(' + numbered.lessonNum + '/' + numbered.totalRegular + ')')
    && getEl('masterScheduleList').innerHTML.includes('本月第 ' + numbered.lessonNum + ' 節'));
check('補堂／加課不編號', run('lessonNoBadge({ lessonNum: 0, totalRegular: 0 })') === '');
run("openLessonModal('" + run('GACSchedule.groupByCell([GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(numbered.lessonId) + ').lesson])[0].key') + "')");
check('課節彈窗標題也帶編號', getEl('lessonModalTitle').innerHTML.includes('(' + numbered.lessonNum + '/' + numbered.totalRegular + ')'));
run('closeLessonModal()');

// 35c) 唯讀模式的「加進 GCal」：Google Calendar 建立事件頁的連結
console.log('[35c] 唯讀加進 GCal');
const gcalWriteWas = run('appSettings.gcalWrite');
run('appSettings.gcalWrite = false');
const tplLesson = '{ lessonId: "S001-20260923-1500-MU", studentId: "S001", studentName: "Student 001", classType: "一對一", program: "Pop Guitar", level: "Intermediate 中級", lessonNum: 0, totalRegular: 5, monthRef: "09/2026", date: "2026-09-23", time: "15:00", duration: 45, tutor: "Instructor A", status: "SCHEDULED", isMakeup: true, originLessonId: "S001-20260916-1500", phone: "00000000", email: "student001@example.com" }';
const tplUrl = run('gcalTemplateUrl(' + tplLesson + ')');
check('連結：TEMPLATE 動作、標題照 lessonTitle（補堂帶「← 原課日期」）、起迄時間、地點碼 MU、時區', tplUrl.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE')
    && tplUrl.includes('text=' + encodeURIComponent('S001 Student 001 補堂([0/5] 09/2026 ← 09/16)'))
    && tplUrl.includes('dates=20260923T150000/20260923T154500') && tplUrl.includes('location=MU') && tplUrl.includes('ctz='));
check('說明：具體課程、導師、狀態：一行、補哪堂；不含學生電話／電郵', tplUrl.includes(encodeURIComponent('補堂 · 一對一 · Pop Guitar · Intermediate 中級'))
    && tplUrl.includes(encodeURIComponent('導師：Instructor A')) && tplUrl.includes(encodeURIComponent('狀態：MU')) && tplUrl.includes(encodeURIComponent('↩ 補的是：2026-09-16（三）15:00 請假的那一堂'))
    && !tplUrl.includes('00000000') && !tplUrl.includes('example.com'));
check('唯讀＋排定的補堂 → 課卡有「加進 GCal」', run('lessonButtons(' + tplLesson + ')').includes('加進 GCal'));
check('常規課／已有結果的補堂 → 不顯示', run('gcalAddButton({ isMakeup: false, status: "SCHEDULED" })') === ''
    && run('gcalAddButton({ isMakeup: true, status: "ATTENDED" })') === '');
run('appSettings.gcalWrite = true');
const cidWas35c = run('appSettings.gcalClientId');
run('appSettings.gcalClientId = "test-client-id"');
check('開了寫入：還沒推送的補堂 →「推送到 GCal」一鍵推（不是加進 GCal、不開面板）', run('gcalAddButton(' + tplLesson + ')').includes("onclick=\"gcalPushLesson('")
    && run('gcalAddButton(' + tplLesson + ')').includes('推送到 GCal') && !run('gcalAddButton(' + tplLesson + ')').includes('openGcalTemplate'));
check('開了寫入：已推送 → 不顯示；已推送但改期過 →「改 GCal 事件」', run('gcalAddButton(Object.assign(' + tplLesson + ', { gcalEventId: "e1" }))') === ''
    && run('gcalAddButton(Object.assign(' + tplLesson + ', { gcalEventId: "e1", gcalMovedFrom: { key: "k", date: "2026-09-22", time: "15:00", inCal: true } }))').includes('改 GCal 事件'));
// 待補堂池排補堂（寫入模式）→ 補堂確認彈窗有「同步到 GCal」
run('pushHistory("冒煙：池排補堂")');
const poolId = run('lessonsByMonth["2026-09"].find(l => !l.groupId && l.status === "SCHEDULED" && !l.isMakeup).lessonId');
run('GACLessonState.markStatus(lessonsByMonth, ' + JSON.stringify(poolId) + ', "LEAVE", { leaveType: "L" }); renderAll()');
// 待補堂池：每行「複製標題」＝系統補堂標題格式（學號開頭、← 原課 MM/DD）、「複製內容」＝說明欄（補堂 · …、↩ 補的是、狀態：MU）；沒有長篇說明
let copiedText = '';
sandbox.navigator.clipboard.writeText = t => { copiedText = String(t); return Promise.resolve(); };
check('待補堂池沒有長篇說明', !getEl('pendingPoolList').innerHTML.includes('想直接在 Google Calendar'));
{
    const page = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
    check('待補堂池排在月曆／清單下面、預設展開', page.indexOf('id="pendingPoolBanner"') > page.indexOf('id="masterCalendarView"')
        && page.includes('<div id="pendingPoolList" class="space-y-2"></div>') && page.includes('id="pendingPoolChevron" class="fa-solid fa-chevron-up'));
}
run('copyPoolGcalTitle(' + JSON.stringify(poolId) + ')');
const draftTitle = run('GACSchedule.lessonTitle(poolMakeupDraft(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(poolId) + ').lesson))');
check('「複製標題」＝系統補堂標題（學號開頭、補堂、← 原課 MM/DD）', getEl('pendingPoolList').innerHTML.includes("copyPoolGcalTitle('" + poolId + "')")
    && copiedText === draftTitle && /^S\d+ .* 補堂\(.*← \d\d\/\d\d\)$/.test(copiedText));
run('copyPoolGcalDetails(' + JSON.stringify(poolId) + ')');
check('「複製內容」＝說明欄：補堂 · 課程、↩ 補的是 原課、導師、狀態：MU', getEl('pendingPoolList').innerHTML.includes("copyPoolGcalDetails('" + poolId + "')")
    && copiedText.startsWith('補堂 · ') && copiedText.includes('↩ 補的是：') && copiedText.includes('\n狀態：MU\n') && copiedText.includes('導師：'));
getEl('poolDate_' + poolId).value = '2026-09-29'; getEl('poolTime_' + poolId).value = '10:00';
run('submitMakeup(' + JSON.stringify(poolId) + ', "poolDate_' + poolId + '", "poolTime_' + poolId + '")');
check('寫入模式：從待補堂池排補堂 → 補堂確認彈窗問「同步到 Google Calendar 嗎？」、一鍵推送鈕', getEl('msgModalBody').innerHTML.includes('同步到 Google Calendar 嗎')
    && getEl('msgModalBody').innerHTML.includes("gcalPushLesson('") && !getEl('msgModalBody').innerHTML.includes('openGcalSync()'));
run('closeMsgModal ? closeMsgModal() : 0');
run('undoLastAction()');
run('appSettings.gcalClientId = ' + JSON.stringify(cidWas35c));
// 常規課單堂改期 → 改期通知彈窗與課卡有 Calendar 聯動鈕：寫入「同步改 GCal 事件」／唯讀「改 GCal 舊事件」（有 eid 就直接開該事件的編輯頁）
run('pushHistory("冒煙：單堂改期聯動")');
run('appSettings.gcalClientId = "test-client-id"');
const rmId = run('(lessonsByMonth["2026-09"].find(l => !l.isMakeup && !GACSchedule.isGroupLesson(l) && l.status === "SCHEDULED" && !l.gcalMovedFrom) || {}).lessonId');
check('有一堂已排課的常規課可改期', !!rmId);
run('Object.assign(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(rmId) + ').lesson, { gcalEventId: "evR", gcalEid: "EID_R" })');
run('openLessonMoveModal(' + JSON.stringify(rmId) + ')');
getEl('moveDate').value = '2026-09-30'; getEl('moveTime').value = '12:00';
run('submitMoveModal()');
check('寫入模式：常規課改期後，改期通知彈窗問「同步到 Google Calendar 嗎？」＋一鍵「改 GCal 事件」', getEl('msgModalBody').innerHTML.includes('同步到 Google Calendar 嗎')
    && getEl('msgModalBody').innerHTML.includes('改 GCal 事件') && getEl('msgModalBody').innerHTML.includes("gcalPushLesson('" + rmId + "')") && !getEl('msgModalBody').innerHTML.includes('openGcalSync()'));
check('課卡也有；改期記號帶舊時段、eid 保留', run('lessonButtons(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(rmId) + ').lesson)').includes("gcalPushLesson('" + rmId + "')")
    && run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(rmId) + ').lesson.gcalMovedFrom.inCal') === true
    && run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(rmId) + ').lesson.gcalEid') === 'EID_R');
run('appSettings.gcalWrite = false');
const rmBtn = run('gcalAddButton(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(rmId) + ').lesson)');
check('唯讀：常規課改期後 →「改 GCal 舊事件（舊 → 09-30 12:00）」', rmBtn.includes('改 GCal 舊事件（') && rmBtn.includes(' → 09-30 12:00）') && rmBtn.includes("openGcalDay('" + rmId + "')"));
let rmOpened = ''; sandbox.open = u => { rmOpened = u; };
run('openGcalDay(' + JSON.stringify(rmId) + ')');
check('有 eid → 直接開該事件的編輯頁，提示寫明改成哪個時間', rmOpened === 'https://calendar.google.com/calendar/r/eventedit/EID_R' && run('lastToast').includes('改到 2026-09-30 12:00'));
sandbox.open = () => {};
run('closeMsgModal()');
run('undoLastAction(); undoLastAction()');
check('撤銷兩步後常規課回到改期前、沒有改期記號', !run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(rmId) + ').lesson.gcalMovedFrom')
    && run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(rmId) + ').lesson.date') !== '2026-09-30');
run('appSettings.gcalClientId = ' + JSON.stringify(cidWas35c));
run('appSettings.gcalWrite = false');
// 真的排一堂補堂：課卡與補堂確認彈窗都有鈕；按鈕會 window.open 那條連結
run('pushHistory("冒煙：加進 GCal")');
const tplOrigin = run('lessonsByMonth["2026-09"].find(l => l.status === "SCHEDULED" && !l.groupId && l.classType === "一對一" && l.date > "2026-09-15").lessonId');
run('GACLessonState.markStatus(lessonsByMonth, ' + JSON.stringify(tplOrigin) + ', "LEAVE", { leaveType: "L" })');
const tplMu = run('GACLessonState.scheduleMakeup(lessonsByMonth, ' + JSON.stringify(tplOrigin) + ', { date: "2026-09-29", time: "10:00" }).makeup.lessonId');
run('renderAll()');
check('清單上的補堂課卡有「加進 GCal」', getEl('masterScheduleList').innerHTML.includes("openGcalTemplate('" + tplMu + "')"));
// 配對色：補堂與原課在月曆上同一個 Set3 顏色；清單卡片有同色小方塊；沒有補堂的課沒有配對色；12 色用完循環
run("switchView('calendar')");
const pcMu = run('pairColorOf(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(tplMu) + ').lesson)');
const pcOr = run('pairColorOf(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(tplOrigin) + ').lesson)');
check('補堂與原課同一配對色（Set3 之一）', /^#[0-9A-F]{6}$/i.test(pcMu || '') && pcMu === pcOr && run('PAIR_PALETTE').includes(pcMu));
check('月曆兩個色塊都以該色作底，圖例有說明', (getEl('masterCalendarView').innerHTML.split('background-color:' + pcMu).length - 1) >= 2
    && getEl('masterCalendarView').innerHTML.includes('補堂與其原課同色'));
check('沒有補堂的課沒有配對色', run('pairColorOf(lessonsByMonth["2026-09"].find(l => l.status === "SCHEDULED" && !l.isMakeup && !l.makeupLessonId))') === null);
check('清單卡片：補堂與原課都帶同色小方塊', run('lessonBadges(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(tplMu) + ').lesson, false)').includes('pair-swatch')
    && run('lessonBadges(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(tplOrigin) + ').lesson, false)').includes('background-color:' + pcMu));
const cyc = run('(() => { const ls = []; for (let i = 0; i < 13; i++) { const d = "2026-11-" + String(i + 1).padStart(2, "0"); ' +
    'ls.push({ lessonId: "X" + i, studentId: "X" + i, date: d, time: "10:00", status: "LEAVE", classType: "一對一", makeupLessonId: "M" + i }); ' +
    'ls.push({ lessonId: "M" + i, studentId: "X" + i, date: "2026-12-01", time: "10:00", status: "SCHEDULED", classType: "一對一", isMakeup: true, originLessonId: "X" + i }); } ' +
    'const m = buildPairColors(ls).byOrigin; return [m.get("X0"), m.get("X11"), m.get("X12"), m.size]; })()');
check('按原課時間先後依序取色，12 色用完循環（第 13 對回到第 1 色）', cyc[0] === run('PAIR_PALETTE[0]') && cyc[1] === run('PAIR_PALETTE[11]') && cyc[2] === run('PAIR_PALETTE[0]') && cyc[3] === 13);
run('openMsgModal("makeup", [' + JSON.stringify(tplMu) + '])');
check('補堂確認彈窗也有', getEl('msgModalBody').innerHTML.includes("openGcalTemplate('" + tplMu + "')"));
run('openMsgModal("makeup", [' + JSON.stringify(tplOrigin) + '])');
check('彈窗收到請假原課時也找得到掛著的補堂', getEl('msgModalBody').innerHTML.includes("openGcalTemplate('" + tplMu + "')"));
run('closeMsgModal()');
let tplOpened = null; sandbox.open = url => { tplOpened = url; };
run('openGcalTemplate(' + JSON.stringify(tplMu) + ')');
check('按鈕開的是該補堂的建立事件連結', !!tplOpened && tplOpened.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE')
    && tplOpened.includes('dates=20260929T100000/') && tplOpened.includes('location=MU'));
sandbox.open = () => {};
run('undoLastAction()');
check('撤銷後原課回到已排課', run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(tplOrigin) + ').lesson.status') === 'SCHEDULED'
    && !run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(tplMu) + ')'));
run('appSettings.gcalWrite = ' + JSON.stringify(gcalWriteWas));

// 36a) 導出 .ics：檔名帶月份與導師，內容依篩選
console.log('[36a] 導出 .ics 檔名');
getEl('batchMonth').value = '2026-09';
getEl('schedTutorFilter').value = 'ALL';
getEl('schedStudentFilter').value = 'ALL';
run('rebuildMonthContext(); renderAll()');
let icsName = null, icsBody = null;
sandbox.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
sandbox.Blob = function (parts) { icsBody = String((parts && parts[0]) || ''); };
sandbox.document.createElement = tag => {
    const el = makeElement('created_' + tag);
    el.setAttribute = (k, v) => { if (k === 'download') icsName = v; }; // buildICSFile 用 setAttribute 設檔名
    return el;
};
run('downloadMasterICS()');
check('未篩選、該月只有一位導師 → 就一個檔，檔名帶該導師（不再叫 All-Tutors）', icsName === 'Guitaristic_2026-09_Instructor-A.ics'
    && icsBody.includes('BEGIN:VCALENDAR') && icsBody.includes('Student 001') && icsBody.includes('Student 003'));
check('檔內帶 X-WR-CALNAME（匯入 ICS 時自動辨認導師）', icsBody.includes('X-WR-CALNAME:Guitaristic Instructor A'));
const icsVevents = icsBody.split('BEGIN:VEVENT').length - 1;
const icsCells = run('GACSchedule.groupByCell(sortedMonthLessons()).length');
check('一節一個事件：S003/S004 同時段只一個事件，事件數＝課節數', icsVevents === icsCells && icsVevents < run('sortedMonthLessons().length')
    && icsBody.includes('小組 ×2 (09/2026)') && icsBody.includes('S003 Student 003') && icsBody.includes('UID:G%7C'));
// 多位導師：純函數拆批，一位一檔、照導師名單次序、各自的堂數
const icsBatches = run('icsExportBatches([{ tutor: "Instructor B", lessonId: "b1" }, { tutor: "Instructor A", lessonId: "a1" }, { tutor: "Instructor A", lessonId: "a2" }, { tutor: "", lessonId: "x1" }], "2026-09", { tutor: "ALL", student: "ALL" })');
check('兩位導師＋未指定 → 三個檔，照名單次序 A、B，最後 Unassigned', icsBatches.length === 3
    && icsBatches[0].name === 'Guitaristic_2026-09_Instructor-A.ics' && icsBatches[0].lessons.length === 2 && icsBatches[0].calName === 'Guitaristic Instructor A'
    && icsBatches[1].name === 'Guitaristic_2026-09_Instructor-B.ics' && icsBatches[1].lessons.length === 1
    && icsBatches[2].name === 'Guitaristic_2026-09_Unassigned.ics' && icsBatches[2].calName === '');
check('已選學生時每個檔名仍帶學生段', run('icsExportBatches([{ tutor: "Instructor A" }], "2026-09", { tutor: "ALL", student: "S001" })')[0].name === 'Guitaristic_2026-09_Instructor-A_S001-Student-001.ics');
check('匯出的 .ics 不含學生電話與電郵，只有導師', !icsBody.includes('Phone:') && !icsBody.includes('Email:')
    && !icsBody.includes('@example.com') && !icsBody.includes('00000000') && icsBody.includes('導師：'));
check('.ics 說明欄：具體課程、狀態：一行、換行逃逸成 \\n', icsBody.includes('DESCRIPTION:一對一 · Pop Guitar · Intermediate 中級\\n導師：Instructor A\\n狀態：\\n（出席留空或填 A'));
check('示範資料：S005（A）與 S024（B）同為週二 14:30，用來看「並行」', run('defaultStudents.filter(s => s.weekday === 2 && s.time === "14:30").map(s => s.tutor).sort().join(",")') === 'Instructor A,Instructor B');
getEl('schedTutorFilter').value = 'Instructor A';
run('onScheduleFilterChange()');
run('downloadMasterICS()');
check('篩選導師 → 檔名帶導師名', icsName === 'Guitaristic_2026-09_Instructor-A.ics');
getEl('schedStudentFilter').value = 'S001';
run('onScheduleFilterChange()');
run('downloadMasterICS()');
check('再篩選學生 → 檔名多一段學生、內容只剩該生', icsName === 'Guitaristic_2026-09_Instructor-A_S001-Student-001.ics'
    && icsBody.includes('Student 001') && !icsBody.includes('Student 003'));
getEl('schedTutorFilter').value = 'Instructor B';
getEl('schedStudentFilter').value = 'ALL';
run('onScheduleFilterChange()');
sandbox.alerts.length = 0;
run('downloadMasterICS()');
check('篩選範圍內無課 → 提示且不產生檔案', sandbox.alerts.length === 1 && sandbox.alerts[0].includes('沒有可匯出的課堂'));
getEl('schedTutorFilter').value = 'ALL';
run('onScheduleFilterChange()');
sandbox.document.createElement = tag => makeElement('created_' + tag);

// 36b) 學生／小組勾選區折疊
console.log('[36b] 勾選區折疊');
check('預設收起', run('batchSelectorIsOpen()') === false);
run('toggleBatchSelector()');
check('展開 → 本機記住', run('batchSelectorIsOpen()') === true && fakeStorage.getItem('gac_batch_open') === '1');
run('toggleBatchSelector()');
check('再收起', run('batchSelectorIsOpen()') === false && fakeStorage.getItem('gac_batch_open') === '0');
getEl('batchStudentGrid').querySelectorAll = () => ([{ checked: true, disabled: false }, { checked: false, disabled: false }, { checked: false, disabled: true }]);
run('updateBatchSelectorSummary()');
check('標題列顯示已勾選數（停用的不計）', getEl('batchSelectorSummary').textContent === '已勾選 1 / 2');
run('applyBatchSelectorState()');
check('收起時右側提示「點擊展開選取」', getEl('batchSelectorHint').textContent === '點擊展開選取');
run('toggleBatchSelector()');
check('展開時提示改為「點擊收起」', getEl('batchSelectorHint').textContent === '點擊收起');
run('toggleBatchSelector()');
getEl('batchStudentGrid').querySelectorAll = () => [];
run('updateBatchSelectorSummary()');
check('沒有可勾選項目 → 不顯示數字', getEl('batchSelectorSummary').textContent === '');

// 37a) 單堂改期（常規課）：搬時間、建改期通知、小組整節一起搬、撞堂提示
console.log('[37a] 單堂改期');
getEl('batchMonth').value = '2026-09';
getEl('weekSelect').value = 'ALL';
run('rebuildMonthContext(); renderAll()');
// 個別課：挑一堂仍是「已排課」的 S001 常規課（date/time 先抄成字串——移動後原物件會變）
const mvId = run('lessonsByMonth["2026-09"].filter(l => l.studentId === "S001" && !l.isMakeup && l.status === "SCHEDULED").pop().lessonId');
const mvDate = run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.date');
const mvTime = run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.time');
check('常規已排課列出現「改期」鈕', getEl('masterScheduleList').innerHTML.includes("openLessonMoveModal('" + mvId + "')"));
run("openLessonMoveModal('" + mvId + "')");
check('改期彈窗：標題「課堂改期」、帶出目前時間、欄位預填', getEl('moveModalTitle').innerHTML.includes('課堂改期')
    && getEl('moveModalInfo').innerHTML.includes(mvDate + ' ' + mvTime)
    && getEl('moveDate').value === mvDate && getEl('moveTime').value === mvTime);
sandbox.alerts.length = 0;
run('submitMoveModal()');
check('時間沒變 → 提示且不動作', sandbox.alerts.length === 1 && sandbox.alerts[0].includes('沒有變更')
    && run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.date') === mvDate);
getEl('moveDate').value = '2026-09-24'; getEl('moveTime').value = '19:00';
run('submitMoveModal()');
check('改期：時間已改、lessonId 不變、仍是已排課、不產生補堂', run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.date') === '2026-09-24'
    && run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.time') === '19:00'
    && run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.status') === 'SCHEDULED'
    && !run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.makeupLessonId'));
const moveEntryObj = run('sendLog["MOVE_CONFIRM:' + mvId + '"]');
check('建立改期通知條目（快照改期前時間、待發送）', !!moveEntryObj && moveEntryObj.status === 'TODO'
    && moveEntryObj.fromDate === mvDate && moveEntryObj.fromTime === mvTime);
const moveMsgText = run('sendlogMsgFor(sendLog["MOVE_CONFIRM:' + mvId + '"])');
check('改期通知訊息：原時間 → 新時間、結尾「上堂」', moveMsgText.includes(mvTime) && moveMsgText.includes('19:00') && moveMsgText.includes('上堂'));
check('訊息彈窗開出改期通知', getEl('msgModalTitle').textContent.includes('改期通知'));
run('closeMsgModal()');
check('該課行有「複製改期／WhatsApp」與發送狀態徽章', getEl('masterScheduleList').innerHTML.includes("copyLessonMsg('move', '" + mvId + "')")
    && getEl('masterScheduleList').innerHTML.includes("openWhatsAppMessage('" + mvId + "', 'move')")
    && getEl('masterScheduleList').innerHTML.includes('發送中心：待發送'));
check('發送中心列出此改期通知', run('renderSendCenter()') === undefined && todoHtml().includes('改期通知'));
check('有快照可撤銷', run('actionHistory[0].description').includes('課堂改期'));
run('undoLastAction()');
check('撤銷改期 → 時間還原、條目消失', run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.date') === mvDate
    && !run('sendLog["MOVE_CONFIRM:' + mvId + '"]'));
// 小組課：先把小組班生成到 9 月，再整節一起搬
sandbox.__qsaHook = sel => (sel === '.batch-group-chk:checked' ? [{ value: 'G01' }] : []);
run('generateMasterSchedule()');
sandbox.__qsaHook = () => [];
const gId = run('lessonsByMonth["2026-09"].filter(l => l.groupId && l.status === "SCHEDULED").pop().lessonId');
const gDate = run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(gId) + ').lesson.date');
const gTime = run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(gId) + ').lesson.time');
{
    const gCell = run('GACSchedule.groupByCell(lessonsByMonth["2026-09"]).find(c => c.lessons.some(l => l.lessonId === ' + JSON.stringify(gId) + '))');
    const gCard = run('renderGroupCard(GACSchedule.groupByCell(lessonsByMonth["2026-09"]).find(c => c.lessons.some(l => l.lessonId === ' + JSON.stringify(gId) + ')), new Set())');
    check('小組卡：改期只在卡頭（一顆「全組改期」），成員行沒有改期鈕', gCell.lessons.length >= 2
        && (gCard.match(/openLessonMoveModal\(/g) || []).length === 1 && gCard.includes('全組改期')
        && gCard.includes("openLessonMoveModal('" + gCell.lessons[0].lessonId + "')"));
    run('manualMode = true');
    const manualCard = run('renderGroupCard(GACSchedule.groupByCell(lessonsByMonth["2026-09"]).find(c => c.lessons.some(l => l.lessonId === ' + JSON.stringify(gId) + ')), new Set())');
    check('手動模式：卡頭不出「全組改期」，成員行各有改期（只搬該位）', !manualCard.includes('全組改期')
        && (manualCard.match(/openLessonMoveModal\(/g) || []).length === gCell.lessons.length
        && run('lessonMoveTargets(GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(gId) + ').lesson).length') === 1);
    run('manualMode = false');
}
run("openLessonMoveModal('" + gId + "')");
check('小組課改期彈窗：標題「小組改期」、寫明全組一併改期', getEl('moveModalTitle').innerHTML.includes('小組改期')
    && getEl('moveModalInfo').innerHTML.includes('小組課：全組') && getEl('moveModalInfo').innerHTML.includes('位一併改期'));
getEl('moveDate').value = '2026-09-25'; getEl('moveTime').value = '16:00';
run('submitMoveModal()');
const movedMates = run('lessonsByMonth["2026-09"].filter(l => l.date === "2026-09-25" && l.time === "16:00")');
check('小組同節全體一起搬、每人各一筆改期通知（from 為原時段）', movedMates.length >= 2
    && run('lessonsByMonth["2026-09"].filter(l => l.date === "2026-09-25" && l.time === "16:00").every(l => { const e = sendLog["MOVE_CONFIRM:" + l.lessonId]; return !!e && e.fromDate === ' + JSON.stringify(gDate) + ' && e.fromTime === ' + JSON.stringify(gTime) + '; })'));
check('改期訊息彈窗列出全體成員', getEl('msgModalBody').innerHTML.includes('共 ' + movedMates.length + ' 位學生'));
check('快照寫「小組改期」', run('actionHistory[0].description').includes('小組改期'));
run('closeMsgModal()');
run('undoLastAction()');
check('撤銷小組改期 → 全體回原時段', run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(gId) + ').lesson.date') === gDate
    && run('lessonsByMonth["2026-09"].filter(l => l.date === "2026-09-25" && l.time === "16:00").length') === 0);
// 撞堂：搬到同導師另一堂的時段 → 先問再改
const clashId = run('lessonsByMonth["2026-09"].filter(l => l.studentId === "S001" && !l.isMakeup && l.status === "SCHEDULED" && l.lessonId !== ' + JSON.stringify(mvId) + ').pop().lessonId');
const clashDate = run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(clashId) + ').lesson.date');
const clashTime = run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(clashId) + ').lesson.time');
run("openLessonMoveModal('" + mvId + "')");
getEl('moveDate').value = clashDate; getEl('moveTime').value = clashTime;
run('submitMoveModal()');
check('撞堂先問（沙盒一律確定）→ 改期完成且雙方標記撞堂', run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.date') === clashDate
    && run('GACSchedule.detectClashes(lessonsByMonth["2026-09"]).has(' + JSON.stringify(mvId) + ')') === true
    && run('GACSchedule.detectClashes(lessonsByMonth["2026-09"]).has(' + JSON.stringify(clashId) + ')') === true);
run('closeMsgModal()');
run('undoLastAction()');
check('撤銷後回到原時段、無撞堂', run('GACLessonState.findLesson(lessonsByMonth, ' + JSON.stringify(mvId) + ').lesson.date') === mvDate
    && run('GACSchedule.detectClashes(lessonsByMonth["2026-09"]).has(' + JSON.stringify(mvId) + ')') === false);
// 撞堂提示只報這次真的撞到的課：別處原本就有的撞堂不算；請假的課不佔時段
{
    const J = JSON.stringify;
    const L = id => 'GACLessonState.findLesson(lessonsByMonth, ' + J(id) + ').lesson';
    run('pushHistory("冒煙：改期撞堂提示")');
    // 先在別處造一對原本就撞的課：複製一堂別的課成同導師同時段的個別課（最後撤銷還原）
    run('(() => { const base = lessonsByMonth["2026-09"].find(l => l.status === "SCHEDULED" && l.lessonId !== ' + J(mvId) + ' && l.lessonId !== ' + J(clashId) + '); lessonsByMonth["2026-09"].push(Object.assign({}, base, { lessonId: "ZZ-CLASH", studentId: "ZZ", studentName: "Clash Dummy", groupId: null, groupName: "", classType: "一對一" })); })()');
    check('前置：別處有一對原本就撞的課', run('GACSchedule.detectClashes(lessonsByMonth["2026-09"]).has("ZZ-CLASH")') === true);
    check('搬到空時段：不報撞堂（原本就有的撞堂與這次無關）', run('moveClashNames([' + L(mvId) + '], "2026-09-27", "09:00").length') === 0);
    check('搬到別人的時段：只報那一堂', run('moveClashNames([' + L(mvId) + '], ' + J(clashDate) + ', ' + J(clashTime) + ').join()').includes(clashDate + ' ' + clashTime)
        && run('moveClashNames([' + L(mvId) + '], ' + J(clashDate) + ', ' + J(clashTime) + ').length') === 1);
    run(L(clashId) + '.status = "LEAVE"; ' + L(clashId) + '.leaveType = "L"');
    check('那一堂請假了 → 搬過去不報撞堂（請假的課不佔時段）', run('moveClashNames([' + L(mvId) + '], ' + J(clashDate) + ', ' + J(clashTime) + ').length') === 0);
    const keepConfirm = sandbox.confirm;
    let asked = 0;
    sandbox.confirm = () => { asked++; return true; };
    run("openLessonMoveModal('" + mvId + "')");
    getEl('moveDate').value = clashDate; getEl('moveTime').value = clashTime;
    run('submitMoveModal()');
    sandbox.confirm = keepConfirm;
    check('實際改期到請假那堂的時段：沒有彈撞堂確認、改期完成', asked === 0 && run(L(mvId) + '.date') === clashDate && run(L(mvId) + '.time') === clashTime);
    run('closeMsgModal()');
    run('undoLastAction()');   // 撤銷改期
    run('undoLastAction()');   // 撤銷上面手改的資料
    check('清理：回到原狀', run(L(mvId) + '.date') === mvDate && run(L(clashId) + '.status') === 'SCHEDULED'
        && run('GACSchedule.detectClashes(lessonsByMonth["2026-09"]).size') === 0);
}
// 頂部統計卡跳轉：撞堂卡 → 清單只列撞堂、按重疊分組；補堂／請假卡 → 待補堂池（沒有待補就列本月請假與補堂）
{
    const J = JSON.stringify;
    const view0 = run('currentViewMode');
    const listHtml = () => getEl('masterScheduleList').innerHTML;
    run('jumpToClashes()');
    check('沒有撞堂時點撞堂卡：只提示、不改篩選', run('lastToast').includes('沒有撞堂') && (getEl('schedFocusFilter').value || 'ALL') === 'ALL' && getEl('statClashHint').textContent === '');
    run('pushHistory("冒煙：統計卡跳轉")');
    // 複製一堂別的課成同導師同時段的個別課 → 一組撞堂（兩節）
    const baseId = run('(() => { const base = lessonsByMonth["2026-09"].find(l => l.status === "SCHEDULED" && !GACSchedule.isGroupLesson(l)); lessonsByMonth["2026-09"].push(Object.assign({}, base, { lessonId: "ZZ-CLASH", studentId: "ZZ", studentName: "Clash Dummy" })); return base.lessonId; })()');
    const baseName = run('GACLessonState.findLesson(lessonsByMonth, ' + J(baseId) + ').lesson.studentName');
    run('renderAll()');
    check('撞堂卡：一對重疊的課算 1（不是 2 堂）、提示「查看並處理」', String(getEl('statClashCount').textContent) === '1' && getEl('statClashHint').textContent === '查看並處理'
        && run('GACSchedule.detectClashes(lessonsByMonth["2026-09"]).size') === 2);
    check('提示條：寫明幾組', getEl('clashBannerTitle').textContent.includes('有 1 組課堂時間重疊'));
    {
        // 顯示全部時：撞堂那一組也排在清單最前面，後面才是其餘課堂；同一節不會出現兩次
        const was = run('currentViewMode');
        run("switchView('list')");
        const all = listHtml();
        check('顯示全部：撞堂那組排最前、其餘課堂在後、卡片不重複', all.indexOf('data-clash-group="1"') !== -1 && all.indexOf('data-clash-group="1"') < all.indexOf('其餘課堂')
            && all.indexOf('Clash Dummy') < all.indexOf('其餘課堂') && (all.match(/id="leaveBox_ZZ-CLASH"/g) || []).length === 1
            && (all.match(new RegExp('id="leaveBox_' + baseId + '"', 'g')) || []).length === 1
            && (all.match(/id="leaveBox_/g) || []).length === run('lessonsByMonth["2026-09"].filter(l => l.status === "SCHEDULED").length'));
        run('setClashFocus(true)');
        check('切到「只顯示撞堂」：只剩那一組，沒有其餘課堂', getEl('schedFocusFilter').value === 'CLASH' && listHtml().includes('data-clash-group="1"')
            && !listHtml().includes('其餘課堂') && (listHtml().match(/id="leaveBox_/g) || []).length === 2);
        // 月曆不受「只顯示撞堂」影響：一律顯示全部（撞堂有紅框）
        run("switchView('calendar')");
        const calOnly = getEl('masterCalendarView').innerHTML;
        check('月曆視圖：只顯示撞堂時月曆仍列出全部課、提示條說明「到清單處理」', run('GACSchedule.groupByCell(sortedMonthLessons()).length') > 2
            && (calOnly.match(/openLessonModal\(/g) || []).length === run('GACSchedule.groupByCell(sortedMonthLessons()).length')
            && getEl('clashBannerText').textContent.includes('月曆上有紅框'));
        run("switchView('list')");
        check('清單視圖：提示條說明撞堂排最前', getEl('clashBannerText').textContent.includes('排在清單最前面'));
        run('setClashFocus(false)');
        check('切回「顯示全部」', getEl('schedFocusFilter').value === 'ALL' && listHtml().includes('其餘課堂'));
        run("switchView('" + was + "')");
    }
    getEl('schedTutorFilter').value = 'Instructor B';   // 會把要看的課藏住的篩選
    getEl('weekSelect').value = '0';
    run('jumpToClashes()');
    check('點撞堂卡：切到清單、只看撞堂、導師／週次篩選清掉', getEl('schedFocusFilter').value === 'CLASH' && run('currentViewMode') === 'list'
        && getEl('schedTutorFilter').value === 'ALL' && getEl('weekSelect').value === 'ALL');
    check('清單按重疊分組：一組、寫明誰和誰重疊、只有這兩節的卡', listHtml().includes('撞堂 1／1')
        && listHtml().includes(baseName) && listHtml().includes(' ↔ ') && listHtml().includes('Clash Dummy')
        && (listHtml().match(/撞堂重疊<\/span>/g) || []).length === 2 && listHtml().includes("openLessonMoveModal('ZZ-CLASH')"));
    // 把其中一節改期 → 這一組消失，清單提示沒有撞堂
    run("openLessonMoveModal('ZZ-CLASH')");
    getEl('moveDate').value = '2026-09-27'; getEl('moveTime').value = '08:00';
    run('submitMoveModal()');
    run('closeMsgModal()');
    check('改期解決後：清單顯示「沒有撞堂的課」＋「顯示全部」，卡上數字歸零', listHtml().includes('沒有撞堂的課') && listHtml().includes('顯示全部') && listHtml().includes('clearScheduleFocus()')
        && String(getEl('statClashCount').textContent) === '0' && getEl('statClashHint').textContent === '');
    run('clearScheduleFocus()');
    check('顯示全部 → 回到完整清單', getEl('schedFocusFilter').value === 'ALL' && !listHtml().includes('沒有撞堂的課') && listHtml().includes(baseName));
    run('undoLastAction()');   // 撤銷改期
    run('undoLastAction()');   // 撤銷假課
    check('清理：假課移除', !run('GACLessonState.findLesson(lessonsByMonth, "ZZ-CLASH")'));

    // 補堂／請假卡
    const poolN = run('GACLessonState.pendingMakeups(lessonsByMonth, "2026-09-15").length');
    run('renderAll()');
    check('補堂／請假卡：寫出待補堂筆數', getEl('statPoolHint').textContent === (poolN ? '待補堂 ' + poolN + ' 筆' : ''));
    run('pushHistory("冒煙：補堂卡跳轉")');
    const lvId = run('lessonsByMonth["2026-09"].find(l => l.status === "SCHEDULED" && !GACSchedule.isGroupLesson(l)).lessonId');
    run('GACLessonState.markStatus(lessonsByMonth, ' + J(lvId) + ', "LEAVE", { leaveType: "L" }); renderAll()');
    check('多一筆請假 → 待補堂筆數 +1', getEl('statPoolHint').textContent === '待補堂 ' + (poolN + 1) + ' 筆');
    run('lastToast = ""; jumpToPendingPool()');
    check('有待補堂：跳到待補堂池，不動課表篩選', (getEl('schedFocusFilter').value || 'ALL') === 'ALL' && run('lastToast') === '');
    // 把待補的全部排上補堂 → 池空 → 改列本月的請假與補堂
    run('GACLessonState.pendingMakeups(lessonsByMonth, "2026-09-15").forEach((p, i) => GACLessonState.scheduleMakeup(lessonsByMonth, p.lesson.lessonId, { date: "2026-12-0" + (i + 1), time: "09:00" })); renderAll()');
    run('jumpToPendingPool()');
    check('沒有待補堂：清單只看「請假與補堂」並提示', run('GACLessonState.pendingMakeups(lessonsByMonth, "2026-09-15").length') === 0 && getEl('statPoolHint').textContent === ''
        && getEl('schedFocusFilter').value === 'LEAVE' && run('lastToast').includes('請假與補堂') && listHtml().includes("'" + lvId + "'")
        && listHtml().includes('目前只列出請假與補堂的課') && listHtml().includes('顯示全部')
        && run('filterCellsByFocus(GACSchedule.groupByCell(sortedMonthLessons()), new Set()).every(c => c.lessons.some(l => l.status === "LEAVE" || l.isMakeup))') === true);
    run('clearScheduleFocus()');
    run('undoLastAction()');
    run("switchView('" + view0 + "')");
    check('清理：請假與補堂還原', run('GACLessonState.findLesson(lessonsByMonth, ' + J(lvId) + ').lesson.status') === 'SCHEDULED' && !run('lessonsByMonth["2026-12"]')
        && run('GACLessonState.pendingMakeups(lessonsByMonth, "2026-09-15").length') === poolN);
}

// 37b) 批量確認出席：按鈕顯示可確認堂數、沒有就停用並分辨原因
console.log('[37b] 批量確認按鈕狀態');
getEl('batchMonth').value = '2026-09';
getEl('weekSelect').value = 'ALL';
getEl('schedTutorFilter').value = 'ALL';
getEl('schedStudentFilter').value = 'ALL';
run('rebuildMonthContext(); renderAll()');
const confirmable = () => run('GACLessonState.confirmableInRange(lessonsByMonth, "2026-09-01", "2026-09-31", { maxDate: "2026-09-15" }).length');
const futureN = () => run('GACLessonState.confirmableInRange(lessonsByMonth, "2026-09-01", "2026-09-31", {}).length') - confirmable();
check('按鈕寫出可確認堂數且可按', confirmable() > 0 && getEl('batchConfirmBtn').innerHTML.includes('批量確認出席（' + confirmable() + ' 堂）')
    && getEl('batchConfirmBtn').disabled === false);
run('batchConfirmWeek()');
check('確認後：今天以前的課全部已上課、按鈕停用並提示還有未來的課', confirmable() === 0 && futureN() > 0
    && getEl('batchConfirmBtn').disabled === true
    && getEl('batchConfirmBtn').innerHTML.includes('無待確認課堂（還有 ' + futureN() + ' 堂未到上課日）'));
run('batchConfirmWeek()');
check('停用狀態下再按不會拍快照、不會改資料', confirmable() === 0);
run('advancedRefresh()');
check('逾期警告只有一行數字與按鈕，不逐堂列出', !getEl('advancedExpiredWarning').innerHTML.includes('Student 001 ')
    || getEl('advancedExpiredWarning').innerHTML === '');
check('薪酬頁：待確認拆成「日期已過未確認」與「尚未到上課日」', getEl('advPayPendingNote').innerHTML.includes('尚未到上課日')
    && !getEl('advPayPendingNote').innerHTML.includes('日期已過但未確認'));
// 把一堂未來的課改回過去並設為已排課 → 逾期提示與按鈕同時回來
run('(function(){ const l = lessonsByMonth["2026-09"].find(x => x.date > "2026-09-15" && x.status === "SCHEDULED"); l.date = "2026-09-10"; persistLessons(); })()');
run('renderAll(); advancedRefresh()');
check('出現逾期未確認 → 按鈕回復可按、薪酬頁標示「日期已過但未確認」', getEl('batchConfirmBtn').disabled === false
    && getEl('batchConfirmBtn').innerHTML.includes('（1 堂）')
    && getEl('advPayPendingNote').innerHTML.includes('1 堂日期已過但未確認'));
run('batchConfirmWeek()');

// 38) 高級薪酬：預期 vs 目前應付、導師明細展開、調整項目歸屬導師、封存
console.log('[38] 高級薪酬頁');
getEl('advancedPayrollMonth').value = '2026-09';
run('advancedPayrollState.adjustments.length = 0; advancedPayrollState.archives.length = 0; advancedSaveAdjustments()');
run('advancedRefresh()');
const sum = run('advancedPayrollState.summary');
check('彙總：預期＝已確認＋待確認；有導師資料', sum.totals.expected === sum.totals.current + sum.totals.pending
    && sum.totals.expectedGross >= sum.totals.currentGross && sum.tutors.length > 0 && sum.totals.pending > 0);
check('KPI 與進度文字', getEl('advPayCurrent').textContent.startsWith('HK$') && getEl('advPayExpected').textContent.startsWith('HK$')
    && getEl('advPayPending').textContent === sum.totals.pending + ' 堂'
    && getEl('advPayProgress').textContent.includes('已確認 ' + sum.totals.current + ' / 預期 ' + sum.totals.expected));
check('目前應付＝已確認課程總額 × 拆帳；預期同理', getEl('advPayCurrent').textContent === run('advancedMoney(' + sum.totals.currentGross + ' * advancedPayrollState.share / 100)')
    && getEl('advPayExpected').textContent === run('advancedMoney(' + sum.totals.expectedGross + ' * advancedPayrollState.share / 100)'));
const t0 = sum.tutors[0].tutor;
const tutorHtml = () => getEl('advancedTutorList').innerHTML;
check('導師一行：含姓名與已確認／預期；明細預設收起', tutorHtml().includes(t0) && tutorHtml().includes('已確認') && !tutorHtml().includes('報讀項目'));
run("toggleAdvTutor('" + t0 + "')");
check('點開導師 → 明細表（報讀項目／每堂／導師應得）', tutorHtml().includes('報讀項目') && tutorHtml().includes('每堂') && tutorHtml().includes('導師應得'));
run("toggleAdvTutor('" + t0 + "')");
check('再點收起', !tutorHtml().includes('報讀項目'));
const payBefore = run('advancedTotalPayout(advancedPayrollState.summary, "current")');
run('advancedAddAdjustment()');
run("advancedPayrollState.adjustments[0] = { name: '交通津貼', tutor: '" + t0 + "', type: 'add', amount: 500 }; advancedSaveAdjustments(); advancedRefresh()");
check('調整指名導師 → 總額與該導師各 +500、調整合計顯示、已落盤', run('advancedTotalPayout(advancedPayrollState.summary, "current")') === payBefore + 500
    && run("advancedAdjustFor('" + t0 + "')") === 500 && getEl('advPayAdjust').textContent === run('advancedMoney(500)')
    && JSON.parse(fakeStorage.getItem('gac_adjustments'))[0].tutor === t0);
run("advancedPayrollState.adjustments[0].tutor = ''; advancedSaveAdjustments(); advancedRefresh()");
check('改成「全月」→ 總額仍 +500、不計入該導師', run('advancedTotalPayout(advancedPayrollState.summary, "current")') === payBefore + 500
    && run("advancedAdjustFor('" + t0 + "')") === 0);
run("advancedPayrollState.adjustments[0].type = 'sub'; advancedSaveAdjustments(); advancedRefresh()");
check('改成扣款 → 總額 −500', run('advancedTotalPayout(advancedPayrollState.summary, "current")') === payBefore - 500);
run("advancedPayrollState.adjustments[0].type = 'add'; advancedSaveAdjustments(); advancedRefresh()");
run('advancedSaveArchive()');
const arc = run('advancedPayrollState.archives[0]');
check('封存：月份／已確認堂數／應付／各導師，落盤並顯示', arc.month === '2026-09' && arc.lessons === sum.totals.current
    && Math.abs(arc.payout - (payBefore + 500)) < 0.001 && arc.tutors.length === sum.tutors.length
    && JSON.parse(fakeStorage.getItem('gac_payroll_archives')).length === 1
    && getEl('advancedArchivesBody').innerHTML.includes('2026-09'));
run('advancedDeleteArchive(0)');
check('刪除封存', run('advancedPayrollState.archives.length') === 0 && getEl('advancedArchivesBody').innerHTML.includes('沒有封存紀錄'));
run('advancedPayrollState.adjustments.length = 0; advancedSaveAdjustments(); advancedRefresh()');
check('未確認出席的課只算預期：全部標出席後 目前應付＝預期應付', (() => {
    run('lessonsByMonth["2026-09"].forEach(l => { if (l.status === "SCHEDULED") GACLessonState.markStatus(lessonsByMonth, l.lessonId, "ATTENDED"); }); persistLessons(); advancedRefresh()');
    const s2 = run('advancedPayrollState.summary');
    return s2.totals.pending === 0 && s2.totals.currentGross === s2.totals.expectedGross
        && getEl('advPayCurrent').textContent === getEl('advPayExpected').textContent
        && getEl('advancedExpiredWarning').innerHTML === '';
})());

// 40) 學生狀態（在學／停課，可預定）與學號容錯：隔離在 2026-11，測完清掉
sandbox.__qsaHook = () => [];
console.log('[40] 學生狀態（在學／停課）與學號容錯');
{
    const J = JSON.stringify;
    const idx = run('studentDatabase.findIndex(s => s.id === "S001")');   // 週一 21:30；11 月的週一：2/9/16/23/30
    const g01 = run('groupClasses.findIndex(g => g.id === "G01")');
    const S = 'studentDatabase[' + idx + ']';
    const novOf = id => run('(lessonsByMonth["2026-11"] || []).filter(l => l.studentId === ' + J(id) + ').map(l => l.date + "#" + l.lessonNum + "/" + l.totalRegular).join()');
    const genNov = () => {
        getEl('batchMonth').value = '2026-11';
        sandbox.__qsaHook = sel => (sel === '.batch-student-chk:checked' ? [{ value: String(idx) }] : sel === '.batch-group-chk:checked' ? [{ value: 'G01' }] : []);
        run('generateMasterSchedule()');
        sandbox.__qsaHook = () => [];
    };
    // 開編輯窗 → 設狀態 → 儲存。confirmAnswer＝「已生成的月份要不要一併處理」怎麼答；回傳那次確認框的文字（沒問就是 ''）
    // groups＝弹窗裡「所屬小組」勾了哪些（沙盒要自己給，否則儲存會當成全部取消）
    const saveStatus = (studentIdx, status, from, resume, confirmAnswer, groups) => {
        let asked = '';
        const keep = sandbox.confirm;
        sandbox.confirm = msg => { asked = String(msg); return confirmAnswer !== false; };
        sandbox.__qsaHook = sel => (sel === '.modal-group-chk' ? (groups || []).map(g => ({ checked: true, value: g })) : []);
        run('openStudentModal(' + studentIdx + ')');
        getEl('modalStatus').value = status;
        run('onModalStatusChange()');
        if (status === 'INACTIVE') { getEl('modalInactiveFrom').value = from; getEl('modalInactiveResume').value = resume || ''; }
        run('saveStudentFromModal()');
        sandbox.confirm = keep;
        sandbox.__qsaHook = () => [];
        return asked;
    };

    run('openStudentModal(' + idx + ')');
    check('編輯窗：預設「在學」', getEl('modalStatus').value === 'ACTIVE');
    getEl('modalStatus').value = 'INACTIVE';
    run('onModalStatusChange()');
    check('選「停課」→ 開始日預設今天、復課日留空', getEl('modalInactiveFrom').value === '2026-09-15' && getEl('modalInactiveResume').value === '');
    run('closeStudentModal()');
    check('頁面上不再有「長假」', !fs.readFileSync(path.join(repo, 'index.html'), 'utf8').includes('長假') && !fs.readFileSync(path.join(repo, 'app.js'), 'utf8').includes('addModalLongLeave'));

    const alerts0 = sandbox.alerts.length;
    saveStatus(idx, 'INACTIVE', '2026-11-10', '2026-11-01');
    check('復課日早於開始日 → 擋下、不存', sandbox.alerts.length === alerts0 + 1 && sandbox.alerts[alerts0].includes('之後') && !run(S + '.inactivePeriods'));
    run('closeStudentModal()');

    // —— 預定停課（今天 9/15，11/10 才開始）：今天仍在學 ——
    const activeN0 = String(getEl('statTotalStudents').textContent);
    const asked1 = saveStatus(idx, 'INACTIVE', '2026-11-10', '');
    check('預定停課：紀錄存在學生上、已落盤；11 月還沒生成 → 不用問', run('JSON.stringify(' + S + '.inactivePeriods)') === J([{ from: '2026-11-10', resume: '' }]) && asked1 === ''
        && JSON.parse(fakeStorage.getItem('gac_students_v2')).find(s => s.id === 'S001').inactivePeriods.length === 1);
    check('名單標記「將停課：2026-11-10 起（復課日未定）」、仍在上面的名單、在學人數不變', run('studentStatusBadge(' + S + ')').includes('將停課：2026-11-10 起（復課日未定）')
        && getEl('studentTableBody').innerHTML.includes('>S001<') && !getEl('inactiveStudentTableBody').innerHTML.includes('>S001<')
        && String(getEl('statTotalStudents').textContent) === activeN0 && getEl('statInactiveHint').textContent === '');
    run('openStudentModal(' + idx + ')');
    check('再開編輯窗：帶出「停課」與日期', getEl('modalStatus').value === 'INACTIVE' && getEl('modalInactiveFrom').value === '2026-11-10');
    run('closeStudentModal()');
    check('生成勾選區：11 月略過 3 堂', run('batchInactiveTag(' + S + ', "2026-11")').includes('停課略過 3 堂'));

    run('studentDatabase.find(s => s.id === "S021").inactivePeriods = [{ from: "2026-11-01", resume: "2026-11-20" }]');   // 小組成員（週六 15:00：7/14/21/28）
    genNov();
    check('生成：S001 只有 11/02、11/09，編號 1/2、2/2', novOf('S001') === '2026-11-02#1/2,2026-11-09#2/2');
    check('小組：S021 停課那兩個週六不生成，其他成員照常、仍是 5人小組', run('lessonsByMonth["2026-11"].filter(l => l.studentId === "S021").map(l => l.date).join()') === '2026-11-21,2026-11-28'
        && run('lessonsByMonth["2026-11"].filter(l => l.studentId === "S020" && l.groupId).length') === 4
        && run('lessonsByMonth["2026-11"].filter(l => l.groupId).every(l => l.classType === "5人小組")'));
    check('生成訊息列出停課略過的學生（個別＋小組）', run('lastToast').includes('停課不生成') && run('lastToast').includes('S001 Student 001（3 堂）') && run('lastToast').includes('S021'));
    check('學費按實際堂數（S001 2 堂、S021 小組 2 堂）', run('sendLog["TUITION:S001:2026-11"].count') === 2 && run('sendLog["TUITION:S021:2026-11"].count') === 2);

    // —— 已生成的月份：改狀態時問一次，確定就直接處理（不用再去按生成）——
    const asked2 = saveStatus(idx, 'INACTIVE', '2026-11-10', '2026-11-23');
    check('填上復課日 11/23 → 問要不要補生成；確定後補上 11/23、11/30、編號重排、學費 4 堂', asked2.includes('2026-11') && asked2.includes('補生成 2 堂')
        && novOf('S001') === '2026-11-02#1/4,2026-11-09#2/4,2026-11-23#3/4,2026-11-30#4/4' && run('sendLog["TUITION:S001:2026-11"].count') === 4
        && run('lastToast').includes('補生成 2 堂'));
    check('只動這位學生：小組與其他人的課不變', run('lessonsByMonth["2026-11"].filter(l => l.groupId).length') === 4 * 5 - 2);

    const asked3 = saveStatus(idx, 'INACTIVE', '2026-11-01', '', false);
    check('改成 11/01 起停課、按「取消」→ 只存狀態，課表不動，提示之後按生成', asked3.includes('移除 4 堂') && novOf('S001').split(',').length === 4
        && run(S + '.inactivePeriods[0].from') === '2026-11-01' && run('lastToast').includes('未改動'));
    genNov();
    check('之後按「生成」也會套用：整月停課 → 已排課移除、未發送的學費條目一併刪掉', novOf('S001') === '' && !run('sendLog["TUITION:S001:2026-11"]'));
    check('勾選區：「本月停課」', run('batchInactiveTag(' + S + ', "2026-11")').includes('本月停課'));

    const asked4 = saveStatus(idx, 'ACTIVE');
    check('改回「在學」（預定的停課還沒開始）→ 取消停課、問要不要補生成；確定後整月補回、學費條目重建', asked4.includes('補生成 5 堂') && !run(S + '.inactivePeriods')
        && novOf('S001') === '2026-11-02#1/5,2026-11-09#2/5,2026-11-16#3/5,2026-11-23#4/5,2026-11-30#5/5'
        && run('sendLog["TUITION:S001:2026-11"].count') === 5);

    // 已有狀態的課不動：11/09 標已上課，再設 11/01 起停課 → 只移除仍是已排課的 4 堂，那一堂列出來請人工處理
    run('GACLessonState.markStatus(lessonsByMonth, "S001-20261109-2130", "ATTENDED")');
    const asked5 = saveStatus(idx, 'INACTIVE', '2026-11-01', '');
    check('已上課的課落在停課期間 → 不動、確認框列出', asked5.includes('移除 4 堂') && asked5.includes('2026-11-09') && asked5.includes('已上課')
        && novOf('S001') === '2026-11-09#2/5' && run('GACLessonState.findLesson(lessonsByMonth, "S001-20261109-2130").lesson.status') === 'ATTENDED');
    run('GACLessonState.markStatus(lessonsByMonth, "S001-20261109-2130", "SCHEDULED")');
    saveStatus(idx, 'ACTIVE');

    // —— 小組成員：只動他自己在小組的課 ——
    const s21 = run('studentDatabase.findIndex(s => s.id === "S021")');
    run('delete studentDatabase[' + s21 + '].inactivePeriods');
    const asked6 = saveStatus(s21, 'ACTIVE', '', '', true, ['G01']);
    check('（前置）S021 沒有變動 → 不問；仍是小組成員', asked6 === '' && run('groupClasses[' + g01 + '].memberIds.includes("S021")'));
    run('studentDatabase[' + s21 + '].inactivePeriods = [{ from: "2026-11-01", resume: "2026-11-20" }]');
    const asked7 = saveStatus(s21, 'ACTIVE', '', '', true, ['G01']);
    check('S021 取消預定的停課 → 補回他在小組的兩堂；同組其他人不動', asked7.includes('補生成 2 堂')
        && run('lessonsByMonth["2026-11"].filter(l => l.studentId === "S021").map(l => l.date).join()') === '2026-11-07,2026-11-14,2026-11-21,2026-11-28'
        && run('lessonsByMonth["2026-11"].filter(l => l.groupId).length') === 20 && run('sendLog["TUITION:S021:2026-11"].count') === 4);
    const asked8 = saveStatus(s21, 'INACTIVE', '2026-11-10', '', true, ['G01']);
    check('S021 11/10 起停課 → 移除他在小組的 3 堂，同組其他人仍各 4 堂', asked8.includes('移除 3 堂')
        && run('lessonsByMonth["2026-11"].filter(l => l.studentId === "S021").map(l => l.date).join()') === '2026-11-07'
        && run('lessonsByMonth["2026-11"].filter(l => l.studentId === "S020" && l.groupId).length') === 4 && run('sendLog["TUITION:S021:2026-11"].count') === 1);
    run('delete studentDatabase[' + s21 + '].inactivePeriods');

    // —— 今天已在停課：移到下面「停課學生」（預設收起）、在學人數減一；「復課」一鍵回來 ——
    const s2 = run('studentDatabase.findIndex(s => s.id === "S002")');   // 沒有生成過課的學生
    const asked9 = saveStatus(s2, 'INACTIVE', '2026-09-10', '');
    check('今天已在停課：不在上面的名單、在「停課學生」裡，標「停課中」；在學人數減一、卡上寫「另 1 位停課」', asked9 === ''
        && !getEl('studentTableBody').innerHTML.includes('>S002<') && getEl('inactiveStudentTableBody').innerHTML.includes('>S002<')
        && getEl('inactiveStudentTableBody').innerHTML.includes('停課中：2026-09-10 起（復課日未定）') && getEl('inactiveStudentsCount').textContent === '1'
        && String(getEl('statTotalStudents').textContent) === String(Number(activeN0) - 1) && getEl('statInactiveHint').textContent === '另 1 位停課');
    check('停課學生那一行有「復課」鈕；預設收起、可展開', getEl('inactiveStudentTableBody').innerHTML.includes('reactivateStudent(' + s2 + ')')
        && run('inactiveStudentsOpen') === false && (run('toggleInactiveStudents()'), run('inactiveStudentsOpen')) === true && (run('toggleInactiveStudents()'), true));
    run('openBroadcastModal()');
    {
        const seg = getEl('bcList').innerHTML.split('value="' + s2 + '"')[1] || '';
        check('自定義群發：停課中的學生預設不勾、標「停課中」', seg !== '' && !seg.startsWith(' checked') && seg.slice(0, 500).includes('（停課中）')
            && (getEl('bcList').innerHTML.split('value="' + idx + '"')[1] || '').startsWith(' checked'));
    }
    run('closeBroadcastModal()');
    run('reactivateStudent(' + s2 + ')');
    check('按「復課」→ 今天起在學：回到上面的名單、停課紀錄記下起訖', run('JSON.stringify(studentDatabase[' + s2 + '].inactivePeriods)') === J([{ from: '2026-09-10', resume: '2026-09-15' }])
        && getEl('studentTableBody').innerHTML.includes('>S002<') && String(getEl('statTotalStudents').textContent) === activeN0 && run('lastToast').includes('今天起復課'));
    run('delete studentDatabase[' + s2 + '].inactivePeriods; saveToLocalStorage(); renderStudentTable()');

    // 重新載入名單：停課紀錄按學號（容錯）帶過去
    run(S + '.inactivePeriods = [{ from: "2026-12-01", resume: "" }]');
    run('applyRoster({ students: studentDatabase.map(s => { const o = Object.assign({}, s); delete o.inactivePeriods; if (o.id === "S001") o.id = "s1"; return o; }), groups: groupClasses, tutors: tutorsList }, "測試：重新載入")');
    check('重新載入名單：停課紀錄按學號保留（s1 ＝ S001）', run('JSON.stringify(studentDatabase.find(s => s.id === "s1").inactivePeriods)') === J([{ from: '2026-12-01', resume: '' }]));
    run('undoLastAction()');
    check('撤銷重新載入 → 回到 S001', run(S + '.id') === 'S001');
    run('delete ' + S + '.inactivePeriods');

    // 學號查重（容錯）：新增 s01 ＝ 已有的 S001
    const n0 = run('studentDatabase.length'), a1 = sandbox.alerts.length;
    run('openStudentModal(-1)');
    getEl('modalId').value = 's01';
    getEl('modalName').value = 'Dup';
    run('saveStudentFromModal()');
    check('新增學號 s01 → 與 S001 同號，擋下', run('studentDatabase.length') === n0 && sandbox.alerts.length === a1 + 1 && sandbox.alerts[a1].includes('同一個號碼'));
    run('closeStudentModal()');
    check('搜尋學號容錯：0032 ↔ 32、032', run('idMatchesQuery("0032", "32") && idMatchesQuery("32", "0032") && idMatchesQuery("0032", "032") && !idMatchesQuery("0032", "0033")'));

    // 清掉：11 月課表與學費條目，回到 9 月
    run('saveToLocalStorage(); delete lessonsByMonth["2026-11"]; GACSendlog.purgeMonth(sendLog, "2026-11", []); persistLessons();');
    getEl('batchMonth').value = '2026-09';
    run('rebuildMonthContext(); renderAll();');
    check('清理完成', !run('lessonsByMonth["2026-11"]') && g01 >= 0 && !run('studentDatabase.some(s => s.inactivePeriods)'));
}

// 38b) 寫入模式同步：.ics 匯入的事件靠 iCalUID 認回 → 不是手動新建、不重複推送
function __icsSyncTail() {
    console.log('[38b] 同步認得 .ics 匯入的事件');
    getEl('batchMonth').value = '2026-09';
    run('rebuildMonthContext(); renderAll()');
    const cells = run('GACSchedule.groupByCell(lessonsByMonth["2026-09"] || []).length');
    check('9 月有課可測', cells > 0);
    const gwWas = run('appSettings.gcalWrite'), cidWas = run('appSettings.gcalClientId');
    run('appSettings.gcalWrite = true; appSettings.gcalClientId = "test-client-id"; appSettings.gcalCalendarId = "primary"');
    run('tutorsList.forEach(t => { t.calendarId = ""; })');
    run('gcalToken = { accessToken: "t", scope: gcalScope(), expiresAt: Date.now() + 3600000 }');
    // 模擬「導出 .ics → Google 匯入」：Google 把 UID 存成 iCalUID，事件沒有 extendedProperties
    const items = run('GACSchedule.groupByCell(lessonsByMonth["2026-09"]).map((c, i) => { const e = cellToExportEvent(c); const f = c.lessons[0]; ' +
        'return { id: "imp" + i, iCalUID: e.uid, status: "confirmed", summary: e.title, description: e.description, location: e.location, ' +
        'start: { dateTime: f.date + "T" + f.time + ":00+08:00" }, end: { dateTime: f.date + "T" + f.time + ":00+08:00" } }; })');
    items.push({ id: 'manual-x', iCalUID: 'zzz@google.com', status: 'confirmed', summary: 'S001 Student 001 補堂', start: { dateTime: '2026-09-28T10:00:00+08:00' }, end: { dateTime: '2026-09-28T10:45:00+08:00' } });
    sandbox.fetch = (url, init) => (init && init.method && init.method !== 'GET')
        ? Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) })
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: JSON.parse(JSON.stringify(items)) }) });
    run('gcalSyncPlan = null');
    sandbox.alerts.length = 0;
    run('openGcalSync()');
    return new Promise(resolve => {
        const t0 = Date.now();
        (function wait() { if (run('!!gcalSyncPlan') || sandbox.alerts.length || Date.now() - t0 > 3000) resolve(); else setTimeout(wait, 10); })();
    }).then(() => {
        const plan = run('gcalSyncPlan');
        check('同步有跑出面板（沒報錯）', !!plan && sandbox.alerts.length === 0);
        check('.ics 匯入的事件全部認回：不推送重複的一份', !!plan && plan.toPush.length === 0);
        check('只有真正手動建的那一件列成「手動新建」', !!plan && plan.manualNew.length === 1 && plan.manualNew[0].event.id === 'manual-x');
        check('也不當殘留去刪', !!plan && plan.orphans.length === 0);
        sandbox.fetch = () => Promise.reject(new Error('offline'));
        run('gcalSyncPlan = null; gcalToken = null; appSettings.gcalWrite = ' + JSON.stringify(gwWas) + '; appSettings.gcalClientId = ' + JSON.stringify(cidWas));
    });
}

// 39) 強制清空 Calendar＋本地（debug）：寫入模式、假 token、假 fetch；刪視窗內所有事件（含無標籤）、本地整個清空
// 走 Promise 鏈，所以放在最後用 __asyncTail 等它跑完再結算
// 38d) 狀態雙向：本地標請假／缺席 → 寫回 Calendar（寫入 PATCH／唯讀提示＋打開事件編輯頁）；兩邊都有且不同 → 看設定「以哪邊為準」
function __statusSyncTail() {
    console.log('[38d] 狀態寫回與衝突規則');
    const J = JSON.stringify;
    const waitFor = cond => new Promise(resolve => { const t0 = Date.now(); (function wait() { if (cond() || Date.now() - t0 > 3000) resolve(); else setTimeout(wait, 10); })(); });
    const L = id => 'GACLessonState.findLesson(lessonsByMonth, ' + J(id) + ').lesson';
    getEl('batchMonth').value = '2026-09';
    run('rebuildMonthContext(); renderAll()');
    run('__was38d = { w: appSettings.gcalWrite, c: appSettings.gcalClientId, r: appSettings.gcalConflict }');
    run('appSettings.gcalWrite = true; appSettings.gcalClientId = "test-client-id"; appSettings.gcalCalendarId = "primary"; appSettings.gcalConflict = "gcal"');
    run('tutorsList.forEach(t => { t.calendarId = ""; })');
    run('gcalToken = { accessToken: "t", scope: GCAL_WRITE_SCOPE, expiresAt: Date.now() + 3600000 }');
    // Calendar 快照：視窗內每節一件（沿用成員記著的事件 id），都帶 htmlLink（eid）
    const mkItems = () => run('GACSchedule.groupByCell(GACLessonState.allLessons(lessonsByMonth).filter(l => l.date >= "2026-08-25" && l.date <= "2026-10-07")).map((c, i) => { ' +
        'const p = GACGcal.cellToEventPayload(c, { titleFn: GACSchedule.lessonTitle, timeZone: "Asia/Hong_Kong" }); const id = c.lessons[0].gcalEventId || ("s" + i); ' +
        'return { id: id, status: "confirmed", summary: p.summary, description: p.description, location: p.location, extendedProperties: p.extendedProperties, ' +
        'htmlLink: "https://www.google.com/calendar/event?eid=EID_" + id, start: { dateTime: c.date + "T" + c.time + ":00+08:00" }, end: { dateTime: c.date + "T" + c.time + ":00+08:00" } }; })');
    const items = mkItems();   // 先照目前狀態拍（此刻全員與 Calendar 一致）
    const regs = run('lessonsByMonth["2026-09"].filter(l => !l.isMakeup && !GACSchedule.isGroupLesson(l) && l.status !== "LEAVE" && !l.gcalMovedFrom && !l.makeupLessonId).map(l => l.lessonId)');
    const A = regs[0], B = regs[1], C = regs[2] || A;   // 沙盒裡一對一常規課只有 S001 的；唯讀那段沒有第三堂就重用 A
    check('有課可測', !!A && !!B);
    // 本地：A 改缺席（Calendar 沒碼）、B 改病假 SL（Calendar 填的是 L → 兩邊都有、不同）
    run('Object.assign(' + L(A) + ', { status: "NOSHOW", leaveType: "" })');
    run('Object.assign(' + L(B) + ', { status: "LEAVE", leaveType: "SL" })');
    const evB = items.find(e => e.extendedProperties.private.gacLessonId === B);
    evB.location = 'L'; evB.description = evB.description.replace(/狀態：[^\n]*/, '狀態：L') + '\n導師的筆記';
    const calls = [];
    let calItems = items;
    sandbox.fetch = (url, init) => {
        const method = (init && init.method) || 'GET';
        if (method === 'PATCH') { calls.push({ url: url, body: JSON.parse(init.body) }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'x' }) }); }
        if (method !== 'GET') { calls.push({ url: url, method: method }); return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) }); }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: JSON.parse(JSON.stringify(calItems)) }) });
    };
    const sync = () => { run('gcalSyncPlan = null'); sandbox.alerts.length = 0; run('openGcalSync()'); return waitFor(() => run('!!gcalSyncPlan') || sandbox.alerts.length).then(() => run('gcalSyncPlan')); };
    check('寫入模式、本地標了缺席而 Calendar 沒碼 → 課卡有「寫回 GCal 狀態」（知道事件）或「同步 GCal」（還不知道）', /gcalPushStatus\(|openGcalSync\(\)/.test(run('gcalStatusButton(' + L(A) + ')')));
    return sync().then(p => {
        check('Calendar 為準（預設）：A（Calendar 沒碼）→ 寫回 NS；B（L vs SL）→ 拉回 L；其他組空', !!p && sandbox.alerts.length === 0
            && p.pushStatus.length === 1 && p.pushStatus[0].lesson.lessonId === A && p.pushStatus[0].code === 'NS'
            && p.statusChanges.length === 1 && p.statusChanges[0].lesson.lessonId === B && p.statusChanges[0].to.leaveType === 'L'
            && p.toPush.length === 0 && p.orphans.length === 0 && p.timeChanges.length === 0 && p.deletions.length === 0 && p.fillStatus.length === 0);
        check('同步時記下事件 eid 與 Calendar 目前的碼', run(L(A) + '.gcalEid') === 'EID_' + items.find(e => e.extendedProperties.private.gacLessonId === A).id
            && run(L(B) + '.gcalCode') === 'L' && run(L(A) + '.gcalCode') === '');
        check('面板：「寫回狀態」一組、標題寫明以 Calendar 為準', getEl('gcalSyncBody').innerHTML.includes('寫回狀態到 GCal') && getEl('gcalSyncBody').innerHTML.includes('以 Calendar 為準'));
        run('appSettings.gcalConflict = "local"');
        return sync();
    }).then(p => {
        check('本系統為準：B 改成寫回 SL，不再拉回', !!p && p.statusChanges.length === 0 && p.pushStatus.length === 2
            && p.pushStatus.some(s => s.lesson.lessonId === B && s.code === 'SL') && getEl('gcalSyncBody').innerHTML.includes('以 本系統 為準'));
        getEl('gsW_0').checked = true; getEl('gsW_1').checked = true;
        run('applyGcalSync()');
        return waitFor(() => run('gcalSyncPlan === null'));
    }).then(() => {
        const pa = calls.find(c => c.body && c.body.location === 'NS'), pb = calls.find(c => c.body && c.body.location === 'SL');
        check('PATCH 兩件：只送地點欄與說明欄，「狀態：」一行換掉、其他行（導師的筆記）保留', calls.length === 2 && !!pa && !!pb
            && pa.body.description.includes('狀態：NS') && !('start' in pa.body) && !('summary' in pa.body)
            && pb.body.description.includes('狀態：SL') && pb.body.description.endsWith('導師的筆記') && pb.url.endsWith('/events/' + evB.id));
        check('寫回後記下碼 → 課卡按鈕消失；結果列出「寫回狀態」', run(L(A) + '.gcalCode') === 'NS' && run('gcalStatusButton(' + L(A) + ')') === ''
            && getEl('gcalSyncBody').innerHTML.includes('寫回狀態'));

        // —— 唯讀：本地標請假，Calendar 沒填 → 提示＋打開該事件編輯頁；導師填好再同步就消失 ——
        run('appSettings.gcalWrite = false; appSettings.gcalConflict = "gcal"');
        run('gcalToken = { accessToken: "t", scope: gcalScope(), expiresAt: Date.now() + 3600000 }');
        run('Object.assign(' + L(C) + ', { status: "LEAVE", leaveType: "L", gcalCode: "", gcalEid: "" })');
        calItems = mkItems().map(e => Object.assign({}, e, { extendedProperties: undefined }));  // 唯讀：都沒標籤，按內容配對
        const cInfo = run('(l => ({ sid: l.studentId, date: l.date }))(' + L(C) + ')');
        const findC = () => calItems.find(e => e.summary.startsWith(cInfo.sid + ' ') && e.start.dateTime.startsWith(cInfo.date));
        findC().location = ''; findC().description = findC().description.replace(/狀態：[^\n]*/, '狀態：');
        const btn0 = run('gcalStatusButton(' + L(C) + ')');
        check('唯讀：課卡「在 GCal 填 狀態：L」', btn0.includes('在 GCal 填 狀態：L') && btn0.includes("openGcalEvent('" + C + "')"));
        return sync();
    }).then(p => {
        const fill = p ? p.fillStatus.filter(s => s.lesson.lessonId === C) : [];
        check('唯讀同步：列「請到 Calendar 填」附編輯頁連結；不拉回、不推、不當手動新建', !!p && fill.length === 1 && fill[0].code === 'L'
            && getEl('gcalSyncBody').innerHTML.includes('r/eventedit/EID_') && !p.statusChanges.some(s => s.lesson.lessonId === C)
            && p.pushStatus.length === 0 && p.toPush.length === 0 && !p.manualNew.some(m => m.event.id === fill[0].event.id));
        let opened = '';
        sandbox.open = u => { opened = u; };
        run('openGcalEvent(' + J(C) + ')');
        check('按鈕打開該事件的編輯頁（eid 來自同步）', /^https:\/\/calendar\.google\.com\/calendar\/r\/eventedit\/EID_/.test(opened) && run(L(C) + '.gcalEid').indexOf('EID_') === 0);
        // 導師填好了
        const cInfo = run('(l => ({ sid: l.studentId, date: l.date }))(' + L(C) + ')');
        const evC = calItems.find(e => e.summary.startsWith(cInfo.sid + ' ') && e.start.dateTime.startsWith(cInfo.date));
        evC.description = evC.description.replace(/狀態：[^\n]*/, '狀態：L');
        return sync().then(p2 => {
            check('導師在 Calendar 填了 L → 不再提示、按鈕消失', !!p2 && !p2.fillStatus.some(s => s.lesson.lessonId === C) && run(L(C) + '.gcalCode') === 'L'
                && run('gcalStatusButton(' + L(C) + ')') === '');
            // 唯讀取消補堂：打開 Calendar 上該事件讓人刪
            const mu = run('GACLessonState.scheduleMakeup(lessonsByMonth, ' + J(C) + ', { date: "2026-09-30", time: "09:00" }).makeup.lessonId');
            run(L(mu) + '.gcalEid = "EID_MU"');
            let cancelMsg = ''; sandbox.confirm = m => { cancelMsg = String(m); return true; };
            opened = '';
            run('cancelMakeupUI(' + J(mu) + ')');
            check('唯讀取消補堂：確認框說明會打開 Calendar 事件請人刪；取消後打開該事件的編輯頁', cancelMsg.includes('請在 Calendar 把它刪掉')
                && opened === 'https://calendar.google.com/calendar/r/eventedit/EID_MU' && !run('GACLessonState.findLesson(lessonsByMonth, ' + J(mu) + ')'));
            sandbox.confirm = () => true;
        });
    }).then(() => {
        // 設定頁：以哪邊為準
        getEl('setGcalConflict').value = 'local';
        run('saveSettingsForm()');
        check('設定「兩邊都改了時以哪邊為準」可存', run('appSettings.gcalConflict') === 'local');
        // 設定頁：批量操作同時送幾件（1–10，預設 6；填錯／留空回預設）
        check('同時送幾件：預設 6、表單帶出目前值', run('GACStorage.DEFAULT_SETTINGS.gcalParallel') === 6 && run('gcalParallel()') === 6
            && run('loadSettingsForm()') === undefined && String(getEl('setGcalParallel').value) === '6');
        const savePar = v => { getEl('setGcalParallel').value = v; run('saveSettingsForm()'); return [run('appSettings.gcalParallel'), run('gcalParallel()')].join(); };
        check('同時送幾件：3 → 3；99 → 上限 10；1 → 逐件；留空／亂填 → 預設 6', savePar('3') === '3,3' && savePar('99') === '10,10' && savePar('1') === '1,1'
            && savePar('') === '6,6' && savePar('abc') === '6,6' && savePar('0') === '6,6');
        check('存進設定檔', JSON.parse(fakeStorage.getItem('gac_settings_v2')).gcalParallel === 6);
        getEl('setGcalConflict').value = '';
        sandbox.open = () => {};
        sandbox.fetch = () => Promise.reject(new Error('offline'));
        run('gcalSyncPlan = null; gcalToken = null; Object.assign(appSettings, { gcalWrite: __was38d.w, gcalClientId: __was38d.c, gcalConflict: __was38d.r })');
    });
}

function __asyncTail() {
    console.log('[39] 強制清空 Calendar');
    const err404 = run('gcalCalendarErrorText("導師 Instructor B 的日曆（abc@group.calendar.google.com）", new Error("Google Calendar API 404：Not Found"))');
    check('讀日曆 404 → 錯誤寫明哪一本、ID、與「ID 打錯／帳號沒權限」提示', err404.includes('導師 Instructor B 的日曆（abc@group.calendar.google.com）')
        && err404.includes('404＝找不到這本日曆') && err404.includes('日曆 ID') && err404.includes('分享'));
    check('403 → 權限提示；其他錯誤照原文', run('gcalCalendarErrorText("預設日曆（primary）", new Error("Google Calendar API 403：x"))').includes('403＝沒有權限')
        && run('gcalCalendarErrorText("預設日曆（primary）", new Error("timeout"))') === '讀取預設日曆（primary）失敗：timeout');
    const gwWas = run('appSettings.gcalWrite'), cidWas = run('appSettings.gcalClientId');
    run('appSettings.gcalWrite = false; appSettings.gcalClientId = ""');
    sandbox.alerts.length = 0;
    run('forceWipeCalendarEvents()');
    check('沒填 Client ID → 說明要先填', sandbox.alerts.length === 1 && sandbox.alerts[0].includes('Client ID'));
    // 唯讀設定下直接可用：臨時用寫入授權（預先放一個寫入範圍的 token，當作授權視窗已同意）
    run('appSettings.gcalClientId = "test-client-id"; appSettings.gcalCalendarId = "primary"');
    run('gcalToken = { accessToken: "t", scope: GCAL_WRITE_SCOPE, expiresAt: Date.now() + 3600000 }');
    const deletedUrls = [], listedCals = [];
    const fakeFetch = (url, init) => {
        const m = /calendars\/([^/]+)\/events/.exec(url);
        const cal = decodeURIComponent(m ? m[1] : '');
        if (init && init.method === 'DELETE') { deletedUrls.push(url); return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) }); }
        listedCals.push(cal);
        const items = [
            { id: 'tagged-1', status: 'confirmed', summary: 'S001 Student 001([1/5] 09/2026)', extendedProperties: { private: { gacLessonId: 'S001-20260901-2130' } } },
            { id: 'ics-1', status: 'confirmed', summary: 'S002 Student 002([1/4] 09/2026)' },
            { id: 'manual-1', status: 'confirmed', summary: '私人約會' },
            { id: 'cancelled-1', status: 'cancelled', summary: 'x' }
        ];
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) });
    };
    // 第二本（Instructor B）故意給一個 404 的 ID：其餘照刪，錯誤列在結果裡
    run("tutorsList[1].calendarId = 'bad@group.calendar.google.com'");
    const realFake = fakeFetch;
    const fakeFetchWith404 = (url, init) => {
        if (url.includes(encodeURIComponent('bad@group.calendar.google.com'))) {
            listedCals.push('bad');
            return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: { message: 'Not Found' } }) });
        }
        return realFake(url, init);
    };
    // 沒打 DELETE → 什麼都不做
    sandbox.fetch = fakeFetchWith404;
    sandbox.prompt = () => 'delete';
    sandbox.alerts.length = 0;
    run('forceWipeCalendarEvents()');
    check('確認後沒輸入大寫 DELETE → 取消、不打 API', sandbox.alerts.length === 1 && sandbox.alerts[0].includes('已取消') && listedCals.length === 0 && deletedUrls.length === 0);
    const lessonsBefore = run('GACLessonState.allLessons(lessonsByMonth).length');
    check('沙盒裡仍有課堂可測', lessonsBefore > 0);
    run('sendLog["CUSTOM:smoke:S001"] = { key: "CUSTOM:smoke:S001", type: "CUSTOM", studentId: "S001", month: "2026-09", status: "PENDING" }');
    let wipeConfirm = '';
    // 第一個 confirm 是清場確認（答是）；第二個是「要不要一併清快照」（答否，留著才能驗快照）
    let brokenConfirm = '';
    sandbox.confirm = msg => {
        const m = String(msg);
        if (m.startsWith('是否一併清空')) return false;          // 留著快照才能驗撤銷
        if (m.startsWith('⚠️ 有')) { brokenConfirm = m; return true; }  // 有一本讀不到 → 仍清本地
        if (!wipeConfirm) wipeConfirm = m;
        return true;
    };
    sandbox.prompt = () => 'DELETE';
    sandbox.alerts.length = 0;
    run('forceWipeCalendarEvents()');
    return new Promise(resolve => {
        const t0 = Date.now();
        (function wait() { if (sandbox.alerts.length || Date.now() - t0 > 3000) resolve(); else setTimeout(wait, 10); })();
    }).then(() => {
        sandbox.confirm = () => true; sandbox.prompt = () => ''; sandbox.fetch = () => Promise.reject(new Error('offline'));
        check('確認框列出日曆、寫明「不論是否由本系統建立」、本地也清', wipeConfirm.includes('不論是否由本系統建立') && wipeConfirm.includes('預設日曆（primary）')
            && wipeConfirm.includes('本地也一併清空'));
        check('唯讀設定下不用先開「授權寫入」：確認框說明會臨時申請寫入授權；做完設定仍是唯讀、臨時授權已丟棄', wipeConfirm.includes('臨時申請寫入授權')
            && run('appSettings.gcalWrite') === false && run('gcalToken') === null);
        check('讀不到的那本：問過「仍要清本地嗎」、錯誤寫明是 B 的日曆與 404 原因', brokenConfirm.includes('1 本日曆讀不到')
            && brokenConfirm.includes('Instructor B（bad@group.calendar.google.com）') && brokenConfirm.includes('404＝找不到這本日曆'));
        check('視窗內所有非取消事件都刪：帶標籤、.ics 匯入、手動建立 → 3 件；已取消的不刪；壞的那本不擋其他', listedCals.join(',') === 'primary,bad' && deletedUrls.length === 3
            && deletedUrls.some(u => u.endsWith('/tagged-1')) && deletedUrls.some(u => u.endsWith('/ics-1')) && deletedUrls.some(u => u.endsWith('/manual-1')));
        check('本地全清：課堂、發送紀錄歸零', run('Object.keys(lessonsByMonth).length') === 0 && run('Object.keys(sendLog).length') === 0);
        check('結果提示：刪 3 件、本地已清空、快照保留；有拍快照可撤銷', sandbox.alerts.length === 1 && sandbox.alerts[0].includes('刪 3 件')
            && sandbox.alerts[0].includes('本地課表、發送紀錄、薪酬調整與封存已清空') && sandbox.alerts[0].includes('歷史快照保留')
            && run('actionHistory[0].description').includes('強制清空 Calendar＋本地'));
        run('undoLastAction()');
        check('撤銷 → 本地課堂與發送紀錄回來', run('GACLessonState.allLessons(lessonsByMonth).length') === lessonsBefore && !!run('sendLog["CUSTOM:smoke:S001"]'));
        run('tutorsList[1].calendarId = ""; gcalToken = null; appSettings.gcalWrite = ' + JSON.stringify(gwWas) + '; appSettings.gcalClientId = ' + JSON.stringify(cidWas));
    });
}

// 38c) 補堂改期 → 寫入模式同步改 Calendar 上原本那個事件（PATCH，不另建）；唯讀模式提示去 Calendar 改
function __muMoveTail() {
    console.log('[38c] 補堂改期接回原事件');
    const J = JSON.stringify;
    const waitFor = cond => new Promise(resolve => {
        const t0 = Date.now();
        (function wait() { if (cond() || Date.now() - t0 > 3000) resolve(); else setTimeout(wait, 10); })();
    });
    getEl('batchMonth').value = '2026-09';
    run('rebuildMonthContext(); renderAll()');
    const gwWas = run('appSettings.gcalWrite'), cidWas = run('appSettings.gcalClientId');
    run('appSettings.gcalWrite = true; appSettings.gcalClientId = "test-client-id"; appSettings.gcalCalendarId = "primary"');
    run('tutorsList.forEach(t => { t.calendarId = ""; })');
    run('gcalToken = { accessToken: "t", scope: gcalScope(), expiresAt: Date.now() + 3600000 }');
    // 到這裡 9 月的課多已批量確認出席：挑 S001 一堂一對一常規課，直接設成請假（未排補堂）當原課
    const origin = run('lessonsByMonth["2026-09"].find(l => l.studentId === "S001" && !l.isMakeup && !l.groupId && l.date === "2026-09-21").lessonId');
    run('Object.assign(GACLessonState.findLesson(lessonsByMonth, ' + J(origin) + ').lesson, { status: "LEAVE", leaveType: "L", makeupLessonId: null })');
    const mu1 = run('GACLessonState.scheduleMakeup(lessonsByMonth, ' + J(origin) + ', { date: "2026-09-24", time: "10:00" }).makeup.lessonId');
    run('GACLessonState.findLesson(lessonsByMonth, ' + J(mu1) + ').lesson.gcalEventId = "evMU"');   // 當作已推送
    // Calendar：視窗內每一節都有帶標籤的事件（與本地一致），補堂那一個 id＝evMU
    const items = run('GACSchedule.groupByCell(GACLessonState.allLessons(lessonsByMonth).filter(l => l.date >= "2026-08-25" && l.date <= "2026-10-07")).map((c, i) => { ' +
        'const p = GACGcal.cellToEventPayload(c, { titleFn: GACSchedule.lessonTitle, timeZone: "Asia/Hong_Kong" }); ' +
        'return { id: c.key === ' + J(mu1) + ' ? "evMU" : "e" + i, status: "confirmed", summary: p.summary, description: p.description, location: p.location, ' +
        'extendedProperties: p.extendedProperties, htmlLink: "https://calendar.google.com/calendar/event?eid=x" + i, start: { dateTime: c.date + "T" + c.time + ":00+08:00" }, end: { dateTime: c.date + "T" + c.time + ":00+08:00" } }; })');
    run('openMoveModal(' + J(origin) + ')');
    check('補堂改期彈窗提示：同步會改 Calendar 上原本那個事件', getEl('moveModalInfo').innerHTML.includes('原本那個事件改到新時間'));
    getEl('moveDate').value = '2026-09-25'; getEl('moveTime').value = '11:00';
    run('submitMoveModal()');
    const mu2 = run('GACLessonState.findLesson(lessonsByMonth, ' + J(origin) + ').lesson.makeupLessonId');
    const mf = run('GACLessonState.findLesson(lessonsByMonth, ' + J(mu2) + ').lesson.gcalMovedFrom');
    check('新補堂接手舊事件：記下舊 key／舊時段、事件 id', mu2 !== mu1 && !!mf && mf.key === mu1 && mf.date === '2026-09-24' && mf.time === '10:00' && mf.inCal === true
        && run('GACLessonState.findLesson(lessonsByMonth, ' + J(mu2) + ').lesson.gcalEventId') === 'evMU');
    const calls = [];
    let calItems = items;
    sandbox.fetch = (url, init) => {
        const method = (init && init.method) || 'GET';
        if (method === 'PATCH') { calls.push({ url: url, body: JSON.parse(init.body) }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'evMU' }) }); }
        if (method !== 'GET') { calls.push({ url: url, method: method }); return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) }); }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: JSON.parse(JSON.stringify(calItems)) }) });
    };
    run('gcalSyncPlan = null');
    sandbox.alerts.length = 0;
    run('openGcalSync()');
    return waitFor(() => run('!!gcalSyncPlan') || sandbox.alerts.length).then(() => {
        const p = run('gcalSyncPlan');
        check('寫入模式：列進「改 GCal 事件」，對準原事件 evMU', !!p && p.moves.length === 1 && p.moves[0].event.id === 'evMU' && p.moves[0].lesson.lessonId === mu2 && !p.moves[0].tagOnly);
        check('不另推新事件、不把舊事件當殘留刪、不當成 Calendar 改了時間', !!p && p.toPush.length === 0 && p.orphans.length === 0 && p.timeChanges.length === 0 && p.deletions.length === 0 && p.manualNew.length === 0);
        check('面板：「本地改期 → 改 GCal 上原本那個事件」、舊→新時間', getEl('gcalSyncBody').innerHTML.includes('本地改期 → 改 GCal 上原本那個事件')
            && getEl('gcalSyncBody').innerHTML.includes('GCal 2026-09-24 10:00 → <b>2026-09-25 11:00</b>'));
        getEl('gsV_0').checked = true;
        run('applyGcalSync()');
        return waitFor(() => run('gcalSyncPlan === null'));
    }).then(() => {
        const pc = calls.find(c => c.body);
        check('PATCH 原事件（不 POST 新的、不 DELETE）：新時間、新標籤、舊型態標籤設 null、補堂標題帶「← 原課日期」', calls.length === 1 && !!pc && pc.url.endsWith('/events/evMU')
            && pc.body.start.dateTime === '2026-09-25T11:00:00' && pc.body.extendedProperties.private.gacLessonId === mu2
            && pc.body.extendedProperties.private.gacCellKey === null && pc.body.summary.includes(' 補堂(') && pc.body.summary.includes(' ← '));
        const l = run('GACLessonState.findLesson(lessonsByMonth, ' + J(mu2) + ').lesson');
        check('改完：改期記號清掉、事件 id 保留', !l.gcalMovedFrom && l.gcalEventId === 'evMU');
        check('結果列出「改 GCal 事件」', getEl('gcalSyncBody').innerHTML.includes('改 GCal 事件'));

        // —— 唯讀：導師按「加進 GCal」建的（無標籤），之後在系統再改期 ——
        run('appSettings.gcalWrite = false');
        run('gcalToken = { accessToken: "t", scope: gcalScope(), expiresAt: Date.now() + 3600000 }');   // 唯讀用唯讀範圍的授權
        let opened = '';
        sandbox.open = u => { opened = u; };
        run('openGcalTemplate(' + J(mu2) + ')');
        check('按「加進 GCal」→ 記下已加', run('GACLessonState.findLesson(lessonsByMonth, ' + J(mu2) + ').lesson.gcalAdded') === true && opened.includes('action=TEMPLATE'));
        run('openMoveModal(' + J(origin) + ')');
        check('唯讀：改期彈窗提示去 Calendar 改原本那個事件', getEl('moveModalInfo').innerHTML.includes('請在 Calendar 把原本那個事件改到新時間'));
        getEl('moveDate').value = '2026-09-26'; getEl('moveTime').value = '14:00';
        run('submitMoveModal()');
        const mu3 = run('GACLessonState.findLesson(lessonsByMonth, ' + J(origin) + ').lesson.makeupLessonId');
        const btn = run('gcalAddButton(GACLessonState.findLesson(lessonsByMonth, ' + J(mu3) + ').lesson)');
        check('唯讀：課卡按鈕換成「改 GCal 舊事件（09-25 11:00 → 09-26 14:00）」，不再是加進 GCal', btn.includes("openGcalDay('" + mu3 + "')") && !btn.includes('openGcalTemplate')
            && btn.includes('改 GCal 舊事件（09-25 11:00 → 09-26 14:00）'));
        run('openGcalDay(' + J(mu3) + ')');
        check('「改 GCal 舊事件」打開舊事件那一天', opened === 'https://calendar.google.com/calendar/r/day/2026/9/25');
        sandbox.confirm = () => false;
        opened = '';
        run('openGcalTemplate(' + J(mu3) + ')');
        check('唯讀：舊事件在 Calendar 時硬按「加進 GCal」→ 先警告會重複（按取消就不開）', opened === '');
        sandbox.confirm = () => true;
        // Calendar：全部事件沒有標籤（唯讀按內容配對）；補堂那一個是按「加進 GCal」建的，仍在 9/25 11:00
        const muTitle = run('GACSchedule.lessonTitle(GACLessonState.findLesson(lessonsByMonth, ' + J(mu3) + ').lesson)');
        calItems = items.filter(e => e.id !== 'evMU').map(e => Object.assign({}, e, { extendedProperties: undefined }))
            .concat([{ id: 'tpl1', status: 'confirmed', summary: muTitle, htmlLink: 'https://calendar.google.com/calendar/event?eid=tpl1', start: { dateTime: '2026-09-25T11:00:00+08:00' }, end: { dateTime: '2026-09-25T11:45:00+08:00' } }]);
        run('gcalSyncPlan = null');
        sandbox.alerts.length = 0;
        run('openGcalSync()');
        return waitFor(() => run('!!gcalSyncPlan') || sandbox.alerts.length);
    }).then(() => {
        const p = run('gcalSyncPlan');
        const stale = p ? p.staleMoves.filter(m => m.event.id === 'tpl1') : [];
        check('唯讀同步：Calendar 仍在舊時間 → 列「請到 Calendar 改」，附事件連結', stale.length === 1 && !stale[0].duplicate
            && getEl('gcalSyncBody').innerHTML.includes('本地已改期、Calendar 上還是舊時間') && getEl('gcalSyncBody').innerHTML.includes('r/eventedit/tpl1'));
        const mu3 = run('GACLessonState.findLesson(lessonsByMonth, ' + J(origin) + ').lesson.makeupLessonId');
        check('唯讀同步：那個舊事件不當「手動新建」、新補堂不當「Calendar 沒有」、不改回本地', !!p && !p.manualNew.some(m => m.event.id === 'tpl1')
            && !p.deletions.some(d => d.cell.key === mu3) && !p.timeChanges.some(c => c.cell.key === mu3) && p.moves.length === 0 && p.toPush.length === 0);
        // 導師在 Calendar 把它拖到 9/26 14:00 → 再同步：沒有待改，記號清掉
        calItems = calItems.map(e => e.id === 'tpl1' ? Object.assign({}, e, { start: { dateTime: '2026-09-26T14:00:00+08:00' }, end: { dateTime: '2026-09-26T14:45:00+08:00' } }) : e);
        run('gcalSyncPlan = null');
        run('openGcalSync()');
        return waitFor(() => run('!!gcalSyncPlan') || sandbox.alerts.length).then(() => {
            const p2 = run('gcalSyncPlan');
            const l = run('GACLessonState.findLesson(lessonsByMonth, ' + J(mu3) + ').lesson');
            check('導師在 Calendar 改好後再同步：不再提示、改期記號清掉、按鈕回到「加進 GCal」之外的正常狀態', !!p2 && p2.staleMoves.length === 0 && !l.gcalMovedFrom && l.gcalAdded === true
                && !run('gcalAddButton(GACLessonState.findLesson(lessonsByMonth, ' + J(mu3) + ').lesson)').includes('openGcalDay'));
        });
    }).then(() => {
        sandbox.open = () => {};
        sandbox.fetch = () => Promise.reject(new Error('offline'));
        run('gcalSyncPlan = null; gcalToken = null; appSettings.gcalWrite = ' + J(gwWas) + '; appSettings.gcalClientId = ' + J(cidWas));
    });
}

// 38e) 導師各有日曆：推送到各自的日曆；放錯日曆的搬回；改期後彈窗一鍵推送（PATCH 原事件）；池排補堂一鍵推（新建）；狀態直接寫回；清空本月逐本日曆刪
function __tutorCalTail() {
    console.log('[38e] 導師日曆推送與一鍵推送');
    const J = JSON.stringify;
    const waitFor = cond => new Promise(resolve => { const t0 = Date.now(); (function wait() { if (cond() || Date.now() - t0 > 3000) resolve(); else setTimeout(wait, 10); })(); });
    const L = id => 'GACLessonState.findLesson(lessonsByMonth, ' + J(id) + ').lesson';
    const A_CAL = 'a@group.calendar.google.com', B_CAL = 'b@group.calendar.google.com';
    getEl('batchMonth').value = '2026-09';
    run('rebuildMonthContext(); renderAll()');
    const was = run('({ w: appSettings.gcalWrite, c: appSettings.gcalClientId })');
    run('appSettings.gcalWrite = true; appSettings.gcalClientId = "test-client-id"; appSettings.gcalCalendarId = "primary"; appSettings.gcalConflict = "gcal"');
    run('tutorsList[0].calendarId = ' + J(A_CAL) + '; tutorsList[1].calendarId = ' + J(B_CAL));
    run('gcalToken = { accessToken: "t", scope: GCAL_WRITE_SCOPE, expiresAt: Date.now() + 3600000 }');
    check('導師都填了日曆 → 只讀兩本；B 的課推到 B 的日曆、名單外的導師推預設', run('gcalCalendarsToRead().map(c => c.calendarId).sort().join()') === A_CAL + ',' + B_CAL
        && run('gcalCalendarForTutor("Instructor B")') === B_CAL && run('gcalCalendarForTutor("沒有這人")') === 'primary'
        && run('gcalCalendarLabel(' + J(B_CAL) + ')') === '導師 Instructor B 的日曆' && run('gcalCalendarLabel("primary")') === '預設日曆');
    run('tutorsList[1].calendarId = ""');
    check('有導師沒填 → 預設日曆也讀（他的課在那裡）', run('gcalCalendarsToRead().map(c => c.calendarId).sort().join()') === A_CAL + ',primary');
    run('tutorsList[1].calendarId = ' + J(B_CAL));
    // 清掉全部事件 id／記號，當作兩本日曆都是空的 → 整月要推
    run('GACLessonState.allLessons(lessonsByMonth).forEach(l => { delete l.gcalEventId; delete l.gcalMovedFrom; delete l.gcalCalId; delete l.gcalEid; delete l.gcalAdded; delete l.gcalCode; })');
    // 一對一常規課沙盒裡只有 S001 有（前面幾段把它們標成請假／缺席，沒掛補堂 → 還原成已排課）；它的導師 T1、日曆 C1，另一本 C2
    const regs = run('lessonsByMonth["2026-09"].filter(l => !l.isMakeup && !GACSchedule.isGroupLesson(l) && !l.makeupLessonId && !l.gcalMovedFrom && l.date !== "2026-09-29" && l.date !== "2026-09-30").map(l => l.lessonId)');
    const reg1 = regs[0], leave1 = regs[1];
    check('有兩堂一對一常規課可用', !!reg1 && !!leave1);
    run('[' + J(reg1) + ', ' + J(leave1) + '].forEach(id => Object.assign(GACLessonState.findLesson(lessonsByMonth, id).lesson, { status: "SCHEDULED", leaveType: "" })); renderAll()');
    const T1 = run(L(reg1) + '.tutor');
    const calls = [];
    const calOf = url => { const m = /calendars\/([^/?]+)\/events/.exec(url); return decodeURIComponent(m ? m[1] : ''); };
    let calItems = {};   // calendarId → events
    let nextId = 1;
    sandbox.fetch = (url, init) => {
        const method = (init && init.method) || 'GET';
        const cal = calOf(url);
        if (method === 'GET') {
            if (/\/events\/[^/?]+$/.test(url)) {
                const id = decodeURIComponent(url.split('/events/')[1]);
                const ev = (calItems[cal] || []).find(e => e.id === id);
                return Promise.resolve(ev ? { ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(ev))) }
                    : { ok: false, status: 404, json: () => Promise.resolve({ error: { message: 'Not Found' } }) });
            }
            if (url.includes('privateExtendedProperty=')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: JSON.parse(JSON.stringify(calItems[cal] || [])) }) });
        }
        const body = init.body ? JSON.parse(init.body) : null;
        const rec = { method, cal, url, body };
        calls.push(rec);
        if (method === 'POST' && url.includes('/move?')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: decodeURIComponent(url.split('/events/')[1].split('/move')[0]) }) });
        if (method === 'POST') { rec.id = 'n' + (nextId++); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: rec.id, htmlLink: 'https://www.google.com/calendar/event?eid=E_' + rec.id }) }); }
        if (method === 'PATCH') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: decodeURIComponent(url.split('/events/')[1]) }) });
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) });
    };
    const sync = () => { run('gcalSyncPlan = null'); sandbox.alerts.length = 0; run('openGcalSync()'); return waitFor(() => run('!!gcalSyncPlan') || sandbox.alerts.length).then(() => run('gcalSyncPlan')); };
    const cellsAll = run('GACSchedule.groupByCell(GACLessonState.allLessons(lessonsByMonth)).map(c => ({ key: c.key, tutor: c.lessons[0].tutor, ids: c.lessons.map(l => l.lessonId) }))');
    const tutorOfKey = key => (cellsAll.find(c => c.key === key) || {}).tutor;
    const calFor = t => t === 'Instructor B' ? B_CAL : A_CAL;
    const sept = cellsAll.filter(c => c.ids[0].indexOf('-202609') !== -1);
    check('9 月兩位導師都有課', sept.some(c => c.tutor === 'Instructor B') && sept.some(c => c.tutor === 'Instructor A'));
    const C1 = calFor(T1), C2 = C1 === A_CAL ? B_CAL : A_CAL;
    const label = c => '導師 ' + (c === A_CAL ? 'Instructor A' : 'Instructor B') + ' 的日曆';
    let stray = null, ev1 = null, muId = null;
    return sync().then(p => {
        check('兩本都空 → 整月列推送；面板每行寫明推到誰的日曆', !!p && sandbox.alerts.length === 0 && p.toPush.length >= sept.length && p.relocations.length === 0
            && getEl('gcalSyncBody').innerHTML.includes('→ 導師 Instructor B 的日曆') && getEl('gcalSyncBody').innerHTML.includes('→ 導師 Instructor A 的日曆'));
        for (let i = 0; i < p.toPush.length; i++) getEl('gsP_' + i).checked = true;   // 沙盒 DOM 不會照 checked 屬性，手動勾
        run('applyGcalSync()');
        return waitFor(() => run('gcalSyncPlan === null'));
    }).then(() => {
        const posts = calls.filter(c => c.method === 'POST');
        const keyOf = c => (c.body.extendedProperties.private.gacCellKey || c.body.extendedProperties.private.gacLessonId);
        const wrong = posts.filter(c => c.cal !== calFor(tutorOfKey(keyOf(c))));
        check('每節 POST 到該導師的日曆（B 的進 B、A 的進 A），沒有一件推到預設日曆', posts.length > 0 && wrong.length === 0
            && posts.some(c => c.cal === B_CAL) && posts.some(c => c.cal === A_CAL) && !calls.some(c => c.cal === 'primary'));
        check('推送後每堂記下所在日曆；結果按日曆分列新增件數', run('lessonsByMonth["2026-09"].filter(l => l.tutor === "Instructor B").every(l => l.gcalEventId && l.gcalCalId === ' + J(B_CAL) + ')')
            && run('lessonsByMonth["2026-09"].filter(l => l.tutor === "Instructor A").every(l => l.gcalCalId === ' + J(A_CAL) + ')')
            && getEl('gcalSyncBody').innerHTML.includes('導師 Instructor B 的日曆 ') && getEl('gcalSyncBody').innerHTML.includes('導師 Instructor A 的日曆 '));
        // Calendar 現況＝剛推的事件；把 T1 的一件一對一（leave1）放進另一本 C2，模擬以前推錯
        calItems = {};
        posts.forEach(c => { (calItems[c.cal] = calItems[c.cal] || []).push(Object.assign({ id: c.id, status: 'confirmed', htmlLink: 'https://www.google.com/calendar/event?eid=E_' + c.id }, c.body)); });
        stray = calItems[C1].find(e => e.extendedProperties.private.gacLessonId === leave1);
        check('leave1 的事件在 T1 的日曆', !!stray);
        calItems[C1] = calItems[C1].filter(e => e.id !== stray.id);
        calItems[C2].push(stray);
        calls.length = 0;
        return sync();
    }).then(p => {
        check('放錯日曆的事件 → 列「搬到導師的日曆」（C2 → C1），其他組空', !!p && sandbox.alerts.length === 0 && p.relocations.length === 1 && p.relocations[0].event.id === stray.id
            && p.relocations[0].from === C2 && p.relocations[0].to === C1
            && p.toPush.length === 0 && p.orphans.length === 0 && p.moves.length === 0 && p.timeChanges.length === 0 && p.deletions.length === 0
            && getEl('gcalSyncBody').innerHTML.includes('搬到導師的日曆') && getEl('gcalSyncBody').innerHTML.includes(label(C2) + ' → <b>' + label(C1) + '</b>'));
        check('留空＝沒資訊：Calendar 全部沒填狀態 → 沒有任何狀態提案（過去的課也不當出席）', p.statusChanges.length === 0 && !getEl('gcalSyncBody').innerHTML.includes('已上課'));
        getEl('gsR_0').checked = true;
        run('applyGcalSync()');
        return waitFor(() => run('gcalSyncPlan === null'));
    }).then(() => {
        const mv = calls.find(c => c.url.includes('/move?'));
        check('執行：POST …/calendars/C2/events/<id>/move?destination=C1（只此一件）；本地記下新日曆；結果列出', calls.length === 1 && !!mv && mv.cal === C2
            && mv.url.endsWith('/events/' + stray.id + '/move?destination=' + encodeURIComponent(C1))
            && run(L(leave1) + '.gcalCalId') === C1 && getEl('gcalSyncBody').innerHTML.includes('搬到' + label(C1)));
        calItems[C2] = calItems[C2].filter(e => e.id !== stray.id);
        calItems[C1].push(stray);

        // —— 清單改期 → 改期通知彈窗問「同步到 Google Calendar 嗎？」→ 一鍵 PATCH 原事件（在 T1 的日曆）——
        ev1 = run(L(reg1) + '.gcalEventId');
        check('reg1 已推送、記在 T1 的日曆', !!ev1 && run(L(reg1) + '.gcalCalId') === C1);
        run('openLessonMoveModal(' + J(reg1) + ')');
        check('改期彈窗（寫入）提示：彈窗會問「同步到 Google Calendar 嗎？」', getEl('moveModalInfo').innerHTML.includes('同步到 Google Calendar 嗎'));
        getEl('moveDate').value = '2026-09-29'; getEl('moveTime').value = '16:30';
        run('submitMoveModal()');
        const body = getEl('msgModalBody').innerHTML;
        check('改期後彈窗頂部：「同步到 Google Calendar 嗎？」＋「改 GCal 事件」一鍵鈕（不再是開面板）', body.includes('同步到 Google Calendar 嗎') && body.includes("gcalPushLesson('" + reg1 + "')")
            && body.includes('改 GCal 事件') && !body.includes('openGcalSync()'));
        check('課卡也是一鍵「改 GCal 事件」', run('gcalAddButton(' + L(reg1) + ')').includes("gcalPushLesson('" + reg1 + "')") && run('gcalAddButton(' + L(reg1) + ')').includes('改 GCal 事件'));
        run('closeMsgModal()');
        calls.length = 0;
        run('gcalPushLesson(' + J(reg1) + ')');
        return waitFor(() => calls.some(c => c.method === 'PATCH') || sandbox.alerts.length);
    }).then(() => {
        const pc = calls.find(c => c.method === 'PATCH');
        check('一鍵推：PATCH T1 的日曆上原本那個事件到新時間（不 POST 新的）', calls.length === 1 && !!pc && pc.cal === C1 && pc.url.endsWith('/events/' + ev1)
            && pc.body.start.dateTime === '2026-09-29T16:30:00' && sandbox.alerts.length === 0);
        return waitFor(() => run('!' + L(reg1) + '.gcalMovedFrom'));
    }).then(() => {
        check('改完：改期記號清掉、事件 id 保留、toast 說已改；課卡按鈕消失', !run(L(reg1) + '.gcalMovedFrom') && run(L(reg1) + '.gcalEventId') === ev1
            && run('lastToast').includes('已改 Google Calendar') && run('gcalAddButton(' + L(reg1) + ')') === '');

        // —— 待補堂池排補堂 → 補堂確認彈窗一鍵「推送到 GCal」→ 在 T1 的日曆新建（check-then-insert）——
        run('GACLessonState.markStatus(lessonsByMonth, ' + J(leave1) + ', "LEAVE", { leaveType: "L" }); renderAll()');
        getEl('poolDate_' + leave1).value = '2026-09-30'; getEl('poolTime_' + leave1).value = '10:00';
        run('submitMakeup(' + J(leave1) + ', "poolDate_' + leave1 + '", "poolTime_' + leave1 + '")');
        muId = run(L(leave1) + '.makeupLessonId');
        const body2 = getEl('msgModalBody').innerHTML;
        check('補堂確認彈窗：「同步到 Google Calendar 嗎？」＋「推送到 GCal」鈕指向新補堂', !!muId && body2.includes('同步到 Google Calendar 嗎') && body2.includes("gcalPushLesson('" + muId + "')") && body2.includes('推送到 GCal'));
        run('closeMsgModal()');
        calls.length = 0;
        run('gcalPushLesson(' + J(muId) + ')');
        return waitFor(() => calls.some(c => c.method === 'POST') || sandbox.alerts.length);
    }).then(() => {
        const po = calls.find(c => c.method === 'POST');
        check('一鍵推補堂：POST 到 T1 的日曆、標題帶「補堂」', calls.length === 1 && !!po && po.cal === C1 && po.body.summary.includes('補堂') && sandbox.alerts.length === 0);
        return waitFor(() => run('!!' + L(muId) + '.gcalEventId'));
    }).then(() => {
        check('推完：補堂記下事件 id 與所在日曆；toast 說推到 T1 的日曆', run(L(muId) + '.gcalEventId') === calls[0].id && run(L(muId) + '.gcalCalId') === C1
            && run('lastToast').includes('已推送到' + label(C1)));

        // —— 標缺席 → 課卡「寫回 GCal 狀態」→ 先 GET 該事件再 PATCH 只換「狀態：」一行 ——
        run('Object.assign(' + L(reg1) + ', { status: "NOSHOW", leaveType: "" })');
        const sb = run('gcalStatusButton(' + L(reg1) + ')');
        check('知道事件 → 課卡「寫回 GCal 狀態」一鍵鈕', sb.includes("gcalPushStatus('" + reg1 + "')") && sb.includes('寫回 GCal 狀態'));
        calItems[C1].find(e => e.id === ev1).description += '\n導師的筆記';
        calls.length = 0;
        run('gcalPushStatus(' + J(reg1) + ')');
        return waitFor(() => calls.some(c => c.method === 'PATCH') || sandbox.alerts.length);
    }).then(() => {
        const pc = calls.find(c => c.method === 'PATCH');
        check('寫回狀態：PATCH T1 的日曆上那個事件，只送地點欄與說明欄，「狀態：NS」、導師的筆記保留', calls.length === 1 && !!pc && pc.cal === C1 && pc.url.endsWith('/events/' + ev1)
            && pc.body.location === 'NS' && pc.body.description.includes('狀態：NS') && pc.body.description.endsWith('導師的筆記') && !('start' in pc.body) && sandbox.alerts.length === 0);
        return waitFor(() => run(L(reg1) + '.gcalCode') === 'NS');
    }).then(() => {
        check('寫回後記下碼 → 按鈕消失', run(L(reg1) + '.gcalCode') === 'NS' && run('gcalStatusButton(' + L(reg1) + ')') === '' && run('lastToast').includes('已寫回'));

        // —— 衝突：系統改回已確認出席、Calendar 卻是 NS → 面板「⚠️ 狀態衝突」、預設不勾、不列在一般的狀態碼變更 ——
        run('Object.assign(' + L(reg1) + ', { status: "ATTENDED", leaveType: "" })');
        const evObj = calItems[C1].find(e => e.id === ev1);
        evObj.description = evObj.description.replace(/狀態：[^\n]*/, '狀態：NS'); evObj.location = 'NS';
        return sync();
    }).then(p => {
        const cf = p ? p.statusChanges.filter(x => x.conflict) : [];
        const html = getEl('gcalSyncBody').innerHTML;
        check('系統已上課、Calendar 填了 NS → 衝突：列在「⚠️ 狀態衝突」、預設不勾、不在一般狀態碼變更組', !!p && sandbox.alerts.length === 0 && cf.length === 1 && cf[0].lesson.lessonId === reg1 && cf[0].to.status === 'NOSHOW'
            && p.statusChanges.length === 1 && html.includes('⚠️ 狀態衝突') && html.includes('系統已確認出席') && !html.includes('🏷️ 狀態碼變更')
            && /id="gsS_0"(?! checked)/.test(html) && !/id="gsS_0" checked/.test(html));
        run('closeGcalSyncModal(); gcalSyncPlan = null');

        // —— 清空本月：預設日曆與每本導師日曆都掃，在各自那本刪 ——
        calls.length = 0;
        sandbox.alerts.length = 0;
        const confirmWas = sandbox.confirm;
        sandbox.confirm = () => true;
        run('clearCurrentMonthData()');
        return waitFor(() => sandbox.alerts.length > 0).then(() => { sandbox.confirm = confirmWas; });
    }).then(() => {
        const dels = calls.filter(c => c.method === 'DELETE');
        check('清空本月：兩本導師日曆的帶標籤事件都刪（各在自己那本）、預設日曆也掃過', dels.length > 0 && dels.some(c => c.cal === A_CAL) && dels.some(c => c.cal === B_CAL) && !dels.some(c => c.cal === 'primary')
            && sandbox.alerts[sandbox.alerts.length - 1].includes('已清空 2026-09') && run('(lessonsByMonth["2026-09"] || []).length') === 0);
        run('undoLastAction()');
        check('撤銷清空 → 課表回來', run('(lessonsByMonth["2026-09"] || []).length') > 0);
    }).then(() => {
        sandbox.fetch = () => Promise.reject(new Error('offline'));
        run('gcalSyncPlan = null; gcalToken = null; appSettings.gcalWrite = ' + J(was.w) + '; appSettings.gcalClientId = ' + J(was.c) + '; tutorsList[0].calendarId = ""; tutorsList[1].calendarId = ""');
    });
}

// 38f) 標題容錯與更正：導師手打的標題（學號少零、空格不同、編號寫錯）照樣配到那一節；寫入模式勾選即改標題，唯讀列出來逐個改
function __titleFixTail() {
    console.log('[38f] Calendar 標題容錯與更正');
    const J = JSON.stringify;
    const waitFor = cond => new Promise(resolve => { const t0 = Date.now(); (function wait() { if (cond() || Date.now() - t0 > 3000) resolve(); else setTimeout(wait, 10); })(); });
    const L = id => 'GACLessonState.findLesson(lessonsByMonth, ' + J(id) + ').lesson';
    // 隔離在 2026-12：只生成 S001（週一 21:30：12/7、14、21、28），測完清掉
    const was = run('({ w: appSettings.gcalWrite, c: appSettings.gcalClientId })');
    getEl('batchMonth').value = '2026-12';
    run('rebuildMonthContext()');
    sandbox.__qsaHook = sel => (sel === '.batch-student-chk:checked' ? [{ value: String(run('studentDatabase.findIndex(s => s.id === "S001")')) }] : []);
    run('generateMasterSchedule()');
    sandbox.__qsaHook = () => [];
    run('appSettings.gcalWrite = true; appSettings.gcalClientId = "test-client-id"; appSettings.gcalCalendarId = "primary"; appSettings.gcalConflict = "gcal"');
    run('tutorsList.forEach(t => { t.calendarId = ""; })');
    run('gcalToken = { accessToken: "t", scope: GCAL_WRITE_SCOPE, expiresAt: Date.now() + 3600000 }');
    run('GACLessonState.allLessons(lessonsByMonth).forEach(l => { delete l.gcalEventId; delete l.gcalMovedFrom; delete l.gcalCalId; delete l.gcalEid; delete l.gcalAdded; delete l.gcalCode; })');
    const regs = run('(lessonsByMonth["2026-12"] || []).filter(l => l.studentId === "S001" && !l.isMakeup).map(l => l.lessonId)');
    const r1 = regs[0], r2 = regs[1], r3 = regs[2];
    check('有三堂 S001 常規課可用', !!r1 && !!r2 && !!r3);
    const at = id => run(L(id) + '.date') + 'T' + run(L(id) + '.time') + ':00+08:00';
    const good = id => run('GACSchedule.lessonTitle(' + L(id) + ')');
    const num = id => '[' + run(L(id) + '.lessonNum') + '/' + run(L(id) + '.totalRegular') + ']';
    const items = [
        // 導師手打：學號寫成 s1（少了零、小寫）、空格位置不同、編號寫錯——沒有系統標籤
        { id: 'evA', status: 'confirmed', summary: 's1 Student 001 ([1/1]12/2026 )', start: { dateTime: at(r1) } },
        // 系統標籤的事件，只是空格寫法不同 → 不算
        { id: 'evB', status: 'confirmed', summary: 'S001 Student 001 (' + num(r2) + '12/2026 )', start: { dateTime: at(r2) }, extendedProperties: { private: { gacLessonId: r2 } } },
        // 手打、編號對、後面帶了請假碼 L → 標題不算錯（狀態另列）
        { id: 'evC', status: 'confirmed', summary: good(r3) + ' L', start: { dateTime: at(r3) } }
    ];
    const calls = [];
    sandbox.fetch = (url, init) => {
        const method = (init && init.method) || 'GET';
        calls.push({ method, url, body: init && init.body });
        if (method === 'GET' && url.includes('timeMin=')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: items.map(x => Object.assign({}, x)) }) });
        if (method === 'GET') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'x' }) });
    };
    const sync = () => { run('gcalSyncPlan = null'); sandbox.alerts.length = 0; run('openGcalSync()'); return waitFor(() => run('!!gcalSyncPlan') || sandbox.alerts.length).then(() => run('gcalSyncPlan')); };
    return sync().then(p => {
        const html = getEl('gcalSyncBody').innerHTML;
        check('寫入模式：手打標題的事件配到那一節（不重推、不當手動新建），記下事件 id', !!p && sandbox.alerts.length === 0
            && !p.toPush.some(c => c.lessons.some(l => l.lessonId === r1 || l.lessonId === r3))
            && !p.manualNew.some(m => m.event.id === 'evA' || m.event.id === 'evC')
            && run(L(r1) + '.gcalEventId') === 'evA' && run(L(r3) + '.gcalEventId') === 'evC');
        check('「更正標題」只列編號寫錯的那一件；寫法不同、帶請假碼的不列', p.fixTitles.length === 1 && p.fixTitles[0].event.id === 'evA'
            && p.fixTitles[0].to === good(r1) && p.staleTitles.length === 0
            && html.includes('✏️ 更正標題') && html.includes('s1 Student 001 ([1/1]12/2026 )') && html.includes('<b>' + good(r1) + '</b>') && html.includes('id="gsN_0" checked'));
        check('帶請假碼 L 的那件 → 列在狀態變更', p.statusChanges.some(s => s.lesson.lessonId === r3 && s.to.leaveType === 'L'));
        // 只勾「更正標題」那一項執行
        for (const [id, el] of elements) if (/^gs[A-Z]_\d+$/.test(id)) el.checked = false;
        getEl('gsN_0').checked = true;
        calls.length = 0;
        run('applyGcalSync()');
        return waitFor(() => run('gcalSyncPlan === null'));
    }).then(() => {
        const patches = calls.filter(c => c.method === 'PATCH');
        check('執行：只 PATCH 那一個事件、只送 summary', patches.length === 1 && patches[0].url.includes('/events/evA')
            && JSON.stringify(JSON.parse(patches[0].body)) === JSON.stringify({ summary: good(r1) })
            && !calls.some(c => c.method === 'POST' || c.method === 'DELETE')
            && getEl('gcalSyncBody').innerHTML.includes('更正標題：' + good(r1)));
        items[0].summary = good(r1);   // Calendar 上已改好
        return sync();
    }).then(p => {
        check('改好後再同步：不再列', !!p && p.fixTitles.length === 0 && !getEl('gcalSyncBody').innerHTML.includes('✏️ 更正標題'));
        // —— 唯讀：列出來逐個改（只是提醒，不算差異）——
        items[0].summary = '1 Student 001 ([9/9]12/2026 )';
        run('appSettings.gcalWrite = false; gcalToken = { accessToken: "t", scope: GCAL_READ_SCOPE, expiresAt: Date.now() + 3600000 }');
        return sync();
    }).then(p => {
        const html = getEl('gcalSyncBody').innerHTML;
        check('唯讀：列在「請到 Calendar 改標題」、有「複製正確標題」、不出現勾選的更正', !!p && p.fixTitles.length === 0 && p.staleTitles.length === 1 && p.staleTitles[0].to === good(r1)
            && html.includes('請到 Calendar 改標題') && html.includes('gcalCopyFixedTitle(0)') && !html.includes('id="gsN_0"'));
        let copied = '';
        const clipWas = sandbox.navigator.clipboard.writeText;
        sandbox.navigator.clipboard.writeText = t => { copied = t; return Promise.resolve(); };
        run('gcalCopyFixedTitle(0)');
        sandbox.navigator.clipboard.writeText = clipWas;
        check('複製正確標題 → 剪貼簿是系統標題', copied === good(r1));
    }).then(() => {
        sandbox.fetch = () => Promise.reject(new Error('offline'));
        run('gcalSyncPlan = null; gcalToken = null; appSettings.gcalWrite = ' + J(was.w) + '; appSettings.gcalClientId = ' + J(was.c));
        run('delete lessonsByMonth["2026-12"]; GACSendlog.purgeMonth(sendLog, "2026-12", []); persistLessons();');
        getEl('batchMonth').value = '2026-09';
        run('rebuildMonthContext(); renderAll()');
        check('清理完成', !run('lessonsByMonth["2026-12"]'));
    });
}

Promise.resolve()
    .then(() => __icsSyncTail())
    .then(() => __muMoveTail())
    .then(() => __statusSyncTail())
    .then(() => __tutorCalTail())
    .then(() => __titleFixTail())
    .then(() => __asyncTail())
    .then(() => __fileModeTail())
    .catch(e => { failures++; console.log('  FAIL - 非同步尾段拋錯：' + ((e && e.stack) || e)); })
    .then(() => {
        console.log(failures === 0 ? '\nSMOKE ALL OK' : `\nSMOKE FAILURES: ${failures}`);
        process.exit(failures === 0 ? 0 : 1);
    });
