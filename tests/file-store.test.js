'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ST = require('../lib/storage.js');
const serve = require('../serve.js');

test('createFileBackedStorage：讀寫在記憶體、改動合併延遲寫回、失敗回報並保留、flush 等到寫完', async () => {
    const saves = [];
    let fail = false;
    const s = ST.createFileBackedStorage({ a: '1', junk: 5 }, obj => { if (fail) return Promise.reject(new Error('boom')); saves.push(obj); return Promise.resolve(); }, { delay: 5 });
    assert.strictEqual(s.getItem('a'), '1');
    assert.strictEqual(s.getItem('junk'), null, '非字串值不收');
    assert.strictEqual(s.length, 1);
    s.setItem('b', 'x'); s.setItem('c', 'y'); s.removeItem('a');
    assert.ok(s.hasPending());
    await new Promise(r => setTimeout(r, 40));
    assert.deepStrictEqual(saves, [{ b: 'x', c: 'y' }], '三個改動合併成一次寫回');
    assert.ok(!s.hasPending());
    fail = true;
    const errs = [];
    s.onError = e => errs.push(e.message);
    s.setItem('d', 'z');
    await s.flush();
    assert.deepStrictEqual(errs, ['boom']);
    assert.strictEqual(s.lastError.message, 'boom');
    fail = false;
    s.setItem('e', 'w');
    await s.flush();
    assert.strictEqual(saves.length, 2);
    assert.deepStrictEqual(saves[1], { b: 'x', c: 'y', d: 'z', e: 'w' }, '失敗那次的改動沒丟，下一次一併寫回');
    assert.strictEqual(s.lastError, null);
    assert.strictEqual(s.key(0), 'b');
    assert.strictEqual(s.key(9), null);
});

test('createFileBackedStorage：寫回進行中又有改動 → 寫完再寫一次，最後狀態一定落地', async () => {
    const saves = [];
    let release = null, n = 0;
    const s = ST.createFileBackedStorage({}, obj => { saves.push(obj); return n++ === 0 ? new Promise(r => { release = r; }) : Promise.resolve(); }, { delay: 1 });
    s.setItem('k', '1');
    const p = s.flush();
    await new Promise(r => setImmediate(r)); // 第一次寫回已開始（拿到 release）
    s.setItem('k', '2');                     // 寫回進行中的改動
    release();
    await p;
    await s.flush();                         // 沒改動就不會多寫一次
    assert.deepStrictEqual(saves, [{ k: '1' }, { k: '2' }]);
    assert.ok(!s.hasPending());
    await s.flush();
    assert.strictEqual(saves.length, 2, '沒有新改動 → flush 不寫');
});

test('pickStorage：有注入 → 檔案後備（掛在 win.__GAC_FILE_STORAGE）；沒有 → localStorage', () => {
    const ls = { getItem() { return null; }, setItem() {} };
    assert.strictEqual(ST.pickStorage({ localStorage: ls }), ls);
    const win = { localStorage: ls, __GAC_FILE_STATE: { gac_students_v2: '[]' }, __GAC_FILE_STORE: { file: 'local-state.json', folder: 'x', save: () => Promise.resolve() } };
    const s = ST.pickStorage(win);
    assert.ok(s.isFileBacked);
    assert.strictEqual(win.__GAC_FILE_STORAGE, s);
    assert.strictEqual(s.getItem('gac_students_v2'), '[]');
    assert.strictEqual(ST.createStore(s).loadStudents([{ id: 'X' }]).length, 0, 'createStore 直接沿用');
});

test('fileSaver：PUT /__state、JSON 本文、小本文 keepalive；非 2xx 視為失敗', async () => {
    const calls = [];
    const save = ST.fileSaver({ fetch: (url, o) => { calls.push({ url, o }); return Promise.resolve({ ok: true }); } });
    await save({ a: '1' });
    assert.strictEqual(calls[0].url, '/__state');
    assert.strictEqual(calls[0].o.method, 'PUT');
    assert.strictEqual(calls[0].o.body, '{"a":"1"}');
    assert.strictEqual(calls[0].o.keepalive, true);
    await assert.rejects(ST.fileSaver({ fetch: () => Promise.resolve({ ok: false, status: 500 }) })({}), /HTTP 500/);
});

test('serve.js：/__state 讀寫本資料夾 local-state.json（先 .tmp 再改名）；index.html 注入狀態（跳脫 </script>）；壞 JSON 拒收；壞檔以空狀態啟動', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-serve-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><head></head><body>\n    <script src="data.js"></script>\n</body></html>');
    const server = serve.createServer(root);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        assert.deepStrictEqual(await (await fetch(base + '/__state')).json(), {});
        let html = await (await fetch(base + '/')).text();
        assert.ok(html.includes('window.__GAC_FILE_STATE={};'), '沒有檔案 → 注入空狀態');
        assert.ok(html.includes('"folder":"' + path.basename(root) + '"') || html.includes('folder:"' + path.basename(root) + '"'));
        assert.ok(html.indexOf('__GAC_FILE_STATE') < html.indexOf('<script src="data.js">'), '注在 data.js 之前');
        const state = { gac_students_v2: '[{"id":"S1"}]', x: '</script><b>' };
        const put = await fetch(base + '/__state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
        assert.strictEqual(put.status, 204);
        assert.ok(fs.existsSync(path.join(root, serve.STATE_FILE)));
        assert.ok(!fs.existsSync(path.join(root, serve.STATE_FILE + '.tmp')));
        assert.deepStrictEqual(await (await fetch(base + '/__state')).json(), state);
        html = await (await fetch(base + '/index.html')).text();
        assert.ok(html.includes('S1'));
        assert.ok(!html.includes('</script><b>'), '狀態裡的 </script> 已跳脫');
        assert.ok(html.includes('\\u003c/script>'));
        assert.strictEqual((await fetch(base + '/__state', { method: 'PUT', body: '[1,2]' })).status, 400);
        assert.strictEqual((await fetch(base + '/__state', { method: 'PUT', body: '{oops' })).status, 400);
        assert.deepStrictEqual(await (await fetch(base + '/__state')).json(), state, '拒收的沒有覆蓋原檔');
        assert.strictEqual((await fetch(base + '/__state', { method: 'DELETE' })).status, 405);
        fs.writeFileSync(path.join(root, serve.STATE_FILE), 'garbage');
        assert.deepStrictEqual(serve.readState(root), {}, '壞檔 → 空狀態');
        assert.strictEqual(fs.readFileSync(path.join(root, serve.STATE_FILE), 'utf8'), 'garbage', '壞檔不動');
    } finally {
        await new Promise(r => server.close(r));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
