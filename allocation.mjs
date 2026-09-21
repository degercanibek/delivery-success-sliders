// Independent integer allocations. Only valid totals may be submitted.
export function initialAllocation(ids) {
  return Object.fromEntries(ids.map(id => [id, 0]));
}
export function setAllocation(values, key, requested) {
  if (key in values && Number.isFinite(requested)) values[key] = Math.max(0, Math.min(100, Math.round(requested)));
  return values;
}
export function remainingFor(values, key) {
  return 100 - Object.entries(values).reduce((sum, [id, value]) => sum + (id === key ? 0 : value), 0);
}
export function useRemaining(values, key) {
  const remaining = remainingFor(values, key);
  if (key in values && remaining >= 0 && remaining <= 100) values[key] = remaining;
  return values;
}
export function validAllocation(values, ids) {
  return ids.length >= 2 && Object.keys(values).length === ids.length &&
    ids.every(id => Number.isFinite(values[id]) && values[id] >= 0 && values[id] <= 100) &&
    ids.reduce((sum, id) => sum + values[id], 0) === 100;
}
