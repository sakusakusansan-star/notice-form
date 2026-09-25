/**
 * Sieg 業務ポータル ─ お知らせ Discord 連携の診断
 *
 * 「投稿したのに Discord に来ない」ときに原因を切り分けるためのファイル。
 * ndDiagnose() を手動実行すると、設定・シート・記録・トリガーを順に調べて
 * ログに出す。Discord には一切投稿しない（Webhook の疎通確認も、投稿では
 * なく GET でメタ情報を読むだけ）。
 *
 * このファイルも名前はすべて ND_ / nd で始めており、既存コードには触らない。
 * 原因が分かったら消してよい。
 */

function ndDiagnose() {
  var L = [];
  var log = function(s) { L.push(s); };
  var section = function(s) { L.push(''); L.push('───── ' + s + ' ─────'); };
  var problems = [];

  log('お知らせ Discord 連携 診断');
  log('実行時刻: ' + Utilities.formatDate(new Date(), ND_TZ, 'yyyy-MM-dd HH:mm:ss') + ' (' + ND_TZ + ')');

  /* ═══ 1. Webhook の登録状況 ═══ */
  section('1. Webhook');
  var url = null;
  try {
    url = PropertiesService.getScriptProperties().getProperty(ND_PROP_WEBHOOK);
    if (!url) {
      log('✗ スクリプトプロパティ ' + ND_PROP_WEBHOOK + ' が未登録');
      problems.push('Webhook URL が未登録。プロジェクトの設定 → スクリプト プロパティ で ' + ND_PROP_WEBHOOK + ' を追加する');
    } else {
      log('✓ 登録あり（末尾は …' + url.slice(-6) + '）');
      if (url.indexOf('https://discord.com/api/webhooks/') !== 0 &&
          url.indexOf('https://discordapp.com/api/webhooks/') !== 0) {
        log('✗ URL が Discord の Webhook の形ではない');
        problems.push('Webhook URL の形式がおかしい。https://discord.com/api/webhooks/... で始まるか確認する');
      }
    }
  } catch (err) {
    log('✗ 読み取り失敗: ' + err);
    problems.push('スクリプトプロパティを読めない: ' + err);
  }

  /* ═══ 2. Discord への疎通（投稿はしない） ═══ */
  section('2. Discord への疎通確認（投稿はしません）');
  if (!url) {
    log('- Webhook 未登録のためスキップ');
  } else {
    try {
      var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
      var code = res.getResponseCode();
      log('HTTP ' + code);
      if (code === 200) {
        var info = {};
        try { info = JSON.parse(res.getContentText()); } catch (e) {}
        log('✓ Webhook は生きている');
        log('  Webhook名: ' + (info.name || '(不明)'));
        log('  チャンネルID: ' + (info.channel_id || '(不明)'));
        log('  → このチャンネルを見ているか確認してください');
      } else if (code === 401 || code === 404) {
        log('✗ Webhook が無効（削除された、URLが違う、再生成された）');
        problems.push('Discord 側の Webhook が無効。Discord でウェブフックを作り直し、スクリプトプロパティを更新する');
      } else if (code === 429) {
        log('✗ レート制限中');
        problems.push('Discord にレート制限されている。通知の頻度を下げる');
      } else {
        log('✗ 想定外の応答: ' + res.getContentText().slice(0, 200));
        problems.push('Discord が HTTP ' + code + ' を返した');
      }
    } catch (err) {
      log('✗ 通信できない: ' + err);
      problems.push('UrlFetchApp が使えない。承認をやり直す（ndSetupTriggers を再実行して許可）: ' + err);
    }
  }

  /* ═══ 3. どのシートを見ているか ═══ */
  section('3. 対象シート');
  var sh = null;
  try {
    log('ND_SHEET_ID: ' + (ND_SHEET_ID || '(空。既存コードの SHEET_ID を使う)'));
    log('既存の SHEET_ID: ' + (typeof SHEET_ID !== 'undefined' && SHEET_ID ? 'あり（末尾 …' + String(SHEET_ID).slice(-6) + '）' : 'なし'));
    log('ND_SHEET_NAME: ' + (ND_SHEET_NAME || '(空。既存コードの SHEET_NAME を使う)'));
    log('既存の SHEET_NAME: ' + (typeof SHEET_NAME !== 'undefined' && SHEET_NAME ? SHEET_NAME : 'なし'));

    sh = ndSheet_();
    log('✓ スプレッドシート: ' + sh.getParent().getName());
    log('✓ シート（タブ）: ' + sh.getName());
    log('  行数: ' + sh.getLastRow() + ' / 列数: ' + sh.getLastColumn());
  } catch (err) {
    log('✗ シートを特定できない: ' + err);
    problems.push('対象シートを開けない。NoticeDiscord.gs の ND_SHEET_ID にお知らせシートのIDを直接書く: ' + err);
  }

  /* ═══ 4. 列の認識 ═══ */
  section('4. 見出し行と列の認識');
  var map = null;
  if (!sh) {
    log('- シート未特定のためスキップ');
  } else {
    try {
      var values = sh.getDataRange().getValues();
      if (!values.length) {
        log('✗ シートが空');
        problems.push('シートにデータが無い');
      } else {
        log('1行目（見出しとして扱う行）: ' + JSON.stringify(values[0]));
        map = ndHeaderMap_(values[0]);
        log('認識できた列: ' + JSON.stringify(map));

        var missing = [];
        ['id', 'name', 'type', 'text', 'when'].forEach(function(f) {
          if (map[f] === undefined) missing.push(f);
        });
        if (missing.length) {
          log('✗ 認識できなかった項目: ' + missing.join(', '));
          problems.push(
            '見出し行の名前が想定と違うため列を認識できていない（' + missing.join(', ') + '）。' +
            'NoticeDiscord.gs の ND_FIELDS に、実際の見出し名を候補として追加する'
          );
        } else {
          log('✓ 必要な列はすべて認識できている');
        }
        if (map.text === undefined) {
          problems.push('本文の列が認識できていない。これだと全行が同じ内容とみなされ、新規投稿を検知できない');
        }
        if (values.length < 2) {
          log('✗ データ行が無い（見出しだけ）');
          problems.push('シートに投稿が1件も無い。1行目が見出しではなくデータになっていないか確認する');
        }
      }
    } catch (err) {
      log('✗ 読み取り失敗: ' + err);
      problems.push('シートを読めない: ' + err);
    }
  }

  /* ═══ 5. 読み取れたお知らせ ═══ */
  section('5. 読み取れたお知らせ');
  var items = [];
  if (!sh) {
    log('- スキップ');
  } else {
    try {
      items = ndReadItems_();
      log('件数: ' + items.length);
      items.slice(-5).forEach(function(it) {
        log('  行' + it._row + ' id=' + (it.id || '(空)') +
            ' [' + (it.type || '(空)') + '] ' + (it.name || '(空)') +
            ' / ' + String(it.text || '(空)').slice(0, 30) +
            ' / 日程=' + (it.when || '(空)') +
            ' / 投稿日時=' + (it.created || '(空)'));
      });
      if (items.length && !items[items.length - 1].text) {
        problems.push('最新行の本文が空。列の対応がずれている可能性がある');
      }
    } catch (err) {
      log('✗ 失敗: ' + err);
      problems.push('お知らせを読めない: ' + err);
    }
  }

  /* ═══ 6. 監視の記録 ═══ */
  section('6. 監視の記録（スナップショット）');
  var snap = {};
  try {
    var props = PropertiesService.getScriptProperties();
    var inited = props.getProperty(ND_PROP_WATCH_INIT);
    var raw = props.getProperty(ND_PROP_SNAPSHOT);
    log('初期化フラグ: ' + (inited === '1' ? '済み（時刻の記録なし。古い版で初期化された）'
                            : inited ? '済み  初期化時刻: ' + inited : '未'));
    log('  → 初期化時刻より後に入った投稿が、通知されるべきもの');
    log('記録の生データ長: ' + (raw ? raw.length + ' 文字' : 'なし'));
    snap = ndSnapLoad_();
    log('記録されている件数: ' + Object.keys(snap).length);

    if (!inited) {
      log('✗ まだ初期化されていない → 次の実行は通知せず記録だけになる');
      problems.push('ndSetupTriggers をまだ実行していない可能性がある');
    }
    if (raw && raw.length > 7500) {
      log('△ 記録が上限（9KB）に近い');
    }
  } catch (err) {
    log('✗ 失敗: ' + err);
  }

  /* ═══ 6b. 直近の送信結果 ═══ */
  section('6b. 直近の Discord 送信結果');
  try {
    var pr = PropertiesService.getScriptProperties();
    var lastOk = pr.getProperty('nd:lastSendOk');
    var lastErr = pr.getProperty('nd:lastSendError');
    log('最後に成功した送信: ' + (lastOk || 'なし（一度も成功していない）'));
    log('最後に失敗した送信: ' + (lastErr || 'なし'));
    if (!lastOk && !lastErr) {
      log('△ どちらも記録がない。送信を試みた記録が無いか、記録機能を入れる前の状態');
      problems.push('送信の成功も失敗も記録が無い。ndResendLatest を実行して送信経路を直接確かめる');
    } else if (!lastOk && lastErr) {
      log('✗ 成功が一度もなく、失敗の記録がある');
      problems.push('Discord への送信が一度も成功していない: ' + lastErr);
    }
  } catch (err) {
    log('✗ 失敗: ' + err);
  }

  /* ═══ 7. 今この瞬間に通知されるはずのもの ═══ */
  section('7. 今の差分（ここに出るなら検知はできている）');
  try {
    var after = {}, events = [];
    items.forEach(function(it) {
      var key = ndSnapKey_(it);
      var hash = ndItemHash_(it);
      after[key] = hash;
      if (!snap[key]) events.push('新規: ' + String(it.text || '').slice(0, 30) + '  (key=' + key + ')');
      else if (snap[key].h !== hash) events.push('更新: ' + String(it.text || '').slice(0, 30));
    });
    Object.keys(snap).forEach(function(k) {
      if (!after[k]) events.push('削除: ' + (snap[k].t || k));
    });

    if (!events.length) {
      log('差分なし（記録と一致している）');
      log('→ 投稿が来ないなら、トリガーが動いていないか、投稿がこのシートに入っていない');
    } else {
      log('差分 ' + events.length + ' 件:');
      events.forEach(function(e) { log('  ' + e); });
      if (events.length > ND_WATCH_BURST_LIMIT) {
        log('△ ' + ND_WATCH_BURST_LIMIT + ' 件超なので、個別ではなくまとめて1通になる');
      }
      log('→ 検知はできている。ndWatchNotices を手動実行すれば送られる');
    }

    var uniq = {};
    items.forEach(function(it) { uniq[ndSnapKey_(it)] = 1; });
    if (items.length > 1 && Object.keys(uniq).length === 1) {
      log('✗ 全行が同じキーに潰れている');
      problems.push('全行が同一視されている。列の認識に失敗しているため新規投稿を検知できない（項目4を確認）');
    }
  } catch (err) {
    log('✗ 失敗: ' + err);
  }

  /* ═══ 8. トリガー ═══ */
  section('8. トリガー');
  try {
    var trs = ScriptApp.getProjectTriggers();
    log('登録数: ' + trs.length);
    var hasWatch = false, hasAlert = false;
    trs.forEach(function(t) {
      var h = t.getHandlerFunction();
      log('  ' + h + '  (' + t.getEventType() + ' / ' + t.getTriggerSource() + ')');
      if (h === 'ndWatchNotices') hasWatch = true;
      if (h === 'ndDailyAlert') hasAlert = true;
    });
    if (!hasWatch) {
      log('✗ ndWatchNotices のトリガーが無い → 自動通知は動かない');
      problems.push('ndWatchNotices のトリガーが無い。ndSetupTriggers を実行する');
    }
    if (!hasAlert) {
      log('✗ ndDailyAlert のトリガーが無い → 前日アラートは動かない');
      problems.push('ndDailyAlert のトリガーが無い。ndSetupTriggers を実行する');
    }
    if (hasWatch) {
      log('△ トリガーが「動いたか」はここでは分からない。');
      log('  左の「実行数」で ndWatchNotices の履歴と、失敗（赤）が無いかを確認すること。');
      log('  1分間隔は1日1440回。無料アカウントのトリガー実行時間は1日90分なので、');
      log('  途中で打ち切られていたら ND_WATCH_INTERVAL_MINUTES を 5 に上げる。');
    }
  } catch (err) {
    log('✗ 失敗: ' + err);
  }

  /* ═══ まとめ ═══ */
  section('まとめ');
  if (!problems.length) {
    log('✓ 設定上の問題は見つからなかった。');
    log('  項目7が「差分なし」かつ投稿が届かないなら、次を確認:');
    log('   - 項目2のチャンネルIDが、見ている Discord チャンネルと同じか');
    log('   - 「実行数」で ndWatchNotices が動いているか（赤い失敗が無いか）');
    log('   - フォームの投稿が本当に項目3のシートに入っているか');
  } else {
    log('見つかった問題 ' + problems.length + ' 件:');
    problems.forEach(function(p, i) { log('  ' + (i + 1) + '. ' + p); });
  }

  console.log(L.join('\n'));
  return L.join('\n');
}


/**
 * 「新規投稿だけ鳴らない」を切り分ける。
 *
 * 最新のお知らせ1件を、条件を変えて3パターン送る。
 * どれが届いてどれが届かないかで原因が特定できる。
 *
 *   A: 新規（メンションなし）        … 埋め込みの中身に問題があるか
 *   B: 新規（メンションを文付きに）  … 本文がメンション単体なのが原因か
 *   C: 新規（現在の設定のまま）      … 今と同じ条件。届かないはず
 *
 * 各パターンの HTTP コードをログに出す。Discord を見て、
 * A/B/C のどれが届いたかを確認すること。
 */
function ndWhyNoCreate() {
  var items = ndReadItems_();
  if (!items.length) { console.log('お知らせが1件もありません'); return; }
  var it = items[items.length - 1];

  var L = [];
  L.push('新規投稿が鳴らない原因の切り分け');
  L.push('対象: 行' + it._row + ' [' + it.type + '] ' + it.name + ' / ' + it.text);
  L.push('現在の設定: ND_ALERT_MENTION=' + JSON.stringify(ND_ALERT_MENTION) +
         ' / ND_MENTION_TYPES=' + JSON.stringify(ND_MENTION_TYPES));
  L.push('');

  var embed = ndEmbed_(it, '📢 新しいお知らせ');

  // A: メンションなし
  var a = ndPost_({ embeds: [embed] });
  L.push('A) メンションなし            → ' + (a ? '送信OK' : '送信失敗'));

  Utilities.sleep(1500);

  // B: メンションの後ろに文を付ける（前日アラートと同じ形）
  var b = ndPost_({
    content: (ND_ALERT_MENTION || '@here') + ' 新しいお知らせがあります',
    embeds: [embed],
    allowed_mentions: { parse: ['everyone', 'roles', 'users'] }
  });
  L.push('B) メンション＋文（アラートと同じ形） → ' + (b ? '送信OK' : '送信失敗'));

  Utilities.sleep(1500);

  // C: 今と同じ条件（ndSend_ をそのまま通す）
  var c = ndSend_('create', it);
  L.push('C) 現在の設定のまま          → ' + (c ? '送信OK' : '送信失敗'));

  L.push('');
  L.push('■ Discord を見て、A/B/C のどれが届いたかを確認してください');
  L.push('  A届く B届く C届かない → 本文がメンション単体なのが原因（Bの形に変えれば解決）');
  L.push('  A届く B届かない C届かない → メンション自体が弾かれている（AutoMod か権限）');
  L.push('  A届かない → 埋め込みの中身に問題がある');
  L.push('  A B C 全部届く → 送信経路は正常。検知側の問題なので ndKeyReport を実行');

  console.log(L.join('\n'));
}

/**
 * 「新規投稿が検知されているか」を調べる。
 *
 * シートの各行がどのキーで記録と照合されるかを一覧にする。
 * 新規投稿が検知されない原因は、そのキーが既に記録済みになっていること。
 * Discord には何も送らない。
 */
function ndKeyReport() {
  var snap = ndSnapLoad_();
  var items = ndReadItems_();
  var L = [];
  var problems = [];

  L.push('キーの照合レポート');
  L.push('シートの件数: ' + items.length + ' / 記録の件数: ' + Object.keys(snap).length);
  L.push('');

  var seen = {};
  var current = {};
  items.forEach(function(it) {
    var key = ndSnapKey_(it);
    var hash = ndItemHash_(it);
    current[key] = true;

    var state;
    if (!snap[key]) state = '★未記録（次の実行で新規として通知される）';
    else if (snap[key].h !== hash) state = '△記録と内容が違う（更新として通知される）';
    else state = '記録済み（通知されない）';

    L.push('行' + it._row + ' id=' + (it.id || '(空)'));
    L.push('   内容: ' + String(it.text || '').slice(0, 30));
    L.push('   キー: ' + key);
    L.push('   状態: ' + state);

    if (seen[key]) {
      L.push('   ✗ 行' + seen[key] + ' と同じキー');
      problems.push('行' + it._row + ' と行' + seen[key] + ' が同じキーになっている。' +
                    'どちらか一方しか検知されない（ID列が空で、内容が完全に同じだと起きる）');
    }
    seen[key] = it._row;

    if (!String(it.id || '').trim()) {
      problems.push('行' + it._row + ' の ID 列が空。内容のハッシュで照合するため、' +
                    '同じ内容の投稿が区別できない。既存コードが ID を後から書き込む作りなら、' +
                    'ID が入る前と後で別のお知らせとして扱われる');
    }
  });

  L.push('');
  var ghosts = Object.keys(snap).filter(function(k) { return !current[k]; });
  if (ghosts.length) {
    L.push('記録にあるが現物に無いキー（削除として通知される）: ' + ghosts.length + ' 件');
    ghosts.forEach(function(k) { L.push('   ' + k + '  ' + (snap[k].t || '')); });
    problems.push('記録に残っているキーが ' + ghosts.length + ' 件ある。' +
                  'ID が書き換わっていると、同じお知らせが「削除」と「新規」の両方で通知される');
  } else {
    L.push('記録にあるが現物に無いキー: なし');
  }

  L.push('');
  L.push('───── まとめ ─────');
  if (!problems.length) {
    L.push('✓ キーの照合に問題は見つからなかった。');
    L.push('  → 新規投稿は正しく検知されるはず。原因は送信側なので ndWhyNoCreate を実行');
  } else {
    var uniq = [];
    problems.forEach(function(p) { if (uniq.indexOf(p) < 0) uniq.push(p); });
    L.push('見つかった問題 ' + uniq.length + ' 件:');
    uniq.forEach(function(p, i) { L.push('  ' + (i + 1) + '. ' + p); });
  }

  console.log(L.join('\n'));
}
