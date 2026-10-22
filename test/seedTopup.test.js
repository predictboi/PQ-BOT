import test from 'node:test';
import assert from 'node:assert/strict';
import { LsLmsr } from '../src/lslmsr.js';
import { planTopup } from '../src/seedTopup.js';
import { pickSeed } from '../src/creator.js';

test('top-up adds exactly `add` collateral and keeps normalized prices', () => {
  const m = new LsLmsr({ outcomes: 2, alpha: 0.05, seed: 15000 }); m.buyAmount(0, 4000); m.buyAmount(1, 900);
  const p = planTopup(m.q, m.alpha, 35000, 4);
  assert.ok(Math.abs(p.total - 35000) < 1e-6);
  p.pricesBefore.forEach((x, i) => assert.ok(Math.abs(x - p.pricesAfter[i]) < 1e-9));
  assert.equal(p.legs.length, 8); // 4 rounds × YES/NO
});

test('pickSeed stays in range and rounds to 100', () => {
  assert.equal(pickSeed([40000, 70000], () => 0), 40000);
  assert.equal(pickSeed([40000, 70000], () => 0.99999), 70000);
  for (let i = 0; i < 200; i++) { const s = pickSeed([40000, 70000]); assert.ok(s >= 40000 && s <= 70000 && s % 100 === 0); }
});
