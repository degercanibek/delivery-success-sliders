import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArchive } from '../imports.mjs';
test('archive preview rejects malformed, unsupported and oversized input', () => {
  const archive = { schema_version: 1, session: { title_tr: 'Arşiv' }, groups: [], dimensions: [], responses: [] };
  assert.deepEqual(parseArchive(JSON.stringify(archive)), archive);
  for (const text of ['{', 'null', JSON.stringify({ ...archive, schema_version: 2 }), JSON.stringify({ ...archive, groups: {} }), JSON.stringify({ ...archive, groups: Array(101).fill({}) }), ' '.repeat(5 * 1024 * 1024 + 1)]) assert.throws(() => parseArchive(text), /DSS_ARCHIVE/);
});
