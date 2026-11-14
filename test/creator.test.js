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

test('sports buckets: round-robin, one per event, skips excluded and already-listed events', async () => {
  const { chooseMarkets } = await import('../src/research.js');
  const { categoryByName } = await import('../src/config.js');
  const S = categoryByName('Sports');
  const mk = (id, tag, q, ev, vol, yesPrice = 0.5) => ({ id, tag, question: q, eventTitle: ev, eventSlug: ev, volume24hr: vol, eventMarketCount: 1, yesPrice });
  const cands = [
    mk(1, 'EPL', 'Exact Score: Any Other Score?', 'e1', 9e9),
    mk(2, 'EPL', 'Will Arsenal win on 2026-10-25?', 'e2', 100),
    mk(3, 'nfl', 'Will the Chiefs make the playoffs?', 'e3', 50),
    mk(4, 'nfl', 'Will the Bills win the AFC East?', 'e4', 40),
    mk(5, 'uefa-nations-league', 'Will Spain win Nations League Group A1?', 'e5', 5),
    mk(6, 'uefa-nations-league', 'Will Italy win Nations League Group A2?', 'e6', 4),
    mk(9, 'uefa-nations-league', 'Will Gibraltar win Nations League Group D1?', 'e9', 99, 0.05),
    mk(7, 'mlb', 'Will the Dodgers win the World Series?', 'used', 999),
    mk(8, 'nba', 'Paul George: Assists O/U 3.5', 'e8', 999),
  ];
  const got = chooseMarkets(cands, 5, { buckets: S.buckets, exclude: S.exclude, priceBand: S.priceBand, usedEvents: new Set(['used']) }).map((m) => m.id);
  assert.deepEqual(got, [5, 3, 6, 2, 4]); // intl, nfl, intl, (mlb used) top-flight club, (nba excluded) … nfl; Gibraltar (5%) is outside the band
});

test('chooseMarkets caps one story (name bigram) at themeCap, counting already-listed titles', async () => {
  const { chooseMarkets, themeKeys } = await import('../src/research.js');
  assert.deepEqual(themeKeys('Will Jensen Huang rejoin NVIDIA by December 31, 2026?'), ['Jensen Huang']);
  const mk = (id, q, vol) => ({ id, question: q, eventTitle: q, eventSlug: `e${id}`, volume24hr: vol, eventMarketCount: 1, yesPrice: 0.4 });
  const cands = [mk(1, 'Jensen Huang divorce by December 31?', 90), mk(2, 'Fourth Jensen Huang affair reported?', 80), mk(3, 'Will Jensen Huang join SpaceX?', 70), mk(4, 'Fed hike in December?', 60)];
  assert.deepEqual(chooseMarkets(cands, 4).map((m) => m.id), [1, 2, 4]);
  assert.deepEqual(chooseMarkets(cands, 4, { usedTitles: ['Jensen Huang out at NVIDIA?'] }).map((m) => m.id), [1, 4]);
});
