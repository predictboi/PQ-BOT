import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../src/funding.js';

const rows = [
  { index: 0, role: 'FUNDER', label: 'FUNDER', address: 'F', sol: 1.6, usdp: 2_500_000 },
  { index: 1, role: 'CREATOR', label: 'CREATOR', address: 'C', sol: 0, usdp: 0 },
  ...Array.from({ length: 30 }, (_, i) => ({ index: i + 2, role: 'TRADER', label: `TRADER-${String(i + 1).padStart(2, '0')}`, address: `T${i + 1}`, sol: 0, usdp: 0 })),
];

test('initial plan can be limited to CREATOR + first N traders with amount overrides', () => {
  const p = plan(rows, 'initial', { traders: 2, creatorSolInit: 0.6, traderSolInit: 0.2 });
  const labels = [...new Set(p.transfers.map((t) => t.label))];
  assert.deepEqual(labels, ['CREATOR', 'TRADER-01', 'TRADER-02']);
  assert.equal(p.transfers.find((t) => t.label === 'CREATOR' && t.kind === 'SOL').amount, 0.6);
  assert.equal(p.transfers.find((t) => t.label === 'TRADER-02' && t.kind === 'SOL').amount, 0.2);
  assert.equal(p.transfers.find((t) => t.label === 'TRADER-02' && t.kind === 'USDP').amount, 50000); // default kept
  assert.equal(p.shortSol, 0); // 0.6 + 0.4 + 3×0.0021 ≤ 1.6 − 0.5 reserve
});

test('initial plan without options covers all 31 wallets', () => {
  const p = plan(rows, 'initial');
  assert.equal(new Set(p.transfers.map((t) => t.label)).size, 31);
});
