import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuote } from '../src/client/polyquest.js';
import { LsLmsr } from '../src/lslmsr.js';

const market = { alpha: 0.05, q: [20000, 60000], decimals: 6, feeBps: 20 };

test('buildQuote BUY: u64 base units, gross = spent, shares a little under what the budget buys', () => {
  const qt = buildQuote(market, 0, 'BUY', 100);
  assert.equal(qt.kind, 'BUY'); assert.equal(qt.grossUnits, '100000000'); assert.match(qt.shareUnits, /^[0-9]+$/);
  const cost = new LsLmsr({ alpha: market.alpha, q: market.q }).quoteBuy(0, Number(qt.shareUnits) / 1e6) * (1 + 0.002);
  assert.ok(cost < 100 && cost > 95, `cost ${cost}`);
});

test('buildQuote SELL: net a little under the pool payout after fees', () => {
  const qt = buildQuote(market, 1, 'SELL', 50);
  assert.equal(qt.kind, 'SELL'); assert.equal(qt.shareUnits, '50000000');
  const gross = new LsLmsr({ alpha: market.alpha, q: market.q }).quoteSell(1, 50);
  const net = Number(qt.netUnits) / 1e6; assert.ok(net < gross * 0.998 && net > gross * 0.99, `${net} vs ${gross}`);
});
