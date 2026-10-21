import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LsLmsr, modelFromState, spendToReachPrice } from '../src/lslmsr.js';

test('normalized prices match the platform (quest 900031 state)', () => {
  const m = modelFromState({ outcomeSharesWad: ['1.567211014883e+25', '1.703692310957e+25'], alphaWad: '50000000000000000' });
  const p = m.normPrices();
  assert.ok(Math.abs(p[0] - 0.31408940545128483) < 1e-9);
  assert.ok(Math.abs(p[0] + p[1] - 1) < 1e-12);
});
test('fresh market with cost-convention seed starts at 50/50 and C(q0)=seed', () => {
  const m = new LsLmsr({ outcomes: 2, alpha: 0.05, seed: 15000, seedMode: 'cost' });
  assert.ok(Math.abs(m.cost() - 15000) < 1e-6);
  assert.deepEqual(m.normPrices().map((x) => x.toFixed(6)), ['0.500000', '0.500000']);
});
test('buying YES raises YES price; spendToReachPrice hits the target', () => {
  const m = new LsLmsr({ outcomes: 2, alpha: 0.05, seed: 15000, seedMode: 'cost' });
  const r = spendToReachPrice(m, 0, 0.6, { maxSpend: 1e6 });
  assert.ok(r.spend > 0 && !r.capped);
  const c = m.clone(); c.buyAmount(0, r.spend);
  assert.ok(Math.abs(c.normPrices()[0] - 0.6) < 2e-3, `got ${c.normPrices()[0]}`);
  assert.equal(spendToReachPrice(m, 0, 0.4), null, 'already above target → null');
});
test('maxSpend cap is respected', () => {
  const m = new LsLmsr({ outcomes: 2, alpha: 0.05, seed: 15000, seedMode: 'cost' });
  const r = spendToReachPrice(m, 0, 0.95, { maxSpend: 500 });
  assert.equal(r.spend, 500); assert.equal(r.capped, true);
});
