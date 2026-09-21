import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as allocation from '../allocation.mjs';
import * as presentation from '../presentation.mjs';
import * as exportsModule from '../exports.mjs';
const require = createRequire(`${process.env.DSS_TEST_TOOLS || '/tmp/dss-review-tools'}/package.json`);
const { JSDOM } = require('jsdom');
const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const session = { id: 'session-one', slug: 'test', title_tr: 'Deneme', title_en: 'Test', is_open: true };
const groups = [{ id: 'group-one', session_id: session.id, name_tr: 'Grup', name_en: 'Group' }];
const dimensions = [0, 1, 2].map(i => ({ id: `dimension-${i}`, session_id: session.id, name_tr: `Boyut ${i}`, name_en: `Dimension ${i}` }));
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw Error('UI did not reach expected state');
}
function harness(hash, options = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: `${options.origin || 'https://example.test'}/repository/${hash}`, runScripts: 'outside-only' });
  const { window } = dom;
  const ticks = new Map(); let tickId = 0;
  const downloads = [];
  Object.assign(window, allocation, presentation, exportsModule, {
    liveFeed: settings => presentation.liveFeed({ ...settings, schedule: callback => { ticks.set(++tickId, callback); return tickId; }, cancel: id => ticks.delete(id) }),
    downloadFile: (...args) => downloads.push(args)
  });
  const calls = [], chartOptions = [], tableReads = []; let authCallback;
  const sb = {
    auth: { getSession: async () => ({ data: { session: options.signedIn ? {} : null }, error: null }), onAuthStateChange: callback => { authCallback = callback; }, signOut: async () => ({ error: null }) },
    from(table) {
      tableReads.push(table);
      let single = false; const filters = [];
      const query = { select: () => query, eq: (key, value) => { filters.push([key, value]); return query; }, order: () => query, maybeSingle: () => { single = true; return query; },
        then(resolve, reject) {
          if (options.loadError) return Promise.resolve({ error: { message: 'network failure' }, data: null }).then(resolve, reject);
          const rows = ({ sessions: options.missing ? [] : [session], groups: options.groups || groups, dimensions: options.dimensions || dimensions })[table];
          assert.ok(rows, `Unexpected table access: ${table}`);
          const filtered = rows.filter(row => filters.every(([key, value]) => row[key] === value));
          return Promise.resolve({ data: single ? filtered[0] || null : filtered, error: null }).then(resolve, reject);
        }
      }; return query;
    },
    rpc: async (fn, params) => {
      calls.push({ fn, params });
      if (fn === 'voting_session') {
        if (options.missing || params.p_slug !== 'test') return { error: { message: 'DSS_NOT_FOUND' } };
        if (options.closed) return { error: { message: 'DSS_CLOSED' } };
        if (options.loadError) return { error: { message: 'network failure' } };
        return { data: { session, groups: options.groups || groups, dimensions: options.dimensions || dimensions } };
      }
      if (fn === 'is_admin') return { data: !!options.isAdmin };
      if (fn === 'submit_vote') return options.submit ? options.submit(params) : { data: null };
      if (fn === 'session_results') return { data: options.aggregate || { response_count: 0, groups: [], averages: [] } };
      if (fn === 'export_session') return options.exportError ? { error: { code: 'PGRST202' } } : { data: options.archive };
      if (fn === 'duplicate_session' && options.duplicateError) return { error: { message: 'DSS_FORBIDDEN' } };
      return { data: session.id };
    }
  };
  window.supabase = { createClient: () => sb };
  window.echarts = { init: () => ({ setOption: option => chartOptions.push(option), dispose() {}, resize() {} }) };
  window.qrcode = options.qrcode;
  window.console.error = () => {};
  window.confirm = () => false;
  window.eval(source);
  return { dom, window, document: window.document, calls, chartOptions, tableReads, authEvent: event => authCallback(event), downloads, ticks, tick: () => { const entry = ticks.entries().next().value; if (entry) { ticks.delete(entry[0]); return entry[1](); } } };
}

test('hash navigation works and management checks authentication and allowlist', async () => {
  const h = harness('#home');
  await waitFor(() => h.document.querySelector('.participant-message'));
  h.window.location.hash = '#manage?s=test';
  await waitFor(() => h.document.querySelector('[name=password]'));
  assert.equal(h.document.querySelector('#wipe'), null);
  h.window.location.hash = '#vote?s=test';
  await waitFor(() => h.document.querySelector('#send'));
  h.dom.window.close();
  const denied = harness('#/admin', { signedIn: true, isAdmin: false });
  await waitFor(() => !denied.document.querySelector('[data-error]').hidden);
  assert.match(denied.document.querySelector('[data-error]').textContent, /yetkili yönetici/);
  assert.equal(denied.document.querySelector('[name=slug]'), null);
  denied.dom.window.close();
});

test('drag keeps the same DOM, synchronizes totals, and blocks double submit', async () => {
  let finish;
  const h = harness('#vote?s=test', { submit: () => new Promise(resolve => { finish = resolve; }) });
  await waitFor(() => h.document.querySelector('#send'));
  const range = h.document.querySelector('[data-range]');
  for (const value of [0, 40, 100, 15]) {
    range.value = value;
    range.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.equal(h.document.querySelector('[data-range]'), range);
    assert.equal(h.document.querySelectorAll('[data-number]')[1].value, '33');
    assert.equal(h.document.querySelectorAll('[data-number]')[2].value, '33');
    assert.equal(h.document.querySelector('#send').disabled, value !== 34);
    assert.equal(h.document.querySelector('[data-number]').value, range.value);
  }
  const number = h.document.querySelector('[data-number]');
  number.value = '60'; number.dispatchEvent(new h.window.Event('input'));
  assert.equal(range.value, '60');
  assert.equal(h.document.querySelector('.total').classList.contains('over-budget'), true);
  h.document.querySelector('[data-balance=dimension-1]').click();
  assert.equal(h.document.querySelectorAll('[data-number]')[1].value, '7');
  assert.equal(range.value, '60');
  assert.equal(h.document.querySelector('#total').textContent, '100');
  h.document.querySelector('[name=group]').checked = true;
  const button = h.document.querySelector('#send');
  button.click(); button.click();
  await waitFor(() => finish);
  assert.equal(button.disabled, true);
  assert.equal(h.calls.filter(c => c.fn === 'submit_vote').length, 1);
  finish({ data: null });
  await waitFor(() => h.document.querySelector('h2')?.textContent === 'Teşekkürler');
  h.dom.window.close();
});

test('failed submission retains values and enables retry with the same device token', async () => {
  const h = harness('#vote?s=test', { submit: async () => ({ error: { message: 'DSS_DUPLICATE' } }) });
  await waitFor(() => h.document.querySelector('#send'));
  h.document.querySelector('[name=group]').checked = true;
  h.document.querySelector('#send').click();
  await waitFor(() => !h.document.querySelector('[data-error]').hidden);
  assert.match(h.document.querySelector('[data-error]').textContent, /zaten oy/);
  assert.equal(h.document.querySelector('#send').disabled, false);
  h.document.querySelector('#send').click();
  await waitFor(() => h.calls.filter(c => c.fn === 'submit_vote').length === 2);
  const submissions = h.calls.filter(call => call.fn === 'submit_vote');
  assert.equal(submissions[0].params.p_device_token, submissions[1].params.p_device_token);
  h.dom.window.close();
});

test('missing sessions, load errors and too few dimensions render bilingual errors', async () => {
  for (const options of [{ missing: true }, { loadError: true }, { dimensions: [dimensions[0]] }]) {
    const h = harness('#vote?s=test', options);
    await waitFor(() => !h.document.querySelector('[data-error]').hidden);
    const turkish = h.document.querySelector('[data-error]').textContent;
    assert.ok(turkish.length);
    h.document.querySelector('#lang').click();
    await waitFor(() => !h.document.querySelector('[data-error]').hidden);
    assert.notEqual(h.document.querySelector('[data-error]').textContent, turkish);
    assert.equal(h.document.documentElement.lang, 'en');
    h.dom.window.close();
  }
});

test('results reveal independently, freeze display, update automatically and clean up on navigation', async () => {
  const options = { signedIn: true, isAdmin: true, aggregate: { response_count: 1, groups: [], averages: [] } };
  const h = harness('?s=test#results', options);
  await waitFor(() => h.document.querySelector('#freeze'));
  assert.equal(h.document.querySelector('#count').textContent, '1');
  assert.equal(h.document.querySelector('#chart-vote-count').textContent, '1 kişi oy kullandı');
  assert.equal(h.document.querySelector('#blur').max, '100');
  h.document.querySelector('[data-reveal=groups]').click();
  let last = h.chartOptions.at(-1);
  assert.equal(last.series[0].name, 'Grup');
  assert.equal(last.series[0].label.show, false);
  assert.equal(last.yAxis.show, false);
  h.document.querySelector('[data-reveal=values]').click();
  assert.equal(h.chartOptions.at(-1).tooltip.show, true);
  const blur = h.document.querySelector('#blur');
  blur.value = '25'; blur.dispatchEvent(new h.window.Event('input'));
  assert.equal(h.document.querySelector('#chart').style.filter, 'blur(8px)');
  h.document.querySelector('#freeze').click();
  const before = h.chartOptions.length;
  options.aggregate = { response_count: 2, groups: [], averages: [] };
  await h.tick();
  assert.equal(h.chartOptions.length, before);
  assert.equal(h.document.querySelector('#count').textContent, '1');
  assert.equal(h.document.querySelector('#chart-vote-count').textContent, '1 kişi oy kullandı');
  h.document.querySelector('#freeze').click();
  await waitFor(() => h.document.querySelector('#count').textContent === '2');
  assert.equal(h.document.querySelector('#chart-vote-count').textContent, '2 kişi oy kullandı');
  assert.equal(h.document.querySelector('#chart').style.filter, 'blur(8px)');
  options.aggregate = { response_count: 3, groups: [], averages: [] };
  await h.tick();
  assert.equal(h.document.querySelector('#count').textContent, '3');
  assert.equal(h.document.querySelector('#chart-vote-count').textContent, '3 kişi oy kullandı');
  h.document.querySelector('#fully-reveal').click();
  assert.equal(h.chartOptions.at(-1).yAxis.show, true);
  assert.equal(h.document.querySelector('#blur').value, '0');
  h.document.querySelector('#fully-blur').click();
  assert.equal(h.document.querySelector('#blur').value, '100');
  assert.equal(h.chartOptions.at(-1).yAxis.show, true); // Blur is independent.
  h.document.querySelector('#reset-reveal').click();
  assert.equal(h.chartOptions.at(-1).yAxis.show, false);
  assert.equal(h.chartOptions.at(-1).series[0].name, 'Grup A');
  h.document.querySelector('#presenter').click();
  await waitFor(() => h.document.body.classList.contains('presenting'));
  assert.equal(h.document.querySelector('.presenter-controls').open, false);
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(h.document.body.classList.contains('presenting'), false);
  h.window.location.hash = '#home';
  await waitFor(() => h.document.querySelector('.participant-message'));
  assert.equal(h.ticks.size, 0);
  assert.equal(h.document.body.classList.contains('results-view'), false);
  h.dom.window.close();
});

test('sharing uses the participant URL, preserves subpaths, warns for localhost and falls back on clipboard failure', async () => {
  let encoded;
  const h = harness('?old=1#manage?s=test', { signedIn: true, isAdmin: true, origin: 'http://127.0.0.1:8000', qrcode: () => ({ addData: value => { encoded = value; }, make() {}, createSvgTag: () => '<svg></svg>' }) });
  await waitFor(() => h.document.querySelector('#participant-link'));
  assert.equal(encoded, 'http://127.0.0.1:8000/repository/#vote?s=test');
  assert.equal(h.document.querySelector('#participant-link').value, encoded);
  assert.ok(h.document.querySelector('.share-warning'));
  assert.ok(h.document.querySelector('#participant-qr svg'));
  h.document.querySelector('#copy-link').click();
  await waitFor(() => h.document.querySelector('#copy-status').textContent);
  assert.match(h.document.querySelector('#copy-status').textContent, /Ctrl\+C/);
  h.dom.window.close();
});

test('slug guidance and QR failure remain usable', async () => {
  const h = harness('#admin', { signedIn: true, isAdmin: true });
  await waitFor(() => h.document.querySelector('#slug-help'));
  assert.match(h.document.querySelector('#slug-help').textContent, /mvp-test-01/);
  assert.equal(h.document.querySelector('[name=slug]').getAttribute('aria-describedby'), 'slug-help');
  h.window.location.hash = '#manage?s=test';
  await waitFor(() => h.document.querySelector('#participant-qr'));
  assert.match(h.document.querySelector('#participant-qr').textContent, /QR yüklenemedi/);
  assert.ok(h.document.querySelector('#participant-link'));
  h.dom.window.close();
});


test('new groups/dimensions join the current reveal state, without exposing identities', async () => {
  const opts = { signedIn: true, isAdmin: true, groups: [...groups], dimensions: [...dimensions] };
  const h = harness('#results?s=test', opts);
  await waitFor(() => h.document.querySelector('#freeze'));
  opts.groups.push({ id: 'new-group', session_id: session.id, name_tr: 'Gizli', name_en: 'Secret' });
  opts.dimensions.push({ id: 'new-dimension', session_id: session.id, name_tr: 'Yeni', name_en: 'New' });
  await h.tick();
  const option = h.chartOptions.at(-1);
  assert.equal(option.series.length, 2);
  assert.equal(option.xAxis.data.length, 4);
  assert.ok(!JSON.stringify(option).includes('Gizli'));
  assert.ok(!JSON.stringify(option).includes('Yeni'));
  h.dom.window.close();
});

test('admin exports download a complete archive, CSV and report missing migration', async () => {
  const options = { signedIn: true, isAdmin: true, archive: { session, groups, dimensions, responses: [], schema_version: 1 } };
  const h = harness('#manage?s=test', options);
  await waitFor(() => h.document.querySelector('#export-json'));
  h.document.querySelector('#export-json').click();
  await waitFor(() => h.downloads.length === 1);
  assert.deepEqual(JSON.parse(h.downloads[0][0]), options.archive);
  h.document.querySelector('#export-csv').click();
  await waitFor(() => h.downloads.length === 2);
  assert.equal(h.downloads[1][1], 'test.csv');
  options.exportError = true;
  h.document.querySelector('#export-json').click();
  await waitFor(() => !h.document.querySelector('[data-error]').hidden);
  assert.match(h.document.querySelector('[data-error]').textContent, /oturum yöneticisine/);
  h.dom.window.close();
});

test('deployed HTTPS participant QR follows the current origin and subpath', async () => {
  let encoded;
  const h = harness('?old=1#manage?s=test', { signedIn: true, isAdmin: true, origin: 'https://workshop.example.org', qrcode: () => ({ addData: value => { encoded = value; }, make() {}, createSvgTag: () => '<svg></svg>' }) });
  await waitFor(() => h.document.querySelector('#participant-link'));
  assert.equal(encoded, 'https://workshop.example.org/repository/#vote?s=test');
  assert.equal(h.document.querySelector('.share-warning'), null);
  h.dom.window.close();
});


test('participant loading, voting, confirmation and language switch never contain admin navigation or data', async () => {
  const h = harness('#vote?s=test');
  const isolated = () => {
    assert.equal(h.document.querySelectorAll('a, nav').length, 0);
    assert.equal(h.document.querySelector('#count, #presenter, #freeze, [name=password]'), null);
  };
  isolated();
  await waitFor(() => h.document.querySelector('#send'));
  isolated();
  assert.deepEqual(h.tableReads, []);
  assert.deepEqual(h.calls.map(call => call.fn), ['voting_session']);
  assert.ok(h.document.querySelector('.budget-complete'));
  h.document.querySelector('[name=group]').checked = true;
  h.document.querySelector('#send').click();
  await waitFor(() => h.document.querySelector('.submitted-mark'));
  isolated();
  assert.equal(h.document.querySelector('#send'), null);
  h.document.querySelector('#lang').click();
  await waitFor(() => h.document.querySelector('.submitted-mark'));
  assert.match(h.document.querySelector('main').textContent, /Thank you/);
  isolated();
  assert.ok(!h.calls.some(call => ['is_admin', 'session_results'].includes(call.fn)));
  h.dom.window.close();
});

test('participant errors and closed/deleted sessions retain isolated layout', async () => {
  for (const options of [{ closed: true }, { missing: true }, { loadError: true }]) {
    const h = harness('#vote?s=test', options);
    await waitFor(() => !h.document.querySelector('[data-error]').hidden);
    assert.equal(h.document.querySelectorAll('a, nav').length, 0);
    assert.equal(h.document.querySelector('#count, #presenter, [name=password]'), null);
    assert.deepEqual(h.tableReads, []);
    h.dom.window.close();
  }
});

test('anonymous/non-admin result routes never fetch aggregates or render charts', async () => {
  for (const options of [{}, { signedIn: true, isAdmin: false }]) {
    const h = harness('#results?s=test', options);
    await waitFor(() => h.document.querySelector('[name=password]') || !h.document.querySelector('[data-error]').hidden);
    assert.equal(h.calls.some(c => c.fn === 'session_results'), false);
    assert.deepEqual(h.tableReads, []);
    assert.equal(h.document.querySelector('#chart, #count, #presenter'), null);
    h.dom.window.close();
  }
});

test('admin stays signed in between management and results; signout immediately clears frozen results', async () => {
  const options = { signedIn: true, isAdmin: true };
  const h = harness('#manage?s=test', options);
  await waitFor(() => h.document.querySelector('#wipe'));
  h.window.location.hash = '#results?s=test';
  await waitFor(() => h.document.querySelector('#freeze'));
  assert.equal(h.document.querySelector('[name=password]'), null);
  h.document.querySelector('#freeze').click();
  options.signedIn = false;
  h.authEvent('SIGNED_OUT');
  assert.equal(h.document.querySelector('#chart, #count'), null);
  await waitFor(() => h.document.querySelector('[name=password]'));
  assert.equal(h.ticks.size, 0);
  h.dom.window.close();
});
