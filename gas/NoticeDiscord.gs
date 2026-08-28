/**
 * Sieg 業務ポータル ─ お知らせ Discord 連携
 *
 * このファイル1枚で以下ができます。
 *   1. お知らせが投稿／更新／削除されたら Discord に自動で飛ばす
 *   2. 日程（when）の前日になったら Discord にアラートを飛ばす
 *
 * 導入手順は gas/SETUP.md を参照。
 */

/* ═══════════════ 設定 ═══════════════ */

// Webhook URL は「プロジェクトの設定 → スクリプト プロパティ」に
// DISCORD_WEBHOOK_URL という名前で登録する。コードには書かないこと。
var PROP_WEBHOOK = 'DISCORD_WEBHOOK_URL';

// お知らせを保存しているシート名。空文字なら先頭シートを使う
var SHEET_NAME = '';

var TZ = 'Asia/Tokyo';

// 前日アラートに付けるメンション（不要なら '' にする）
var ALERT_MENTION = '@here';

// 種別「重要」の投稿にもメンションを付けるか
var MENTION_IMPORTANT = true;

// 前日アラートを送る時刻（0〜23、JST）
var ALERT_HOUR = 9;

// 種別ごとの色（Discord embed）
var TYPE_COLOR = {
  'お知らせ': 0xE8A33D,
  '会議':     0x4C9BD9,
  '重要':     0xE86A5A
};

// シートの見出し行から列を探すときの候補名
var FIELD_ALIASES = {
  id:      ['id', 'ID'],
  name:    ['name', '投稿者', '名前'],
  type:    ['type', '種別'],
  text:    ['text', '内容', '本文', 'メッセージ'],
  when:    ['when', '日程', '日付'],
  time:    ['time', '時間', '時間・場所', '場所'],
  expire:  ['expire', '表示期限', '期限'],
  created: ['created', '投稿日時', 'timestamp', 'タイムスタンプ']
};


/* ═══════════════ 公開関数 ═══════════════ */

/**
 * お知らせを Discord に通知する。
 * 既存の doPost から、保存が成功した直後に呼ぶ。
 *
 *   notifyDiscord('create', item);   // 新規投稿
 *   notifyDiscord('update', item);   // 更新
 *   notifyDiscord('delete', item);   // 削除
 *
 * item は { id, name, type, text, when, time, expire } の形。
 * 通信に失敗しても投稿処理は止めない（例外を投げない）。
 */
function notifyDiscord(kind, item) {
  sendNotice_(kind, item);

  // 送信済みとして監視側の記録に反映させ、
  // watchNotices() が同じ内容をもう一度通知しないようにする。
  if (typeof snapshotSync_ !== 'function') return;  // NoticeWatch.gs 未導入
  try {
    snapshotSync_(kind, item);
  } catch (err) {
    console.error('snapshotSync_ failed: ' + err);
  }
}

/**
 * 実際に Discord へ 1 件送る。監視側からもここを呼ぶ。
 */
function sendNotice_(kind, item) {
  try {
    var titles = {
      create: '📢 新しいお知らせ',
      update: '✏️ お知らせが更新されました',
      'delete': '🗑️ お知らせが削除されました'
    };
    var payload = { embeds: [noticeEmbed_(item, titles[kind] || titles.create)] };

    if (MENTION_IMPORTANT && kind !== 'delete' && item && item.type === '重要' && ALERT_MENTION) {
      payload.content = ALERT_MENTION;
    }
    postDiscord_(payload);
  } catch (err) {
    console.error('notifyDiscord failed: ' + err);
  }
}

/**
 * 前日アラート。1日1回のトリガーから呼ばれる。
 * 日程（when）が「明日」のお知らせをまとめて Discord に流す。
 * 同じお知らせを二重に通知しないよう、送信済みは記録しておく。
 */
function dailyAlert() {
  var props = PropertiesService.getScriptProperties();
  var tomorrow = shiftDays_(todayYmd_(), 1);

  var targets = readItems_().filter(function(it) {
    if (!it.when || it.when !== tomorrow) return false;
    return !props.getProperty(alertKey_(it));
  });
  if (!targets.length) return;

  var payload = {
    embeds: targets.slice(0, 10).map(function(it) {
      return noticeEmbed_(it, '⏰ 【前日アラート】明日の予定');
    })
  };
  var head = '明日 ' + jpDate_(tomorrow) + ' の予定が ' + targets.length + ' 件あります';
  payload.content = (ALERT_MENTION ? ALERT_MENTION + ' ' : '') + head;

  // 送信できたときだけ「送信済み」にする。
  // 失敗したまま記録すると、翌日の実行で再送されなくなってしまう。
  if (!postDiscord_(payload)) {
    console.error('前日アラートの送信に失敗しました。次回の実行で再送します');
    return;
  }

  targets.forEach(function(it) { props.setProperty(alertKey_(it), '1'); });
  pruneAlertKeys_();
}

/**
 * トリガーを作り直す。導入時に1回だけ手動実行する。
 *
 *   dailyAlert    … 毎日 ALERT_HOUR 時に前日アラート
 *   watchNotices  … WATCH_INTERVAL_MINUTES 分ごとにシートを見張って投稿を通知
 *
 * 何度実行しても重複しない（同名のトリガーを消してから作り直す）。
 */
function setupTriggers() {
  var handlers = ['dailyAlert', 'watchNotices'];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('dailyAlert')
    .timeBased()
    .atHour(ALERT_HOUR)
    .everyDays(1)
    .inTimezone(TZ)
    .create();
  console.log('毎日 ' + ALERT_HOUR + ':00（' + TZ + '）に dailyAlert を実行します');

  // NoticeWatch.gs を入れていない場合は監視トリガーを作らない
  if (typeof watchNotices !== 'function') {
    console.log('NoticeWatch.gs が無いため、投稿の自動通知は doPost 側の notifyDiscord() に任せます');
    return;
  }

  ScriptApp.newTrigger('watchNotices')
    .timeBased()
    .everyMinutes(WATCH_INTERVAL_MINUTES)
    .create();
  console.log(WATCH_INTERVAL_MINUTES + ' 分ごとに watchNotices を実行します');

  // 初回の記録を今ここで作っておく（既存のお知らせが一斉通知されるのを防ぐ）
  watchNotices();
}

/**
 * 動作確認用。手動実行すると Discord にテスト投稿が1件飛ぶ。
 */
function testDiscord() {
  notifyDiscord('create', {
    id: 'test',
    name: 'テスト',
    type: 'お知らせ',
    text: 'Discord 連携のテストです。これが見えていれば設定は完了しています。',
    when: shiftDays_(todayYmd_(), 1),
    time: '10:00〜 本社2F',
    expire: shiftDays_(todayYmd_(), 14)
  });
}

/**
 * 動作確認用。明日の予定に対する前日アラートを、送信済み記録を無視して1回流す。
 */
function testDailyAlert() {
  var props = PropertiesService.getScriptProperties();
  var tomorrow = shiftDays_(todayYmd_(), 1);
  readItems_().forEach(function(it) {
    if (it.when === tomorrow) props.deleteProperty(alertKey_(it));
  });
  dailyAlert();
}


/* ═══════════════ Discord 送信 ═══════════════ */

/** 送信できたら true、できなかったら false を返す */
function postDiscord_(payload) {
  var url = PropertiesService.getScriptProperties().getProperty(PROP_WEBHOOK);
  if (!url) {
    console.warn('スクリプトプロパティ ' + PROP_WEBHOOK + ' が未設定のため送信をスキップしました');
    return false;
  }
  if (ALERT_MENTION) {
    payload.allowed_mentions = { parse: ['everyone', 'roles', 'users'] };
  }
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('Discord 送信失敗 (' + code + '): ' + res.getContentText());
    return false;
  }
  return true;
}

function noticeEmbed_(item, title) {
  item = item || {};
  var fields = [];
  if (item.name) fields.push({ name: '投稿者', value: String(item.name), inline: true });
  if (item.type) fields.push({ name: '種別',   value: String(item.type), inline: true });

  var when = whenLabel_(item);
  if (when) fields.push({ name: '日程', value: when, inline: false });
  if (item.expire) fields.push({ name: '表示期限', value: jpDate_(item.expire), inline: true });

  return {
    title: title,
    description: String(item.text || '（本文なし）').slice(0, 3900),
    color: TYPE_COLOR[item.type] || TYPE_COLOR['お知らせ'],
    fields: fields,
    footer: { text: 'SIEG OPS BOARD' },
    timestamp: new Date().toISOString()
  };
}

function whenLabel_(item) {
  var parts = [];
  if (item.when) parts.push(jpDate_(item.when));
  if (item.time) parts.push(String(item.time));
  return parts.join('　');
}


/* ═══════════════ シート読み取り ═══════════════ */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : null;
  return sh || ss.getSheets()[0];
}

/** 見出し行から { フィールド名: 列番号(0始まり) } を作る */
function headerMap_(header) {
  var map = {};
  var norm = header.map(function(h) { return String(h).trim().toLowerCase(); });
  Object.keys(FIELD_ALIASES).forEach(function(field) {
    FIELD_ALIASES[field].some(function(alias) {
      var i = norm.indexOf(String(alias).toLowerCase());
      if (i >= 0) { map[field] = i; return true; }
      return false;
    });
  });
  return map;
}

/** シート全件を { id, name, type, text, when, time, expire, _row } の配列で返す */
function readItems_() {
  var values = getSheet_().getDataRange().getValues();
  if (values.length < 2) return [];
  var map = headerMap_(values[0]);
  var items = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row.join('').trim()) continue;
    items.push(rowToItem_(row, map, i + 1));
  }
  return items;
}

function rowToItem_(row, map, rowNumber) {
  var item = { _row: rowNumber };
  Object.keys(FIELD_ALIASES).forEach(function(field) {
    if (map[field] === undefined) { item[field] = ''; return; }
    var v = row[map[field]];
    item[field] = (field === 'when' || field === 'expire') ? toYmd_(v) : (v === null ? '' : v);
  });
  return item;
}


/* ═══════════════ 日付ユーティリティ ═══════════════ */

function todayYmd_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/** Date でも文字列でも 'yyyy-MM-dd' に正規化する */
function toYmd_(v) {
  if (!v && v !== 0) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!m) return s;
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

/**
 * 'yyyy-MM-dd' を Date にする。
 * スクリプトのタイムゾーン設定でズレないよう、正午で組み立てる。
 */
function parseYmd_(ymd) {
  var m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

function formatYmd_(d) {
  return d.getFullYear() + '-' +
    ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
    ('0' + d.getDate()).slice(-2);
}

function shiftDays_(ymd, days) {
  var d = parseYmd_(ymd);
  if (!d) return ymd;
  d.setDate(d.getDate() + days);
  return formatYmd_(d);
}

function jpDate_(ymd) {
  var d = parseYmd_(toYmd_(ymd));
  if (!d) return String(ymd);
  var w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日（' + w + '）';
}


/* ═══════════════ 送信済み記録 ═══════════════ */

function alertKey_(item) {
  return 'alerted:' + (item.id || item._row) + ':' + item.when;
}

/** 60日より古い送信済み記録を掃除する */
function pruneAlertKeys_() {
  var props = PropertiesService.getScriptProperties();
  var limit = shiftDays_(todayYmd_(), -60);
  var all = props.getProperties();
  Object.keys(all).forEach(function(k) {
    if (k.indexOf('alerted:') !== 0) return;
    var ymd = k.split(':').pop();
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd < limit) props.deleteProperty(k);
  });
}
