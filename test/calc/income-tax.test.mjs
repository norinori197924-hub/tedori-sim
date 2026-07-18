import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateIncomeTax } from '../../src/calc/income-tax.js';
import { loadRates } from './helpers/load-rates.mjs';

const rates = loadRates();

function baseInput(overrides = {}) {
  return {
    age: 30,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'employee',
    annualIncome: 5000000,
    spouse: { hasSpouse: false, spouseIncome: null },
    ...overrides
  };
}

test('算出所得税額の速算表(国税庁「令和7年分 年末調整のしかた」p.38の計算例)', () => {
  const taxableIncome = 2696000;
  const bracket = rates.incomeTaxBrackets.brackets.find((b) => b.max === null || taxableIncome <= b.max);
  const actual = Math.round(taxableIncome * bracket.rate - bracket.deduction);
  assert.equal(actual, 172100);
});

test('子供0人・配偶者なしでも例外にならない', () => {
  assert.doesNotThrow(() => calculateIncomeTax(baseInput(), 700000, rates));
});

test('年収が極端に低い場合(100万円)、所得税は0円になる', () => {
  const result = calculateIncomeTax(baseInput({ annualIncome: 1000000 }), 100000, rates);
  assert.equal(result.total, 0);
});

test('年収850万円超・23歳未満の扶養親族がいる場合、所得金額調整控除が反映される', () => {
  const result = calculateIncomeTax(
    baseInput({ annualIncome: 9000000, numberOfChildren: 1, childrenAges: [10] }),
    900000,
    rates
  );
  assert.ok(result.incomeAdjustmentDeduction > 0);
});

test('年収が極端に高い場合(3000万円)でも例外にならず、所得税がかかる', () => {
  const result = calculateIncomeTax(baseInput({ annualIncome: 30000000 }), 1500000, rates);
  assert.ok(result.total > 0);
});

test('所得税額と復興特別所得税の合計が100円未満切り捨てになっている', () => {
  const result = calculateIncomeTax(baseInput(), 700000, rates);
  assert.equal(result.total % 100, 0);
});
