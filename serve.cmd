@echo off
REM 本地開發伺服器：雙擊本檔即可（Google OAuth 需經 http 開啟，直接雙擊 index.html 的 file:// 不行）
REM 啟動後自動開瀏覽器 http://127.0.0.1:5500/ ；關閉：在本視窗按 Ctrl+C 或直接關窗
start "" http://127.0.0.1:5500/
"D:\local_storagge\codes\Guitar_sys\Guitaristic_Academy_System_merged_sanitized\.tools\node\node.exe" "%~dp0serve.js"
pause
