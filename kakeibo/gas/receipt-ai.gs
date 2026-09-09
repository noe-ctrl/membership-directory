/**
 * 家計簿アプリ用 レシートAI読み取り（Google Apps Script）
 *
 * セットアップ:
 *  1. https://script.google.com で新しいプロジェクトを作り、このファイルの内容を貼り付ける
 *  2. 左メニュー「プロジェクトの設定」→「スクリプト プロパティ」に
 *       ANTHROPIC_API_KEY = （Anthropic の APIキー）
 *     を追加する
 *  3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *     でデプロイし、発行された URL（…/exec）を家計簿アプリの
 *     「設定 → レシート読み取りの設定 → AI読み取り用のURL」に貼り付ける
 *
 * 家計簿アプリからは { image: <base64 JPEG>, mime: 'image/jpeg', categories: [...] } が
 * POST されるので、Claude に画像を渡して JSON で品目を返す。
 */

const MODEL = 'claude-opus-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

// 返してほしい JSON の形（構造化出力）
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'レシートの日付 YYYY-MM-DD。読めなければ空文字' },
    store: { type: 'string', description: '店名。読めなければ空文字' },
    total: { type: 'integer', description: '税込の支払合計（円）。読めなければ 0' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '品目名' },
          amount: { type: 'integer', description: '税込の金額（円）。値引きは反映済みの正の整数' },
          category: { type: 'string', description: '渡された分類リストの中から最も近いもの' }
        },
        required: ['name', 'amount', 'category'],
        additionalProperties: false
      }
    }
  },
  required: ['date', 'store', 'total', 'items'],
  additionalProperties: false
};

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (!body.image) throw new Error('画像がありません');
    const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('スクリプト プロパティ ANTHROPIC_API_KEY が設定されていません');

    const categories = Array.isArray(body.categories) && body.categories.length ? body.categories : ['食費', '日用品', 'その他'];
    const instruction =
      'これは日本のレシートの写真です。購入した品目と金額を読み取ってください。\n' +
      '- 金額は税込の円（整数）。外税表示なら税を按分して税込にし、値引き行は該当品目に反映する\n' +
      '- 小計・お預り・お釣り・ポイント・点数などの行は品目に含めない\n' +
      '- 品目名は略称をできるだけ一般的な名前に直す（例: ｷｬﾍﾞﾂ → キャベツ）\n' +
      '- category は次のリストから選ぶ: ' + categories.join(' / ') + '\n' +
      '- 日付は YYYY-MM-DD 形式。読めない項目は空文字または 0 にする';

    const payload = {
      model: MODEL,
      max_tokens: 4096,
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: body.mime || 'image/jpeg', data: body.image } },
          { type: 'text', text: instruction }
        ]
      }]
    };

    const res = UrlFetchApp.fetch(API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const status = res.getResponseCode();
    const json = JSON.parse(res.getContentText());
    if (status !== 200) throw new Error((json.error && json.error.message) || ('API エラー ' + status));
    if (json.stop_reason === 'refusal') throw new Error('この画像は読み取れませんでした（拒否されました）');

    const text = (json.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    const data = JSON.parse(text);
    return out({ ok: true, data: data, usage: json.usage });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

// ブラウザから直接開いたときの動作確認用
function doGet() {
  return out({ ok: true, message: 'receipt-ai is running. POST a JSON body { image, mime, categories }.' });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
