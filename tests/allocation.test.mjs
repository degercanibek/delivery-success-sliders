import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAllocation, setAllocation, remainingFor, useRemaining, validAllocation } from '../allocation.mjs';
test('independent changes preserve all other values', () => {
  const v = { scope: 40, time: 35, quality: 10 };
  setAllocation(v, 'time', 30);
  assert.deepEqual(v, { scope: 40, time: 30, quality: 10 });
  assert.equal(remainingFor(v, 'quality'), 30);
  useRemaining(v, 'quality');
  assert.deepEqual(v, { scope: 40, time: 30, quality: 30 });
  assert.equal(validAllocation(v, Object.keys(v)), true);
});
test('remaining action refuses impossible totals and accepts zero', () => {
  const v = { a: 80, b: 30, c: 10 };
  useRemaining(v, 'c');
  assert.equal(v.c, 10);
  assert.equal(remainingFor(v, 'c'), -10);
  setAllocation(v, 'a', 70); useRemaining(v, 'c');
  assert.equal(v.c, 0);
});
test('bounds, invalid input, minimum dimensions and exact totals', () => {
  for (const count of [1, 2, 3, 4, 7, 101]) {
    const ids = Array.from({ length: count }, (_, i) => `d${i}`);
    const v = initialAllocation(ids);
    assert.deepEqual(Object.values(v), Array(count).fill(0));
    assert.equal(validAllocation(v, ids), false);
    const others = ids.slice(1).map(id => v[id]);
    setAllocation(v, ids[0], 1000);
    assert.equal(v[ids[0]], 100);
    assert.equal(validAllocation(v, ids), count >= 2);
    assert.deepEqual(ids.slice(1).map(id => v[id]), others);
    setAllocation(v, ids[0], NaN);
    assert.equal(v[ids[0]], 100);
    setAllocation(v, ids[0], -10);
    assert.equal(v[ids[0]], 0);
  }
  assert.equal(validAllocation({ a: 40, b: 59 }, ['a', 'b']), false);
  assert.equal(validAllocation({ a: 40, b: 61 }, ['a', 'b']), false);
});
