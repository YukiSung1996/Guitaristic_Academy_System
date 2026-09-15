@echo off
rem 跑全部單元測試。使用 .tools\node 內的便攜版 Node（不需系統安裝）。
rem 若已安裝系統 Node，也可直接執行: node --test "tests/*.test.js"
setlocal
set NODE=%~dp0.tools\node\node.exe
if not exist "%NODE%" (
    where node >nul 2>nul
    if errorlevel 1 (
        echo [!] 找不到 %NODE%，系統也沒有安裝 Node。
        echo     請把便攜版 Node 解壓到 .tools\node\ 或安裝 Node.js 後重試。
        exit /b 1
    )
    set NODE=node
)
"%NODE%" --test "tests/*.test.js"
