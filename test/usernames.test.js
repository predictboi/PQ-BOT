import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateNames, NAME_RE } from '../src/usernames.js';

test('generateNames: valid, unique, deterministic per salt', () => {
  const labels = Array.from({ length: 40 }, (_, i) => `TRADER-${i}`);
  const a = generateNames(labels); const b = generateNames(labels); const c = generateNames(labels, { salt: 'v2' });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  const vals = Object.values(a);
  assert.ok(vals.every((n) => NAME_RE.test(n)));
  assert.equal(new Set(vals.map((n) => n.toLowerCase())).size, vals.length);
});
