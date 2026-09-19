#!/bin/sh
# macOS 一鍵本地伺服器（對應 Windows 的 serve.cmd）：雙擊本檔即可。
# 第一次若被系統擋下：在檔案上按右鍵 →「打開」；或在終端機執行 chmod +x serve.command。
# 有 Node 就用 serve.js（不快取、最省事）；沒有就用 macOS 的 python3（第一次可能會提示安裝命令列工具，按安裝即可）。
cd "$(dirname "$0")" || exit 1
PORT=5500
URL="http://127.0.0.1:$PORT/"
if command -v node >/dev/null 2>&1; then
  (sleep 1; open "$URL") &
  exec node serve.js
elif command -v python3 >/dev/null 2>&1; then
  (sleep 1; open "$URL") &
  echo "伺服器已啟動：$URL  （關閉此視窗或按 Ctrl+C 停止）"
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
else
  echo "找不到 node 或 python3，請安裝其中一個後再雙擊本檔："
  echo "  - 命令列工具（含 python3）：在終端機輸入  xcode-select --install"
  echo "  - 或 Node.js：https://nodejs.org"
  echo "按 Enter 關閉…"; read -r _
fi
