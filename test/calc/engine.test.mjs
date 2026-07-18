import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTakeHome } from '../../src/calc/engine.js';
import { loadRates } from './helpers/load-rates.mjs';

const rates = loadRates();

function baseInput(overrides = {}) {
  return {
    age: 38,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 2,
    childrenAges: [4, 7],
    employmentType: 'employee',
    annualIncome: 5000000,
    spouse: { hasSpouse: true, spouseIncome: 1000000 },
    ...overrides
  };
}

test('かんたん入力の標準ケース(モックアップ想定条件)で例外なく計算でき、0<手取り<年収となる', () => {
  const result = calculateTakeHome(baseInput(), rates);
  assert.ok(result.takeHomeAnnual > 0);
  assert.ok(result.takeHomeAnnual < baseInput().annualIncome);
  assert.equal(
    result.takeHomeAnnual,
    baseInput().annualIncome - result.incomeTax.total - result.residentTax.total - result.socialInsurance.total
  );
});

test('子供0人・配偶者なしでも例外にならない', () => {
  const input = baseInput({ numberOfChildren: 0, childrenAges: [], spouse: { hasSpouse: false, spouseIncome: null } });
  assert.doesNotThrow(() => calculateTakeHome(input, rates));
});

test('年収が極端に低い場合(50万円)でも例外にならず、手取りが年収を超えない', () => {
  const input = baseInput({ annualIncome: 500000, numberOfChildren: 0, childrenAges: [], spouse: { hasSpouse: false, spouseIncome: null } });
  const result = calculateTakeHome(input, rates);
  assert.ok(result.takeHomeAnnual <= input.annualIncome);
});

test('年収が極端に高い場合(3000万円)でも例外にならず、所得金額調整控除が反映される', () => {
  const input = baseInput({ annualIncome: 30000000 });
  const result = calculateTakeHome(input, rates);
  assert.ok(result.incomeTax.incomeAdjustmentDeduction > 0);
  assert.ok(result.takeHomeAnnual > 0);
});

test('フリーランス・自営業は第1弾では未対応でエラーになる', () => {
  const input = baseInput({ employmentType: 'freelance' });
  assert.throws(() => calculateTakeHome(input, rates));
});

test('assumptions(前提・注記)が必ず1件以上含まれる', () => {
  const result = calculateTakeHome(baseInput(), rates);
  assert.ok(Array.isArray(result.assumptions));
  assert.ok(result.assumptions.length > 0);
});
