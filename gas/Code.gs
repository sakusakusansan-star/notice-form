/**
 * Sieg 業務ポータル ─ お知らせバックエンド（参考実装）
 *
 * すでに動いている doGet / doPost がある場合、このファイルは不要。
 * NoticeDiscord.gs だけ追加して、保存成功の直後に
 *     ndNotify('create', item);
 * を1行足せば Discord 連携は動く。
 *
 * まだバックエンドが無い／作り直す場合はこのファイルをそのまま使う。
 *
 * 【注意】このファイルは doGet / doPost / json_ を定義する。既存のバックエンドが
 * ある状態で追加すると名前がぶつかって既存側が壊れるので、その場合は追加しないこと。
 * ヘルパー（ndReadItems_ / ndSheet_ / ndHeaderMap_ など）は NoticeDiscord.gs 側にある。
 */

var COLUMNS = ['id', 'name', 'type', 'text', 'when', 'time', 'expire', 'created'];


/* ═══════════════ Web API ═══════════════ */

/**
 * GET
 *   ?mode=edit … 期限切れも含めて全件返す（投稿フォームの一覧用）
 *   （なし）    … 期限内のものだけ返す（ポータル表示用）
 */
function doGet(e) {
  try {
    var editMode = e && e.parameter && e.parameter.mode === 'edit';
    var items = ndReadItems_();

    if (!editMode) {
      var today = ndToday_();
      items = items.filter(function(it) { return !it.expire || it.expire >= today; });
    }
    return json_({ ok: true, items: items.map(publicItem_) });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/**
 * POST（Content-Type: text/plain の JSON ボディ）
 *   { action: 'create' | 'update' | 'delete', ... }
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = body.action || 'create';

    if (action === 'create') return json_(createNotice_(body));
    if (action === 'update') return json_(updateNotice_(body));
    if (action === 'delete') return json_(deleteNotice_(body));
    return json_({ ok: false, error: '不明な action: ' + action });

  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}


/* ═══════════════ 各操作 ═══════════════ */

function createNotice_(body) {
  if (!String(body.text || '').trim()) return { ok: false, error: '内容が空です' };

  var sh = ensureSheet_();
  var map = ndHeaderMap_(sh.getDataRange().getValues()[0]);

  var item = {
    id:      'n' + Date.now() + Math.floor(Math.random() * 1000),
    name:    body.name || '',
    type:    body.type || 'お知らせ',
    text:    String(body.text).trim(),
    when:    ndYmd_(body.when),
    time:    body.time || '',
    expire:  ndYmd_(body.expire),
    created: Utilities.formatDate(new Date(), ND_TZ, 'yyyy-MM-dd HH:mm:ss')
  };

  var row = new Array(sh.getLastColumn()).fill('');
  Object.keys(item).forEach(function(f) {
    if (map[f] !== undefined) row[map[f]] = item[f];
  });
  sh.appendRow(row);

  ndNotify('create', item);
  return { ok: true, id: item.id };
}

function updateNotice_(body) {
  if (!body.id) return { ok: false, error: 'id がありません' };

  var target = findItem_(body.id);
  if (!target) return { ok: false, error: '対象のお知らせが見つかりません' };

  var sh = ndSheet_();
  var map = ndHeaderMap_(sh.getDataRange().getValues()[0]);
  var updated = {
    id:     target.item.id,
    name:   body.name !== undefined ? body.name : target.item.name,
    type:   body.type !== undefined ? body.type : target.item.type,
    text:   body.text !== undefined ? String(body.text).trim() : target.item.text,
    when:   body.when !== undefined ? ndYmd_(body.when) : target.item.when,
    time:   body.time !== undefined ? body.time : target.item.time,
    expire: body.expire !== undefined ? ndYmd_(body.expire) : target.item.expire
  };

  Object.keys(updated).forEach(function(f) {
    if (map[f] !== undefined) sh.getRange(target.item._row, map[f] + 1).setValue(updated[f]);
  });

  // 日程が変わったら前日アラートの送信済み記録を消して、新しい日程で再度飛ぶようにする
  if (updated.when !== target.item.when) {
    PropertiesService.getScriptProperties().deleteProperty(ndAlertKey_(target.item));
  }

  ndNotify('update', updated);
  return { ok: true, id: updated.id };
}

function deleteNotice_(body) {
  if (!body.id) return { ok: false, error: 'id がありません' };

  var target = findItem_(body.id);
  if (!target) return { ok: false, error: '対象のお知らせが見つかりません' };

  ndSheet_().deleteRow(target.item._row);
  PropertiesService.getScriptProperties().deleteProperty(ndAlertKey_(target.item));

  ndNotify('delete', target.item);
  return { ok: true, id: body.id };
}


/* ═══════════════ 補助 ═══════════════ */

function findItem_(id) {
  var items = ndReadItems_();
  for (var i = 0; i < items.length; i++) {
    if (String(items[i].id) === String(id)) return { item: items[i] };
  }
  return null;
}

/** 見出し行が無ければ作る */
function ensureSheet_() {
  var sh = ndSheet_();
  if (sh.getLastRow() === 0) sh.appendRow(COLUMNS);
  return sh;
}

/** フロントに返す形（内部用の _row は落とす） */
function publicItem_(it) {
  return {
    id: it.id, name: it.name, type: it.type, text: it.text,
    when: it.when, time: it.time, expire: it.expire
  };
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
