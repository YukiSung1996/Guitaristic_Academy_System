// System State
        let studentDatabase = [];
        let generatedLessons = [];      // 單一學生頁籤的臨時預覽（不持久化）
        let lessonsByMonth = {};        // gac_lessons_v2：{ "2026-09": [lesson, ...] }，v2 課表唯一事實來源
        let sendLog = {};               // gac_sendlog_v2：發送中心紀錄
        let appSettings = {};           // gac_settings_v2：設定
        let gacStore = null;            // lib/storage.js 的 store 實例（window.onload 時建立）
        let currentViewMode = 'list';
        let monthWeeksData = [];
        let manualMode = false;         // 手動模式：跳過狀態機限制、不觸發小組聯動（每次載入預設關閉，防誤觸）
        let pendingWaConfirmKeys = [];  // 發送中心：點開 WhatsApp 後待「切回頁面時詢問是否已發」的條目 key（waSentMode='confirm'）
