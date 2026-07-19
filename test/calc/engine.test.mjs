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
  assert.ok(result.income.incomeAdjustmentDeduction > 0);
  assert.ok(result.takeHomeAnnual > 0);
});

test('assumptions(前提・注記)が必ず1件以上含まれる', () => {
  const result = calculateTakeHome(baseInput(), rates);
  assert.ok(Array.isArray(result.assumptions));
  assert.ok(result.assumptions.length > 0);
});

test('未対応の雇用形態を指定するとエラーになる', () => {
  const input = baseInput({ employmentType: 'part-time' });
  assert.throws(() => calculateTakeHome(input, rates));
});

test('フリーランス(市川市・単身38歳・年収500万円)で例外なく計算でき、内訳の合計が一致する', () => {
  const input = {
    age: 38,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'freelance',
    annualIncome: 5000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  const result = calculateTakeHome(input, rates);
  assert.ok(result.takeHomeAnnual > 0);
  assert.ok(result.takeHomeAnnual < input.annualIncome);
  assert.equal(
    result.takeHomeAnnual,
    input.annualIncome - result.incomeTax.total - result.residentTax.total - result.socialInsurance.total
  );
  assert.equal(result.income.totalIncome, input.annualIncome);
  assert.equal(result.income.businessExpense, 0);
  assert.equal(
    result.socialInsurance.total,
    result.socialInsurance.nationalHealthInsurance.total + result.socialInsurance.nationalPension.total
  );
});

test('フリーランスは所得金額調整控除の対象外(給与所得者のみの制度)', () => {
  const input = {
    age: 38,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 1,
    childrenAges: [10],
    employmentType: 'freelance',
    annualIncome: 9000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  const result = calculateTakeHome(input, rates);
  assert.equal(result.income.businessExpense, 0);
  assert.equal(result.income.totalIncome, input.annualIncome);
});

test('同一年収・条件で会社員よりフリーランスの方が社会保険料の仕組みが異なり、手取りが変わる', () => {
  const employeeInput = {
    age: 38,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'employee',
    annualIncome: 5000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  const freelanceInput = { ...employeeInput, employmentType: 'freelance' };
  const employeeResult = calculateTakeHome(employeeInput, rates);
  const freelanceResult = calculateTakeHome(freelanceInput, rates);
  assert.notEqual(employeeResult.takeHomeAnnual, freelanceResult.takeHomeAnnual);
});
