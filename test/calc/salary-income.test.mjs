import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSalaryIncome, lookupSalaryIncomeDeduction } from '../../src/calc/salary-income.js';
import { loadRates } from './helpers/load-rates.mjs';

const rates = loadRates();

test('給与所得控除後の給与等の金額(国税庁「令和7年分 年末調整のしかた」p.36の計算例)', () => {
  // 給与の総額7,654,321円 × 90% − 1,100,000円 = 5,788,888.9円 → 切り捨て
  const actual = calculateSalaryIncome(7654321, rates.salaryIncomeDeduction);
  assert.equal(actual, 5788888);
});

test('給与所得控除額+給与所得=収入金額の関係が常に成り立つ(端数処理の整合性)', () => {
  const income = 7654321;
  const deduction = lookupSalaryIncomeDeduction(income, rates.salaryIncomeDeduction);
  const salaryIncome = calculateSalaryIncome(income, rates.salaryIncomeDeduction);
  assert.equal(deduction + salaryIncome, income);
});

test('最低保障額(74万円)が適用される低収入帯', () => {
  const actual = calculateSalaryIncome(1000000, rates.salaryIncomeDeduction);
  assert.equal(actual, 1000000 - 740000);
});

test('収入が最低保障額未満の場合、給与所得はマイナスにならず0になる', () => {
  const actual = calculateSalaryIncome(500000, rates.salaryIncomeDeduction);
  assert.equal(actual, 0);
});

test('収入0円でも例外にならない', () => {
  assert.doesNotThrow(() => calculateSalaryIncome(0, rates.salaryIncomeDeduction));
  assert.equal(calculateSalaryIncome(0, rates.salaryIncomeDeduction), 0);
});
