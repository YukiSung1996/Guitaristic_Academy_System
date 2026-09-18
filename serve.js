// 本地開發伺服器：雙擊 serve.cmd（或執行 .tools\node\node.exe serve.js）後，
// 瀏覽器開 http://127.0.0.1:5500/ 。Google OAuth（GIS）不支援 file://，必須經 http 開啟。
// 連接埠固定 5500——與 GCP「Authorized JavaScript origins」及 VS Code Live Server 預設一致，
// 換埠會變成另一個 origin：localStorage 資料看不見、Google 授權也會報 origin 不符。
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 5500;
const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.ics': 'text/calendar; charset=utf-8'
};

const server = http.createServer((req, res) => {
    try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        const file = path.normalize(path.join(root, urlPath === '/' ? '/index.html' : urlPath));
        if (!file.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
            res.writeHead(200, {
                'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-store' // 永遠給最新檔案，改完程式不用強刷
            });
            res.end(data);
        });
    } catch (e) { res.writeHead(500); res.end('Server error'); }
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error('連接埠 5500 已被佔用——多半已經有一個伺服器在跑（VS Code Live Server 或另一個 serve.cmd）。');
        console.error('直接在瀏覽器開 http://127.0.0.1:5500/ 即可，不用再啟動。');
        process.exit(1);
    }
    throw e;
});

server.listen(port, '127.0.0.1', () => {
    console.log('伺服器已啟動：http://127.0.0.1:5500/  （按 Ctrl+C 停止）');
    console.log('服務目錄：' + root);
});
