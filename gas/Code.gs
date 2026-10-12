// ═══════════════════════════════════════════
//  Sieg お知らせボード GAS
//  1. 新しいスプレッドシートを作成し、IDを下に貼る
//  2. setup() を1回実行（ヘッダー作成）※既存シートがある場合も再実行でOK（ID列が追加されます）
//  3. デプロイ → ウェブアプリ →「全員（匿名含む）」で公開
//  4. デプロイURLを index.html と notice-form の NOTICE_API に貼る
// ═══════════════════════════════════════════

var SHEET_ID = '1DSIXZlzmXgudaWpnjEKwTCgCd94ND9oyq6wcaHC-zfM';
var SHEET_NAME = 'お知らせ';

// 合言葉。notice-form の NOTICE_TOKEN と同じ文字列にする。
// 投稿・更新・削除のときだけ確かめる（ポータルの一覧表示は合言葉なしで読める）。
// ページのソースを見れば読めるので本格的な認証ではないが、URLだけ知った人が
// 投稿を書き換えたり消したりするのを防ぐ。
var NOTICE_TOKEN = 'sieg-notice-2026';

// コードの版。/exec をブラウザで開くと表示されるので、再デプロイが反映されたかの確認に使う。
var CODE_VERSION = '2026-10-12b';

// 新規投稿の送信IDを覚えておく時間（秒）。同じIDの投稿はこの間、二重に作らない。
var DEDUPE_SEC = 21600;

function setup() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  sheet.getRange(1, 1, 1, 8).setValues([[
    '投稿日時', '投稿者', '種別', '内容', '表示期限', '日程', '時間・場所', 'ID'
  ]]);
  sheet.setFrozenRows(1);
}

function getSheet_() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function newId_() {
  return Utilities.getUuid().slice(0, 8);
}

// 既存行にIDが無ければ振る（旧データ互換用）
function ensureId_(sheet, rowIndex, row) {
  if (row[7]) return String(row[7]);
  var id = newId_();
  sheet.getRange(rowIndex + 1, 8).setValue(id);
  return id;
}

// ─── 一覧取得 ───
//   通常（ポータル表示用）      : 期限切れ除外・最大8件・新しい順
//   ?mode=edit（フォーム編集用）: 期限切れ含む全件・最大30件・新しい順
function doGet(e) {
  try {
    var mode = (e && e.parameter && e.parameter.mode) || '';
    var sheet = getSheet_();
    var data = sheet.getDataRange().getValues();
    var now = new Date();
    var items = [];
    var limit = mode === 'edit' ? 30 : 8;
    var tz = sheet.getParent().getSpreadsheetTimeZone() || 'Asia/Tokyo';

    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      if (!row[3]) continue;

      if (mode !== 'edit' && row[4]) {
        var exp = new Date(row[4]);
        exp.setHours(23, 59, 59, 999);
        if (exp < now) continue;
      }

      var d = new Date(row[0]);
      var item = {
        id: ensureId_(sheet, i, row),
        date: Utilities.formatDate(d, 'Asia/Tokyo', 'M/d'),
        name: String(row[1] || ''),
        type: String(row[2] || 'お知らせ'),
        text: String(row[3]),
        expire: row[4] ? Utilities.formatDate(new Date(row[4]), 'Asia/Tokyo', 'yyyy-MM-dd') : ''
      };

      if (row[5]) {
        var w = new Date(row[5]);
        if (!isNaN(w.getTime())) {
          var youbi = ['日', '月', '火', '水', '木', '金', '土'][w.getDay()];
          item.when = Utilities.formatDate(w, 'Asia/Tokyo', mode === 'edit' ? 'yyyy-MM-dd' : 'M/d');
          item.youbi = youbi;
        }
      }
      if (row[6]) item.time = timeText_(row[6], tz);

      items.push(item);
      if (items.length >= limit) break;
    }

    return json_({ ok: true, version: CODE_VERSION, items: items });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 「時間・場所」の欄を文字にする。
// 「21:30」とだけ入れるとスプレッドシートが時刻と見なし、日付つきの値
// （1899年12月30日 21:30）として返ってくるので、時刻の部分だけを取り出す。
function timeText_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz || 'Asia/Tokyo', 'H:mm');
  }
  return String(v);
}

// 書き込む行の「時間・場所」（G列）を書式なしテキストにしておく。
// こうしないと「21:30」が時刻に変換され、Discord通知やポータルの表示が崩れる。
function keepTimeAsText_(sheet, row) {
  sheet.getRange(row, 7).setNumberFormat('@');
}

// 指定IDの行番号（1始まり・シート上の行）を探す。見つからなければ0
function findRowById_(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][7]) === String(id)) return i + 1;
  }
  return 0;
}

// ─── 投稿・更新・削除（notice-form から送信）───
// 削除で行が詰まっている最中に別の投稿が行番号を探すと、違う行を書き換えるため、
// 1件ずつ順番に処理する。
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var p = JSON.parse(e.postData.contents);
    if (NOTICE_TOKEN && String(p.token || '') !== NOTICE_TOKEN) {
      return json_({ ok: false, error: '合言葉が違います（ページを読み込み直してください）' });
    }
    if (!lock.tryLock(25000)) {
      lock = null;
      return json_({ ok: false, error: 'ほかの人の投稿を処理中です。少し待ってからもう一度お試しください' });
    }
    return json_(handlePost_(p));
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (ignore) {} }
  }
}

function handlePost_(p) {
  var action = p.action || 'create';
  var sheet = getSheet_();

  // ─── 削除 ───
  if (action === 'delete') {
    if (!p.id) return { ok: false, error: 'IDがありません' };
    var rowToDelete = findRowById_(sheet, p.id);
    if (!rowToDelete) return { ok: false, error: '対象のお知らせが見つかりません' };
    sheet.deleteRow(rowToDelete);
    return { ok: true };
  }

  if (!p.text || !String(p.text).trim()) {
    return { ok: false, error: '内容が空です' };
  }

  var values = [
    new Date(),
    String(p.name || ''),
    String(p.type || 'お知らせ'),
    String(p.text).trim(),
    p.expire ? String(p.expire) : '',
    p.when ? String(p.when) : '',
    p.time ? String(p.time).trim() : ''
  ];

  // ─── 更新 ───
  if (action === 'update' && p.id) {
    var rowToUpdate = findRowById_(sheet, p.id);
    if (!rowToUpdate) return { ok: false, error: '対象のお知らせが見つかりません' };
    // 投稿日時（1列目）は元の値を保持、2〜7列目のみ更新
    keepTimeAsText_(sheet, rowToUpdate);
    sheet.getRange(rowToUpdate, 2, 1, 6).setValues([values.slice(1)]);
    sheet.getRange(rowToUpdate, 8).setValue(p.id); // ID保持
    return { ok: true, id: p.id };
  }

  // ─── 新規作成 ───
  // 通信が途中で切れて送り直されたときに同じお知らせを2件作らないよう、
  // 同じ送信IDが来たら前回の結果を返す。
  var requestId = String(p.requestId || '').slice(0, 100);
  var cache = CacheService.getScriptCache();
  if (requestId) {
    var done = cache.get('notice:' + requestId);
    if (done) return JSON.parse(done);
  }
  var id = newId_();
  values.push(id);
  // appendRow だと書き込みと同時に時刻へ変換されるので、先にG列をテキストにしてから書く
  // （doPost でロックを取っているので、ほかの投稿と行が重なることはない）
  var newRow = sheet.getLastRow() + 1;
  keepTimeAsText_(sheet, newRow);
  sheet.getRange(newRow, 1, 1, values.length).setValues([values]);
  var res = { ok: true, id: id };
  if (requestId) {
    try { cache.put('notice:' + requestId, JSON.stringify(res), DEDUPE_SEC); } catch (ignore) {}
  }
  return res;
}
