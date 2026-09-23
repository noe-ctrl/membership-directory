/**
 * 家計簿アプリ用 スプレッドシート同期（Google Apps Script）
 *
 * セットアップ:
 *  1. https://script.google.com で新しいプロジェクトを作り、このファイルの内容を貼り付ける
 *  2. 「プロジェクトの設定」→「スクリプト プロパティ」に
 *       SYNC_KEY = （好きな長めの文字列。家計簿アプリ側にも同じ値を入れる）
 *     を追加する。SPREADSHEET_ID は初回同期時に自動で作成・保存される
 *     （既存のシートを使う場合はそのIDを SPREADSHEET_ID に入れる）
 *  3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *     でデプロイし、発行された URL（…/exec）を家計簿アプリの
 *     「設定 → スプレッドシート同期」に貼り付ける
 *
 * 仕組み:
 *  - 「entries」シートに明細を1行1件で保存（削除は deleted=1 の印を付けて残す）
 *  - 「meta」シートに分類・口座・予算・定期収支などをセクションごとに JSON で保存
 *  - 端末から「前回同期以降に変わった明細」と「消した明細のID」を受け取り、
 *    サーバー側で前回同期以降に他の端末が変更したものは他端末の変更を優先する
 *  - 端末には「前回同期以降にサーバーで変わった明細」を返す
 */

const COLS = ['id', 'date', 'type', 'category', 'item', 'amount', 'memo', 'account', 'toAccount', 'store', 'receiptId', 'ruleId', 'ruleMonth', 'autoPay', 'updatedAt', 'deleted'];
const META_SECTIONS = ['categories', 'accounts', 'budgets', 'recurring', 'favorites', 'startDay'];

// シートが日付や数値に自動変換した値を文字列に戻す
function asText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const props = PropertiesService.getScriptProperties();
    const key = props.getProperty('SYNC_KEY');
    if (!key) throw new Error('スクリプト プロパティ SYNC_KEY が設定されていません');
    if (String(body.key || '') !== key) throw new Error('同期キーが違います');

    const ss = getSpreadsheet_(props);
    const sheet = getSheet_(ss, 'entries', COLS);
    const metaSheet = getSheet_(ss, 'meta', ['section', 'json', 'updatedAt']);
    const now = Date.now();
    const since = Number(body.since) || 0;

    // 既存データを読み込む
    const values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, COLS.length).getValues() : [];
    const rows = new Map();
    values.forEach(function (v) {
      const o = {}; COLS.forEach(function (c, i) { o[c] = asText_(v[i]); });
      o.updatedAt = Number(o.updatedAt) || 0; o.deleted = Number(o.deleted) ? 1 : 0; o.amount = Number(o.amount) || 0;
      if (o.id) rows.set(String(o.id), o);
    });

    const accepted = new Set();
    let changedSheet = false;
    (body.entries || []).forEach(function (ce) {
      if (!ce || !ce.id) return;
      const id = String(ce.id);
      const ex = rows.get(id);
      if (ex && ex.updatedAt > since) return; // 他端末が先に変更 → サーバー側を優先（応答で返す）
      const o = { id: id, date: String(ce.date || ''), type: String(ce.type || 'expense'), category: String(ce.category || ''), item: String(ce.item || ''),
        amount: Number(ce.amount) || 0, memo: String(ce.memo || ''), account: String(ce.account || ''), toAccount: String(ce.toAccount || ''),
        store: String(ce.store || ''), receiptId: String(ce.receiptId || ''), ruleId: String(ce.ruleId || ''), ruleMonth: String(ce.ruleMonth || ''), autoPay: String(ce.autoPay || ''), updatedAt: now, deleted: 0 };
      rows.set(id, o); accepted.add(id); changedSheet = true;
    });
    (body.deleted || []).forEach(function (id) {
      id = String(id);
      const ex = rows.get(id);
      if (!ex || ex.deleted) return;
      if (ex.updatedAt > since) return; // 他端末が変更していたら削除しない
      ex.deleted = 1; ex.updatedAt = now; accepted.add(id); changedSheet = true;
    });

    if (changedSheet) {
      const out = [];
      rows.forEach(function (o) { out.push(COLS.map(function (c) { return o[c] == null ? '' : o[c]; })); });
      sheet.getRange(2, 1, Math.max(1, sheet.getMaxRows() - 1), COLS.length).clearContent();
      if (out.length) {
        const range = sheet.getRange(2, 1, out.length, COLS.length);
        range.setNumberFormat('@'); // 日付や "1,000" などの自動変換を防ぐ
        range.setValues(out);
      }
    }

    // meta（分類・口座・予算など）: セクションごとに更新時刻を持ち、他端末が先に変更したセクションはそちらを優先
    const meta = readMeta_(metaSheet);
    const metaOut = {}; let metaOutAny = false, metaWrite = false;
    const sent = (body.meta && typeof body.meta === 'object') ? body.meta : {};
    META_SECTIONS.forEach(function (k) {
      const srv = meta[k];
      if (k in sent) {
        if (srv && srv.updatedAt > since) { metaOut[k] = JSON.parse(srv.json); metaOutAny = true; }
        else { meta[k] = { json: JSON.stringify(sent[k]), updatedAt: now }; metaWrite = true; }
      } else if (srv && srv.updatedAt > since) { metaOut[k] = JSON.parse(srv.json); metaOutAny = true; }
    });
    if (metaWrite) writeMeta_(metaSheet, meta);

    // 応答
    const entries = [], deleted = [];
    rows.forEach(function (o, id) {
      if (accepted.has(id) || o.updatedAt <= since) return;
      if (o.deleted) deleted.push(id);
      else { const c = {}; COLS.forEach(function (k) { if (k !== 'deleted' && o[k] !== '' && o[k] != null) c[k] = o[k]; }); entries.push(c); }
    });
    return out_({ ok: true, serverTime: now, entries: entries, deleted: deleted, meta: metaOutAny ? metaOut : null });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return out_({ ok: true, message: 'kakeibo sync is running.' });
}

function getSpreadsheet_(props) {
  let id = props.getProperty('SPREADSHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* 作り直す */ } }
  const ss = SpreadsheetApp.create('家計簿データ');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}
function getSheet_(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, header.length).setValues([header]); sh.setFrozenRows(1); }
  return sh;
}
function readMeta_(sh) {
  const n = sh.getLastRow();
  const res = {};
  if (n < 2) return res;
  sh.getRange(2, 1, n - 1, 3).getValues().forEach(function (r) {
    const k = String(r[0] || '');
    if (META_SECTIONS.indexOf(k) >= 0 && r[1]) res[k] = { json: String(r[1]), updatedAt: Number(r[2]) || 0 };
  });
  return res;
}
function writeMeta_(sh, meta) {
  const rows = META_SECTIONS.filter(function (k) { return meta[k]; }).map(function (k) { return [k, meta[k].json, meta[k].updatedAt]; });
  sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), 3).clearContent();
  if (rows.length) { const r = sh.getRange(2, 1, rows.length, 3); r.setNumberFormat('@'); r.setValues(rows); }
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
