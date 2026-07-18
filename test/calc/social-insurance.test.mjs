import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSocialInsurance } from '../../src/calc/social-insurance.js';
import { loadRates } from './helpers/load-rates.mjs';

function baseInput(overrides = {}) {
  return {
    age: 30,
    prefectureCode: '13',
    municipalityCode: '13104',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'employee',
    annualIncome: 5000000,
    spouse: { hasSpouse: false, spouseIncome: null },
    ...overrides
  };
}

test('厚生年金保険料(第三者公開記事[30歳・独身・東京都・年収500万円]との一致確認)', () => {
  const rates = loadRates('tokyo');
  const result = calculateSocialInsurance(baseInput(), rates);
  assert.equal(result.pensionAnnual, 450180);
});

test('介護保険第2号被保険者(40〜64歳)に該当する場合、健康保険料が上乗せされる', () => {
  const rates = loadRates('tokyo');
  const under40 = calculateSocialInsurance(baseInput({ age: 39 }), rates);
  const over40 = calculateSocialInsurance(baseInput({ age: 40 }), rates);
  assert.equal(under40.careInsuranceApplied, false);
  assert.equal(over40.careInsuranceApplied, true);
  assert.ok(over40.healthInsuranceAnnual > under40.healthInsuranceAnnual);
});

test('都道府県ごとに健康保険料が異なる(千葉・東京・北海道)', () => {
  const input = baseInput();
  const chiba = calculateSocialInsurance(input, loadRates('chiba'));
  const tokyo = calculateSocialInsurance(input, loadRates('tokyo'));
  const hokkaido = calculateSocialInsurance(input, loadRates('hokkaido'));
  const values = new Set([chiba.healthInsuranceAnnual, tokyo.healthInsuranceAnnual, hokkaido.healthInsuranceAnnual]);
  assert.equal(values.size, 3);
});

test('年収が極端に高い場合(標準報酬月額の最上位等級)でも例外にならない', () => {
  const rates = loadRates('tokyo');
  assert.doesNotThrow(() => calculateSocialInsurance(baseInput({ annualIncome: 30000000 }), rates));
});

test('年収が極端に低い場合(標準報酬月額の最下位等級)でも例外にならない', () => {
  const rates = loadRates('tokyo');
  assert.doesNotThrow(() => calculateSocialInsurance(baseInput({ annualIncome: 500000 }), rates));
});
