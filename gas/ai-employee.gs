/**
 * AI社員（会員名鑑コンシェルジュ）バックエンド
 * ------------------------------------------------------------
 * 既存の GAS プロジェクト（doGet で会員データを返しているもの）に
 * このファイルを追加し、「新しいデプロイ」として再デプロイしてください。
 *
 * 必要なスクリプトプロパティ（プロジェクトの設定 > スクリプトプロパティ）:
 *   ANTHROPIC_API_KEY : Anthropic の API キー（必須）
 *   MEMBER_PASSWORD   : 会員名鑑のログインパスワード（既存 doGet と同じ値）
 *   AI_MODEL          : 省略可。既定 "claude-opus-5"
 *   AI_EFFORT         : 省略可。low / medium / high。既定 "medium"
 *
 * フロントエンド（index.html）からは次の JSON が POST されます:
 *   { action: "chat", password: "...", members: [...], messages: [{role, content}, ...] }
 *
 * レスポンス:
 *   { ok: true, reply: "...", recommended: [{ id, reason }], model: "..." }
 *   { ok: false, error: "..." }
 */

var AI_DEFAULT_MODEL  = 'claude-opus-5';
var AI_DEFAULT_EFFORT = 'medium';
var AI_MAX_HISTORY    = 12;   // 直近の往復のみ送る（トークン節約）
var AI_MAX_TOKENS     = 4096;

/* ─── エントリポイント ───────────────────────────── */
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'リクエスト形式が不正です' });
  }

  if (!isValidPassword_(body.password)) {
    return jsonOut_({ ok: false, error: 'パスワードが違います' });
  }

  if (body.action !== 'chat') {
    return jsonOut_({ ok: false, error: '不明な操作です' });
  }

  try {
    var result = aiChat_(body.members || [], body.messages || []);
    return jsonOut_(Object.assign({ ok: true }, result));
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ─── 認証 ─────────────────────────────────────── */
function isValidPassword_(pw) {
  var expected = PropertiesService.getScriptProperties().getProperty('MEMBER_PASSWORD');
  if (!expected) throw new Error('MEMBER_PASSWORD が設定されていません');
  return !!pw && String(pw) === String(expected);
}

/* ─── AI社員 本体 ───────────────────────────────── */
function aiChat_(members, history) {
  var props  = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('AI社員は未設定です（ANTHROPIC_API_KEY がありません）');

  var model  = props.getProperty('AI_MODEL')  || AI_DEFAULT_MODEL;
  var effort = props.getProperty('AI_EFFORT') || AI_DEFAULT_EFFORT;

  var messages = sanitizeHistory_(history);
  if (!messages.length) throw new Error('メッセージが空です');

  var roster = buildRoster_(members);

  var payload = {
    model: model,
    max_tokens: AI_MAX_TOKENS,
    fallbacks: 'default',
    system: [
      { type: 'text', text: SYSTEM_PROMPT_ },
      // 会員一覧は会話中ほぼ不変なのでキャッシュ境界を置く
      { type: 'text', text: '## 会員一覧（JSON）\n' + roster,
        cache_control: { type: 'ephemeral' } }
    ],
    messages: messages,
    output_config: {
      effort: effort,
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            reply: { type: 'string',
              description: '利用者への返答（日本語・Markdown不可・プレーンテキスト）' },
            recommended: {
              type: 'array',
              description: '返答内で紹介した会員。該当がなければ空配列',
              items: {
                type: 'object',
                properties: {
                  id:     { type: 'string', description: '会員一覧の id（例 "M3"）' },
                  reason: { type: 'string', description: 'おすすめ理由（40字以内）' }
                },
                required: ['id', 'reason'],
                additionalProperties: false
              }
            }
          },
          required: ['reply', 'recommended'],
          additionalProperties: false
        }
      }
    }
  };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
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

  var code = res.getResponseCode();
  var data = JSON.parse(res.getContentText() || '{}');

  if (code !== 200) {
    var msg = (data.error && data.error.message) || ('API エラー (' + code + ')');
    throw new Error(msg);
  }
  if (data.stop_reason === 'refusal') {
    return { reply: 'ごめんなさい、この内容にはお答えできません。別の聞き方で試してみてください。',
             recommended: [], model: data.model };
  }

  var text = '';
  for (var i = 0; i < (data.content || []).length; i++) {
    if (data.content[i].type === 'text') { text = data.content[i].text; break; }
  }
  var parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { parsed = { reply: text || '（応答を取得できませんでした）', recommended: [] }; }

  // id の妥当性チェック（存在しない id は捨てる）
  var validIds = {};
  members.forEach(function (_, idx) { validIds['M' + (idx + 1)] = true; });
  parsed.recommended = (parsed.recommended || []).filter(function (r) {
    return r && validIds[r.id];
  });

  return { reply: parsed.reply || '', recommended: parsed.recommended, model: data.model };
}

/* ─── ヘルパー ──────────────────────────────────── */
var SYSTEM_PROMPT_ =
  'あなたは会員コミュニティの「AI社員」です。会員名鑑をもとに、会員同士のマッチングや紹介、' +
  '相談への回答を行います。\n\n' +
  '役割:\n' +
  '- 「○○ができる人」「○○を探している人」などの相談に、会員一覧から該当者を選んで紹介する\n' +
  '- 相性の良さそうな会員同士を提案し、つなぐ理由を具体的に述べる\n' +
  '- 紹介文・自己紹介文・メッセージ文案の作成を手伝う\n' +
  '- 会員一覧に載っていないことは推測せず、「名鑑に情報がありません」と正直に伝える\n\n' +
  'ルール:\n' +
  '- 日本語で、親しみやすく簡潔に（長くても400字程度）\n' +
  '- 紹介する会員は reply 本文で名前を挙げ、必ず recommended にも id を入れる（最大5名）\n' +
  '- 会員一覧に含まれない人物・会社を作り出さない\n' +
  '- 連絡先（電話・メール等）は一覧に含まれていないので、「名鑑のカードから連絡できます」と案内する\n' +
  '- Markdown 記法は使わず、プレーンテキストで書く（改行は使ってよい）';

function buildRoster_(members) {
  var compact = members.map(function (m, idx) {
    return {
      id:      'M' + (idx + 1),
      name:    m.name    || '',
      company: m.company || '',
      job:     m.job     || '',
      type:    m.type    || '',
      venue:   m.venue   || '',
      needs:   Array.isArray(m.needs) ? m.needs : [],
      detail:  m.detail  || ''
    };
  });
  return JSON.stringify(compact);
}

function sanitizeHistory_(history) {
  var out = [];
  (history || []).forEach(function (m) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return;
    var text = String(m.content || '').trim();
    if (!text) return;
    out.push({ role: m.role, content: text });
  });
  // 直近 AI_MAX_HISTORY 件に絞り、先頭が user になるよう調整
  out = out.slice(-AI_MAX_HISTORY);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
