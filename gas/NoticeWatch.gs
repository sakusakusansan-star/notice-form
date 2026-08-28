/**
 * Sieg 業務ポータル ─ お知らせ監視（既存コードを触らずに Discord 通知する）
 *
 * 既存の doPost に notifyDiscord() を差し込めない／差し込みたくない場合はこちら。
 * シートを定期的に見張って、増えた・変わった・消えたお知らせを Discord に流す。
 *
 * doPost 側で notifyDiscord() を呼んでいる場合でも二重通知にはならない。
 * notifyDiscord() が送信時に記録を更新するので、監視側は「既知」として扱う。
 */

/* ═══════════════ 設定 ═══════════════ */

// 監視の間隔（分）。GASが受け付けるのは 1, 5, 10, 15, 30 のいずれか。
// 1 にすると最短1分で届く。実行回数が増えるので、無料アカウントで
// 実行時間の上限に当たるようなら 5 に上げる。
var WATCH_INTERVAL_MINUTES = 1;

// 一度にこの件数を超える変化を検知したら、個別通知ではなく件数だけ知らせる
// （シートを一括編集したときに大量投稿するのを防ぐ）
var WATCH_BURST_LIMIT = 8;

var PROP_SNAPSHOT   = 'watch:snapshot';
var PROP_WATCH_INIT = 'watch:initialized';


/* ═══════════════ 監視本体 ═══════════════ */

/**
 * シートを見て、前回からの差分を Discord に流す。
 * 時間主導トリガーから呼ばれる（setupTriggers で作成）。
 */
function watchNotices() {
  var props = PropertiesService.getScriptProperties();
  var before = snapshotLoad_();
  var items = readItems_();

  var after = {};
  var events = [];

  items.forEach(function(it) {
    var key = snapshotKey_(it);
    var hash = itemHash_(it);
    after[key] = { h: hash, n: it.name, ty: it.type, t: String(it.text || '').slice(0, 60) };

    if (!before[key]) events.push({ kind: 'create', item: it });
    else if (before[key].h !== hash) events.push({ kind: 'update', item: it });
  });

  Object.keys(before).forEach(function(key) {
    if (after[key]) return;
    events.push({
      kind: 'delete',
      item: { id: key, name: before[key].n, type: before[key].ty, text: before[key].t }
    });
  });

  snapshotSave_(after);

  // 初回は「今ある分」を記録するだけ。既存のお知らせを一斉通知しないため。
  if (!props.getProperty(PROP_WATCH_INIT)) {
    props.setProperty(PROP_WATCH_INIT, '1');
    console.log('初回のため現状 ' + items.length + ' 件を記録しました（通知はしません）');
    return;
  }

  if (!events.length) return;

  if (events.length > WATCH_BURST_LIMIT) {
    console.log('変化が ' + events.length + ' 件あったため、まとめて通知します');
    postDiscord_({
      embeds: [{
        title: '🔄 お知らせが一括で更新されました',
        description: 'まとめて ' + events.length + ' 件の変更がありました。ポータルで確認してください。',
        color: TYPE_COLOR['お知らせ'],
        footer: { text: 'SIEG OPS BOARD' },
        timestamp: new Date().toISOString()
      }]
    });
    return;
  }

  events.forEach(function(ev) { sendNotice_(ev.kind, ev.item); });
}

/**
 * 監視の記録をリセットする。
 * 次の実行で、通知せずに「今ある分」を記録し直す。
 */
function resetWatch() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_SNAPSHOT);
  props.deleteProperty(PROP_WATCH_INIT);
  console.log('監視の記録をリセットしました。次回の実行で現状を記録し直します');
}


/* ═══════════════ 記録（スナップショット） ═══════════════ */

/**
 * 各お知らせを識別するキー。
 * id 列があればそれを使う。無い場合は内容のハッシュを使う。
 * （行番号を使うと、1件消したときに以降の行がずれて誤検知するため）
 */
function snapshotKey_(item) {
  var id = String(item.id || '').trim();
  return id ? 'id:' + id : 'h:' + itemHash_(item);
}

function itemHash_(item) {
  var src = ['name', 'type', 'text', 'when', 'time', 'expire']
    .map(function(f) { return String(item[f] === undefined ? '' : item[f]); })
    .join('');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, src, Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); })
    .join('');
}

function snapshotLoad_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_SNAPSHOT);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (err) {
    console.error('記録の読み込みに失敗したため作り直します: ' + err);
    return {};
  }
}

function snapshotSave_(snap) {
  var json = JSON.stringify(snap);

  // 1プロパティあたり9KBの上限があるので、溢れそうならハッシュだけに切り詰める
  if (json.length > 8000) {
    var slim = {};
    Object.keys(snap).forEach(function(k) { slim[k] = { h: snap[k].h }; });
    json = JSON.stringify(slim);
  }
  PropertiesService.getScriptProperties().setProperty(PROP_SNAPSHOT, json);
}

/** notifyDiscord() から呼ばれ、送信済みの1件を記録に反映する（二重通知の防止） */
function snapshotSync_(kind, item) {
  var snap = snapshotLoad_();
  var key = snapshotKey_(item);

  if (kind === 'delete') delete snap[key];
  else snap[key] = { h: itemHash_(item), n: item.name, ty: item.type, t: String(item.text || '').slice(0, 60) };

  snapshotSave_(snap);
}
