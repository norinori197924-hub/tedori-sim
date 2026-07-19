// @ts-check
import { calculateSalaryIncome, lookupSalaryIncomeDeduction } from './salary-income.js';
import { calculateIncomeAdjustmentDeduction } from './income-adjustment.js';

/** @typedef {import('./types.js').SimpleInput} SimpleInput */
/** @typedef {import('./types.js').RateBundle} RateBundle */

/**
 * 会社員の合計所得金額(所得金額調整控除後)を求める。
 * 所得金額調整控除は給与所得者のみに適用される制度のため、この関数の中でのみ適用する。
 * @param {SimpleInput} input
 * @param {RateBundle} rates
 * @returns {{ totalIncome: number, salaryIncomeDeduction: number, incomeAdjustmentDeduction: number }}
 */
export function calculateEmployeeIncome(input, rates) {
  const salaryIncomeDeduction = lookupSalaryIncomeDeduction(input.annualIncome, rates.salaryIncomeDeduction);
  const salaryIncomeBeforeAdjustment = calculateSalaryIncome(input.annualIncome, rates.salaryIncomeDeduction);
  const incomeAdjustmentDeduction = calculateIncomeAdjustmentDeduction(input.annualIncome, input.childrenAges);
  const totalIncome = Math.max(0, salaryIncomeBeforeAdjustment - incomeAdjustmentDeduction);
  return { totalIncome, salaryIncomeDeduction, incomeAdjustmentDeduction };
}

/**
 * フリーランス・自営業の事業所得(合計所得金額)を求める。
 * かんたん入力の簡易モードでは、経費控除・青色申告控除を一切適用せず、
 * 「年収(額面) = 事業所得」とみなす(SPEC.md 3章の方針)。
 * @param {SimpleInput} input
 * @returns {{ totalIncome: number, businessExpense: number, blueReturnDeduction: number }}
 */
export function calculateFreelanceIncome(input) {
  const totalIncome = Math.max(0, input.annualIncome);
  return { totalIncome, businessExpense: 0, blueReturnDeduction: 0 };
}
