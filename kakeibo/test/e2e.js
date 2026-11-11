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
// 設定画面を開き、折りたたまれた枠をすべて展開する
async function openSettings(pg) {
  await pg.click('[data-view=settings]');
  await pg.evaluate(() => document.querySelectorAll('#view-settings details.fold').forEach(d => { d.open = true; }));
}
const fmtYenT = n => (n < 0 ? '-' : '') + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
const text = async (page, sel) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ');

(async () => {
  const staticSrv = await serveStatic();
  const { server: syncSrv } = await mock.start(SYNC_PORT);
  const browser = await chromium.launch();
  const today = todayStr(), thisYm = today.slice(0, 7), prevYm = addMonths(thisYm, -1);
  const [Y, M] = thisYm.split('-').map(Number);
  try {
    const page = await newPage(browser);

    // ── 設定画面: 使い始めは移行欄が開き、その他は折りたたみ ──
    await page.click('[data-view=settings]');
    const folds0 = await page.evaluate(() => [...document.querySelectorAll('#view-settings details.fold')].map(d => d.id + ':' + d.open));
    check('使い始めは移行（CSV取り込み）の欄だけ開いている', folds0[0] === 'fold-import:true' && folds0.slice(1).every(x => x.endsWith(':false')), folds0.join(','));
    await page.click('#view-settings summary:has-text("暗証番号ロック")');
    check('折りたたみをタップで開ける', await page.isVisible('#pin-btns button'));
    await page.click('[data-view=input]');

    // ── 基本入力・振替 ──
    await page.fill('#in-amount', '1,234');
    await page.selectOption('#in-account', '現金');
    await page.click('#in-cats .chip:nth-child(1)');
    await page.click('#in-items .chip:nth-child(1)');
    await page.fill('#in-memo', 'テスト');
    await page.click('#save-btn');
    check('支出の保存', (await text(page, '#day-entries')).includes('スーパー'));
    await page.click('#type-inc');
    await page.fill('#in-amount', '300000'); await page.selectOption('#in-account', '銀行口座');
    await page.click('#save-btn');
    await page.click('#type-trn');
    await page.selectOption('#in-from', '銀行口座'); await page.selectOption('#in-to', '現金');
    await page.fill('#in-amount', '20000');
    await page.click('#save-btn');
    check('振替の保存', (await text(page, '#day-entries')).includes('銀行口座 → 現金'));
    await shot(page, '01-input');

    // ── お気に入り・履歴・複製 ──
    await page.click('#type-exp');
    await page.click('#in-cats .chip:nth-child(2)');
    check('入力画面: 項目の自由入力欄がない（選択式）', !(await page.$('#in-item')) && await page.isVisible('#in-product'));
    await page.click('#in-items .chip:has-text("消耗品")');
    await page.fill('#in-product', 'トイレットペーパー'); await page.fill('#in-amount', '398');
    await page.click('#fav-add-btn'); // prompt は自動で既定値を受け入れる
    await wait(100);
    check('お気に入り登録', (await text(page, '#fav-row')).includes('トイレットペーパー'));
    await page.fill('#in-amount', ''); await page.fill('#in-product', ''); await page.click('#in-items .chip:has-text("消耗品")');
    await page.click('#fav-row .chip');
    check('お気に入りで入力欄が埋まる', (await page.inputValue('#in-amount')) === '398' && (await page.inputValue('#in-product')) === 'トイレットペーパー' && (await text(page, '#in-items .chip.on')) === '消耗品');
    await page.click('#save-btn');
    await page.click('#view-input .entry:has-text("トイレットペーパー")');
    await page.waitForSelector('#modal.open');
    await page.click('button:has-text("複製して入力")');
    await wait(100);
    check('明細の複製', (await page.inputValue('#in-amount')) === '398' && !(await page.isVisible('#modal.open')));
    await page.fill('#in-amount', '');
    check('商品名は候補に出て、項目には追加されない', (await page.$$eval('#product-history option', l => l.map(o => o.value))).includes('トイレットペーパー') && !(await text(page, '#in-items')).includes('トイレットペーパー'));
    const tpSaved = await page.evaluate(() => db.entries.find(e => e.product === 'トイレットペーパー'));
    check('保存: 項目と商品名を別々に記録', tpSaved && tpSaved.item === '消耗品' && tpSaved.category === '日用品', JSON.stringify(tpSaved));
    // 項目をその場で追加（登録してから選ぶ）
    await page.evaluate(() => { window.prompt = () => 'トイレ用品'; });
    await page.click('#in-items .add-chip'); await wait(100);
    check('入力画面: ＋項目を追加で分類に登録して選択', (await text(page, '#in-items .chip.on')) === 'トイレ用品' && await page.evaluate(() => catsOf('expense').find(c => c.name === '日用品').items.includes('トイレ用品')));
    await page.click('#in-items .chip.on');

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
    check('編集: 項目は選択式・商品名は入力欄', (await page.evaluate(() => document.getElementById('m-e-item').tagName)) === 'SELECT' && (await page.inputValue('#m-e-item')) === '消耗品' && (await page.inputValue('#m-e-product')) === 'トイレットペーパー');
    await page.selectOption('#m-e-cat', '食費');
    check('編集: 分類を変えると項目の選択肢が入れ替わる', (await page.$$eval('#m-e-item option', l => l.map(o => o.value).join(','))) === ',スーパー,外食,コンビニ,カフェ');
    await page.selectOption('#m-e-cat', '日用品');
    await page.selectOption('#m-e-type', 'transfer');
    await page.selectOption('#m-e-from', '現金'); await page.selectOption('#m-e-to', '現金');
    await page.click('#modal-box button:has-text("保存する")'); await wait(100);
    check('不正な振替編集は拒否', await page.isVisible('#modal.open'));
    await page.click('.modal-close');
    const tp = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.find(e => e.product === 'トイレットペーパー'));
    check('拒否された編集は反映されない', tp.type === 'expense' && tp.category === '日用品' && tp.item === '消耗品', JSON.stringify(tp));

    // ── レシート入力 ──
    await page.click('#type-exp'); await page.click('#receipt-top-btn');
    await page.waitForSelector('#rc-lines');
    await page.fill('#rc-store', 'テストスーパー');
    await page.fill('#rc-lines .rc-prod >> nth=0', 'キャベツ'); await page.fill('#rc-lines .rc-amt >> nth=0', '158');
    await page.click('button:has-text("＋ 行を追加")');
    await page.fill('#rc-lines .rc-prod >> nth=1', '牛乳'); await page.fill('#rc-lines .rc-amt >> nth=1', '248');
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
    await openSettings(page);
    let [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=CSVファイルを選ぶ')]);
    await fc.setFiles(csvPath);
    await page.waitForSelector('#modal.open');
    check('取り込みプレビュー', (await text(page, '#modal-box')).includes('3件を取り込む'));
    await page.click('button:has-text("件を取り込む")');
    await page.waitForSelector('#view-list.active');
    check('取り込み後のトーストに取り消し', (await text(page, '#toast')).includes('取り消す'));
    await openSettings(page);
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
    await page.click('#filter-btn'); await page.selectOption('#f-period', 'all');
    check('全期間検索', (await text(page, '#list-body')).includes('全期間の検索結果: 1件'));
    await page.selectOption('#f-period', 'month'); await page.click('#filter-btn'); await page.fill('#list-q', '');

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
    await openSettings(page);
    await page.click('#cat-list .cat-item >> nth=0 >> button[title="編集"]');
    await page.waitForSelector('#m-cat-colors');
    await page.click('#m-cat-colors .swatch >> nth=7');
    await page.click('#modal-box button:has-text("保存する")');
    await wait(100);
    check('分類の色を変更', (await page.getAttribute('#cat-list .cat-item >> nth=0 >> .cdot', 'style')).includes('#e34948'));
    // 分類名の変更がお気に入り・予算に追随
    await page.click('[data-view=budget]');
    await page.fill('.brow input >> nth=2', '12000'); await page.press('.brow input >> nth=2', 'Tab'); await wait(100); // 日用品（2番目の分類）
    await openSettings(page);
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
    await openSettings(page);
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
    await openSettings(page);
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
      // 年計表の分類ごとの年間合計（13列目）を足す
      const rows = [...document.querySelectorAll('#year-table tr.row')];
      const sum = rows.length ? rows.reduce((s, tr) => s + Number(tr.children[13].textContent.replace(/[¥,]/g, '')), 0) : -1;
      return { ex, sum };
    });
    check('年間の分類別合計が年間支出と一致（締め日あり）', yr.ex === yr.sum, JSON.stringify(yr));
    await page.click('#rep-month');
    await openSettings(page); await page.selectOption('#set-startday', '1'); await wait(100);

    // ── 暗証番号ロック ──
    await openSettings(page);
    await page.click('text=暗証番号を設定');
    await page.fill('#m-p-new', '1234'); await page.fill('#m-p-new2', '1234');
    await page.click('#modal-box button:has-text("保存する")'); await wait(100);
    await page.reload(); await page.waitForSelector('#lock.open');
    await page.fill('#lock-pin', '9999'); await page.click('#lock button');
    check('誤った暗証番号を拒否', (await text(page, '#lock-err')).includes('違います'));
    await page.fill('#lock-pin', '1234'); await page.press('#lock-pin', 'Enter'); await wait(100);
    check('暗証番号で解除', !(await page.isVisible('#lock')));
    // ── 暗号化 ──
    await openSettings(page);
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
    await page.fill('#in-amount', '55'); await page.click('#save-btn'); await wait(800);
    const rawEnc2 = await page.evaluate(() => localStorage.getItem('kakeibo.v1'));
    check('暗号化中の保存も暗号化される', rawEnc2.includes('"enc":1') && !rawEnc2.includes('"entries"'));
    // 大きなデータ（約300KB）でも暗号化保存できる
    await page.evaluate(() => { for (let i = 0; i < 2000; i++) db.entries.push({ id: uid(), date: todayStr(), type: 'expense', category: '食費', item: '大量データ' + i, amount: 100 + i, memo: 'x'.repeat(60), account: '' }); saveDb(true); });
    await wait(1500);
    const bigOk = await page.evaluate(() => { const r = localStorage.getItem('kakeibo.v1'); return r.includes('"enc":1') && r.length > 200000; });
    check('大きなデータでも暗号化保存できる', bigOk);
    await page.evaluate(() => { db.entries = db.entries.filter(e => !String(e.item).startsWith('大量データ')); saveDb(true); });
    await wait(800);
    // 同期スナップショットも平文では残らない
    await openSettings(page); await page.click('text=今すぐ同期'); await wait(800);
    const snapRaw = await page.evaluate(() => localStorage.getItem('kakeibo.syncsnap.v1') || '');
    check('暗号化中は同期スナップショットも暗号化', snapRaw === '' || (snapRaw.includes('"enc":1') && !snapRaw.includes('トイレットペーパー')), snapRaw.slice(0, 40));
    await openSettings(page);
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
    await openSettings(pageB);
    await pageB.fill('#set-sync-key', 'testkey'); await pageB.press('#set-sync-key', 'Tab');
    await pageB.fill('#set-sync-url', syncUrl); await pageB.press('#set-sync-url', 'Tab');
    await wait(800);
    const countB = await pageB.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.length);
    check('端末Bが端末Aの明細を受信', countB === countA, countA + ' vs ' + countB);
    check('端末Bが分類の色（meta）を受信', (await pageB.getAttribute('#cat-list .cat-item >> nth=0 >> .cdot', 'style')).includes('#e34948'));
    // B で追加 → A で受信
    await pageB.click('[data-view=input]');
    await pageB.fill('#in-amount', '777'); await pageB.fill('#in-memo', '端末Bから'); await pageB.fill('#in-product', 'B商品');
    await pageB.click('#save-btn');
    await wait(4800); // 自動同期（4秒デバウンス）
    await openSettings(page); await page.click('text=今すぐ同期'); await wait(600);
    const hasB = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.some(e => e.memo === '端末Bから' && e.product === 'B商品'));
    check('端末Aが端末Bの追加を受信', hasB);
    // A で削除 → B で反映
    await page.click('[data-view=list]');
    await page.click('#view-list .entry:has-text("端末Bから")');
    await page.waitForSelector('#modal.open');
    await page.click('button:has-text("この明細を削除")');
    await wait(4800);
    await openSettings(pageB); await pageB.click('text=今すぐ同期'); await wait(600);
    const stillB = await pageB.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.some(e => e.memo === '端末Bから'));
    check('端末Bで削除が反映', !stillB);
    // 同じ明細を両端末で編集 → 先に同期した方が勝つ
    const targetId = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.find(e => e.memo === 'テスト').id);
    const editMemo = async (pg, memo) => { await pg.evaluate(([id, m]) => { const d = JSON.parse(localStorage.getItem('kakeibo.v1')); d.entries.find(e => e.id === id).memo = m; localStorage.setItem('kakeibo.v1', JSON.stringify(d)); }, [targetId, memo]); await pg.reload(); await pg.waitForSelector('#view-input.active'); await openSettings(pg); };
    await editMemo(page, 'A編集'); await editMemo(pageB, 'B編集');
    await page.click('text=今すぐ同期'); await wait(600);
    await pageB.click('text=今すぐ同期'); await wait(600);
    const memoB = await pageB.evaluate(id => JSON.parse(localStorage.getItem('kakeibo.v1')).entries.find(e => e.id === id).memo, targetId);
    check('競合は先に同期した端末を優先', memoB === 'A編集', memoB);
    // 設定はセクション単位でマージ: A が予算、B がお気に入りを別々に変更しても両方残る
    await page.click('[data-view=budget]');
    await page.fill('.brow input >> nth=0', '333000'); await page.press('.brow input >> nth=0', 'Tab'); await wait(100);
    await openSettings(page); await page.click('text=今すぐ同期'); await wait(600);
    await pageB.click('[data-view=input]');
    await pageB.fill('#in-amount', '120'); await pageB.fill('#in-product', 'ガム');
    await pageB.click('#fav-add-btn'); await wait(100);
    await openSettings(pageB); await pageB.click('text=今すぐ同期'); await wait(600);
    const mergedB = await pageB.evaluate(ym => { const d = JSON.parse(localStorage.getItem('kakeibo.v1')); return { total: d.budgets.overrides[ym] ? d.budgets.overrides[ym].total : d.budgets.total, fav: d.favorites.some(f => f.product === 'ガム') }; }, thisYm);
    await page.click('text=今すぐ同期'); await wait(600);
    const mergedA = await page.evaluate(() => JSON.parse(localStorage.getItem('kakeibo.v1')).favorites.some(f => f.product === 'ガム'));
    check('設定のセクション別マージ（Bに予算が届きお気に入りも残る）', mergedB.total === 333000 && mergedB.fav, JSON.stringify(mergedB));
    check('設定のセクション別マージ（AにBのお気に入りが届く）', mergedA);
    // 使った人とメンバー一覧の同期（sync.gs の新しい列）
    await page.evaluate(() => { db.members = ['自分', '夫']; const e = db.entries.find(x => x.memo === 'A編集'); e.person = '夫'; saveDb(true); });
    await openSettings(page); await page.click('text=今すぐ同期'); await wait(600);
    await openSettings(pageB); await pageB.click('text=今すぐ同期'); await wait(600);
    const pB = await pageB.evaluate(() => ({ m: db.members.join(','), p: (db.entries.find(x => x.memo === 'A編集') || {}).person, v: db.settings.sync.serverVersion }));
    check('使った人とメンバー一覧が同期される', pB.m === '自分,夫' && pB.p === '夫' && pB.v === 4, JSON.stringify(pB));

    // 日記（天気・本文）の同期と削除の反映
    await page.click('[data-view=calendar]'); await page.click('#cal-grid .cell.today');
    await page.click('.diary .chip >> nth=1');
    await page.fill('#diary-text', '同期テストの日記'); await page.press('#diary-text', 'Tab'); await wait(100);
    await openSettings(page); await page.click('text=今すぐ同期'); await wait(600);
    await pageB.click('text=今すぐ同期'); await wait(600);
    const diaryB = await pageB.evaluate(d => JSON.parse(localStorage.getItem('kakeibo.v1')).diary[d], today);
    check('日記が他の端末に同期される', diaryB && diaryB.w === 'cloud' && diaryB.t === '同期テストの日記', JSON.stringify(diaryB));
    await pageB.click('[data-view=calendar]'); await pageB.click('#cal-grid .cell.today');
    await pageB.click('.diary .chip.on'); await pageB.fill('#diary-text', ''); await pageB.press('#diary-text', 'Tab'); await wait(100);
    await openSettings(pageB); await pageB.click('text=今すぐ同期'); await wait(600);
    await page.click('text=今すぐ同期'); await wait(600);
    const diaryA = await page.evaluate(d => JSON.parse(localStorage.getItem('kakeibo.v1')).diary[d], today);
    check('日記の削除が他の端末に反映される', diaryA === undefined, JSON.stringify(diaryA));
    // 資産・負債（meta）、予定・気温（レコード）の同期
    await page.evaluate(d => {
      db.assets.push(sanitizeAsset({ id: 'as1', name: 'つみたてNISA', kind: 'asset', group: '株・投資信託', values: [{ d, v: 500000 }] }));
      db.plans.push(sanitizePlan({ id: 'plan-s1', date: d, time: '10:30', text: '同期する予定' }));
      db.diary[d] = { w: 'sun', t: '', tp: '21.5' }; saveDb(true);
    }, today);
    await openSettings(page); await page.click('text=今すぐ同期'); await wait(600);
    await pageB.click('text=今すぐ同期'); await wait(600);
    const syB = await pageB.evaluate(d => ({ a: db.assets.map(a => a.name + ':' + assetValue(a)).join(','), p: db.plans.map(p => p.time + ' ' + p.text).join(','), tp: (db.diary[d] || {}).tp }), today);
    check('資産・負債・予定・気温が他の端末に同期される', syB.a === 'つみたてNISA:500000' && syB.p === '10:30 同期する予定' && syB.tp === '21.5', JSON.stringify(syB));
    await pageB.evaluate(d => { db.plans = []; delete db.diary[d]; saveDb(true); }, today);
    await pageB.click('text=今すぐ同期'); await wait(600);
    await page.click('text=今すぐ同期'); await wait(600);
    check('予定の削除が他の端末に反映される', await page.evaluate(() => db.plans.length === 0));
    await shot(page, '04-settings');

    // ── 古い sync.gs（使った人の列なし）からの貼り替え ──
    const oldGas = await mock.start(8767, { syncFile: path.join(__dirname, 'fixtures', 'sync-v1.gs') });
    const pc = await newPage(browser);
    await pc.evaluate(() => { db.members = ['自分', '妻']; db.assets.push(sanitizeAsset({ name: '楽天ポイント', group: 'ポイント・電子マネー', values: [{ d: todayStr(), v: 1200 }] })); db.entries.push({ id: 'pv1', date: todayStr(), type: 'expense', category: '食費', item: '', amount: 999, memo: '貼り替えテスト', account: '', person: '妻' }); saveDb(true); });
    await openSettings(pc);
    await pc.fill('#set-sync-key', 'testkey'); await pc.press('#set-sync-key', 'Tab');
    await pc.fill('#set-sync-url', 'http://127.0.0.1:8767/exec'); await pc.press('#set-sync-url', 'Tab'); await wait(800);
    check('古いsync.gsでも同期でき、貼り替えの案内が出る', (await text(pc, '#sync-status')).includes('最終同期') && (await text(pc, '#sync-status')).includes('sync.gs'), await text(pc, '#sync-status'));
    const newGas = await mock.start(8768, { env: oldGas.env }); // 同じスプレッドシートのまま新しい版に貼り替え
    await pc.fill('#set-sync-url', 'http://127.0.0.1:8768/exec'); await pc.press('#set-sync-url', 'Tab'); await wait(800);
    await pc.click('text=今すぐ同期'); await wait(800);
    const sheet = Object.values(oldGas.env.spreadsheets)[0].getSheetByName('entries');
    const hdr = sheet.rows[0], row = sheet.rows.find(r => r[0] === 'pv1');
    check('貼り替え後に見出し行へ「person」「biz」「product」列を追加', hdr.includes('person') && hdr.includes('biz') && hdr[hdr.length - 1] === 'product', hdr.join(','));
    const metaRows = Object.values(oldGas.env.spreadsheets)[0].getSheetByName('meta').rows;
    check('貼り替え後に資産・負債を送り直す', metaRows.some(r => r[0] === 'assets' && String(r[1]).includes('楽天ポイント')), JSON.stringify(metaRows.map(r => r[0])));
    check('貼り替え後に使った人を送り直す', row && row[hdr.indexOf('person')] === '妻' && !(await text(pc, '#sync-status')).includes('sync.gs'), JSON.stringify(row));
    const pd = await newPage(browser);
    await openSettings(pd);
    await pd.fill('#set-sync-key', 'testkey'); await pd.press('#set-sync-key', 'Tab');
    await pd.fill('#set-sync-url', 'http://127.0.0.1:8768/exec'); await pd.press('#set-sync-url', 'Tab'); await wait(800);
    check('貼り替え後は別の端末にも使った人とメンバーが届く', await pd.evaluate(() => db.members.join(',') === '自分,妻' && (db.entries.find(e => e.id === 'pv1') || {}).person === '妻'));
    const compatErr = [...pc.errors, ...pd.errors];
    await pc.context().close(); await pd.context().close(); oldGas.server.close(); newGas.server.close();
    check('貼り替えテストでJSエラーなし', compatErr.length === 0, compatErr.join(' / '));

    // ── 改ざんされたバックアップ・分類名からスクリプトが実行されない ──
    const evil = await newPage(browser);
    await evil.evaluate(() => { window.__xss = 0; });
    const evilBackup = path.join(TMP, 'evil.json');
    fs.writeFileSync(evilBackup, JSON.stringify({
      entries: [{ id: "x');window.__xss=1;('", date: today, type: 'expense', category: '<img src=x onerror="window.__xss=1">', amount: 100 }],
      recurring: [{ category: 'x', amount: 1, day: '<img src=x onerror="window.__xss=1">', startMonth: '<img src=x onerror="window.__xss=1">-01' }],
      categories: { expense: [{ name: '食費" onload="window.__xss=1" x="' }] }
    }));
    await openSettings(evil);
    const [fcE] = await Promise.all([evil.waitForEvent('filechooser'), evil.click('text=JSONバックアップを復元')]);
    await fcE.setFiles(evilBackup);
    await wait(300);
    await evil.click('[data-view=report]');
    await evil.selectOption('#report-body select', { index: 1 }); await wait(100);
    await evil.click('[data-view=list]'); await evil.click('#view-list .entry >> nth=0'); await wait(100); await evil.click('.modal-close');
    await openSettings(evil); await wait(100);
    const xss = await evil.evaluate(() => window.__xss);
    const recTxt = await text(evil, '#rec-list');
    check('改ざんデータでスクリプトが実行されない', xss === 0 && recTxt.includes('毎月1日') && evil.errors.length === 0, 'xss=' + xss + ' ' + evil.errors.join('/'));
    await evil.context().close();

    // ── AI読み取り（擬似GAS経由）と合言葉 ──
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const pngPath = path.join(TMP, 'receipt.png'); fs.writeFileSync(pngPath, png);
    await openSettings(page);
    await page.selectOption('#set-ocr', 'ai'); await wait(100);
    await page.fill('#set-ocr-url', 'http://127.0.0.1:' + SYNC_PORT + '/ocr'); await page.press('#set-ocr-url', 'Tab');
    await page.fill('#set-ocr-key', 'wrongkey'); await page.press('#set-ocr-key', 'Tab');
    await page.click('[data-view=input]');
    await page.click('#type-exp'); await page.click('#receipt-top-btn');
    await page.waitForSelector('#rc-lines');
    let [fcR] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=レシートを読み取る')]);
    await fcR.setFiles(pngPath); await wait(800);
    check('AI読み取り: 合言葉が違うと拒否', (await text(page, '#ocr-status')).includes('合言葉'), await text(page, '#ocr-status'));
    await page.click('.modal-close');
    await openSettings(page);
    await page.fill('#set-ocr-key', 'ocrkey'); await page.press('#set-ocr-key', 'Tab');
    await page.click('[data-view=input]');
    await page.click('#type-exp'); await page.click('#receipt-top-btn');
    await page.waitForSelector('#rc-lines');
    [fcR] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=レシートを読み取る')]);
    await fcR.setFiles(pngPath); await wait(800);
    const rcStore = await page.inputValue('#rc-store');
    const rcItems = await page.$$eval('#rc-lines .rc-prod', l => l.map(i => i.value));
    const rcTotal = await page.inputValue('#rc-total');
    check('AI読み取り: 結果が明細に反映', rcStore === 'モックスーパー' && rcItems.join(',') === 'キャベツ,牛乳' && rcTotal === '406', rcStore + '|' + rcItems + '|' + rcTotal);
    await page.click('.modal-close');
    await openSettings(page); await page.selectOption('#set-ocr', 'browser'); await wait(100);

    // ── 口座の出納帳と残高調整 ──
    const lg = await newPage(browser);
    await lg.evaluate(() => {
      const d = todayStr(), prev = addMonths(periodOf(d), -1) + '-05';
      db.accounts.find(a => a.name === '現金').initial = 10000;
      db.entries.push({ id: uid(), date: prev, type: 'expense', category: '食費', item: '外食', amount: 1000, memo: '', account: '現金' });
      db.entries.push({ id: uid(), date: d, type: 'expense', category: '食費', item: 'スーパー', product: '牛乳', amount: 248, memo: '', account: '現金' });
      db.entries.push({ id: uid(), date: d, type: 'transfer', category: '振替', item: '', amount: 5000, memo: '', account: '銀行口座', toAccount: '現金' });
      saveDb(true); render();
    });
    await lg.click('[data-view=list]');
    if ((await text(lg, '#acct-card button')).includes('表示')) await lg.click('#acct-card button');
    await lg.click('#acct-card .acct-row.link:has-text("現金")'); await lg.waitForSelector('.table.ledger');
    const ledTxt = await text(lg, '#modal-box');
    check('出納帳: 繰越・入出金・残高の推移', ledTxt.includes('出納帳: 現金') && ledTxt.includes('前月から繰越') && ledTxt.includes('¥9,000') && ledTxt.includes('牛乳') && ledTxt.includes('¥8,752') && ledTxt.includes('振替 ← 銀行口座') && ledTxt.includes('¥13,752'), ledTxt.slice(0, 300));
    await lg.click('.ledger-nav .nav-btn >> nth=0');
    const ledPrev = await text(lg, '#modal-box');
    check('出納帳: 前の月に切り替え', ledPrev.includes('外食') && ledPrev.includes('¥10,000') && !ledPrev.includes('牛乳'), ledPrev.slice(0, 200));
    await lg.click('.ledger-nav .nav-btn >> nth=1');
    // 残高を実際の金額に合わせる
    const exBefore = await lg.evaluate(() => sumBy(entriesInMonth(currentPeriod()), 'expense'));
    await lg.click('button:has-text("残高を実際の金額に合わせる")'); await lg.waitForSelector('#m-adj-actual');
    await lg.fill('#m-adj-actual', '13,500');
    check('残高調整: 差額を表示', (await text(lg, '#m-adj-info')).includes('¥13,752') && (await text(lg, '#m-adj-info')).includes('-¥252'), await text(lg, '#m-adj-info'));
    await lg.fill('#m-adj-memo', '移行時の差額');
    await lg.click('#modal-box button:has-text("調整する")'); await lg.waitForSelector('.table.ledger');
    const adj = await lg.evaluate(() => ({ bal: accountBalance('現金'), e: db.entries.find(e => isAdjust(e)), ex: sumBy(entriesInMonth(currentPeriod()), 'expense'), inc: sumBy(entriesInMonth(currentPeriod()), 'income') }));
    check('残高調整: 口座残高が実際の金額になる', adj.bal === 13500 && adj.e && adj.e.amount === 252 && adj.e.account === '現金' && !adj.e.toAccount, JSON.stringify(adj));
    check('残高調整: 収入・支出の集計には入らない', adj.ex === exBefore && adj.inc === 0, JSON.stringify(adj));
    check('残高調整: 出納帳に記録が残る', (await text(lg, '#modal-box')).includes('残高調整（移行時の差額）'));
    await lg.click('.modal-close');
    check('残高調整: 一覧の表示', (await text(lg, '#view-list .entry:has-text("残高調整")')).includes('-¥252'));
    // マイナス残高（カード）に合わせる
    await lg.evaluate(() => openAdjust('クレジットカード')); await lg.waitForSelector('#m-adj-actual');
    await lg.fill('#m-adj-actual', '3000'); await lg.click('#modal-box .calc-btn');
    check('残高調整: ±でマイナスに切り替え', (await lg.inputValue('#m-adj-actual')) === '-3000');
    await lg.click('#modal-box button:has-text("調整する")'); await wait(100);
    check('残高調整: マイナス残高に合わせる', (await lg.evaluate(() => accountBalance('クレジットカード'))) === -3000);
    // 編集と削除
    await lg.click('#view-list .entry:has-text("移行時の差額")'); await lg.waitForSelector('#m-adj-diff');
    check('残高調整: 編集画面で調整額を表示', (await lg.inputValue('#m-adj-diff')) === '-252');
    await lg.fill('#m-adj-diff', '-300'); await lg.click('#modal-box button:has-text("保存する")'); await wait(100);
    check('残高調整: 調整額を直す', (await lg.evaluate(() => accountBalance('現金'))) === 13452);
    await lg.click('#view-list .entry:has-text("移行時の差額")'); await lg.waitForSelector('#m-adj-diff');
    await lg.click('button:has-text("この残高調整を削除")'); await wait(100);
    check('残高調整: 削除すると元の残高', (await lg.evaluate(() => accountBalance('現金'))) === 13752);
    // 設定から出納帳、印刷、CSV
    await openSettings(lg);
    await lg.click('#acct-list .cat-item:has-text("現金") >> button[title="出納帳・残高調整"]'); await lg.waitForSelector('.table.ledger');
    await lg.evaluate(() => { window.print = () => { window.__printed = document.getElementById('print-area').innerHTML; }; });
    await lg.click('#modal-box button:has-text("印刷・PDF")');
    const printed = await lg.evaluate(() => window.__printed || '');
    check('出納帳: 印刷', printed.includes('出納帳: 現金') && printed.includes('牛乳') && printed.includes('前月から繰越'), printed.slice(0, 120));
    const [dlL] = await Promise.all([lg.waitForEvent('download'), lg.click('#modal-box button:has-text("CSVで保存")')]);
    const ledCsv = fs.readFileSync(await dlL.path(), 'utf8');
    check('出納帳: CSVで保存', ledCsv.includes('日付,内容,入金,出金,残高') && ledCsv.includes('前月から繰越,,,9000') && ledCsv.includes('期末残高,5000,248,13752'), ledCsv.slice(0, 160));
    await lg.click('.modal-close');
    // 書き出したCSVを取り込んでも残高調整のまま
    const imp = await lg.evaluate(() => {
      const rows = [['日付', '収支', '分類', '項目', '商品名', '金額', 'メモ', '支払方法', '振替先'], ['2026/11/01', '振替', '残高調整', '', '', '500', '', '', '現金']];
      importState = { name: 't.csv', rows, hasHeader: true, map: guessColumns(rows[0]), typeMode: 'column', skipDup: true };
      return buildImportEntries().entries[0];
    });
    check('残高調整: CSV取り込みで残高調整のまま', imp && imp.type === 'transfer' && imp.category === '残高調整' && imp.toAccount === '現金' && !imp.account, JSON.stringify(imp));
    check('出納帳: JSエラーなし', lg.errors.length === 0, lg.errors.join(' / '));
    await lg.context().close();

    // ── 年計表・資産と負債・予定・一覧入力・気温 ──
    const yp = await newPage(browser);
    const thisYear = todayStr().slice(0, 4), lastYear = String(Number(thisYear) - 1);
    await yp.evaluate(([y, py]) => {
      db.entries.push(
        { id: 'y1', date: y + '-01-10', type: 'expense', category: '食費', item: '外食', amount: 3000, memo: '', account: '現金' },
        { id: 'y2', date: y + '-03-05', type: 'expense', category: '食費', item: '', amount: 2000, memo: '', account: '現金' },
        { id: 'y3', date: y + '-03-06', type: 'expense', category: '住居費', item: '', amount: 80000, memo: '', account: '' },
        { id: 'y4', date: py + '-02-01', type: 'expense', category: '食費', item: '', amount: 4000, memo: '', account: '' },
        { id: 'y5', date: y + '-04-25', type: 'income', category: '給与', item: '', amount: 300000, memo: '', account: '' });
      saveDb(true);
    }, [thisYear, lastYear]);
    await yp.click('[data-view=report]'); await yp.click('#rep-year'); await wait(60);
    const yt = await text(yp, '#year-table');
    check('年計表: 分類×月の表と前年比', yt.includes('年計表') && yt.includes('3月') && yt.includes('食費3,0002,0005,0004,000125%') && yt.includes('住居費'), yt.slice(0, 300));
    await yp.click('#year-table tr.row:has-text("食費")'); await wait(60);
    check('年計表: 分類をタップで項目の行', (await text(yp, '#year-table')).includes('外食') && (await text(yp, '#year-table')).includes('（項目なし）'));
    await yp.click('#year-table .segment button:has-text("収入")'); await wait(60);
    check('年計表: 収入に切り替え', (await text(yp, '#year-table')).includes('給与') && !(await text(yp, '#year-table')).includes('住居費'));
    const [dlY] = await Promise.all([yp.waitForEvent('download'), yp.click('button:has-text("年計表をCSVで保存")')]);
    const yCsv = fs.readFileSync(await dlY.path(), 'utf8');
    check('年計表: CSVで保存', yCsv.includes('分類,項目,1月,2月') && yCsv.includes('給与,,0,0,0,300000'), yCsv.slice(0, 160));
    await yp.click('#year-table .segment button:has-text("支出")'); await wait(60);
    check('年計表: 年間の前年比を表示', (await text(yp, '#report-body .summary')).includes('前年 ¥4,000'), await text(yp, '#report-body .summary'));
    await yp.evaluate(() => { window.print = () => { window.__printed = document.getElementById('print-area').innerHTML; }; });
    await yp.click('button:has-text("この年を印刷・PDF")');
    check('年計表: 印刷に年計表', await yp.evaluate(() => (window.__printed || '').includes('年計表（支出）') && window.__printed.includes('125%')));
    // 資産・負債
    await yp.click('[data-view=list]'); await yp.click('#asset-card button:has-text("追加")'); await yp.waitForSelector('#m-as-name');
    await yp.fill('#m-as-name', 'つみたてNISA'); await yp.fill('#m-as-value', '500000+20000'); await yp.click('#modal-box button:has-text("保存する")'); await wait(80);
    await yp.click('#asset-card button:has-text("追加")'); await yp.waitForSelector('#m-as-name');
    await yp.selectOption('#m-as-kind', 'debt'); await yp.fill('#m-as-name', '自動車ローン'); await yp.fill('#m-as-value', '200000');
    check('資産・負債: 負債に切り替えると区分も変わる', (await yp.inputValue('#m-as-group')) === '住宅ローン');
    await yp.selectOption('#m-as-group', '自動車ローン'); await yp.click('#modal-box button:has-text("保存する")'); await wait(80);
    const nw = await yp.evaluate(() => netWorth());
    const ac = await text(yp, '#asset-card');
    check('資産・負債: 純資産 = 口座 + 資産 - 負債', nw.asset === 520000 && nw.debt === 200000 && nw.net === nw.acct + 320000 && ac.includes('純資産') && ac.includes(fmtYenT(nw.net)), JSON.stringify(nw) + ' ' + ac);
    // 価値を記録し直す（前回との差を表示）、記録の削除
    await yp.click('#asset-card .acct-row:has-text("つみたてNISA")'); await yp.waitForSelector('#m-as-value');
    await yp.fill('#m-as-date', thisYear + '-01-01'); await yp.fill('#m-as-value', '480000'); await yp.click('#modal-box button:has-text("保存する")'); await wait(80);
    const nisa = await yp.evaluate(() => db.assets.find(a => a.name === 'つみたてNISA'));
    check('資産・負債: 日付ごとに記録が残る', nisa.values.length === 2 && nisa.values[0].v === 480000 && nisa.values[1].v === 520000 && (await text(yp, '#asset-card')).includes('+¥40,000'), JSON.stringify(nisa.values));
    check('資産・負債: 過去の時点の価値', await yp.evaluate(y => assetValue(db.assets.find(a => a.name === 'つみたてNISA'), y + '-01-15') === 480000 && assetValue(db.assets.find(a => a.name === 'つみたてNISA'), (Number(y) - 1) + '-12-31') === 0, thisYear));
    await yp.click('#asset-card .acct-row:has-text("つみたてNISA")'); await yp.waitForSelector('#m-as-value');
    await yp.click('#modal-box tr:has-text("480,000") button'); await wait(80);
    check('資産・負債: 記録を削除', await yp.evaluate(() => db.assets.find(a => a.name === 'つみたてNISA').values.length === 1));
    await yp.click('.modal-close');
    await yp.click('#asset-card button:has-text("推移")'); await yp.waitForSelector('#modal-box .table');
    check('資産・負債: 純資産の推移', (await text(yp, '#modal-box')).includes('純資産') && (await text(yp, '#modal-box')).includes(fmtYenT(nw.net)), (await text(yp, '#modal-box')).slice(0, 200));
    await yp.click('.modal-close');
    // 予定: カレンダーで追加 → 入力画面に今日・明日の予定
    await yp.click('[data-view=calendar]'); await yp.click('#cal-grid .cell.today');
    await yp.fill('#plan-time', '09:00'); await yp.fill('#plan-text', '歯医者'); await yp.click('.plan-add button'); await wait(60);
    await yp.fill('#plan-text', '牛乳を買う'); await yp.press('#plan-text', 'Enter'); await wait(60);
    check('予定: カレンダーに追加して印', (await text(yp, '#cal-day-entries')).includes('09:00歯医者') && (await text(yp, '#cal-grid .cell.today')).includes('📌'), await text(yp, '#cal-day-entries'));
    check('予定: 時刻のない予定は後ろ', await yp.evaluate(() => plansOn(todayStr()).map(p => p.text).join(',') === '歯医者,牛乳を買う'));
    await yp.evaluate(() => { db.plans.push(sanitizePlan({ date: addDays(todayStr(), 1), text: '燃えるゴミ' })); db.plans.push(sanitizePlan({ date: addDays(todayStr(), 3), text: '先の予定' })); saveDb(true); });
    await yp.click('[data-view=input]'); await wait(60);
    const pn = await text(yp, '#plan-note');
    check('予定: 入力画面に今日・明日の予定', pn.includes('今日09:00歯医者') && pn.includes('明日燃えるゴミ') && !pn.includes('先の予定'), pn);
    await yp.click('[data-view=calendar]'); // 今日を選んだまま
    await yp.click('.plan-row:has-text("歯医者") button'); await wait(60);
    check('予定: 削除', !(await text(yp, '#cal-day-entries')).includes('歯医者'));
    // 日記の気温
    await yp.fill('#diary-temp', '２３．５'); await yp.press('#diary-temp', 'Tab'); await wait(60);
    check('日記: 気温を記録（全角も可）', await yp.evaluate(() => (db.diary[todayStr()] || {}).tp === '23.5'));
    await yp.fill('#diary-temp', 'あつい'); await yp.press('#diary-temp', 'Tab'); await wait(60);
    check('日記: 数字でない気温は保存しない', await yp.evaluate(() => (db.diary[todayStr()] || {}).tp === '23.5'));
    await yp.evaluate(() => { db.entries.push({ id: 'tpd', date: todayStr(), type: 'expense', category: '食費', item: '', amount: 10, memo: '', account: '' }); saveDb(true); });
    await yp.click('[data-view=list]');
    check('日記: 一覧の日付に気温', (await text(yp, '#list-body')).includes('23.5℃'));
    // 一覧入力
    await yp.click('[data-view=input]'); await yp.click('#bulk-top-btn'); await yp.waitForSelector('#b-amount-0');
    const n0 = await yp.evaluate(() => db.entries.length);
    await yp.selectOption('#b-cat-0', '日用品'); await yp.fill('#b-amount-0', '398'); await yp.fill('#b-product-0', '洗剤');
    await yp.click('#modal-box button:has-text("5行追加")');
    check('一覧入力: 行を追加すると上の行を引き継ぐ', (await yp.$$('.bulk-row')).length === 10 && (await yp.inputValue('#b-cat-5')) === (await yp.inputValue('#b-cat-4')));
    await yp.selectOption('#b-type-1', 'income');
    check('一覧入力: 種別を変えると分類の選択肢も変わる', (await yp.$$eval('#b-cat-1 option', o => o.map(x => x.value))).includes('給与'));
    await yp.fill('#b-amount-1', '5000'); await yp.fill('#b-memo-1', 'おこづかい');
    await yp.fill('#b-amount-2', '100*3');
    await yp.click('#bulk-save'); await wait(80);
    const bulk = await yp.evaluate(n => db.entries.slice(n), n0);
    check('一覧入力: 金額のある行だけまとめて保存', bulk.length === 3 && bulk[0].category === '日用品' && bulk[0].product === '洗剤' && bulk[0].amount === 398 && bulk[1].type === 'income' && bulk[1].memo === 'おこづかい' && bulk[2].amount === 300, JSON.stringify(bulk));
    // 出納帳: 収入・支出の行にメモ
    await yp.evaluate(() => { db.entries.push({ id: 'lm1', date: todayStr(), type: 'expense', category: '食費', item: '', amount: 120, memo: 'お昼のパン', account: '現金' }); saveDb(true); openLedger('現金'); });
    check('出納帳: 収入・支出の行にメモを表示', (await text(yp, '#modal-box')).includes('食費 · お昼のパン'));
    await yp.click('.modal-close');
    check('年計表・資産・予定・一覧入力: JSエラーなし', yp.errors.length === 0, yp.errors.join(' / '));
    await yp.context().close();

    // ── 家計分析（今月の状況など） ──
    const an = await newPage(browser);
    await an.evaluate(() => {
      const t = todayStr(), from = periodRange(currentPeriod())[0], pm = addMonths(currentPeriod(), -1);
      db.budgets.total = 100000; db.budgets.categories = { '食費': 30000 };
      db.entries.push(
        { id: 'a1', date: from, type: 'expense', category: '住居費', item: '', amount: 80000, memo: '家賃', account: '銀行口座', ruleId: 'r1', ruleMonth: currentPeriod() },
        { id: 'a2', date: t, type: 'expense', category: '食費', item: '', amount: 40000, memo: '', account: '現金', store: 'スーパーA' },
        { id: 'a3', date: periodRange(pm)[0], type: 'expense', category: '食費', item: '', amount: 5000, memo: '', account: '現金' });
      saveDb(true);
    });
    await an.click('[data-view=report]'); await an.click('#rep-anal'); await wait(80);
    const ms = await text(an, '#month-status');
    check('分析: 今月の状況（予算超過）', ms.includes('今月の状況') && ms.includes('予算を ¥20,000 超えています') && ms.includes('支出（家計）¥120,000'), ms.slice(0, 300));
    check('分析: 注意したい分類', ms.includes('食費') && ms.includes('予算超過 +¥10,000'), ms);
    check('分析: 先月の同じ時期と比較', ms.includes('先月の同じ時期¥5,000'), ms);
    const proj = await an.evaluate(() => { const st = monthStatus(currentPeriod()); return { st, exp: Math.round(80000 + 40000 / st.done * st.total) }; });
    check('分析: 月末の見込みは定期収支を日割りしない', proj.st.projected === proj.exp, JSON.stringify(proj));
    check('分析: 曜日別の支出', (await an.$$('#weekday-card .week-row')).length === 7, await text(an, '#weekday-card'));
    check('分析: 支払方法別・お店別', (await text(an, '#pay-card')).includes('銀行口座') && (await text(an, '#store-card')).includes('スーパーA'));
    check('分析: 大きな支出から定期収支を除く', !(await text(an, '#big-card')).includes('家賃') && (await text(an, '#big-card')).includes('食費'));
    await an.click('[data-view=input]'); await an.click('[data-view=report]');
    check('分析: 画面を移っても分析のまま', await an.evaluate(() => document.getElementById('rep-anal').className === 'on' && !!document.getElementById('month-status')));
    await an.evaluate(() => { ui.month = addMonths(currentPeriod(), -1); render(); }); await wait(60);
    check('分析: 過去の月は確定', (await text(an, '#month-status')).includes('確定'), await text(an, '#month-status'));
    check('分析: JSエラーなし', an.errors.length === 0, an.errors.join(' / '));
    await an.context().close();

    // ── ダークモード ──
    const dark = await newPage(browser, { colorScheme: 'dark' });
    await dark.fill('#in-amount', '500'); await dark.click('#save-btn');
    await dark.click('[data-view=report]');
    const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('ダークモードの背景', bg === 'rgb(21, 21, 20)', bg);
    await shot(dark, '05-dark-report');
    await dark.click('[data-view=input]'); await shot(dark, '06-dark-input');

    // ── 使い勝手の改善（狭い画面・グラフの色・口座の記憶・検索の合計） ──
    const ux = await newPage(browser, { viewport: { width: 320, height: 640 } });
    await ux.evaluate(([ym, pym]) => {
      const names = ['食費', '日用品', '住居費', '水道光熱費', '通信費', '交通費', '医療費', '教育費', '衣服・美容', '趣味・娯楽', '交際費'];
      names.forEach((c, i) => { db.entries.push({ id: uid(), date: ym + '-02', type: 'expense', category: c, item: '', amount: 1000 * (i + 1), memo: '', account: '' }); });
      db.entries.push({ id: uid(), date: pym + '-02', type: 'income', category: '給与', item: '', amount: 1234567, memo: '', account: '' });
      saveDb(true);
    }, [thisYm, prevYm]);
    await ux.click('[data-view=report]'); await wait(100);
    const uxW = await ux.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: document.documentElement.clientWidth }));
    check('狭い画面（320px）でも集計が横にはみ出さない', uxW.sw <= uxW.w, JSON.stringify(uxW));
    const dots = await ux.$$eval('#report-body .legend .lrow .dot', l => l.slice(0, 8).map(d => d.style.background));
    check('グラフ上位8分類の色が重ならない', dots.length === 8 && new Set(dots).size === 8, dots.join(','));
    await ux.click('[data-view=input]');
    await ux.selectOption('#in-account', 'クレジットカード');
    await ux.fill('#in-amount', '300'); await ux.click('#save-btn');
    await ux.reload(); await ux.waitForSelector('#view-input.active');
    check('前回の支払方法を覚えている', (await ux.inputValue('#in-account')) === 'クレジットカード');
    await ux.click('#type-inc');
    check('収入は別に覚える（未使用なら指定なし）', (await ux.inputValue('#in-account')) === '');
    await ux.click('[data-view=list]');
    await ux.fill('#list-q', '交際費');
    check('検索時の合計は検索結果の合計', (await text(ux, '#list-summary')).includes('¥11,000') && (await text(ux, '#list-body')).includes('検索結果: 1件'));
    await ux.fill('#list-q', '');
    // 絞り込み: 金額範囲・分類・種別・日付指定・クリア・CSV保存
    await ux.click('#filter-btn');
    await ux.fill('#f-min', '5000'); await ux.fill('#f-max', '9000');
    const fAmt = await ux.$$eval('#list-body .entry .amt', l => l.map(x => x.textContent));
    check('絞り込み: 金額の範囲', fAmt.slice().sort().join(',') === '-¥5,000,-¥6,000,-¥7,000,-¥8,000,-¥9,000' && (await text(ux, '#filter-btn')).includes('（1）'), fAmt.join(','));
    await ux.fill('#f-min', ''); await ux.fill('#f-max', '');
    await ux.selectOption('#f-cat', '交際費');
    check('絞り込み: 分類', (await ux.$$eval('#list-body .entry', l => l.length)) === 1 && (await text(ux, '#list-summary')).includes('¥11,000'));
    await ux.selectOption('#f-cat', ''); await ux.selectOption('#f-type', 'income'); await ux.selectOption('#f-period', 'all');
    check('絞り込み: 種別＋全期間（前月の収入も出る）', (await text(ux, '#list-body')).includes('全期間の検索結果: 1件') && (await text(ux, '#list-summary')).includes('¥1,234,567'));
    await ux.selectOption('#f-period', 'range'); await ux.fill('#f-from', prevYm + '-01'); await ux.fill('#f-to', prevYm + '-28');
    await ux.dispatchEvent('#f-to', 'change');
    check('絞り込み: 日付を指定', (await text(ux, '#list-body')).includes('検索結果: 1件') && (await text(ux, '#list-body')).includes('〜'));
    const [dl] = await Promise.all([ux.waitForEvent('download'), ux.click('text=この結果をCSVで保存')]);
    const dlTxt = fs.readFileSync(await dl.path(), 'utf8');
    check('絞り込み結果のCSV保存', dl.suggestedFilename() === 'kakeibo_search.csv' && dlTxt.split('\r\n').length === 2 && dlTxt.includes('1234567'), dlTxt.slice(0, 120));
    await ux.click('text=条件をクリア');
    check('絞り込みのクリア', (await text(ux, '#filter-btn')) === '絞り込み' && !(await text(ux, '#list-body')).includes('検索結果'));
    await ux.click('#filter-btn');
    await openSettings(ux);
    await ux.evaluate(() => { db.entries.push({ id: uid(), date: todayStr(), type: 'expense', category: 'その他', item: '', amount: 10, memo: '', account: '' }); saveDb(true); renderSettings(); });
    await ux.click('#cat-list .cat-item:has-text("その他") >> button[title="削除"]'); await wait(100);
    check('使用中の「その他」は削除できない', await ux.evaluate(() => catsOf('expense').some(c => c.name === 'その他')));
    // 電卓入力・計算式
    await ux.click('[data-view=input]');
    await ux.click('.calc-btn');
    for (const k of ['1', '2', '8', '0', '+', '3', '5', '0', '×', '2']) await ux.click('#calc-keys button[data-k="' + k + '"]');
    check('電卓の計算結果（掛け算を先に計算）', (await text(ux, '#calc-rs')).includes('¥1,980'));
    await ux.click('#calc-keys button[data-k="確定"]');
    check('電卓の確定で金額欄に入る', (await ux.inputValue('#in-amount')) === '1980' && !(await ux.isVisible('#calc')));
    await ux.click('#type-exp');
    await ux.fill('#in-amount', '1280+350');
    check('保存ボタンに計算結果の金額を表示', (await text(ux, '#save-btn')).includes('支出 ¥1,630 を保存'), await text(ux, '#save-btn'));
    const stick = await ux.evaluate(() => { window.scrollTo(0, 0); const r = document.getElementById('save-btn').getBoundingClientRect(); const tab = document.querySelector('.tabbar').getBoundingClientRect(); return r.bottom <= tab.top && r.top >= 0; });
    check('保存ボタンはスクロールせずに押せる位置にある（320×640）', stick);
    await ux.fill('#in-amount', '１０００÷３'); await ux.click('#save-btn'); await wait(100);
    const calcSaved = await ux.evaluate(() => db.entries[db.entries.length - 1].amount);
    check('計算式を直接入力して保存（全角も可）', calcSaved === 333, String(calcSaved));
    await ux.fill('#in-amount', '100+'); await ux.click('#save-btn'); await wait(100);
    check('不完全な計算式は保存しない', (await ux.evaluate(() => db.entries[db.entries.length - 1].amount)) === 333 && (await text(ux, '#toast')).includes('金額'));
    // カレンダー: 週ごとの収支・日記
    await ux.click('[data-view=calendar]');
    const weeksTxt = await text(ux, '#cal-weeks');
    check('週ごとの収支を表示', weeksTxt.includes('週ごとの収支') && weeksTxt.includes('第1週'));
    await ux.click('#cal-grid .cell.today');
    await ux.click('.diary .chip >> nth=0');
    await ux.fill('#diary-text', '日記のテスト'); await ux.press('#diary-text', 'Tab'); await wait(100);
    await ux.reload(); await ux.waitForSelector('#view-input.active');
    const dsaved = await ux.evaluate(d => JSON.parse(localStorage.getItem('kakeibo.v1')).diary[d], today);
    check('日記と天気を保存', dsaved && dsaved.w === 'sun' && dsaved.t === '日記のテスト', JSON.stringify(dsaved));
    await ux.click('[data-view=calendar]');
    check('カレンダーに天気を表示', (await text(ux, '#cal-grid .cell.today')).includes('☀️'));
    // うきうき家計簿形式のCSV（Shift_JIS・日付/項目/内訳/品名/お店/収入/支出/口座/メモ）
    await openSettings(ux);
    const [fcU] = await Promise.all([ux.waitForEvent('filechooser'), ux.click('text=CSVファイルを選ぶ')]);
    await fcU.setFiles(path.join(__dirname, 'fixtures', 'ukiuki-sample.csv'));
    await ux.waitForSelector('#modal.open');
    const impTxt = await text(ux, '#modal-box');
    check('うきうき形式: 8件を認識（Shift_JIS）', impTxt.includes('8件を取り込む') && impTxt.includes('収入列・支出列') && !impTxt.includes('読み取れない行'), impTxt.slice(0, 200));
    await ux.click('button:has-text("件を取り込む")'); await ux.waitForSelector('#view-list.active');
    const uk = await ux.evaluate(() => db.entries.filter(e => e.date.startsWith('2025-0')).sort((a, b) => (a.date + a.amount < b.date + b.amount ? -1 : 1)));
    const rice = uk.find(e => e.amount === 2580), book = uk.find(e => e.amount === 1650), pay = uk.find(e => e.amount === 280000);
    check('うきうき形式: 項目→分類・内訳→項目・品名→商品名・お店→店名',
      rice && rice.category === '食費' && rice.item === 'お米' && rice.product === 'コシヒカリ5kg' && rice.memo === '' && rice.store === '○○スーパー' && rice.account === '現金' && rice.type === 'expense', JSON.stringify(rice));
    check('うきうき形式: 引用符・カンマ入りの品名とメモ', book && book.product === '家計簿の本, 第2版' && book.memo === 'メモに "引用符" あり' && book.account === '楽天カード', JSON.stringify(book));
    check('うきうき形式: 収入列は収入として取り込み・口座を自動登録', pay && pay.type === 'income' && pay.category === '給料' && pay.memo === '4月分' && (await ux.evaluate(() => db.accounts.some(a => a.name === 'ゆうちょ銀行') && db.accounts.some(a => a.name === '楽天カード'))), JSON.stringify(pay));
    check('うきうき形式: 合計が一致', uk.length === 8 && uk.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0) === 2580 + 198 + 438 + 1650 + 85000 + 3300, String(uk.length));
    await openSettings(ux);
    const [fcU2] = await Promise.all([ux.waitForEvent('filechooser'), ux.click('text=CSVファイルを選ぶ')]);
    await fcU2.setFiles(path.join(__dirname, 'fixtures', 'ukiuki-sample.csv'));
    await ux.waitForSelector('#modal.open');
    check('うきうき形式: 同じファイルの再取り込みは重複スキップ', (await text(ux, '#modal-box')).includes('スキップ（8件）') && (await ux.isDisabled('button:has-text("件を取り込む")')));
    await ux.click('.modal-close');

    // 起動時の読み込み: 全種類のデータ（定期収支・カード・予算の上書き・お気に入り・日記）がある状態で開き直しても起動できる
    await openSettings(ux);
    await ux.click('text=＋ 定期収支を追加'); await ux.waitForSelector('#m-r-amount');
    await ux.fill('#m-r-amount', '80000'); await ux.selectOption('#m-r-cat', '住居費'); await ux.selectOption('#m-r-item', '家賃');
    check('定期収支: 項目は分類の登録項目から選ぶ', (await ux.$$eval('#m-r-item option', l => l.map(o => o.value).join(','))) === ',家賃,住宅ローン,管理費');
    await ux.click('#modal-box button:has-text("保存する")'); await wait(100);
    await ux.evaluate(ym => {
      db.accounts.push({ id: uid(), name: 'テストカード', initial: 0, card: true, closingDay: 15, payDay: 10, payOffset: 1, payAccount: '銀行口座', payFrom: ym });
      db.budgets.overrides[ym] = { total: 1000, categories: { '食費': 500 } };
      db.favorites.push({ id: uid(), name: 'お気に入り', type: 'expense', category: '食費', item: '', amount: 100, memo: '', account: '' });
      saveDb(true);
    }, thisYm);
    await ux.reload();
    const booted = await ux.waitForSelector('#view-input.active', { timeout: 5000 }).then(() => true, () => false);
    check('全種類のデータがある状態で再起動できる（定期収支など）', booted && (await ux.evaluate(() => db.recurring.length === 1 && Object.keys(db.diary).length === 1)), ux.errors.join(' / '));
    // カレンダーの金額表示（320pxでもマスに収まる・1万以上は100円単位）
    const calAmt = await ux.evaluate(() => {
      const ym = currentPeriod(); [9999, 10320, 123456, 1234567].forEach((a, i) => db.entries.push({ id: uid(), date: ym + '-1' + i, type: 'expense', category: '食費', item: 'cal', amount: a, memo: '', account: '' }));
      showView('calendar');
      const cut = [...document.querySelectorAll('.cal .ce, .cal .ci')].filter(el => el.scrollWidth > el.clientWidth).map(el => el.textContent);
      db.entries = db.entries.filter(e => e.item !== 'cal'); saveDb(true);
      return { f: [9999, 10320, 123456, 1234567].map(fmtCompact).join(' '), cut };
    });
    check('カレンダーの金額が細かく表示されマスに収まる', calAmt.f === '9,999 1.03万 12.3万 123万' && calAmt.cut.length === 0, JSON.stringify(calAmt));
    // 印刷・PDF: 印刷用の表を作って印刷画面を開く（印刷時はアプリ画面を隠す）
    await ux.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
    await ux.click('[data-view=report]'); await ux.click('#rep-month');
    await ux.click('text=この月を印刷・PDF');
    const pr = await ux.evaluate(() => ({ n: window.__printed, t: document.getElementById('print-area').textContent }));
    check('月の印刷: 合計・内訳・予算比・明細を含む', pr.n === 1 && pr.t.includes('の家計簿') && pr.t.includes('予算との比較') && pr.t.includes('交際費') && /明細（\d+件）/.test(pr.t), pr.t.slice(0, 100));
    await ux.emulateMedia({ media: 'print' });
    const prVis = await ux.evaluate(() => ({ area: getComputedStyle(document.getElementById('print-area')).display, tab: getComputedStyle(document.querySelector('.tabbar')).display }));
    await ux.emulateMedia({ media: 'screen' });
    check('印刷時は印刷用の表だけを表示', prVis.area === 'block' && prVis.tab === 'none', JSON.stringify(prVis));
    await ux.click('#rep-year'); await ux.click('text=この年を印刷・PDF');
    check('年の印刷: 月別の収支を含む', (await ux.evaluate(() => document.getElementById('print-area').textContent)).includes('月別の収支'));
    await ux.click('#rep-month');
    // 使った人: 登録・入力・前回の人を記憶・人別集計・絞り込み・名前変更・CSV
    await openSettings(ux);
    await ux.evaluate(() => { window.__names = ['自分', '妻']; window.prompt = () => window.__names.shift() || ''; });
    await ux.click('text=＋ 使った人を追加'); await ux.click('text=＋ 使った人を追加');
    check('使った人を登録', (await text(ux, '#member-list')).includes('自分') && (await text(ux, '#member-list')).includes('妻'));
    await ux.click('[data-view=input]'); await ux.click('#type-exp');
    check('入力画面に使った人の選択が出る', await ux.isVisible('#in-personfield'));
    await ux.click('#in-persons .chip:has-text("妻")');
    await ux.fill('#in-amount', '4321'); await ux.click('#save-btn'); await wait(100);
    check('使った人を付けて保存', (await ux.evaluate(() => db.entries[db.entries.length - 1].person)) === '妻');
    await ux.reload(); await ux.waitForSelector('#view-input.active');
    check('前回の使った人を覚えている', (await text(ux, '#in-persons .chip.on')).includes('妻'));
    await ux.click('[data-view=report]'); await ux.click('#rep-month');
    check('集計に使った人別の支出', (await text(ux, '#person-card')).includes('妻') && (await text(ux, '#person-card')).includes('¥4,321') && (await text(ux, '#person-card')).includes('（指定なし）'));
    await ux.click('[data-view=list]'); await ux.click('#filter-btn'); await ux.selectOption('#f-person', '妻');
    check('使った人で絞り込み', (await ux.$$eval('#list-body .entry', l => l.length)) === 1 && (await text(ux, '#list-body')).includes('👤妻'));
    const [dlp] = await Promise.all([ux.waitForEvent('download'), ux.click('text=この結果をCSVで保存')]);
    const dlpTxt = fs.readFileSync(await dlp.path(), 'utf8');
    check('CSVに使った人の列', dlpTxt.split('\r\n')[0].includes(',使った人,') && dlpTxt.includes(',妻'), dlpTxt.slice(0, 120));
    await ux.click('text=条件をクリア'); await ux.click('#filter-btn');
    await openSettings(ux);
    await ux.evaluate(() => { window.prompt = () => 'パートナー'; });
    await ux.click('#member-list .cat-item:has-text("妻") >> button[title="名前を変更"]'); await wait(100);
    check('使った人の名前変更が明細に反映', (await ux.evaluate(() => db.entries.filter(e => e.person === 'パートナー').length)) === 1 && !(await ux.evaluate(() => db.entries.some(e => e.person === '妻'))));
    await ux.click('[data-view=list]'); await ux.click('#list-body .entry:has-text("パートナー")'); await ux.waitForSelector('#m-e-person');
    await ux.selectOption('#m-e-person', '自分'); await ux.click('#modal-box button:has-text("保存する")'); await wait(100);
    check('編集で使った人を変更', (await ux.evaluate(() => db.entries.filter(e => e.person === '自分').length)) === 1);

    // 貯金目標: 口座連動・手入力・毎月の必要額・達成
    await ux.click('[data-view=budget]');
    await ux.click('#goals-card button:has-text("目標を追加")'); await ux.waitForSelector('#m-g-name');
    await ux.fill('#m-g-name', '家族旅行'); await ux.fill('#m-g-target', '120000');
    const dl12 = await ux.evaluate(() => addMonths(currentPeriod(), 11));
    await ux.fill('#m-g-deadline', dl12); await ux.fill('#m-g-saved', '24000');
    await ux.click('#modal-box button:has-text("保存する")'); await wait(100);
    const gTxt = await text(ux, '#goals-card');
    check('貯金目標: 毎月の必要額（残り12か月で96,000円 → 8,000円）', gTxt.includes('家族旅行') && gTxt.includes('20%') && gTxt.includes('残り12か月') && gTxt.includes('¥8,000'), gTxt);
    await ux.click('#goals-card .brow:has-text("家族旅行")'); await ux.waitForSelector('#m-g-account');
    await ux.selectOption('#m-g-account', '銀行口座'); await ux.click('#modal-box button:has-text("保存する")'); await wait(100);
    const gAcc = await ux.evaluate(() => ({ g: db.goals[0].account, bal: accountBalance('銀行口座') }));
    check('貯金目標: 口座と連動して残高を使う', gAcc.g === '銀行口座' && (await text(ux, '#goals-card')).includes(fmtYenT(gAcc.bal) + ' / ¥120,000'), JSON.stringify(gAcc) + (await text(ux, '#goals-card')));
    await ux.evaluate(() => { db.goals[0].account = ''; db.goals[0].saved = 130000; saveDb(true); renderBudget(); });
    check('貯金目標: 達成の表示', (await text(ux, '#goals-card')).includes('達成しました'));

    // レシート入力（うきうき家計簿風）: 外税・軽減税率・値引き・品名の記憶・税額の手直し・レシート全体の編集
    await ux.click('[data-view=input]'); await ux.click('#type-exp');
    check('レシート入力ボタンが入力画面の上にある', await ux.isVisible('#receipt-top-btn') && (await ux.evaluate(() => document.getElementById('receipt-top-btn').getBoundingClientRect().top)) < 200);
    await ux.click('#receipt-top-btn'); await ux.waitForSelector('#rc-lines');
    await ux.fill('#rc-store', 'うきうきマート');
    await ux.click('#rc-tax-out');
    await ux.fill('#rc-lines .rc-prod >> nth=0', 'レシート野菜'); await ux.selectOption('#rc-lines .rc-cat >> nth=0', '食費'); await ux.dispatchEvent('#rc-lines .rc-cat >> nth=0', 'change');
    await ux.selectOption('#rc-lines .rc-itemsel >> nth=0', 'スーパー');
    await ux.fill('#rc-lines .rc-amt >> nth=0', '158'); await ux.press('#rc-lines .rc-amt >> nth=0', 'Enter');
    await ux.fill('#rc-lines .rc-prod >> nth=1', 'レシート洗剤'); await ux.selectOption('#rc-lines .rc-cat >> nth=1', '日用品'); await ux.dispatchEvent('#rc-lines .rc-cat >> nth=1', 'change');
    await ux.fill('#rc-lines .rc-amt >> nth=1', '398'); await ux.press('#rc-lines .rc-amt >> nth=1', 'Enter');
    await ux.fill('#rc-lines .rc-prod >> nth=2', 'レシート牛乳'); await ux.selectOption('#rc-lines .rc-cat >> nth=2', '食費'); await ux.dispatchEvent('#rc-lines .rc-cat >> nth=2', 'change');
    await ux.fill('#rc-lines .rc-amt >> nth=2', '248');
    await ux.click('text=－ 値引きの行'); await ux.fill('#rc-lines .rc-amt >> nth=3', '-30');
    const rates = await ux.$$eval('#rc-lines .rc-rate', l => l.map(x => x.textContent));
    const calcTxt = await text(ux, '#rc-calc');
    // 8%対象: 158 + (248-30) = 376 → 税30、10%対象: 398 → 税39、合計 376+398+69 = 843
    check('レシート: 行の追加・食費は8%・Enterで次の行', rates.join(',') === '8%,10%,8%,8%', rates.join(','));
    check('レシート: 外税と値引きの計算', calcTxt.includes('8%対象 ¥376') && calcTxt.includes('税 ¥30') && calcTxt.includes('税 ¥39') && calcTxt.includes('¥843') && calcTxt.includes('値引き1件'), calcTxt);
    await ux.fill('#rc-total', '843');
    check('レシート: 合計の照合', (await text(ux, '#rc-diff')).includes('一致'));
    await ux.click('button:has-text("まとめて保存する")'); await wait(100);
    const saved = await ux.evaluate(() => db.entries.filter(e => e.store === 'うきうきマート').map(e => e.product + ':' + e.amount).sort().join(','));
    // 税30を金額比で割り振り: 野菜158+12=170、牛乳218+17+端数1=236（端数は高い方へ）、洗剤398+39=437
    check('レシート: 税込に割り振って保存', saved === 'レシート洗剤:437,レシート牛乳:236,レシート野菜:170', saved);
    check('レシート: 選んだ項目と商品名を別々に保存', await ux.evaluate(() => { const e = db.entries.find(x => x.product === 'レシート野菜'); return e && e.item === 'スーパー' && e.category === '食費'; }));
    check('レシート: 品名は分類の項目ボタンに追加しない', !(await ux.evaluate(() => catsOf('expense').some(c => c.items.includes('レシート牛乳')))));
    // 品名の記憶: 前回の分類と金額が出る
    await ux.click('#receipt-top-btn'); await ux.waitForSelector('#rc-lines');
    await ux.selectOption('#rc-lines .rc-cat >> nth=0', '日用品');
    await ux.fill('#rc-lines .rc-prod >> nth=0', 'レシート野菜'); await ux.dispatchEvent('#rc-lines .rc-prod >> nth=0', 'change');
    check('レシート: 商品名から前回の分類・項目', (await ux.inputValue('#rc-lines .rc-cat >> nth=0')) === '食費' && (await ux.inputValue('#rc-lines .rc-itemsel >> nth=0')) === 'スーパー');
    await ux.selectOption('#rc-lines .rc-cat >> nth=0', '日用品');
    await ux.fill('#rc-lines .rc-prod >> nth=0', 'レシート牛乳'); await ux.dispatchEvent('#rc-lines .rc-prod >> nth=0', 'change');
    check('レシート: 品名から前回の分類と金額', (await ux.inputValue('#rc-lines .rc-cat >> nth=0')) === '食費' && (await ux.getAttribute('#rc-lines .rc-amt >> nth=0', 'placeholder')) === '前回236');
    check('レシート: お店の候補', await ux.evaluate(() => [...document.querySelectorAll('#rc-stores option')].some(o => o.value === 'うきうきマート')));
    // 項目は分類に登録したものから選ぶ（選択式）。分類を変えると選択肢が入れ替わり、選んでいた項目は外れる
    await ux.selectOption('#rc-lines .rc-cat >> nth=0', '食費');
    const opt0 = await ux.$$eval('#rc-lines .rc-line:nth-child(1) .rc-itemsel option', l => l.map(o => o.value).join(','));
    const foodItems = await ux.evaluate(() => ',' + catsOf('expense').find(c => c.name === '食費').items.join(','));
    check('レシート: 項目は選択式（分類の登録項目だけ）', opt0 === foodItems && opt0.startsWith(',スーパー,外食,コンビニ,カフェ') && !opt0.includes('レシート') && !(await ux.$('#rc-lines .rc-item')), opt0);
    await ux.selectOption('#rc-lines .rc-itemsel >> nth=0', 'コンビニ');
    await ux.selectOption('#rc-lines .rc-cat >> nth=0', '日用品');
    const opt0b = await ux.$$eval('#rc-lines .rc-line:nth-child(1) .rc-itemsel option', l => l.map(o => o.value).join(','));
    const dailyItems = await ux.evaluate(() => ',' + catsOf('expense').find(c => c.name === '日用品').items.join(','));
    check('レシート: 分類を変えると項目の選択肢が入れ替わる', opt0b === dailyItems && opt0b.startsWith(',消耗品,ドラッグストア') && (await ux.inputValue('#rc-lines .rc-itemsel >> nth=0')) === '', opt0b);
    check('レシート: 商品名の候補', await ux.evaluate(() => [...document.querySelectorAll('#rc-products option')].some(o => o.value === 'レシート牛乳')));
    // 税額を手で直す
    await ux.click('#rc-tax-out'); await ux.fill('#rc-lines .rc-amt >> nth=0', '1000');
    await ux.fill('#rc-tax', '79'); await ux.dispatchEvent('#rc-tax', 'change');
    check('レシート: 税額の手直し', (await text(ux, '#rc-sum')) === '¥1,079', await text(ux, '#rc-sum'));
    await ux.click('.modal-close');
    // 商品名の欄ができる前のレシート（項目に品名が入っている）は、商品名として表示・編集する
    await ux.evaluate(() => { db.entries.push({ id: uid(), date: todayStr(), type: 'expense', category: '食費', item: '旧品名パン', amount: 150, memo: '', account: '', store: '旧店', receiptId: 'legacyrc' }); saveDb(true); render(); });
    check('古いレシート: 一覧では品名を商品名として表示', (await text(ux, '#day-entries .entry:has-text("旧品名パン")')).includes('食費'));
    await ux.evaluate(() => openReceiptEdit('legacyrc')); await ux.waitForSelector('#rc-lines');
    check('古いレシート: 開き直すと商品名の欄に入り、項目は空', (await ux.inputValue('#rc-lines .rc-prod >> nth=0')) === '旧品名パン' && (await ux.inputValue('#rc-lines .rc-itemsel >> nth=0')) === '');
    await ux.click('.modal-close');
    await ux.evaluate(() => { db.entries = db.entries.filter(e => e.receiptId !== 'legacyrc'); saveDb(true); render(); });
    // 保存したレシートを丸ごと編集
    await ux.click('#day-entries .entry:has-text("レシート洗剤")'); await ux.waitForSelector('#modal.open');
    await ux.click('text=このレシート全体を編集'); await ux.waitForSelector('#rc-lines');
    check('レシート編集: 3品目を開き直す', (await ux.$$eval('#rc-lines .rc-line', l => l.length)) === 3 && (await ux.inputValue('#rc-store')) === 'うきうきマート');
    await ux.fill('#rc-lines .rc-amt >> nth=0', '400');
    await ux.click('button:has-text("レシートを保存し直す")'); await wait(100);
    const edited = await ux.evaluate(() => { const l = db.entries.filter(e => e.store === 'うきうきマート'); return { n: l.length, ids: new Set(l.map(e => e.receiptId)).size, sum: l.reduce((s, e) => s + e.amount, 0) }; });
    check('レシート編集: 置き換えて保存（件数・レシートIDはそのまま）', edited.n === 3 && edited.ids === 1 && edited.sum === 400 + 437 + 236, JSON.stringify(edited));

    // 事業の経費と家計の分離: 3社のプルダウン・家計の集計から除外・会社別表示・まとめて変更・CSV・定期収支・レシート
    await ux.click('[data-view=input]'); await ux.click('#type-exp');
    check('事業: 会社が未登録なら「家計／事業」の欄は出ない', await ux.evaluate(() => db.companies.length === 0 && document.getElementById('in-bizfield').style.display === 'none'));
    check('事業: 会社名はプログラムに書かれていない', await ux.evaluate(() => typeof DEFAULT_COMPANIES === 'undefined'));
    await openSettings(ux);
    for (const c of ['テスト商事', 'サンプル株式会社', '株式会社見本ラボ']) { await ux.evaluate(n => { window.prompt = () => n; }, c); await ux.click('button:has-text("＋ 会社を追加")'); await wait(50); }
    check('事業: 設定で会社を登録', (await ux.evaluate(() => db.companies.join(','))) === 'テスト商事,サンプル株式会社,株式会社見本ラボ');
    await ux.click('[data-view=input]'); await ux.click('#type-exp');
    const bizOpts = await ux.$$eval('#in-biz option', l => l.map(o => o.textContent));
    check('事業: 家計と3社を選べる', bizOpts.join(',') === '家計,🏢 テスト商事,🏢 サンプル株式会社,🏢 株式会社見本ラボ', bizOpts.join(','));
    await ux.selectOption('#in-biz', '株式会社見本ラボ'); await ux.dispatchEvent('#in-biz', 'change');
    await ux.fill('#in-amount', '55000'); await ux.fill('#in-memo', '事業テスト');
    check('事業: 保存ボタンに事業と表示', (await text(ux, '#save-btn')).includes('🏢') && (await text(ux, '#save-btn')).includes('（事業）'));
    await ux.click('#save-btn'); await wait(100);
    const bz = await ux.evaluate(() => db.entries.find(e => e.memo === '事業テスト'));
    check('事業: 会社名を付けて保存', bz && bz.biz === '株式会社見本ラボ', JSON.stringify(bz));
    await ux.reload(); await ux.waitForSelector('#view-input.active');
    check('事業: 前回の区分を覚えている', (await ux.inputValue('#in-biz')) === '株式会社見本ラボ');
    await ux.selectOption('#in-biz', ''); await ux.dispatchEvent('#in-biz', 'change');
    await ux.click('[data-view=list]');
    check('事業: 一覧は家計のみが初期表示（事業の経費は合計に入らない）', (await ux.inputValue('#scope-sel')) === 'home' && !(await text(ux, '#list-body')).includes('事業テスト'));
    await ux.selectOption('#scope-sel', 'c:株式会社見本ラボ');
    check('事業: 会社を選ぶとその会社の経費だけ', (await text(ux, '#list-body')).includes('事業テスト') && (await text(ux, '#list-summary')).includes('¥55,000'));
    await ux.click('[data-view=report]'); await ux.click('#rep-month');
    await ux.selectOption('#scope-sel', 'home');
    const bizCard = await text(ux, '#biz-card');
    check('事業: 集計に会社別の事業経費（家計の合計には含まない）', bizCard.includes('株式会社見本ラボ') && bizCard.includes('¥55,000') && !(await text(ux, '#report-body .donut-wrap')).includes('¥55,000'), bizCard);
    await ux.click('#biz-card .lrow'); await wait(50);
    check('事業: 会社名タップで表示切り替え', (await ux.inputValue('#scope-sel')) === 'c:株式会社見本ラボ');
    await ux.selectOption('#scope-sel', 'home');
    await ux.click('[data-view=budget]');
    check('事業: 予算は家計のみで計算', !(await ux.evaluate(() => entriesInMonth(ui.month, 'home').some(e => e.biz))) && (await text(ux, '#budget-body')).includes('事業の経費は含みません'));
    // まとめて変更: 交際費を検索してサンプル株式会社へ
    await ux.click('[data-view=list]'); await ux.click('#filter-btn'); await ux.selectOption('#f-cat', '交際費');
    await ux.selectOption('#f-bulkbiz', 'サンプル株式会社'); await ux.click('button:has-text("変更")'); await wait(100);
    check('事業: 絞り込み結果（今月の交際費）をまとめて会社に変更', await ux.evaluate(() => { const l = db.entries.filter(e => e.category === '交際費'); return l.filter(e => periodOf(e.date) === ui.month).every(e => e.biz === 'サンプル株式会社') && l.filter(e => periodOf(e.date) !== ui.month).every(e => !e.biz); }));
    check('事業: まとめて変更後は家計の一覧から消える', (await text(ux, '#list-body')).includes('該当する明細がありません'));
    await ux.selectOption('#scope-sel', 'c:サンプル株式会社');
    const [dlb] = await Promise.all([ux.waitForEvent('download'), ux.click('text=この結果をCSVで保存')]);
    const dlbTxt = fs.readFileSync(await dlb.path(), 'utf8');
    check('事業: 会社ごとにCSVで保存（事業区分の列つき）', dlbTxt.split('\r\n')[0].endsWith('事業区分') && dlbTxt.includes('サンプル株式会社') && !dlbTxt.includes(',家計'), dlbTxt.slice(0, 160));
    await ux.click('text=条件をクリア'); await ux.click('#filter-btn'); await ux.selectOption('#scope-sel', 'home');
    // 編集で家計に戻す
    await ux.selectOption('#scope-sel', 'all');
    await ux.click('#list-body .entry:has-text("事業テスト")'); await ux.waitForSelector('#m-e-biz');
    await ux.selectOption('#m-e-biz', ''); await ux.click('#modal-box button:has-text("保存する")'); await wait(100);
    check('事業: 編集で家計に戻せる', await ux.evaluate(() => !db.entries.find(e => e.memo === '事業テスト').biz));
    await ux.selectOption('#scope-sel', 'home');
    // 会社名の変更が明細に反映
    await openSettings(ux);
    await ux.evaluate(() => { window.prompt = () => 'サンプル株式会社（本社）'; });
    await ux.click('#company-list .cat-item:has-text("サンプル株式会社") >> button[title="名前を変更"]'); await wait(100);
    check('事業: 会社名の変更が明細に反映', await ux.evaluate(() => db.entries.filter(e => e.category === '交際費' && periodOf(e.date) === ui.month).every(e => e.biz === 'サンプル株式会社（本社）') && db.companies.includes('サンプル株式会社（本社）') && !db.companies.includes('サンプル株式会社')));
    // レシートと定期収支にも区分
    await ux.click('[data-view=input]'); await ux.click('#type-exp'); await ux.click('#receipt-top-btn'); await ux.waitForSelector('#rc-biz');
    await ux.selectOption('#rc-biz', 'テスト商事');
    await ux.fill('#rc-lines .rc-prod >> nth=0', '事業用文具'); await ux.fill('#rc-lines .rc-amt >> nth=0', '880');
    await ux.click('button:has-text("まとめて保存する")'); await wait(100);
    check('事業: レシートに会社を付けて保存', (await ux.evaluate(() => (db.entries.find(e => e.product === '事業用文具') || {}).biz)) === 'テスト商事');
    await openSettings(ux);
    await ux.click('text=＋ 定期収支を追加'); await ux.waitForSelector('#m-r-biz');
    await ux.fill('#m-r-amount', '33000'); await ux.selectOption('#m-r-cat', '住居費'); await ux.selectOption('#m-r-item', '家賃'); await ux.fill('#m-r-memo', '事務所家賃'); await ux.fill('#m-r-day', '1');
    await ux.selectOption('#m-r-biz', '株式会社見本ラボ');
    await ux.click('#modal-box button:has-text("保存する")'); await wait(100);
    check('事業: 定期収支の自動入力にも会社', await ux.evaluate(() => { const l = db.entries.filter(e => e.memo === '事務所家賃'); return l.length > 0 && l.every(e => e.biz === '株式会社見本ラボ'); }));

    // 日記は入力欄から離れなくても少し待てば保存される
    await ux.click('[data-view=calendar]'); await ux.click('#cal-grid .cell.today');
    await ux.fill('#diary-text', '入力途中の日記'); await wait(1200);
    await ux.reload(); await ux.waitForSelector('#view-input.active');
    check('日記は入力中にも自動保存される', (await ux.evaluate(d => (JSON.parse(localStorage.getItem('kakeibo.v1')).diary[d] || {}).t, today)) === '入力途中の日記');
    const uxErr = ux.errors.slice();
    await ux.context().close();

    // ── 救出画面: 起動に失敗してもデータを書き出せる ──
    const broken = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const bp = await broken.newPage();
    await bp.route('**/index.html', async route => {
      const res = await route.fetch(); let body = await res.text();
      body = body.replace('/* ════════════════════════════════════════════════════════════\n   家計簿', 'throw new Error("起動テスト用のエラー");\n/* ════════════════════════════════════════════════════════════\n   家計簿');
      await route.fulfill({ response: res, body });
    });
    await bp.addInitScript(() => { if (!localStorage.getItem('kakeibo.v1')) localStorage.setItem('kakeibo.v1', JSON.stringify({ entries: [{ id: 'r1', date: '2026-01-05', type: 'expense', category: '食費', amount: 777, memo: '救出テスト' }] })); });
    await bp.goto('http://127.0.0.1:' + PORT + '/index.html');
    const rescued = await bp.waitForSelector('#rescue', { timeout: 5000 }).then(() => true, () => false);
    check('起動に失敗すると救出画面を表示', rescued && (await text(bp, '#rescue')).includes('起動テスト用のエラー'));
    const [rdl] = await Promise.all([bp.waitForEvent('download'), bp.click('#rescue-save')]);
    const rescuePath = path.join(TMP, 'rescue.json'); await rdl.saveAs(rescuePath);
    check('救出画面からデータを保存', JSON.parse(fs.readFileSync(rescuePath, 'utf8')).entries[0].memo === '救出テスト');
    await broken.close();
    const rp = await newPage(browser);
    await openSettings(rp);
    const [fcRes] = await Promise.all([rp.waitForEvent('filechooser'), rp.click('text=JSONバックアップを復元')]);
    await fcRes.setFiles(rescuePath); await wait(300);
    check('救出したファイルを復元できる', await rp.evaluate(() => db.entries.some(e => e.memo === '救出テスト')));
    check('正常に起動したときは救出画面を出さない', !(await rp.$('#rescue')));
    // 暗号化された端末の救出ファイルは暗証番号で復号して復元
    const encPath = path.join(TMP, 'rescue-enc.json');
    const env = await rp.evaluate(async () => { const salt = b64.enc(crypto.getRandomValues(new Uint8Array(16))); return encryptJson(JSON.stringify({ entries: [{ id: 'r2', date: '2026-01-06', type: 'expense', category: '食費', amount: 888, memo: '暗号化救出' }] }), await deriveKey('2468', salt), salt); });
    fs.writeFileSync(encPath, JSON.stringify(env));
    await rp.evaluate(() => { window.prompt = () => '2468'; });
    const [fcEnc] = await Promise.all([rp.waitForEvent('filechooser'), rp.click('text=JSONバックアップを復元')]);
    await fcEnc.setFiles(encPath); await wait(1500);
    check('暗号化された救出ファイルを暗証番号で復元', await rp.evaluate(() => db.entries.some(e => e.memo === '暗号化救出')));
    // 保存容量の表示と、上限に近いときの警告
    await openSettings(rp);
    check('保存容量の使用量を表示', /保存容量: 約\d+KB使用/.test(await text(rp, '#storage-usage')), await text(rp, '#storage-usage'));
    await rp.evaluate(() => { localStorage.setItem('kakeibo.testfill', 'x'.repeat(1900000)); renderSettings(); });
    const fullTxt = await text(rp, '#storage-usage');
    await rp.click('[data-view=input]');
    const fullNote = await text(rp, '#backup-note');
    await rp.evaluate(() => localStorage.removeItem('kakeibo.testfill'));
    check('保存容量が上限に近いと警告', fullTxt.includes('上限に近づいています') && fullNote.includes('保存容量が上限の'), fullTxt + ' | ' + fullNote);
    const rpErr = rp.errors.slice(); await rp.context().close();

    // ── 各画面がエラーなく描画 ──
    for (const v of ['calendar', 'budget', 'list', 'report']) { await page.click('[data-view=' + v + ']'); await wait(60); }
    await page.click('#rep-year'); await wait(60);
    await page.click('#rep-anal'); await wait(60);
    const errs = [...page.errors, ...pageB.errors, ...dark.errors, ...uxErr, ...rpErr];
    check('JSエラーなし', errs.length === 0, errs.join(' / '));
  } finally {
    await browser.close();
    staticSrv.close(); syncSrv.close();
  }
  const ng = results.filter(r => !r.ok);
  console.log('\n' + (results.length - ng.length) + ' / ' + results.length + ' passed');
  process.exit(ng.length ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
