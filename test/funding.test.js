import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../src/funding.js';

const rows = [
  { index: 0, role: 'FUNDER', label: 'FUNDER', address: 'F', sol: 1.6, usdp: 2_500_000 },
  { index: 1, role: 'CREATOR', label: 'CREATOR', address: 'C', sol: 0, usdp: 0 },
  ...Array.from({ length: 30 }, (_, i) => ({ index: i + 2, role: 'TRADER', label: `TRADER-${String(i + 1).padStart(2, '0')}`, address: `T${i + 1}`, sol: 0, usdp: 0 })),
  { index: 32, role: 'CREATOR', label: 'CREATOR-02', address: 'C2', sol: 0, usdp: 0 },
];

test('initial plan can be limited to CREATOR + first N traders with amount overrides', () => {
  const p = plan(rows, 'initial', { traders: 2, creatorSolInit: 0.4, traderSolInit: 0.2 });
  const labels = [...new Set(p.transfers.map((t) => t.label))];
  assert.deepEqual(labels, ['CREATOR', 'TRADER-01', 'TRADER-02', 'CREATOR-02']);
  assert.equal(p.transfers.find((t) => t.label === 'CREATOR' && t.kind === 'SOL').amount, 0.4);
  assert.equal(p.transfers.find((t) => t.label === 'TRADER-02' && t.kind === 'SOL').amount, 0.2);
  assert.equal(p.transfers.find((t) => t.label === 'TRADER-02' && t.kind === 'USDP').amount, 50000); // default kept
  assert.equal(p.shortSol, 0); // 2×0.4 + 2×0.2 + 4×0.0021 ≤ 1.6 − 0.2 reserve
});

test('initial plan without options covers all 32 non-FUNDER wallets', () => {
  const p = plan(rows, 'initial');
  assert.equal(new Set(p.transfers.map((t) => t.label)).size, 32);
});

test('default SOL budget: 2 creators + 30 traders + reserve fits in 3–4 SOL', () => {
  const p = plan(rows, 'initial');
  const sol = p.transfers.filter((t) => t.kind === 'SOL').reduce((a, t) => a + t.amount, 0);
  assert.ok(Math.abs(sol - (2 * 0.3 + 30 * 0.08)) < 1e-9);
  assert.ok(sol + 0.2 >= 3 && sol + 0.2 <= 4);
});
