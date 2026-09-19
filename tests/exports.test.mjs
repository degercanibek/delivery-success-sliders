import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, responsesCsv } from '../exports.mjs';
test('CSV escapes quotes/newlines and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  for (const value of ['=CMD()', '+1', '-2', '@SUM(A1)', '  =1', '\tvalue']) assert.ok(csvCell(value).startsWith('"\''));
});
test('CSV retains individual rows and bilingual headers with dimension IDs', () => {
  const result = responsesCsv({ session: { slug: 'test' }, groups: [{ id: 'g', name_tr: 'Ürün', name_en: 'Product' }], dimensions: [{ id: 'd', name_tr: 'Kapsam', name_en: 'Scope' }], responses: [{ id: 'r', created_at: '2026-09-19', group_id: 'g', answers: { d: 100 } }] });
  assert.ok(result.startsWith('\uFEFF'));
  assert.match(result, /Kapsam \/ Scope \[d\]/);
  assert.match(result, /"Ürün","Product","100"/);
  assert.equal(result.split('\r\n').length, 3);
  assert.ok(!result.includes('device_token'));
});
