import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subjectFor, buildImagePrompt } from '../src/images.js';

test('subjectFor picks a single hero subject from the question, with category fallback', () => {
  assert.match(subjectFor('Will Bitcoin close above $130,000 by October 31?', 3), /Bitcoin coin/);
  assert.match(subjectFor('연준이 10월 FOMC에서 금리를 인하할까?', 4), /Federal Reserve/);
  assert.match(subjectFor('Will Gen.G and T1 meet in the Worlds 2026 Grand Final?', 2), /esports trophy/);
  assert.match(subjectFor('Something with no keywords', 2), /stadium/);
});
test('prompt forbids text and demands a full-bleed single subject', () => {
  const p = buildImagePrompt('Will X happen?', { subject: 'a golden trophy' });
  assert.match(p, /a golden trophy/); assert.match(p, /NO title text/); assert.match(p, /NO numbers/); assert.match(p, /Full-bleed square 1:1/);
});
