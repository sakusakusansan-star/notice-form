// ═══════════════════════════════════════════
//  Sieg お知らせボード GAS
//  1. 新しいスプレッドシートを作成し、IDを下に貼る
//  2. setup() を1回実行（ヘッダー作成）※既存シートがある場合も再実行でOK（ID列が追加されます）
//  3. デプロイ → ウェブアプリ →「全員（匿名含む）」で公開
//  4. デプロイURLを index.html と notice-form の NOTICE_API に貼る
// ═══════════════════════════════════════════

var SHEET_ID = '1DSIXZlzmXgudaWpnjEKwTCgCd94ND9oyq6wcaHC-zfM';
var SHEET_NAME = 'お知らせ';

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
      if (row[6]) item.time = String(row[6]);

      items.push(item);
      if (items.length >= limit) break;
    }

    return json_({ ok: true, items: items });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
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
function doPost(e) {
  try {
    var p = JSON.parse(e.postData.contents);
    var action = p.action || 'create';
    var sheet = getSheet_();

    // ─── 削除 ───
    if (action === 'delete') {
      if (!p.id) return json_({ ok: false, error: 'IDがありません' });
      var rowToDelete = findRowById_(sheet, p.id);
      if (!rowToDelete) return json_({ ok: false, error: '対象のお知らせが見つかりません' });
      sheet.deleteRow(rowToDelete);
      return json_({ ok: true });
    }

    if (!p.text || !String(p.text).trim()) {
      return json_({ ok: false, error: '内容が空です' });
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
      if (!rowToUpdate) return json_({ ok: false, error: '対象のお知らせが見つかりません' });
      // 投稿日時（1列目）は元の値を保持、2〜7列目のみ更新
      sheet.getRange(rowToUpdate, 2, 1, 6).setValues([values.slice(1)]);
      sheet.getRange(rowToUpdate, 8).setValue(p.id); // ID保持
      return json_({ ok: true, id: p.id });
    }

    // ─── 新規作成 ───
    var id = newId_();
    values.push(id);
    sheet.appendRow(values);
    return json_({ ok: true, id: id });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}
