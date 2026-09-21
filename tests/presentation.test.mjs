import test from 'node:test';
import assert from 'node:assert/strict';
import { chartOption, identityMap, letter, liveFeed, groupParticipation } from '../presentation.mjs';
const data = {
  groups: [{ id: 'lead', name_en: 'Leadership' }, { id: 'eng', name_en: 'Engineering' }, { id: 'prod', name_en: 'Product' }],
  dimensions: [{ id: 'scope', name_en: 'Scope' }, { id: 'time', name_en: 'Time' }],
  results: { averages: [{ group_id: 'lead', dimension_id: 'scope', average: 40 }] }
};
test('hidden identities have no real labels, IDs, colors or configuration ordering', () => {
  const identities = identityMap(() => 0), aliases = new Map();
  const flags = { categories: false, groups: false, values: false, axis: false };
  const hidden = chartOption(data, flags, identities, aliases, 'en');
  for (const secret of ['Leadership', 'Engineering', 'Product', 'Scope', 'Time', 'lead', 'prod', 'scope']) assert.ok(!JSON.stringify(hidden).includes(secret));
  assert.deepEqual(hidden.xAxis.data, ['Dimension A', 'Dimension B']);
  assert.deepEqual(hidden.series.map(s => s.name), ['Group A', 'Group B', 'Group C']);
  assert.ok(hidden.series.every(s => s.itemStyle.color.colorStops[0].color === '#a0aec6'));
  assert.equal(hidden.tooltip.show, false);
  const shown = chartOption(data, { ...flags, groups: true, values: true }, identities, aliases, 'en');
  assert.notEqual(shown.series[0].name, 'Leadership');
  assert.equal(shown.series.find(s => s.name === 'Leadership').data[0], 40);
  assert.equal(shown.xAxis.data[0], 'Dimension A');
  assert.equal(shown.yAxis.show, false);
  const again = chartOption(data, flags, identities, aliases, 'en');
  assert.deepEqual(again.series.map(s => [s.id, s.data]), hidden.series.map(s => [s.id, s.data]));
});
test('aliases survive additions/removals and support more than 26 items', () => {
  const identities = identityMap(() => 0), aliases = new Map();
  const flags = {};
  const first = chartOption(data, flags, identities, aliases, 'en');
  const next = chartOption({ ...data, groups: [...data.groups, { id: 'new', name_en: 'New Group' }], dimensions: [data.dimensions[1], { id: 'new-dim', name_en: 'New' }] }, flags, identities, aliases, 'en');
  assert.equal(next.series.at(-1).name, 'Group D');
  assert.deepEqual(next.series.slice(0, 3).map(s => s.id), first.series.map(s => s.id));
  assert.deepEqual(next.xAxis.data, ['Dimension B', 'Dimension C']);
  assert.equal(letter(26), 'AA'); assert.equal(letter(701), 'ZZ');
});
test('freeze rejects in-flight data, unfreeze fetches fresh, failures retry and stop discards pending work', async () => {
  const tasks = new Map(); let tid = 0;
  const pending = [], applied = [], states = [];
  const feed = liveFeed({
    load: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    apply: x => applied.push(x), status: s => states.push(s),
    schedule: fn => { tasks.set(++tid, fn); return tid; }, cancel: id => tasks.delete(id)
  });
  const initial = feed.refresh();
  feed.freeze(true);
  pending.shift().resolve('stale'); await initial;
  assert.deepEqual(applied, []); assert.equal(tasks.size, 0);
  feed.freeze(false);
  pending.shift().resolve('fresh'); await new Promise(r => setImmediate(r));
  assert.deepEqual(applied, ['fresh']);
  const failed = feed.refresh(); pending.shift().reject(Error('offline')); await failed;
  assert.equal(states.at(-1), 'error'); assert.equal(tasks.size, 1);
  const active = feed.refresh(); feed.stop(); pending.shift().resolve('after-stop'); await active;
  assert.deepEqual(applied, ['fresh']); assert.equal(tasks.size, 0);
});
test('rapid unfreeze does not apply a pre-freeze response or overlap requests', async () => {
  const pending = [], applied = [];
  const feed = liveFeed({ load: () => new Promise(resolve => pending.push(resolve)), apply: x => applied.push(x), schedule: () => 0, cancel() {} });
  const first = feed.refresh(); feed.freeze(true); feed.freeze(false);
  assert.equal(pending.length, 1);
  pending.shift()('old'); await first;
  assert.deepEqual(applied, []); assert.equal(pending.length, 1);
  pending.shift()('new'); await new Promise(r => setImmediate(r));
  assert.deepEqual(applied, ['new']); feed.stop();
});

test('chart typography, bar width and spacing scale with the available window', () => {
  const make = (width, height) => chartOption(data, { groups: true, values: true, axis: true }, identityMap(() => 0), new Map(), 'en', false, { width, height });
  const small = make(700, 350), standard = make(1200, 560), projected = make(3000, 1500);
  for (const read of [o => o.legend.textStyle.fontSize, o => o.xAxis.axisLabel.fontSize, o => o.yAxis.axisLabel.fontSize, o => o.series[0].label.fontSize, o => o.series[0].barMaxWidth, o => o.grid.top]) {
    assert.ok(read(small) < read(standard));
    assert.ok(read(projected) > read(standard));
  }
  assert.ok(make(3000, 300).series[0].label.fontSize < projected.series[0].label.fontSize);
  assert.ok(make(300, 200).legend.textStyle.fontSize >= 10);
});


test('participation cards use stable aliases, show zero counts and refresh without leaking identities', () => {
  const identities = identityMap(() => 0);
  const snapshot = { ...data, results: { ...data.results, groups: [{ group_id: 'lead', response_count: 12 }] } };
  const hidden = groupParticipation(snapshot, identities, false, 'tr');
  assert.ok(hidden.every(g => g.label.startsWith('Grup ')));
  assert.ok(!JSON.stringify(hidden).includes('Leadership'));
  const shown = groupParticipation(snapshot, identities, true, 'en');
  assert.equal(shown.find(g => g.label === 'Leadership').count, 12);
  assert.equal(shown.find(g => g.label === 'Product').count, 0);
  snapshot.results.groups[0].response_count = 13;
  const refreshed = groupParticipation(snapshot, identities, false, 'tr');
  assert.deepEqual(refreshed.map(g => g.label), hidden.map(g => g.label));
  assert.equal(refreshed.find(g => g.count > 0).count, 13);
});
