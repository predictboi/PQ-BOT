import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerOf } from '../src/creator.js';
import { CATEGORIES } from '../src/config.js';

test('every category has exactly one creator owner (CREATOR or CREATOR-02)', () => {
  const owners = Object.fromEntries(CATEGORIES.map((c) => [c.name, ownerOf(c.name)]));
  assert.deepEqual(owners, { Politics: 'CREATOR', Sports: 'CREATOR-02', Crypto: 'CREATOR', Economics: 'CREATOR', Culture: 'CREATOR-02', Science: 'CREATOR', Social: 'CREATOR-02', Other: 'CREATOR-02' });
  assert.equal(ownerOf('politics'), 'CREATOR'); // case-insensitive
  assert.equal(ownerOf('Unknown'), 'CREATOR'); // unlisted → CREATOR
});
