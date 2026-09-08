# 会員名鑑・マッチングシート（membership-directory）

交流会・商工会・オンラインサロンなどのコミュニティ向けに、
会員情報を検索し、相性の良い会員をキーワードで自動マッチングできる Web アプリです。

- 会員データは Google スプレッドシート、API は Google Apps Script（GAS）。サーバー費用ゼロ
- パスワード1つで会員限定公開
- 名前・会社名・会場・仕事内容・探している相手で横断検索
- 「相性を探す」ボタンで、探している相手と仕事内容のキーワードが重なる会員を上位表示
- スマホ対応、静的HTML1枚なので GitHub Pages / Netlify にそのまま配置可能

## 構成

```
index.html   画面・ロジック（設定は先頭の CONFIG にまとめています）
docs/        導入手順・保守プラン提案書
```

GAS 側は `?password=xxxx` を受け取り、認証OKなら会員配列を JSON で返します。
各会員のフィールド: `name, company, job, venue, email, tel, facebook, lineId, needs[], detail, photo, type, timestamp`

## 別のコミュニティへ導入する手順

`docs/setup-new-community.md` を参照してください。所要時間の目安は 1〜2 時間です。

## 保守・運用

`docs/proposal-monthly-maintenance.md` に、運営者向けの月額保守プラン提案書を置いています。
