import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateNationalPension } from '../../src/calc/national-pension.js';
import { loadRates } from './helpers/load-rates.mjs';

const rates = loadRates();

test('38歳・配偶者なし: 本人分のみ(17,920円×12)', () => {
  const result = calculateNationalPension(
    { age: 38, spouse: { hasSpouse: false, spouseIncome: null } },
    rates.nationalPension
  );
  assert.equal(result.selfAnnual, 215040);
  assert.equal(result.spouseAnnual, 0);
  assert.equal(result.total, 215040);
});

test('45歳・配偶者あり: 本人+配偶者の2人分', () => {
  const result = calculateNationalPension(
    { age: 45, spouse: { hasSpouse: true, spouseIncome: 0 } },
    rates.nationalPension
  );
  assert.equal(result.total, 430080);
});

test('20歳未満は第1号被保険者の対象外', () => {
  const result = calculateNationalPension(
    { age: 19, spouse: { hasSpouse: false, spouseIncome: null } },
    rates.nationalPension
  );
  assert.equal(result.selfAnnual, 0);
});

test('60歳以上は第1号被保険者の対象外', () => {
  const result = calculateNationalPension(
    { age: 65, spouse: { hasSpouse: false, spouseIncome: null } },
    rates.nationalPension
  );
  assert.equal(result.selfAnnual, 0);
});
