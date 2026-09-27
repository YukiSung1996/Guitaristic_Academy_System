#!/bin/sh
# macOS 一鍵本地伺服器（對應 Windows 的 serve.cmd）：雙擊本檔即可。
# 第一次若被系統擋下：在檔案上按右鍵 →「打開」；或在終端機執行 chmod +x serve.command。
# 有 Node 就用 serve.js，沒有就用 python3 跑 serve.py（第一次可能會提示安裝命令列工具，按安裝即可）。
# 兩者行為相同：不快取（改完程式不會混用舊版 JS）；資料存在本資料夾的 local-state.json，每個資料夾各自一份。
cd "$(dirname "$0")" || exit 1
PORT=5500
URL="http://127.0.0.1:$PORT/"

pause_close() { echo ""; echo "按 Enter 關閉此視窗…"; read -r _; }

# 5500 已被佔用（多半是上一次的 serve.command 還開著、另一個資料夾的伺服器，或 VS Code Live Server）：
# 不處理的話新伺服器起不來，瀏覽器連到的是「那個」伺服器——別的資料夾或舊版檔案，頁面可能整個沒反應
PIDS=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "連接埠 $PORT 已被下列程式佔用："
  for p in $PIDS; do
    echo "  PID $p：$(ps -o command= -p "$p" 2>/dev/null)"
  done
  echo ""
  echo "要關掉它、改開本資料夾嗎？"
  echo "  按 Enter ＝ 關掉上面的程式並啟動本資料夾的伺服器"
  echo "  直接關閉此視窗 ＝ 什麼都不做"
  read -r _
  kill $PIDS 2>/dev/null
  i=0
  while [ $i -lt 20 ] && lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1; do sleep 0.25; i=$((i+1)); done
  if lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "關不掉（可能是別的使用者或 VS Code 開的）。請手動關掉它：VS Code 右下角按「Port : 5500」停止 Live Server，或在終端機執行："
    echo "  kill -9 $PIDS"
    pause_close; exit 1
  fi
  echo "已關閉舊的伺服器。"
fi

if command -v node >/dev/null 2>&1; then
  RUN="node serve.js"
elif command -v python3 >/dev/null 2>&1; then
  RUN="python3 serve.py"
else
  echo "找不到 node 或 python3，請安裝其中一個後再雙擊本檔："
  echo "  - 命令列工具（含 python3）：在終端機輸入  xcode-select --install"
  echo "  - 或 Node.js：https://nodejs.org"
  pause_close; exit 1
fi

(sleep 1; open "$URL") &
$RUN
# 伺服器結束（出錯或 Ctrl+C）：視窗留著讓人看清楚訊息
pause_close
