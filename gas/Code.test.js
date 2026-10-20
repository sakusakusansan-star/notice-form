// 実行: node gas/Code.test.js  （Node単体で動く。GASへ貼る前の確認用）
// お知らせシートと同じ形のモックで gas/Code.gs を検証する
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function load() {
  const g = [['投稿日時', '投稿者', '種別', '内容', '表示期限', '日程', '時間・場所', 'ID']];
  const textCells = {};   // setNumberFormat('@') された G列の行
  const sheet = {
    getDataRange: () => ({ getValues: () => g.map(r => r.slice()) }),
    getLastRow: () => g.length,
    getParent: () => ({ getSpreadsheetTimeZone: () => 'Asia/Tokyo' }),
    getRange: (r, c, nr = 1, nc = 1) => ({
      setValues: (v) => v.forEach((line, i) => line.forEach((x, j) => {
        while (g.length < r + i) g.push(new Array(8).fill(''));
        // 本物のスプレッドシートと同じく、テキスト書式でない G列の「21:30」は時刻に化ける
        const col = c + j, row = r + i;
        if (col === 7 && !textCells[row] && /^\d{1,2}:\d{2}$/.test(String(x))) {
          const [h, m] = String(x).split(':').map(Number);
          x = new Date(1899, 11, 30, h, m);
        }
        g[row - 1][col - 1] = x;
      })),
      setValue: (v) => { g[r - 1][c - 1] = v; },
      setNumberFormat: (f) => { if (c === 7 && f === '@') textCells[r] = true; }
    }),
    appendRow: (v) => g.push(v.slice()),
    deleteRow: (r) => g.splice(r - 1, 1)
  };
  const cache = {};
  let n = 0;
  global.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
  global.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  global.CacheService = { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) };
  global.ContentService = { MimeType: { JSON: 1 }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) };
  global.Utilities = {
    getUuid: () => 'uuid' + (++n) + '-xxxx',
    formatDate: (d, tz, f) => f === 'H:mm' ? d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') : '10/12'
  };
  (0, eval)(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'));
  return g;
}
const post = (body) => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).t);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('✓ ' + name); }

test('合言葉なしで投稿できる（合言葉は使わない）', () => {
  const g = load();
  assert.strictEqual(post({ action: 'create', name: '古川', text: 'x', requestId: 'n0' }).ok, true);
  assert.strictEqual(g.length, 2);
});

test('同じ送信IDの新規投稿は1件だけ作る', () => {
  const g = load();
  const body = { token: NOTICE_TOKEN, action: 'create', name: '古川', text: '明日の会議', requestId: 'r1' };
  const a = post(body), b = post(body);
  assert.ok(a.ok && b.ok);
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(g.length, 2);
  post(Object.assign({}, body, { requestId: 'r2' }));
  assert.strictEqual(g.length, 3);
});

test('更新と削除はIDの行に対して行う', () => {
  const g = load();
  const a = post({ token: NOTICE_TOKEN, action: 'create', name: 'A', text: '1件目' });
  const b = post({ token: NOTICE_TOKEN, action: 'create', name: 'B', text: '2件目' });
  assert.ok(post({ token: NOTICE_TOKEN, action: 'delete', id: a.id }).ok);
  assert.ok(post({ token: NOTICE_TOKEN, action: 'update', id: b.id, name: 'B', text: '2件目（修正）' }).ok);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[1][3], '2件目（修正）');
  assert.strictEqual(g[1][7], b.id);
});

test('一覧は合言葉なしで読め、版が付く', () => {
  load();
  post({ token: NOTICE_TOKEN, action: 'create', name: 'A', text: 'お知らせ' });
  const r = JSON.parse(doGet({ parameter: {} }).t);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, CODE_VERSION);
  assert.strictEqual(r.items.length, 1);
});

test('時間・場所は時刻に化けず、すでに化けている行も「21:30」で返す', () => {
  const g = load();
  post({ token: NOTICE_TOKEN, action: 'create', name: 'A', text: '会議', time: '21:30' });
  assert.strictEqual(g[1][6], '21:30', '新しく書く行はテキストのまま');
  // 以前の書き方で時刻に化けてしまった行
  g.push([new Date(), 'B', '会議', '前の会議', '', '', new Date(1899, 11, 30, 9, 5), 'old1']);
  const items = JSON.parse(doGet({ parameter: { mode: 'edit' } }).t).items;
  assert.deepStrictEqual(items.map(i => i.time), ['9:05', '21:30']);
});

console.log('\n' + passed + '件すべて成功');
