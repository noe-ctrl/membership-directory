# 別コミュニティへの導入手順（所要 1〜2 時間）

## 1. スプレッドシートを用意する

Google スプレッドシートを新規作成し、1行目に次の見出しを置きます。

| 列 | 見出し | 内容 |
| --- | --- | --- |
| A | timestamp | 登録日時（Googleフォーム連携なら自動） |
| B | name | 氏名 |
| C | company | 会社名・屋号 |
| D | job | 仕事内容 |
| E | venue | 所属会場・支部 |
| F | email | メール |
| G | tel | 電話 |
| H | facebook | Facebook URL |
| I | lineId | LINE ID |
| J | needs | 探している方（カンマ区切り） |
| K | detail | 自己紹介・詳細 |
| L | photo | 顔写真URL |
| M | type | 会員種別（正会員・ゲストなど） |

Googleフォームから回答を流し込む運用にすると、会員自身に更新してもらえます。

## 2. GAS をデプロイする

1. スプレッドシートの「拡張機能 → Apps Script」を開く
2. `doGet(e)` で `e.parameter.password` を検証し、一致すればシート内容を JSON で返す関数を置く
3. 「デプロイ → 新しいデプロイ → ウェブアプリ」で、実行ユーザー「自分」、アクセス「全員」を選ぶ
4. 発行された `https://script.google.com/macros/s/.../exec` を控える

## 3. index.html の CONFIG を書き換える

```js
const CONFIG = {
  appName: '◯◯会 会員名鑑',
  loginNote: 'パスワードを入力すると会員情報を閲覧できます。',
  gasApiUrl: 'https://script.google.com/macros/s/XXXX/exec',
};
```

必要なら `:root` の CSS 変数（`--accent` など）でブランドカラーを変えます。

## 4. 公開する

- GitHub Pages: リポジトリ設定 → Pages → ブランチを選ぶだけ
- Netlify / Cloudflare Pages: `index.html` をドラッグ＆ドロップ

公開URLとパスワードを運営者に渡して完了です。

## 5. 納品時に渡すもの

- 公開URL
- パスワード変更方法（GAS のスクリプトプロパティ、またはシート上のセル）
- スプレッドシートの編集権限の説明
- 保守プランのご案内（`proposal-monthly-maintenance.md`）
