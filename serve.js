// 本地開發伺服器：雙擊 serve.cmd（或執行 .tools\node\node.exe serve.js）後，
// 瀏覽器開 http://127.0.0.1:5500/ 。Google OAuth（GIS）不支援 file://，必須經 http 開啟。
// 連接埠固定 5500——與 GCP「Authorized JavaScript origins」及 VS Code Live Server 預設一致，換埠 Google 授權會報 origin 不符。
//
// 資料存放：頁面的資料（名單／課表／設定／撤銷快照／薪酬調整）存在「本資料夾」的 local-state.json，不存瀏覽器 localStorage——
// 所以每個資料夾各自一份，開哪個資料夾就是哪個資料夾上次的狀態，不會帶著另一個資料夾的操作。
// 做法：送出 index.html 時把 local-state.json 的內容注進頁面（window.__GAC_FILE_STATE），
// 頁面每次改動 0.3 秒內合併成一次 PUT /__state 寫回（先寫 .tmp 再改名，不會寫壞）。
// 用 VS Code Live Server 等別的伺服器開，沒有這個注入，頁面就退回瀏覽器 localStorage（同網址的資料夾共用）。
const http = require('http');
const fs = require('fs');
const path = require('path');

const STATE_FILE = 'local-state.json';
const MAX_BODY = 64 * 1024 * 1024;
const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.ics': 'text/calendar; charset=utf-8'
};

// 讀本資料夾的狀態檔；沒有＝空狀態；壞掉的 JSON 不動它，以空狀態啟動並在主控台說明
function readState(root) {
    const p = path.join(root, STATE_FILE);
    if (!fs.existsSync(p)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
        console.error(STATE_FILE + ' 不是有效的 JSON，本次以空狀態啟動（檔案未動）：' + e.message);
        return {};
    }
}

// 先寫 .tmp 再改名：寫到一半斷電也不會留下半個檔
function writeState(root, obj) {
    const p = path.join(root, STATE_FILE), tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, p);
}

// 在 data.js 之前放一段 <script>：本資料夾的狀態與資料夾名，頁面（lib/storage.js pickStorage）據此改用檔案存放
function injectState(html, root) {
    const json = JSON.stringify(readState(root)).replace(/</g, '\\u003c');
    const tag = '<script>window.__GAC_FILE_STATE=' + json + ';window.__GAC_FILE_STORE={file:' + JSON.stringify(STATE_FILE) + ',folder:' + JSON.stringify(path.basename(root)) + '};</script>\n    ';
    const marker = '<script src="data.js"></script>';
    return html.includes(marker) ? html.replace(marker, tag + marker) : html;
}

function handleState(req, res, root) {
    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(readState(root)));
        return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
        const chunks = [];
        let size = 0, tooBig = false;
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) { tooBig = true; req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (tooBig) return;
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
                writeState(root, parsed);
                res.writeHead(204);
                res.end();
            } catch (e) { res.writeHead(400); res.end('Bad state: ' + e.message); }
        });
        return;
    }
    res.writeHead(405);
    res.end();
}

function createServer(root) {
    root = path.resolve(root); // 正規化（呼叫方給 / 或相對路徑也行；下面用 startsWith 擋路徑穿越）
    return http.createServer((req, res) => {
        try {
            const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
            if (urlPath === '/__state') { handleState(req, res, root); return; }
            const file = path.normalize(path.join(root, urlPath === '/' ? '/index.html' : urlPath));
            if (!file.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
            fs.readFile(file, (err, data) => {
                if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
                res.writeHead(200, {
                    'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
                    'Cache-Control': 'no-store' // 永遠給最新檔案，改完程式不用強刷
                });
                res.end(path.basename(file).toLowerCase() === 'index.html' ? injectState(data.toString('utf8'), root) : data);
            });
        } catch (e) { res.writeHead(500); res.end('Server error'); }
    });
}

module.exports = { createServer, readState, writeState, injectState, STATE_FILE };

if (require.main === module) {
    const root = __dirname;
    const port = 5500;
    const server = createServer(root);
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error('連接埠 5500 已被佔用——多半已經有一個伺服器在跑（VS Code Live Server 或另一個資料夾的 serve.cmd）。');
            console.error('要開這個資料夾，請先關掉那個；直接開 http://127.0.0.1:5500/ 看到的是「那個」資料夾的資料。');
            process.exit(1);
        }
        throw e;
    });
    server.listen(port, '127.0.0.1', () => {
        console.log('伺服器已啟動：http://127.0.0.1:5500/  （按 Ctrl+C 停止）');
        console.log('服務目錄：' + root);
        console.log('資料檔：' + path.join(root, STATE_FILE) + '（每個資料夾各自一份；改動 0.3 秒內寫回）');
    });
}
