import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateTo1000, truncateTo100, truncateYen, roundPremiumHalf } from '../../src/calc/rounding.js';

test('truncateTo1000: 1,000円未満を切り捨てる', () => {
  assert.equal(truncateTo1000(1830999), 1830000);
  assert.equal(truncateTo1000(1830000), 1830000);
});

test('truncateTo1000: 負の値は0として扱う', () => {
  assert.equal(truncateTo1000(-500), 0);
});

test('truncateTo100: 100円未満を切り捨てる', () => {
  assert.equal(truncateTo100(172199), 172100);
  assert.equal(truncateTo100(172100), 172100);
});

test('truncateYen: 円未満を切り捨てる', () => {
  assert.equal(truncateYen(1234.9), 1234);
});

test('roundPremiumHalf: 50銭以下は切り捨て', () => {
  assert.equal(roundPremiumHalf(2821.5), 2821);
  assert.equal(roundPremiumHalf(2821.0), 2821);
});

test('roundPremiumHalf: 50銭超は切り上げ', () => {
  assert.equal(roundPremiumHalf(2821.51), 2822);
  assert.equal(roundPremiumHalf(2821.99), 2822);
});
