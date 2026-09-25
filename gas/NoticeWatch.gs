/**
 * Sieg 業務ポータル ─ お知らせ監視（既存コードを触らずに Discord 通知する）
 *
 * 既存の doPost に ndNotify() を差し込めない／差し込みたくない場合はこちら。
 * シートを定期的に見張って、増えた・変わった・消えたお知らせを Discord に流す。
 *
 * doPost 側で ndNotify() を呼んでいる場合でも二重通知にはならない。
 * ndNotify() が送信時に記録を更新するので、監視側は「既知」として扱う。
 *
 * このファイルが定義する名前もすべて ND_ / nd で始めており、
 * 既存コードの名前は上書きしない。NoticeDiscord.gs と併せて導入する。
 *
 * 【重要】記録は「送信できたものだけ」に反映する。
 * 送る前に記録してしまうと、Discord 側が落ちていたときにその1件が
 * 永久に失われる（記録上は送信済みになり、再送されない）。
 */

/* ═══════════════ 設定 ═══════════════ */

// 監視の間隔（分）。GASが受け付けるのは 1, 5, 10, 15, 30 のいずれか。
// 1 にすると最短1分で届く。実行回数が増えるので、無料アカウントで
// 実行時間の上限に当たるようなら 5 に上げる。
var ND_WATCH_INTERVAL_MINUTES = 1;

// 一度にこの件数を超える変化を検知したら、個別通知ではなく件数だけ知らせる
// （シートを一括編集したときに大量投稿するのを防ぐ）
var ND_WATCH_BURST_LIMIT = 8;

var ND_PROP_SNAPSHOT   = 'nd:watch:snapshot';
var ND_PROP_WATCH_INIT = 'nd:watch:initialized';


/* ═══════════════ 監視本体 ═══════════════ */

/**
 * シートを見て、前回からの差分を Discord に流す。
 * 時間主導トリガーから呼ばれる（ndSetupTriggers で作成）。
 *
 * 送信に失敗した分は記録に入れないので、次の実行で自動的に再送される。
 */
function ndWatchNotices() {
  var props = PropertiesService.getScriptProperties();
  var before = ndSnapLoad_();
  var items = ndReadItems_();

  var after = {};
  var events = [];

  items.forEach(function(it) {
    var key = ndSnapKey_(it);
    var entry = { h: ndItemHash_(it), n: it.name, ty: it.type, t: String(it.text || '').slice(0, 60) };
    after[key] = entry;

    if (!before[key]) events.push({ kind: 'create', key: key, item: it, entry: entry });
    else if (before[key].h !== entry.h) events.push({ kind: 'update', key: key, item: it, entry: entry });
  });

  Object.keys(before).forEach(function(key) {
    if (after[key]) return;
    events.push({
      kind: 'delete',
      key: key,
      item: { id: key, name: before[key].n, type: before[key].ty, text: before[key].t }
    });
  });

  // 初回は「今ある分」を記録するだけ。既存のお知らせを一斉通知しないため。
  if (!props.getProperty(ND_PROP_WATCH_INIT)) {
    ndSnapSave_(after);
    props.setProperty(ND_PROP_WATCH_INIT,
      Utilities.formatDate(new Date(), ND_TZ, 'yyyy-MM-dd HH:mm:ss'));
    console.log('初回のため現状 ' + items.length + ' 件を記録しました（通知はしません）');
    return;
  }

  if (!events.length) return;

  // 一括編集時は個別に投げない。これも送れたときだけ記録する。
  if (events.length > ND_WATCH_BURST_LIMIT) {
    console.log('変化が ' + events.length + ' 件あったため、まとめて通知します');
    var ok = ndPost_({
      embeds: [{
        title: '🔄 お知らせが一括で更新されました',
        description: 'まとめて ' + events.length + ' 件の変更がありました。ポータルで確認してください。',
        color: ND_TYPE_COLOR['お知らせ'],
        footer: { text: 'SIEG OPS BOARD' },
        timestamp: new Date().toISOString()
      }]
    });
    if (ok) ndSnapSave_(after);
    else console.error('一括通知の送信に失敗しました。次回の実行で再送します');
    return;
  }

  // ここが本題。
  // 記録は before から始めて、送信に成功した分だけを反映していく。
  // 失敗した分は before のままなので、次回の実行で再び差分として検知される。
  var confirmed = {};
  Object.keys(before).forEach(function(k) { confirmed[k] = before[k]; });

  var sentCount = 0;
  var failedCount = 0;

  events.forEach(function(ev) {
    if (!ndSend_(ev.kind, ev.item)) {
      failedCount++;
      return;                      // 記録に反映しない → 次回再送
    }
    sentCount++;
    if (ev.kind === 'delete') delete confirmed[ev.key];
    else confirmed[ev.key] = ev.entry;
  });

  ndSnapSave_(confirmed);

  console.log('通知 ' + sentCount + ' 件送信' + (failedCount ? ' / ' + failedCount + ' 件失敗' : ''));
  if (failedCount) {
    console.error(failedCount + ' 件の送信に失敗しました。記録に入れていないので次回の実行で再送します');
  }
}

/**
 * 監視の記録をリセットする。
 * 次の実行で、通知せずに「今ある分」を記録し直す。
 */
function ndResetWatch() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(ND_PROP_SNAPSHOT);
  props.deleteProperty(ND_PROP_WATCH_INIT);
  console.log('監視の記録をリセットしました。次回の実行で現状を記録し直します');
}

/**
 * 最新のお知らせ1件を、記録を無視して今すぐ送り直す。
 * 「仕組みは健全に見えるのに届かない」ときの切り分け用。
 * 実際に POST して HTTP コードをログに出すので、送信経路の可否が分かる。
 */
function ndResendLatest() {
  var items = ndReadItems_();
  if (!items.length) {
    console.log('お知らせが1件もありません');
    return;
  }
  var it = items[items.length - 1];
  console.log('送り直す対象: 行' + it._row + ' [' + it.type + '] ' + it.name + ' / ' + it.text);

  var ok = ndSend_('create', it);
  console.log(ok ? '✓ 送信できました。Discord を確認してください' : '✗ 送信できませんでした。上のエラー行を確認してください');
}


/* ═══════════════ 記録（スナップショット） ═══════════════ */

/**
 * 各お知らせを識別するキー。
 * id 列があればそれを使う。無い場合は内容のハッシュを使う。
 * （行番号を使うと、1件消したときに以降の行がずれて誤検知するため）
 */
function ndSnapKey_(item) {
  var id = String(item.id || '').trim();
  return id ? 'id:' + id : 'h:' + ndItemHash_(item);
}

function ndItemHash_(item) {
  var src = ['name', 'type', 'text', 'when', 'time', 'expire']
    .map(function(f) { return String(item[f] === undefined ? '' : item[f]); })
    .join('');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, src, Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); })
    .join('');
}

function ndSnapLoad_() {
  var raw = PropertiesService.getScriptProperties().getProperty(ND_PROP_SNAPSHOT);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (err) {
    console.error('記録の読み込みに失敗したため作り直します: ' + err);
    return {};
  }
}

function ndSnapSave_(snap) {
  var json = JSON.stringify(snap);

  // 1プロパティあたり9KBの上限があるので、溢れそうならハッシュだけに切り詰める
  if (json.length > 8000) {
    var slim = {};
    Object.keys(snap).forEach(function(k) { slim[k] = { h: snap[k].h }; });
    json = JSON.stringify(slim);
  }
  PropertiesService.getScriptProperties().setProperty(ND_PROP_SNAPSHOT, json);
}

/** ndNotify() から呼ばれ、送信済みの1件を記録に反映する（二重通知の防止） */
function ndSnapSync_(kind, item) {
  var snap = ndSnapLoad_();
  var key = ndSnapKey_(item);

  if (kind === 'delete') delete snap[key];
  else snap[key] = { h: ndItemHash_(item), n: item.name, ty: item.type, t: String(item.text || '').slice(0, 60) };

  ndSnapSave_(snap);
}
