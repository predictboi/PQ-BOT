import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bip39 from 'bip39';
import { keypairFromMnemonic, deriveAddresses, roleOf, generateMnemonic } from '../src/wallets.js';

// Known-answer vector for Phantom-compatible derivation m/44'/501'/0'/0'
const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
test('derivation is deterministic and Phantom-compatible (m/44\'/501\'/i\'/0\')', () => {
  const a0 = keypairFromMnemonic(M, 0).publicKey.toBase58();
  assert.equal(a0, keypairFromMnemonic(M, 0).publicKey.toBase58());
  assert.equal(a0, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.notEqual(a0, keypairFromMnemonic(M, 1).publicKey.toBase58());
});
test('roles: 0 FUNDER, 1 CREATOR, 2.. TRADER-01.., 32 CREATOR-02', () => {
  assert.equal(roleOf(0).label, 'FUNDER'); assert.equal(roleOf(1).label, 'CREATOR'); assert.equal(roleOf(2).label, 'TRADER-01'); assert.equal(roleOf(31).label, 'TRADER-30');
  assert.equal(roleOf(32).label, 'CREATOR-02'); assert.equal(roleOf(32).role, 'CREATOR');
  const rows = deriveAddresses(M); assert.equal(rows.length, 33); assert.equal(new Set(rows.map((r) => r.address)).size, 33);
  assert.equal(rows.at(-1).index, 32); assert.equal(rows.at(-1).label, 'CREATOR-02');
});
test('generated mnemonic is 24 valid words', () => { const m = generateMnemonic(); assert.equal(m.split(' ').length, 24); assert.ok(bip39.validateMnemonic(m)); });
