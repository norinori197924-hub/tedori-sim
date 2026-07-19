// @ts-check
import { lookupBasicDeduction, calculateSpousalDeduction, calculateDependentDeduction } from './deductions.js';
import { truncateTo1000, truncateTo100 } from './rounding.js';

/** @typedef {import('./types.js').SimpleInput} SimpleInput */
/** @typedef {import('./types.js').RateBundle} RateBundle */
/** @typedef {import('./types.js').IncomeTaxResult} IncomeTaxResult */

/**
 * @param {number} taxableIncome
 * @param {Array<{min:number, max:number|null, rate:number, deduction:number}>} brackets
 */
function lookupIncomeTaxBracket(taxableIncome, brackets) {
  for (const b of brackets) {
    if (b.max === null || taxableIncome <= b.max) return b;
  }
  throw new Error(`所得税率区分が見つかりません(課税所得: ${taxableIncome}円)`);
}

/**
 * 所得税額(復興特別所得税を含む)を計算する。会社員・フリーランス共通。
 * 所得の種類ごとの計算(給与所得控除・所得金額調整控除、または事業所得の簡易計算)は
 * 呼び出し側(income-by-type.js)で済ませ、その結果である合計所得金額を受け取る。
 * @param {number} totalIncome 合計所得金額(所得の種類ごとの計算を終えた後の値)
 * @param {SimpleInput} input
 * @param {number} socialInsuranceTotal 社会保険料の本人負担合計(年額)。全額が社会保険料控除の対象。
 * @param {RateBundle} rates
 * @returns {IncomeTaxResult}
 */
export function calculateIncomeTax(totalIncome, input, socialInsuranceTotal, rates) {
  const basicDeduction = lookupBasicDeduction(totalIncome, rates.basicDeduction.incomeTax);

  const { deduction: spousalDeduction } = calculateSpousalDeduction(
    totalIncome,
    input.spouse,
    rates.spousalDeduction.incomeTax,
    rates.spousalDeduction.spouseIncomeRequirement,
    rates.salaryIncomeDeduction
  );

  const dependent = calculateDependentDeduction(input.childrenAges, rates.dependentDeduction.incomeTax);
  const dependentDeduction = dependent.total;

  const totalDeductions = basicDeduction + socialInsuranceTotal + spousalDeduction + dependentDeduction;
  const taxableIncome = truncateTo1000(totalIncome - totalDeductions);

  const bracket = lookupIncomeTaxBracket(taxableIncome, rates.incomeTaxBrackets.brackets);
  const incomeTaxBeforeSurtax = Math.max(0, Math.round(taxableIncome * bracket.rate - bracket.deduction));
  // 年調所得税額(=incomeTaxBeforeSurtax、住宅ローン控除等は今回未対応につき同額)に102.1%を乗じてから
  // 100円未満を切り捨てる(復興特別所得税を先に丸めて加算すると結果がずれるため)。
  const surtaxMultiplier = 1 + rates.incomeTaxBrackets.reconstructionSurtax.rate;
  const total = truncateTo100(incomeTaxBeforeSurtax * surtaxMultiplier);
  const reconstructionSurtax = total - incomeTaxBeforeSurtax;

  return {
    basicDeduction,
    socialInsuranceDeduction: socialInsuranceTotal,
    spousalDeduction,
    dependentDeduction,
    taxableIncome,
    incomeTaxBeforeSurtax,
    reconstructionSurtax,
    total
  };
}
