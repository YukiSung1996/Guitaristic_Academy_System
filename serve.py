#!/usr/bin/env python3
# 本地伺服器（Python 版，給沒有 Node 的 macOS 用；serve.command 會自動選它）。行為與 serve.js 相同：
#   - 連接埠 5500，只聽 127.0.0.1；所有檔案回 Cache-Control: no-store（改完程式不會混用舊版 JS）
#   - 資料存在「本資料夾」的 local-state.json：送出 index.html 時注入 window.__GAC_FILE_STATE，
#     頁面改動後 PUT /__state 寫回（先寫 .tmp 再改名）。每個資料夾各自一份，互不干擾。
# 只用標準庫，Python 3.7 以上可跑（macOS 命令列工具內建的 python3 即可）。
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = 'local-state.json'
PORT = 5500
MAX_BODY = 64 * 1024 * 1024
MARKER = '<script src="data.js"></script>'


def read_state(root):
    p = os.path.join(root, STATE_FILE)
    if not os.path.exists(p):
        return {}
    try:
        with open(p, 'r', encoding='utf-8') as f:
            parsed = json.load(f)
        return parsed if isinstance(parsed, dict) else {}
    except Exception as e:  # 壞檔不動它，以空狀態啟動
        print(STATE_FILE + ' 不是有效的 JSON，本次以空狀態啟動（檔案未動）：' + str(e), file=sys.stderr)
        return {}


def write_state(root, obj):
    p = os.path.join(root, STATE_FILE)
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, p)


def inject_state(html, root):
    state = json.dumps(read_state(root), ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
    store = json.dumps({'file': STATE_FILE, 'folder': os.path.basename(root)}, ensure_ascii=False, separators=(',', ':'))
    tag = '<script>window.__GAC_FILE_STATE=' + state + ';window.__GAC_FILE_STORE=' + store + ';</script>\n    '
    return html.replace(MARKER, tag + MARKER, 1) if MARKER in html else html


# Windows 的 SO_REUSEADDR 允許同一埠綁兩次（第二個伺服器靜默「成功」卻收不到連線）：關掉；macOS／Linux 保留（重啟時不被 TIME_WAIT 擋）
ThreadingHTTPServer.allow_reuse_address = os.name != 'nt'


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):  # 只記錯誤，不洗版
        if args and len(args) > 1 and str(args[1]).startswith(('4', '5')):
            super().log_message(fmt, *args)

    def _send(self, code, body=b'', ctype='application/json'):
        self.send_response(code)
        if body:
            self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/__state':
            self._send(200, json.dumps(read_state(ROOT), ensure_ascii=False).encode('utf-8'))
            return
        if path in ('/', '/index.html'):
            try:
                with open(os.path.join(ROOT, 'index.html'), 'r', encoding='utf-8') as f:
                    html = f.read()
            except OSError:
                self._send(404, b'Not found', 'text/plain')
                return
            self._send(200, inject_state(html, ROOT).encode('utf-8'), 'text/html; charset=utf-8')
            return
        super().do_GET()

    def do_PUT(self):
        if self.path.split('?', 1)[0] != '/__state':
            self._send(405)
            return
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_BODY:
                self._send(413)
                return
            parsed = json.loads(self.rfile.read(n).decode('utf-8'))
            if not isinstance(parsed, dict):
                raise ValueError('not an object')
            write_state(ROOT, parsed)
            self._send(204)
        except Exception as e:
            self._send(400, ('Bad state: ' + str(e)).encode('utf-8'), 'text/plain; charset=utf-8')

    do_POST = do_PUT

    def do_DELETE(self):
        self._send(405)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    try:
        server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    except OSError as e:
        print('連接埠 %d 已被佔用（%s）——多半已經有一個伺服器在跑（另一個 serve.command／serve.cmd 或 VS Code Live Server）。' % (port, e.strerror), file=sys.stderr)
        print('請先關掉那個再開；直接開 http://127.0.0.1:%d/ 看到的是「那個」資料夾、那個版本的檔案。' % port, file=sys.stderr)
        sys.exit(1)
    print('伺服器已啟動：http://127.0.0.1:%d/  （按 Ctrl+C 或關閉此視窗停止）' % port)
    print('服務目錄：' + ROOT)
    print('資料檔：' + os.path.join(ROOT, STATE_FILE) + '（每個資料夾各自一份；改動 0.3 秒內寫回）')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
