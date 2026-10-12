// 実行: node gas/Code.test.js  （Node単体で動く。GASへ貼る前の確認用）
// お知らせシートと同じ形のモックで gas/Code.gs を検証する
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function load() {
  const g = [['投稿日時', '投稿者', '種別', '内容', '表示期限', '日程', '時間・場所', 'ID']];
  const sheet = {
    getDataRange: () => ({ getValues: () => g.map(r => r.slice()) }),
    getRange: (r, c, nr = 1, nc = 1) => ({
      setValues: (v) => v.forEach((line, i) => line.forEach((x, j) => { g[r - 1 + i][c - 1 + j] = x; })),
      setValue: (v) => { g[r - 1][c - 1] = v; }
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
  global.Utilities = { getUuid: () => 'uuid' + (++n) + '-xxxx', formatDate: () => '10/12' };
  (0, eval)(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'));
  return g;
}
const post = (body) => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).t);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('✓ ' + name); }

test('合言葉が無い・違う投稿は受け付けない', () => {
  const g = load();
  assert.strictEqual(post({ action: 'create', name: '古川', text: 'x' }).ok, false);
  assert.strictEqual(post({ token: 'nope', action: 'create', name: '古川', text: 'x' }).ok, false);
  assert.strictEqual(g.length, 1);
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

console.log('\n' + passed + '件すべて成功');
