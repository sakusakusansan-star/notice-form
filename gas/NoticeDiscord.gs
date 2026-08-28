/**
 * Sieg 業務ポータル ─ お知らせ Discord 連携
 *
 * このファイル1枚で以下ができます。
 *   1. お知らせが投稿／更新／削除されたら Discord に自動で飛ばす
 *   2. 日程（when）の前日になったら Discord にアラートを飛ばす
 *
 * 【既存コードとの共存について】
 * Apps Script は全ファイルが同じグローバル空間を共有するため、名前がぶつかると
 * 後から読み込まれた方で上書きされ、既存の doGet / doPost が壊れます。
 * それを避けるため、このファイルが定義する名前はすべて ND_ / nd で始めています。
 * 既存コードの名前は一切上書きしません。
 *
 * 導入手順は gas/SETUP.md を参照。
 */

/* ═══════════════ 設定 ═══════════════ */

// Webhook URL は「プロジェクトの設定 → スクリプト プロパティ」に
// DISCORD_WEBHOOK_URL という名前で登録する。コードには書かないこと。
var ND_PROP_WEBHOOK = 'DISCORD_WEBHOOK_URL';

// お知らせを保存しているスプレッドシートのID。
// 空にしておくと、既存コードの SHEET_ID を読み取って使う（推奨）。
// 既存コードに SHEET_ID が無い場合だけ、ここに直接IDを書く。
var ND_SHEET_ID = '';

// 対象シート名。空にしておくと、既存コードの SHEET_NAME を読み取って使う。
// どちらも無ければ先頭シートを使う。
var ND_SHEET_NAME = '';

var ND_TZ = 'Asia/Tokyo';

// 前日アラートに付けるメンション（不要なら '' にする）
var ND_ALERT_MENTION = '@here';

// 種別「重要」の投稿にもメンションを付けるか
var ND_MENTION_IMPORTANT = true;

// 前日アラートを送る時刻（0〜23、JST）
var ND_ALERT_HOUR = 9;

// 種別ごとの色（Discord embed）
var ND_TYPE_COLOR = {
  'お知らせ': 0xE8A33D,
  '会議':     0x4C9BD9,
  '重要':     0xE86A5A
};

// シートの見出し行から列を探すときの候補名
var ND_FIELDS = {
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
 * 既存の doPost から、保存が成功した直後に呼ぶ場合はこれを使う。
 *
 *   ndNotify('create', item);   // 新規投稿
 *   ndNotify('update', item);   // 更新
 *   ndNotify('delete', item);   // 削除
 *
 * item は { id, name, type, text, when, time, expire } の形。
 * 通信に失敗しても投稿処理は止めない（例外を投げない）。
 */
function ndNotify(kind, item) {
  ndSend_(kind, item);

  // 送信済みとして監視側の記録に反映させ、
  // ndWatchNotices() が同じ内容をもう一度通知しないようにする。
  if (typeof ndSnapSync_ !== 'function') return;  // NoticeWatch.gs 未導入
  try {
    ndSnapSync_(kind, item);
  } catch (err) {
    console.error('ndSnapSync_ failed: ' + err);
  }
}

/**
 * 実際に Discord へ1件送る。監視側からもここを呼ぶ。
 */
function ndSend_(kind, item) {
  try {
    var titles = {
      create: '📢 新しいお知らせ',
      update: '✏️ お知らせが更新されました',
      'delete': '🗑️ お知らせが削除されました'
    };
    var payload = { embeds: [ndEmbed_(item, titles[kind] || titles.create)] };

    if (ND_MENTION_IMPORTANT && kind !== 'delete' && item && item.type === '重要' && ND_ALERT_MENTION) {
      payload.content = ND_ALERT_MENTION;
    }
    ndPost_(payload);
  } catch (err) {
    console.error('ndSend_ failed: ' + err);
  }
}

/**
 * 前日アラート。1日1回のトリガーから呼ばれる。
 * 日程（when）が「明日」のお知らせをまとめて Discord に流す。
 * 同じお知らせを二重に通知しないよう、送信済みは記録しておく。
 */
function ndDailyAlert() {
  var props = PropertiesService.getScriptProperties();
  var tomorrow = ndShiftDays_(ndToday_(), 1);

  var targets = ndReadItems_().filter(function(it) {
    if (!it.when || it.when !== tomorrow) return false;
    return !props.getProperty(ndAlertKey_(it));
  });
  if (!targets.length) return;

  var payload = {
    embeds: targets.slice(0, 10).map(function(it) {
      return ndEmbed_(it, '⏰ 【前日アラート】明日の予定');
    })
  };
  var head = '明日 ' + ndJpDate_(tomorrow) + ' の予定が ' + targets.length + ' 件あります';
  payload.content = (ND_ALERT_MENTION ? ND_ALERT_MENTION + ' ' : '') + head;

  // 送信できたときだけ「送信済み」にする。
  // 失敗したまま記録すると、翌日の実行で再送されなくなってしまう。
  if (!ndPost_(payload)) {
    console.error('前日アラートの送信に失敗しました。次回の実行で再送します');
    return;
  }

  targets.forEach(function(it) { props.setProperty(ndAlertKey_(it), '1'); });
  ndPruneAlertKeys_();
}

/**
 * トリガーを作り直す。導入時に1回だけ手動実行する。
 *
 *   ndDailyAlert    … 毎日 ND_ALERT_HOUR 時に前日アラート
 *   ndWatchNotices  … ND_WATCH_INTERVAL_MINUTES 分ごとにシートを見張って投稿を通知
 *
 * 何度実行しても重複しない（自分が作ったトリガーだけ消してから作り直す）。
 * 既存コードが作ったトリガーには触らない。
 */
function ndSetupTriggers() {
  var mine = ['ndDailyAlert', 'ndWatchNotices'];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (mine.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('ndDailyAlert')
    .timeBased()
    .atHour(ND_ALERT_HOUR)
    .everyDays(1)
    .inTimezone(ND_TZ)
    .create();
  console.log('毎日 ' + ND_ALERT_HOUR + ':00（' + ND_TZ + '）に ndDailyAlert を実行します');

  // NoticeWatch.gs を入れていない場合は監視トリガーを作らない
  if (typeof ndWatchNotices !== 'function') {
    console.log('NoticeWatch.gs が無いため、投稿の自動通知は doPost 側の ndNotify() に任せます');
    return;
  }

  ScriptApp.newTrigger('ndWatchNotices')
    .timeBased()
    .everyMinutes(ND_WATCH_INTERVAL_MINUTES)
    .create();
  console.log(ND_WATCH_INTERVAL_MINUTES + ' 分ごとに ndWatchNotices を実行します');

  // 初回の記録を今ここで作っておく（既存のお知らせが一斉通知されるのを防ぐ）
  ndWatchNotices();
}

/**
 * 導入前の確認用。どのシートを見に行くかをログに出す。
 * Discord には何も送らない。既存コードにも触らない。
 */
function ndCheckSetup() {
  var url = PropertiesService.getScriptProperties().getProperty(ND_PROP_WEBHOOK);
  console.log('Webhook: ' + (url ? '登録済み（先頭30文字: ' + url.slice(0, 30) + '…）' : '未登録'));

  var sh = ndSheet_();
  console.log('スプレッドシート: ' + sh.getParent().getName());
  console.log('シート: ' + sh.getName());

  var values = sh.getDataRange().getValues();
  console.log('見出し行: ' + JSON.stringify(values[0]));
  console.log('認識できた列: ' + JSON.stringify(ndHeaderMap_(values[0])));

  var items = ndReadItems_();
  console.log('読み取れたお知らせ: ' + items.length + ' 件');
  items.slice(0, 3).forEach(function(it) {
    console.log('  - [' + it.type + '] ' + it.name + ' / ' + it.text + ' / 日程=' + it.when);
  });
}

/**
 * 動作確認用。手動実行すると Discord にテスト投稿が1件飛ぶ。
 */
function ndTestDiscord() {
  ndSend_('create', {
    id: 'test',
    name: 'テスト',
    type: 'お知らせ',
    text: 'Discord 連携のテストです。これが見えていれば設定は完了しています。',
    when: ndShiftDays_(ndToday_(), 1),
    time: '10:00〜 本社2F',
    expire: ndShiftDays_(ndToday_(), 14)
  });
}

/**
 * 動作確認用。明日の予定に対する前日アラートを、送信済み記録を無視して1回流す。
 */
function ndTestDailyAlert() {
  var props = PropertiesService.getScriptProperties();
  var tomorrow = ndShiftDays_(ndToday_(), 1);
  ndReadItems_().forEach(function(it) {
    if (it.when === tomorrow) props.deleteProperty(ndAlertKey_(it));
  });
  ndDailyAlert();
}


/* ═══════════════ Discord 送信 ═══════════════ */

/** 送信できたら true、できなかったら false を返す */
function ndPost_(payload) {
  var url = PropertiesService.getScriptProperties().getProperty(ND_PROP_WEBHOOK);
  if (!url) {
    console.warn('スクリプトプロパティ ' + ND_PROP_WEBHOOK + ' が未設定のため送信をスキップしました');
    return false;
  }
  if (ND_ALERT_MENTION) {
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

function ndEmbed_(item, title) {
  item = item || {};
  var fields = [];
  if (item.name) fields.push({ name: '投稿者', value: String(item.name), inline: true });
  if (item.type) fields.push({ name: '種別',   value: String(item.type), inline: true });

  var when = ndWhenLabel_(item);
  if (when) fields.push({ name: '日程', value: when, inline: false });
  if (item.expire) fields.push({ name: '表示期限', value: ndJpDate_(item.expire), inline: true });

  return {
    title: title,
    description: String(item.text || '（本文なし）').slice(0, 3900),
    color: ND_TYPE_COLOR[item.type] || ND_TYPE_COLOR['お知らせ'],
    fields: fields,
    footer: { text: 'SIEG OPS BOARD' },
    timestamp: new Date().toISOString()
  };
}

function ndWhenLabel_(item) {
  var parts = [];
  if (item.when) parts.push(ndJpDate_(item.when));
  if (item.time) parts.push(String(item.time));
  return parts.join('　');
}


/* ═══════════════ シート読み取り ═══════════════ */

/**
 * 対象シートを返す。
 *
 * スプレッドシートの特定は次の順で試す。
 *   1. ND_SHEET_ID（このファイルの設定）
 *   2. 既存コードの SHEET_ID（読み取るだけ。書き換えはしない）
 *   3. getActiveSpreadsheet()
 *
 * 3 はスタンドアロンのプロジェクトや時間主導トリガーからは null になるため、
 * 既存コードが SHEET_ID を持っているならそれを使うのが確実。
 */
function ndSheet_() {
  var ss = null;

  if (ND_SHEET_ID) {
    ss = SpreadsheetApp.openById(ND_SHEET_ID);
  } else if (typeof SHEET_ID !== 'undefined' && SHEET_ID) {
    ss = SpreadsheetApp.openById(SHEET_ID);
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }

  if (!ss) {
    throw new Error(
      'スプレッドシートを特定できません。NoticeDiscord.gs の ND_SHEET_ID に ' +
      'お知らせシートのIDを設定してください'
    );
  }

  var name = ND_SHEET_NAME || (typeof SHEET_NAME !== 'undefined' ? SHEET_NAME : '');
  var sh = name ? ss.getSheetByName(name) : null;
  if (!sh) sh = ss.getSheets()[0];
  return sh;
}

/** 見出し行から { フィールド名: 列番号(0始まり) } を作る */
function ndHeaderMap_(header) {
  var map = {};
  var norm = header.map(function(h) { return String(h).trim().toLowerCase(); });
  Object.keys(ND_FIELDS).forEach(function(field) {
    ND_FIELDS[field].some(function(alias) {
      var i = norm.indexOf(String(alias).toLowerCase());
      if (i >= 0) { map[field] = i; return true; }
      return false;
    });
  });
  return map;
}

/** シート全件を { id, name, type, text, when, time, expire, _row } の配列で返す */
function ndReadItems_() {
  var values = ndSheet_().getDataRange().getValues();
  if (values.length < 2) return [];
  var map = ndHeaderMap_(values[0]);
  var items = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row.join('').trim()) continue;
    items.push(ndRowToItem_(row, map, i + 1));
  }
  return items;
}

function ndRowToItem_(row, map, rowNumber) {
  var item = { _row: rowNumber };
  Object.keys(ND_FIELDS).forEach(function(field) {
    if (map[field] === undefined) { item[field] = ''; return; }
    var v = row[map[field]];
    item[field] = (field === 'when' || field === 'expire') ? ndYmd_(v) : (v === null ? '' : v);
  });
  return item;
}


/* ═══════════════ 日付ユーティリティ ═══════════════ */

function ndToday_() {
  return Utilities.formatDate(new Date(), ND_TZ, 'yyyy-MM-dd');
}

/** Date でも文字列でも 'yyyy-MM-dd' に正規化する */
function ndYmd_(v) {
  if (!v && v !== 0) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, ND_TZ, 'yyyy-MM-dd');
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
function ndParseYmd_(ymd) {
  var m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

function ndFormatYmd_(d) {
  return d.getFullYear() + '-' +
    ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
    ('0' + d.getDate()).slice(-2);
}

function ndShiftDays_(ymd, days) {
  var d = ndParseYmd_(ymd);
  if (!d) return ymd;
  d.setDate(d.getDate() + days);
  return ndFormatYmd_(d);
}

function ndJpDate_(ymd) {
  var d = ndParseYmd_(ndYmd_(ymd));
  if (!d) return String(ymd);
  var w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日（' + w + '）';
}


/* ═══════════════ 送信済み記録 ═══════════════ */

function ndAlertKey_(item) {
  return 'nd:alerted:' + (item.id || item._row) + ':' + item.when;
}

/** 60日より古い送信済み記録を掃除する */
function ndPruneAlertKeys_() {
  var props = PropertiesService.getScriptProperties();
  var limit = ndShiftDays_(ndToday_(), -60);
  var all = props.getProperties();
  Object.keys(all).forEach(function(k) {
    if (k.indexOf('nd:alerted:') !== 0) return;
    var ymd = k.split(':').pop();
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd < limit) props.deleteProperty(k);
  });
}
