/**
 * 家計簿アプリの自動テスト（Playwright + Chromium）
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node kakeibo/test/e2e.js            # 失敗があると終了コード 1
 *   SHOTS=1 node kakeibo/test/e2e.js    # スクリーンショットを kakeibo/test/shots/ に保存
 *
 * 静的サーバーと擬似GAS（同期サーバー）を自分で起動するので、他に準備は不要です。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const mock = require('./mock-gas');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); } catch (e2) { console.error('playwright が見つかりません: npm i -D playwright'); process.exit(2); } }

const ROOT = path.join(__dirname, '..');
const PORT = 8765, SYNC_PORT = 8766;
const SHOTS = process.env.SHOTS ? path.join(__dirname, 'shots') : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kakeibo-'));
const results = [];
const check = (label, ok, extra) => { results.push({ label, ok }); console.log((ok ? '  OK  ' : '  NG  ') + label + (extra && !ok ? '  |  ' + extra : '')); };
const shot = (page, name) => SHOTS ? page.screenshot({ path: path.join(SHOTS, name + '.png') }) : Promise.resolve();
const wait = ms => new Promise(r => setTimeout(r, ms));

function serveStatic() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function addMonths(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function ymd(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }

async function newPage(browser, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ja-JP', acceptDownloads: true }, opts || {}));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) page.errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined));
  await page.goto('http://127.0.0.1:' + PORT + '/index.html');
  await page.waitForSelector('#view-input.active');
  return page;
}
const text = async (page, sel) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ');

(async () => {
  const staticSrv = await serveStatic();
  const { server: syncSrv } = await mock.start(SYNC_PORT);
  const browser = await chromium.launch();
  const today = todayStr(), thisYm = today.slice(0, 7), prevYm = addMonths(thisYm, -1);
  const [Y, M] = thisYm.split('-').map(Number);
  try {
    const page = await newPage(browser);

    // ── 基本入力・振替 ──
    await page.fill('#in-amount', '1,234');
    await page.selectOption('#in-account', '現金');
    await page.click('#in-cats .chip:nth-child(1)');
    await page.click('#in-items .chip:nth-child(1)');
    await page.fill('#in-memo', 'テスト');
    await page.click('button:has-text("保存する")');
    check('支出の保存', (await text(page, '#day-entries')).includes('スーパー'));
    await page.click('#type-inc');
    await page.fill('#in-amount', '300000'); await page.selectOption('#in-account', '銀行口座');
    await page.click('button:has-text("保存する")');
    await page.click('#type-trn');
    await page.selectOption('#in-from', '銀行口座'); await page.selectOption('#in-to', '現金');
    await page.fill('#in-amount', '20000');
    await page.click('button:has-text("保存する")');
    check('振替の保存', (await text(page, '#day-entries')).includes('銀行口座 → 現金'));
    await shot(page, '01-input');

    // ── お気に入り・履歴・複製 ──
    await page.click('#type-exp');
    await page.click('#in-cats .chip:nth-child(2)');
    await page.fill('#in-item', 'トイレットペーパー'); await page.fill('#in-amount', '398');
    await page.click('#fav-add-btn'); // prompt は自動で既定値を受け入れる
    await wait(100);
    check('お気に入り登録', (await text(page, '#fav-row')).includes('トイレットペーパー'));
    await page.fill('#in-amount', ''); await page.fill('#in-item', '');
    await page.click('#fav-row .chip');
    check('お気に入りで入力欄が埋まる', (await page.inputValue('#in-amount')) === '398' && (await page.inputValue('#in-item')) === 'トイレットペーパー');
    await page.click('button:has-text("保存する")');
    await page.click('#view-input .entry:has-text("トイレットペーパー")');
    await page.waitForSelector('#modal.open');
    await page.click('button:has-text("複製して入力")');
    await wait(100);
    check('明細の複製', (await page.inputValue('#in-amount')) === '398' && !(await page.isVisible('#modal.open')));
    await page.fill('#in-amount', '');
    check('保存した項目が候補に出る', (await text(page, '#in-items')).includes('トイレットペーパー'));

    // ── 削除の取り消し ──
    await page.click('#view-input .entry:has-text("トイレットペーパー")');
    await page.waitForSelector('#modal.open');
    await page.click('button:has-text("この明細を削除")');
    await wait(100);
    check('削除後に取り消しボタン', (await text(page, '#toast')).includes('元に戻す'));
    await page.click('#toast .toast-btn');
    await wait(100);
    check('削除の取り消し', (await text(page, '#day-entries')).includes('トイレットペーパー'));

    // ── 編集の検証エラーで明細が壊れない ──
    await page.click('#view-input .entry:has-text("トイレットペーパー")');
    await page.waitForSelector('#modal.open');
    await page.selectOption('#m-e-type', 'transfer');
    await page.selectOption('#m-e-from', '現金'); await page.selectOption('#m-e-to', '現金');
    await page.click('#modal-box button:has-text("保存する")'); await wait(100);
    check('不正な振替編集は拒否', await page.isVisible('#modal.open'));
    await page.click('.modal-close');
    const tp = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.find(e => e.item === 'トイレットペーパー'));
    check('拒否された編集は反映されない', tp.type === 'expense' && tp.category === '日用品', JSON.stringify(tp));

    // ── レシート入力 ──
    await page.click('button:has-text("レシートをまとめて入力")');
    await page.waitForSelector('#rc-lines');
    await page.fill('#rc-store', 'テストスーパー');
    await page.fill('#rc-lines .rc-item >> nth=0', 'キャベツ'); await page.fill('#rc-lines .rc-amt >> nth=0', '158');
    await page.click('button:has-text("＋ 行を追加")');
    await page.fill('#rc-lines .rc-item >> nth=1', '牛乳'); await page.fill('#rc-lines .rc-amt >> nth=1', '248');
    await page.fill('#rc-total', '406');
    check('レシート合計の照合', (await text(page, '#rc-diff')).includes('一致'));
    await page.click('button:has-text("まとめて保存する")');
    await wait(100);
    check('レシート保存', (await text(page, '#day-entries')).includes('テストスーパー'));

    // ── CSV取り込みと取り消し（前月・カード利用を含む） ──
    const csvPath = path.join(TMP, 'import.csv');
    const prevDate = prevYm + '-05';
    const cardDate = addMonths(thisYm, -3) + '-20'; // 3か月前の20日 → 2か月前15日締め → 前月10日引き落とし（必ず過去）
    fs.writeFileSync(csvPath, '﻿日付,収支,分類,項目,金額,メモ,支払方法,振替先\n' + prevDate.replace(/-/g, '/') + ',支出,食費,外食,2600,ランチ,現金,\n' + cardDate.replace(/-/g, '/') + ',支出,趣味・娯楽,書籍,3000,,クレジットカード,\n' + prevDate.replace(/-/g, '/') + ',振替,,,7000,,現金,銀行口座\n');
    await page.click('[data-view=settings]');
    let [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=CSVファイルを選ぶ')]);
    await fc.setFiles(csvPath);
    await page.waitForSelector('#modal.open');
    check('取り込みプレビュー', (await text(page, '#modal-box')).includes('3件を取り込む'));
    await page.click('button:has-text("件を取り込む")');
    await page.waitForSelector('#view-list.active');
    check('取り込み後のトーストに取り消し', (await text(page, '#toast')).includes('取り消す'));
    await page.click('[data-view=settings]');
    check('設定に取り消しボタン', (await text(page, '#import-undo')).includes('3件'));
    // 取り消してから再取り込み
    await page.click('#import-undo button');
    await wait(100);
    check('取り込みの取り消し', !(await text(page, '#stats-hint')).includes(prevDate.replace(/-/g, '/')) && (await text(page, '#import-undo')) === '');
    [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=CSVファイルを選ぶ')]);
    await fc.setFiles(csvPath);
    await page.waitForSelector('#modal.open');
    await page.click('button:has-text("件を取り込む")');
    await page.waitForSelector('#view-list.active');

    // ── 全期間検索 ──
    await page.click('.today-btn');
    await page.fill('#list-q', 'ランチ');
    check('月内検索は空', (await text(page, '#list-body')).includes('該当する明細がありません'));
    await page.check('#list-all');
    check('全期間検索', (await text(page, '#list-body')).includes('全期間の検索結果: 1件'));
    await page.uncheck('#list-all'); await page.fill('#list-q', '');

    // ── 集計: 前月比・推移 ──
    await page.click('[data-view=report]');
    const rep = await text(page, '#report-body');
    check('前月比の表示', rep.includes('前月') && rep.includes('推移（12か月）'));
    await page.selectOption('#report-body select', '食費');
    check('分類別の推移', (await text(page, '#report-body')).includes('食費の12か月の推移') || (await page.innerHTML('#report-body')).includes('食費の12か月の推移'));
    await shot(page, '02-report');

    // ── 予算: この月だけ上書き ──
    await page.click('[data-view=budget]');
    await page.fill('.brow input >> nth=0', '200000'); await page.press('.brow input >> nth=0', 'Tab'); await wait(100);
    await page.check('#budget-ov'); await wait(100);
    await page.fill('.brow input >> nth=0', '150000'); await page.press('.brow input >> nth=0', 'Tab'); await wait(100);
    check('月別予算の上書き', (await text(page, '#budget-body')).includes('この月のみ') && (await page.inputValue('.brow input >> nth=0')) === '150,000');
    await page.click('#month-nav .nav-btn >> nth=0'); await wait(80);
    check('他の月は共通予算', (await page.inputValue('.brow input >> nth=0')) === '200,000');
    await page.click('.today-btn');

    // ── 分類の色 ──
    await page.click('[data-view=settings]');
    await page.click('#cat-list .cat-item >> nth=0 >> button[title="編集"]');
    await page.waitForSelector('#m-cat-colors');
    await page.click('#m-cat-colors .swatch >> nth=7');
    await page.click('#modal-box button:has-text("保存する")');
    await wait(100);
    check('分類の色を変更', (await page.getAttribute('#cat-list .cat-item >> nth=0 >> .cdot', 'style')).includes('#e34948'));
    // 分類名の変更がお気に入り・予算に追随
    await page.click('[data-view=budget]');
    await page.fill('.brow input >> nth=2', '12000'); await page.press('.brow input >> nth=2', 'Tab'); await wait(100); // 日用品（2番目の分類）
    await page.click('[data-view=settings]');
    await page.click('#cat-list .cat-item >> nth=1 >> button[title="編集"]');
    await page.waitForSelector('#m-cat-name');
    await page.fill('#m-cat-name', '日用雑貨');
    await page.click('#modal-box button:has-text("保存する")'); await wait(100);
    // （この月は「この月だけの予算」が有効なので、12000 は月別予算に入る）
    const afterRename = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('kakeibo.v1')); const ov = Object.values(d.budgets.overrides)[0].categories; return { fav: d.favorites[0].category, ov: ov['日用雑貨'], old: ov['日用品'], entry: d.entries.some(e => e.category === '日用品') }; });
    check('分類名の変更がお気に入り・予算・明細に追随', afterRename.fav === '日用雑貨' && afterRename.ov === 12000 && !afterRename.old && !afterRename.entry, JSON.stringify(afterRename));

    // ── 月の開始日（締め日） ──
    await page.selectOption('#set-startday', '25');
    await wait(100);
    await page.click('[data-view=calendar]');
    const lbl = await text(page, '#month-label');
    check('締め日設定で期間表示', /〜/.test(lbl));
    const cells = await page.$$eval('.cal .cell:not(.blank)', l => l.length);
    check('カレンダーが期間の日数分', cells >= 28 && cells <= 31, String(cells));
    await shot(page, '03-calendar-startday');
    await page.click('[data-view=settings]');
    await page.selectOption('#set-startday', '1'); await wait(100);

    // ── カードの引き落とし自動振替 ──
    await page.click('#acct-list .cat-item:has-text("クレジットカード") >> button[title="編集"]');
    await page.waitForSelector('#m-a-card');
    await page.check('#m-a-card');
    await page.selectOption('#m-a-closing', '15'); await page.selectOption('#m-a-payday', '10'); await page.selectOption('#m-a-payacc', '銀行口座');
    await page.click('#modal-box button:has-text("保存する")');
    await wait(150);
    // 過去分を対象にするため payFrom を3か月前に書き換えて再読み込み
    await page.evaluate(ym => { const d = JSON.parse(localStorage.getItem('kakeibo.v1')); d.accounts.forEach(a => { if (a.card) a.payFrom = ym; }); localStorage.setItem('kakeibo.v1', JSON.stringify(d)); }, addMonths(thisYm, -3));
    await page.reload(); await page.waitForSelector('#view-input.active');
    const autoPay = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.filter(e => e.autoPay));
    check('引き落とし振替の自動作成', autoPay.length === 1 && autoPay[0].amount === 3000 && autoPay[0].account === '銀行口座' && autoPay[0].toAccount === 'クレジットカード', JSON.stringify(autoPay));
    await page.reload(); await page.waitForSelector('#view-input.active');
    check('引き落とし振替は二重に作られない', (await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.filter(e => e.autoPay).length)) === 1);
    // 口座名の変更がカードの引き落とし口座に追随
    await page.click('[data-view=settings]');
    await page.click('#acct-list .cat-item:has-text("銀行口座") >> button[title="編集"]');
    await page.waitForSelector('#m-a-name');
    await page.fill('#m-a-name', 'ゆうちょ');
    await page.click('#modal-box button:has-text("保存する")'); await wait(150);
    const acc = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('kakeibo.v1')); return { pay: d.accounts.find(a => a.card).payAccount, ghost: d.accounts.filter(a => a.name === '銀行口座').length, entries: d.entries.some(e => e.account === '銀行口座' || e.toAccount === '銀行口座') }; });
    check('口座名の変更が引き落とし口座・明細に追随', acc.pay === 'ゆうちょ' && acc.ghost === 0 && !acc.entries, JSON.stringify(acc));
    // 年間集計: 締め日ありでも分類別合計と年間支出が一致
    await page.selectOption('#set-startday', '25'); await wait(100);
    await page.click('[data-view=report]'); await page.click('#rep-year'); await wait(100);
    const yr = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('#report-body .tile')].map(t => t.textContent);
      const ex = Number((tiles[1].match(/¥([\d,]+)/) || [])[1].replace(/,/g, ''));
      const cards = [...document.querySelectorAll('#report-body .card')];
      const catCard = cards.find(c => c.textContent.includes('分類別の支出'));
      const sum = catCard ? [...catCard.querySelectorAll('.lrow .a')].reduce((s, el) => s + Number(el.textContent.replace(/[¥,]/g, '')), 0) : -1;
      return { ex, sum };
    });
    check('年間の分類別合計が年間支出と一致（締め日あり）', yr.ex === yr.sum, JSON.stringify(yr));
    await page.click('#rep-month');
    await page.click('[data-view=settings]'); await page.selectOption('#set-startday', '1'); await wait(100);

    // ── 暗証番号ロック ──
    await page.click('[data-view=settings]');
    await page.click('text=暗証番号を設定');
    await page.fill('#m-p-new', '1234'); await page.fill('#m-p-new2', '1234');
    await page.click('#modal-box button:has-text("保存する")'); await wait(100);
    await page.reload(); await page.waitForSelector('#lock.open');
    await page.fill('#lock-pin', '9999'); await page.click('#lock button');
    check('誤った暗証番号を拒否', (await text(page, '#lock-err')).includes('違います'));
    await page.fill('#lock-pin', '1234'); await page.press('#lock-pin', 'Enter'); await wait(100);
    check('暗証番号で解除', !(await page.isVisible('#lock')));
    // ── 暗号化 ──
    await page.click('[data-view=settings]');
    await page.click('text=データを暗号化する');
    await page.fill('#m-p-cur', '1234'); await page.fill('#m-p-confirm', '暗号化');
    await page.click('#modal-box button:has-text("暗号化する")'); await wait(1500);
    const rawEnc = await page.evaluate(() => localStorage.getItem('kakeibo.v1'));
    check('保存データが暗号化される', rawEnc.includes('"enc":1') && !rawEnc.includes('"entries"') && !rawEnc.includes('テスト'), rawEnc.slice(0, 60));
    await page.reload(); await page.waitForSelector('#lock.open');
    await page.fill('#lock-pin', '9999'); await page.click('#lock button'); await wait(800);
    check('誤った暗証番号では復号されない', (await text(page, '#lock-err')).includes('違います'));
    await page.fill('#lock-pin', '1234'); await page.press('#lock-pin', 'Enter');
    try { await page.waitForFunction(() => !document.getElementById('lock').classList.contains('open'), null, { timeout: 10000 }); }
    catch (e) { check('復号の完了', false, 'lock-err=' + await text(page, '#lock-err') + ' errors=' + page.errors.join('/')); }
    await wait(300);
    check('復号後にデータが読める', (await text(page, '#day-entries')).includes('トイレットペーパー'));
    await page.fill('#in-amount', '55'); await page.click('button:has-text("保存する")'); await wait(800);
    const rawEnc2 = await page.evaluate(() => localStorage.getItem('kakeibo.v1'));
    check('暗号化中の保存も暗号化される', rawEnc2.includes('"enc":1') && !rawEnc2.includes('"entries"'));
    await page.click('[data-view=settings]');
    await page.click('text=暗号化をやめる');
    await page.fill('#m-p-cur', '1234'); await page.click('#modal-box button:has-text("暗号化をやめる")'); await wait(300);
    const rawPlain = await page.evaluate(() => localStorage.getItem('kakeibo.v1'));
    check('暗号化の解除で平文に戻る', rawPlain.includes('"entries"') && JSON.parse(rawPlain).entries.some(e => e.amount === 55));
    await page.click('text=ロックを解除する');
    await page.fill('#m-p-cur', '1234'); await page.click('#modal-box button:has-text("ロックを解除する")'); await wait(100);

    // ── スプレッドシート同期（2端末） ──
    const syncUrl = 'http://127.0.0.1:' + SYNC_PORT + '/exec';
    await page.fill('#set-sync-key', 'testkey'); await page.press('#set-sync-key', 'Tab');
    await page.fill('#set-sync-url', syncUrl); await page.press('#set-sync-url', 'Tab');
    await wait(800);
    check('端末Aの初回同期', (await text(page, '#sync-status')).includes('最終同期'), await text(page, '#sync-status'));
    const countA = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.length);

    const pageB = await newPage(browser);
    await pageB.click('[data-view=settings]');
    await pageB.fill('#set-sync-key', 'testkey'); await pageB.press('#set-sync-key', 'Tab');
    await pageB.fill('#set-sync-url', syncUrl); await pageB.press('#set-sync-url', 'Tab');
    await wait(800);
    const countB = await pageB.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.length);
    check('端末Bが端末Aの明細を受信', countB === countA, countA + ' vs ' + countB);
    check('端末Bが分類の色（meta）を受信', (await pageB.getAttribute('#cat-list .cat-item >> nth=0 >> .cdot', 'style')).includes('#e34948'));
    // B で追加 → A で受信
    await pageB.click('[data-view=input]');
    await pageB.fill('#in-amount', '777'); await pageB.fill('#in-memo', '端末Bから');
    await pageB.click('button:has-text("保存する")');
    await wait(4800); // 自動同期（4秒デバウンス）
    await page.click('[data-view=settings]'); await page.click('text=今すぐ同期'); await wait(600);
    const hasB = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.some(e => e.memo === '端末Bから'));
    check('端末Aが端末Bの追加を受信', hasB);
    // A で削除 → B で反映
    await page.click('[data-view=list]');
    await page.click('#view-list .entry:has-text("端末Bから")');
    await page.waitForSelector('#modal.open');
    await page.click('button:has-text("この明細を削除")');
    await wait(4800);
    await pageB.click('[data-view=settings]'); await pageB.click('text=今すぐ同期'); await wait(600);
    const stillB = await pageB.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.some(e => e.memo === '端末Bから'));
    check('端末Bで削除が反映', !stillB);
    // 同じ明細を両端末で編集 → 先に同期した方が勝つ
    const targetId = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.find(e => e.memo === 'テスト').id);
    const editMemo = async (pg, memo) => { await pg.evaluate(([id, m]) => { const d = JSON.parse(localStorage.getItem('kakeibo.v1')); d.entries.find(e => e.id === id).memo = m; localStorage.setItem('kakeibo.v1', JSON.stringify(d)); }, [targetId, memo]); await pg.reload(); await pg.waitForSelector('#view-input.active'); await pg.click('[data-view=settings]'); };
    await editMemo(page, 'A編集'); await editMemo(pageB, 'B編集');
    await page.click('text=今すぐ同期'); await wait(600);
    await pageB.click('text=今すぐ同期'); await wait(600);
    const memoB = await pageB.evaluate(id => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.find(e => e.id === id).memo, targetId);
    check('競合は先に同期した端末を優先', memoB === 'A編集', memoB);
    // 設定はセクション単位でマージ: A が予算、B がお気に入りを別々に変更しても両方残る
    await page.click('[data-view=budget]');
    await page.fill('.brow input >> nth=0', '333000'); await page.press('.brow input >> nth=0', 'Tab'); await wait(100);
    await page.click('[data-view=settings]'); await page.click('text=今すぐ同期'); await wait(600);
    await pageB.click('[data-view=input]');
    await pageB.fill('#in-amount', '120'); await pageB.fill('#in-item', 'ガム');
    await pageB.click('#fav-add-btn'); await wait(100);
    await pageB.click('[data-view=settings]'); await pageB.click('text=今すぐ同期'); await wait(600);
    const mergedB = await pageB.evaluate(ym => { const d = JSON.parse(localStorage.getItem('kakeibo.v1')); return { total: d.budgets.overrides[ym] ? d.budgets.overrides[ym].total : d.budgets.total, fav: d.favorites.some(f => f.item === 'ガム') }; }, thisYm);
    await page.click('text=今すぐ同期'); await wait(600);
    const mergedA = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).favorites.some(f => f.item === 'ガム'));
    check('設定のセクション別マージ（Bに予算が届きお気に入りも残る）', mergedB.total === 333000 && mergedB.fav, JSON.stringify(mergedB));
    check('設定のセクション別マージ（AにBのお気に入りが届く）', mergedA);
    await shot(page, '04-settings');

    // ── 改ざんされたバックアップ・分類名からスクリプトが実行されない ──
    const evil = await newPage(browser);
    await evil.evaluate(() => { window.__xss = 0; });
    const evilBackup = path.join(TMP, 'evil.json');
    fs.writeFileSync(evilBackup, JSON.stringify({
      entries: [{ id: "x');window.__xss=1;('", date: '2026-09-01', type: 'expense', category: '<img src=x onerror="window.__xss=1">', amount: 100 }],
      recurring: [{ category: 'x', amount: 1, day: '<img src=x onerror="window.__xss=1">', startMonth: '<img src=x onerror="window.__xss=1">-01' }],
      categories: { expense: [{ name: '食費" onload="window.__xss=1" x="' }] }
    }));
    await evil.click('[data-view=settings]');
    const [fcE] = await Promise.all([evil.waitForEvent('filechooser'), evil.click('text=JSONバックアップを復元')]);
    await fcE.setFiles(evilBackup);
    await wait(300);
    await evil.click('[data-view=report]');
    await evil.selectOption('#report-body select', { index: 1 }); await wait(100);
    await evil.click('[data-view=list]'); await evil.click('#view-list .entry >> nth=0'); await wait(100); await evil.click('.modal-close');
    await evil.click('[data-view=settings]'); await wait(100);
    const xss = await evil.evaluate(() => window.__xss);
    const recTxt = await text(evil, '#rec-list');
    check('改ざんデータでスクリプトが実行されない', xss === 0 && recTxt.includes('毎月1日') && evil.errors.length === 0, 'xss=' + xss + ' ' + evil.errors.join('/'));
    await evil.context().close();

    // ── ダークモード ──
    const dark = await newPage(browser, { colorScheme: 'dark' });
    await dark.fill('#in-amount', '500'); await dark.click('button:has-text("保存する")');
    await dark.click('[data-view=report]');
    const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('ダークモードの背景', bg === 'rgb(21, 21, 20)', bg);
    await shot(dark, '05-dark-report');
    await dark.click('[data-view=input]'); await shot(dark, '06-dark-input');

    // ── 各画面がエラーなく描画 ──
    for (const v of ['calendar', 'budget', 'list', 'report']) { await page.click('[data-view=' + v + ']'); await wait(60); }
    await page.click('#rep-year'); await wait(60);
    const errs = [...page.errors, ...pageB.errors, ...dark.errors];
    check('JSエラーなし', errs.length === 0, errs.join(' / '));
  } finally {
    await browser.close();
    staticSrv.close(); syncSrv.close();
  }
  const ng = results.filter(r => !r.ok);
  console.log('\n' + (results.length - ng.length) + ' / ' + results.length + ' passed');
  process.exit(ng.length ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
