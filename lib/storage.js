// lib/storage.js — localStorage 持久化與備份/遷移純函數庫（無 DOM 依賴；storageLike 可注入以便測試）
// 原則：儲存只存字串（date/time），Date 物件在渲染時重建；損壞的 JSON 不白屏，收集錯誤並回退預設。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GACStorage = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const KEYS = {
        students: 'gac_students_v2',
        legacyStudents: 'demo_music_academy_students_v1', // 舊版 key：只讀兼容，永不刪除
        lessons: 'gac_lessons_v2',
        sendlog: 'gac_sendlog_v2',
        settings: 'gac_settings_v2',
        groups: 'gac_groups_v2',      // 小組班（一個時段多個學生的一堂課）
        history: 'gac_history_v3',    // 操作快照（撤銷／還原）；不入備份
        tutors: 'gac_tutors_v3',      // 導師名單 [{name, tier}]
        rateOverrides: 'gac_rate_overrides_v3' // 費率覆寫 { 'tier|program|level|classType|duration': rate }
    };

    const DEFAULT_SETTINGS = {
        payNoShow: true,           // TODO(跟老闆確認)：NOSHOW 是否計薪，預設計入
        gcalClientId: '',          // Phase 2：Google OAuth Client ID
        gcalCalendarId: 'primary', // Phase 2：目標日曆 ID
        // 授權寫入 Google Calendar：false＝唯讀（只申請唯讀 scope；同步只拉回改動、不推送不刪；清場只清本地）
        gcalWrite: true,
        // 發送中心：點開 WhatsApp 後如何對應「已發送」（瀏覽器無法得知訊息是否真的送出）
        // 'confirm'＝標記已開啟＋切回頁面時詢問（預設）；'badge'＝只標記；'auto'＝點開即移已發送
        waSentMode: 'confirm',
        // 學費單尾段（填了才會加進訊息；FPS ID／網址屬機構資料，倉庫預設留空由用戶自填）
        fpsId: '',
        infoUrl: '',
        feeNotice: '＊如需更改上課時間，請盡早通知，如 24 小時內通知不設補堂，謝謝！',
        // 「出席與繳費」付款方式的名稱，編號 1、2、3… 對應繳費紀錄的 payMethod；清單長度不限（設定頁可增減）
        payMethods: ['現金', '轉數快 FPS', '銀行轉帳', 'PayMe', '支票'],
        // 催繳：學費單發出滿 remindDays 天仍未繳清 → 自動在發送中心建「催繳」條目（每生每月一筆）
        remindAuto: true,
        remindDays: 7,
        remindMsg: '【學費提醒】\n你好，{month} 的學費 {outstanding} 尚未收到，煩請於方便時安排繳交，謝謝！\n{fps}',
        // 收款確認：繳清即建條目；發出後自動勾上「收據」
        receiptAuto: true,
        receiptMsg: '【收款確認】\n你好，已收到 {month} 的學費 {paid}{payinfo}，謝謝！',
        // 訊息模板（設定頁「訊息模板」；留空＝用預設；佔位符見設定頁說明）。學費單中段（每個報讀項目的明細）格式固定
        tplTuitionHeader: '【學費】\n你好，以下是 {month} 的學費單：\n\n【{m}月份上堂詳情及學費】\n學生：{name}',
        tplTuitionTotal: '總額：{amount}',
        tplTuitionFooter: '＊以上收費均以每位學生計算',
        tplLeave: '已確認 {date} ({weekday}) 的課堂請假。',
        tplMakeup: '已確認 {date} ({weekday}) {time} 進行補課。',
        tplMove: '已確認 {fromDate} ({fromWeekday}) {fromTime} 的課堂改期至 {date} ({weekday}) {time} 上堂。'
    };

    // storageLike 需支援 getItem/setItem（瀏覽器傳 window.localStorage；測試傳假物件）
    function createStore(storageLike) {
        const errors = [];

        function get(key) {
            try { return storageLike.getItem(key); } catch (e) { return null; }
        }
        function set(key, value) {
            try { storageLike.setItem(key, JSON.stringify(value)); }
            catch (e) { errors.push('寫入 ' + key + ' 失敗：' + (e && e.message || e)); }
        }
        function safeParse(raw, label, fallback) {
            if (raw === null || raw === undefined || raw === '') return fallback;
            try { return JSON.parse(raw); }
            catch (e) { errors.push(label + ' 資料損壞，已回退預設值'); return fallback; }
        }

        return {
            errors: errors,
            KEYS: KEYS,
            DEFAULT_SETTINGS: DEFAULT_SETTINGS,

            // 讀新 key；沒有則兼容讀舊 key 並遷移到新 key（舊 key 保留不動）；都沒有則用預設並落盤
            loadStudents: function (defaults) {
                const rawNew = get(KEYS.students);
                if (rawNew !== null) {
                    const parsed = safeParse(rawNew, '學生資料', null);
                    if (Array.isArray(parsed)) return parsed;
                    return defaults ? defaults.slice() : [];
                }
                const rawLegacy = get(KEYS.legacyStudents);
                if (rawLegacy !== null) {
                    const parsed = safeParse(rawLegacy, '學生資料（舊版）', null);
                    if (Array.isArray(parsed)) {
                        set(KEYS.students, parsed);
                        return parsed;
                    }
                }
                const base = defaults ? defaults.slice() : [];
                set(KEYS.students, base);
                return base;
            },
            saveStudents: function (students) { set(KEYS.students, students); },

            loadLessons: function () {
                const parsed = safeParse(get(KEYS.lessons), '課堂資料', {});
                return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
            },
            saveLessons: function (buckets) { set(KEYS.lessons, buckets); },

            // 小組班：[{ id, name, program, level, duration, tutor, weekday, time, memberIds: [studentId...] }]
            loadGroups: function (defaults) {
                const raw = get(KEYS.groups);
                if (raw !== null) {
                    const parsed = safeParse(raw, '小組資料', null);
                    return Array.isArray(parsed) ? parsed : (defaults ? defaults.slice() : []);
                }
                const base = defaults ? defaults.slice() : [];
                set(KEYS.groups, base);
                return base;
            },
            saveGroups: function (groups) { set(KEYS.groups, groups); },

            loadSendlog: function () {
                const parsed = safeParse(get(KEYS.sendlog), '發送紀錄', {});
                return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
            },
            saveSendlog: function (log) { set(KEYS.sendlog, log); },

            // 歷史快照（最新在前）。快照可能很大：寫入失敗（配額）時逐筆丟最舊再試，回傳實際保存筆數
            loadHistory: function () {
                const h = safeParse(get(KEYS.history), '歷史記錄', []);
                return Array.isArray(h) ? h : [];
            },
            // 導師名單 [{name, tier}]（tier：資深導師／普通導師）；沒有則用預設並落盤；壞資料回退預設
            // 導師 {name, tier, calendarId（該導師的 Google 日曆 ID，同步時逐一讀取；留空＝預設日曆）}
            loadTutors: function (defaults) {
                const norm = function (t) {
                    return {
                        name: String(t.name).trim(), tier: t.tier === '資深導師' ? '資深導師' : '普通導師',
                        calendarId: String(t.calendarId || '').trim()
                    };
                };
                const d = (defaults || []).map(norm);
                const raw = get(KEYS.tutors);
                const arr = safeParse(raw, '導師名單', null);
                if (Array.isArray(arr)) {
                    return arr.filter(function (t) { return t && String(t.name || '').trim(); }).map(norm);
                }
                set(KEYS.tutors, d);
                return d;
            },
            saveTutors: function (list) { set(KEYS.tutors, list); },
            loadRateOverrides: function () {
                const o = safeParse(get(KEYS.rateOverrides), '費率覆寫', {});
                return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
            },
            saveRateOverrides: function (o) { set(KEYS.rateOverrides, o); },

            saveHistory: function (list) {
                let arr = (list || []).slice();
                while (arr.length) {
                    try { storageLike.setItem(KEYS.history, JSON.stringify(arr)); return arr.length; }
                    catch (e) { arr.pop(); }
                }
                try { storageLike.setItem(KEYS.history, '[]'); } catch (e) { /* 連空陣列都寫不進：放棄 */ }
                return 0;
            },

            loadSettings: function () {
                const parsed = safeParse(get(KEYS.settings), '設定', {});
                return Object.assign({}, DEFAULT_SETTINGS,
                    (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {});
            },
            saveSettings: function (settings) { set(KEYS.settings, settings); }
        };
    }

    // 全量備份 payload（students + lessons + sendlog + settings），帶 schema 版本
    function buildExportPayload(data) {
        return {
            schemaVersion: 2,
            app: 'guitaristic-academy',
            exportedAt: data.now || new Date().toISOString(),
            students: data.students || [],
            groups: data.groups || [],
            lessons: data.lessons || {},
            sendlog: data.sendlog || {},
            settings: data.settings || {},
            tutors: data.tutors || [],
            rateOverrides: data.rateOverrides || {}
        };
    }

    // 解析匯入檔：v2 全量物件（檢查 schemaVersion）或舊版純學生陣列
    function parseImportPayload(text) {
        let parsed;
        try { parsed = (typeof text === 'string') ? JSON.parse(text) : text; }
        catch (e) { return { ok: false, error: '無效的 JSON 檔案格式' }; }
        if (Array.isArray(parsed)) {
            return { ok: true, legacy: true, students: parsed, lessons: null, sendlog: null, settings: null, tutors: null, rateOverrides: null };
        }
        if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 2) {
            return {
                ok: true, legacy: false,
                students: Array.isArray(parsed.students) ? parsed.students : [],
                groups: Array.isArray(parsed.groups) ? parsed.groups : [], // 舊 v2 備份沒有此鍵 → 空
                lessons: (parsed.lessons && typeof parsed.lessons === 'object') ? parsed.lessons : {},
                sendlog: (parsed.sendlog && typeof parsed.sendlog === 'object') ? parsed.sendlog : {},
                settings: (parsed.settings && typeof parsed.settings === 'object') ? parsed.settings : {},
                tutors: Array.isArray(parsed.tutors) ? parsed.tutors : [],           // v2 備份沒有 → 空（還原時保留現有名單）
                rateOverrides: (parsed.rateOverrides && typeof parsed.rateOverrides === 'object' && !Array.isArray(parsed.rateOverrides)) ? parsed.rateOverrides : {}
            };
        }
        return { ok: false, error: '無法識別的備份格式（缺少 schemaVersion: 2）' };
    }

    return {
        KEYS: KEYS,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        createStore: createStore,
        buildExportPayload: buildExportPayload,
        parseImportPayload: parseImportPayload
    };
}));
