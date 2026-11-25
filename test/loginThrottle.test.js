import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginThrottle, isRateLimited } from '../src/client/polyquest.js';

const clock = () => { let t = 0; return { now: () => t, sleepFn: async (ms) => { t += ms; } }; };

test('logins run one at a time with a minimum gap', async () => {
  const c = clock(); const starts = [];
  const login = createLoginThrottle(async (id) => { starts.push([id, c.now()]); return id; }, { gapMs: 2000, ...c });
  const got = await Promise.all([login('a'), login('b'), login('c')]);
  assert.deepEqual(got, ['a', 'b', 'c']);
  assert.deepEqual(starts.map(([, t]) => t), [0, 2000, 4000]);
});

test('429 is retried with backoff; other errors are not', async () => {
  const c = clock(); let n = 0;
  const login = createLoginThrottle(async () => { if (++n < 3) throw new Error('login failed (status 429) — Too many requests'); return 'ok'; }, { gapMs: 0, backoffMs: 5000, ...c });
  assert.equal(await login('x'), 'ok');
  assert.equal(n, 3);
  assert.equal(c.now(), 5000 + 10000);
  const bad = createLoginThrottle(async () => { throw new Error('nonce step failed (HTTP 500)'); }, { gapMs: 0, ...c });
  await assert.rejects(bad('y'), /500/);
  assert.equal(isRateLimited(new Error('HTTP 429')), true);
  assert.equal(isRateLimited(new Error('HTTP 4290 bytes')), false);
});

test('a failed login does not block the queue', async () => {
  const c = clock();
  const login = createLoginThrottle(async (id) => { if (id === 'bad') throw new Error('boom'); return id; }, { gapMs: 0, retries: 0, ...c });
  const [r1, r2] = await Promise.allSettled([login('bad'), login('good')]);
  assert.equal(r1.status, 'rejected'); assert.equal(r2.value, 'good');
});
