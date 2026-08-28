# notice-form

Sieg 業務ポータルの「お知らせ投稿」フォーム。投稿・編集・削除ができ、内容はポータルのトップに表示されます。

- `index.html` — 投稿フォーム本体（GitHub Pages で公開）
- `gas/` — バックエンド（Google Apps Script）

## Discord 連携

お知らせを投稿すると Discord に自動で流れ、日程の前日になるとアラートが飛びます。
セットアップ手順は **[gas/SETUP.md](gas/SETUP.md)** を参照してください。

> Discord の Webhook URL はリポジトリには置かず、GAS のスクリプトプロパティ
> `DISCORD_WEBHOOK_URL` に登録します。
