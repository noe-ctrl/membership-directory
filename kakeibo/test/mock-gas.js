/**
 * gas/sync.gs と gas/receipt-ai.gs をローカルで動かすための擬似 Google Apps Script 環境。
 * SpreadsheetApp / PropertiesService / LockService / ContentService をメモリ上で再現し、
 * HTTP サーバーとして doPost を公開する（テスト専用。本番では使わない）。
 *
 *   node kakeibo/test/mock-gas.js [port]   → http://127.0.0.1:8766/exec で待ち受け
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

function createSheet(name) {
  const sh = { name, rows: [], frozen: 0, textFmt: new Set() };
  sh.getLastRow = () => sh.rows.length;
  sh.getMaxRows = () => Math.max(sh.rows.length, 1000);
  sh.setFrozenRows = n => { sh.frozen = n; };
  sh.getRange = (r, c, nr, nc) => ({
    getValues() {
      const out = [];
      for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i] || []; out.push(Array.from({ length: nc }, (_, j) => row[c - 1 + j] === undefined ? '' : row[c - 1 + j])); }
      return out;
    },
    setValues(vals) {
      // 本物のシートと同様、書式が「書式なしテキスト(@)」でないセルでは日付文字列を Date に自動変換する
      vals.forEach((v, i) => { const idx = r - 1 + i; while (sh.rows.length <= idx) sh.rows.push([]); v.forEach((x, j) => {
        const key = idx + ':' + (c - 1 + j);
        sh.rows[idx][c - 1 + j] = (!sh.textFmt.has(key) && typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) ? new Date(x + 'T00:00:00+09:00') : x;
      }); });
    },
    setNumberFormat(fmt) {
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) { const key = (r - 1 + i) + ':' + (c - 1 + j); if (fmt === '@') sh.textFmt.add(key); else sh.textFmt.delete(key); }
      return this;
    },
    clearContent() {
      for (let i = 0; i < nr; i++) { const idx = r - 1 + i; if (sh.rows[idx]) for (let j = 0; j < nc; j++) sh.rows[idx][c - 1 + j] = ''; }
      while (sh.rows.length && sh.rows[sh.rows.length - 1].every(x => x === '' || x === undefined)) sh.rows.pop();
    }
  });
  return sh;
}
function createEnv(props) {
  const spreadsheets = {};
  const SpreadsheetApp = {
    create(name) { const id = 'ss_' + Object.keys(spreadsheets).length; const sheets = {}; spreadsheets[id] = { getId: () => id, getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = createSheet(n)) }; return spreadsheets[id]; },
    openById(id) { if (!spreadsheets[id]) throw new Error('not found'); return spreadsheets[id]; }
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const ContentService = { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) };
  // Anthropic API の代わりに固定のレシート読み取り結果を返す
  const FAKE_RECEIPT = { date: '2026-09-09', store: 'モックスーパー', total: 406, items: [{ name: 'キャベツ', amount: 158, category: '食費' }, { name: '牛乳', amount: 248, category: '食費' }] };
  const UrlFetchApp = { fetch(url, opt) {
    const req = JSON.parse(opt.payload || '{}');
    if (!opt.headers || !opt.headers['x-api-key']) return { getResponseCode: () => 401, getContentText: () => JSON.stringify({ error: { message: 'no key' } }) };
    const img = req.messages && req.messages[0].content.find(c => c.type === 'image');
    if (!img || !img.source.data) return { getResponseCode: () => 400, getContentText: () => JSON.stringify({ error: { message: 'no image' } }) };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(FAKE_RECEIPT) }], usage: {} }) };
  } };
  const Session = { getScriptTimeZone: () => 'Asia/Tokyo' };
  const nodeCrypto = require('crypto');
  const Utilities = {
    formatDate(d, tz, fmt) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); },
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest(alg, s, cs) { return [...nodeCrypto.createHash(alg).update(String(s), cs).digest()].map(b => (b > 127 ? b - 256 : b)); }
  };
  return { SpreadsheetApp, PropertiesService, LockService, ContentService, UrlFetchApp, Session, Utilities, spreadsheets };
}
function loadGas(file, env) {
  const code = fs.readFileSync(file, 'utf8');
  const fn = new Function('SpreadsheetApp', 'PropertiesService', 'LockService', 'ContentService', 'UrlFetchApp', 'Session', 'Utilities', code + '\n;return { doPost: typeof doPost === "function" ? doPost : null, doGet: typeof doGet === "function" ? doGet : null };');
  return fn(env.SpreadsheetApp, env.PropertiesService, env.LockService, env.ContentService, env.UrlFetchApp, env.Session, env.Utilities);
}
function start(port, opts) {
  opts = opts || {};
  const env = createEnv(Object.assign({ SYNC_KEY: 'testkey', OCR_KEY: 'ocrkey', ANTHROPIC_API_KEY: 'sk-test' }, opts.props || {}));
  const sync = loadGas(path.join(__dirname, '..', 'gas', 'sync.gs'), env);
  const ocr = loadGas(path.join(__dirname, '..', 'gas', 'receipt-ai.gs'), env);
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const app = req.url.startsWith('/ocr') ? ocr : sync;
        const out = req.method === 'POST' ? app.doPost({ postData: { contents: body } }) : app.doGet();
        res.writeHead(200, cors); res.end(out.text);
      } catch (e) { res.writeHead(500, cors); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, env })));
}
module.exports = { start, createEnv, loadGas };
if (require.main === module) {
  const port = Number(process.argv[2]) || 8766;
  start(port).then(() => console.log('mock GAS listening on http://127.0.0.1:' + port + '/exec (SYNC_KEY=testkey) and /ocr (OCR_KEY=ocrkey)'));
}
