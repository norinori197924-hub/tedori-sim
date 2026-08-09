// @ts-check
import { lookupBasicDeduction, calculateSpousalDeduction, calculateDependentDeduction } from './deductions.js';
import { truncateTo1000, truncateTo100 } from './rounding.js';

/** @typedef {import('./types.js').SimpleInput} SimpleInput */
/** @typedef {import('./types.js').RateBundle} RateBundle */
/** @typedef {import('./types.js').ResidentTaxResult} ResidentTaxResult */

/**
 * 調整控除額を計算する。人的控除差(所得税と住民税の控除額の差)の合計を、
 * 課税所得金額に応じた式にあてはめる。
 * 基礎控除の人的控除差(personalDeductionDifferences.basic)は現時点でneedsReview=trueの
 * プレースホルダのため、値が無い場合は0として計算し、結果にneedsReviewを伝播する。
 * @param {number} taxableIncome
 * @param {{ spousalType: 'none'|'spousalDeduction'|'spousalSpecialDeduction', dependentGeneralCount: number, dependentSpecificCount: number }} context
 * @param {Object} residentTaxStandard resident-tax-standard.json
 * @returns {{ amount: number, needsReview: boolean }}
 */
function calculateAdjustmentCredit(taxableIncome, context, residentTaxStandard) {
  const diffs = residentTaxStandard.adjustmentCredit.personalDeductionDifferences;
  const needsReview = diffs.basic === null || residentTaxStandard.adjustmentCredit.needsReview === true;

  let differenceTotal = diffs.basic ?? 0;
  if (context.spousalType === 'spousalDeduction') {
    differenceTotal += diffs.spousalGeneral;
  }
  differenceTotal += context.dependentGeneralCount * diffs.dependentGeneral;
  differenceTotal += context.dependentSpecificCount * diffs.dependentSpecific;

  if (differenceTotal <= 0) return { amount: 0, needsReview };

  let amount;
  if (taxableIncome <= 2000000) {
    amount = Math.min(differenceTotal, taxableIncome) * 0.05;
  } else {
    amount = Math.max(0, (differenceTotal - (taxableIncome - 2000000)) * 0.05);
    amount = Math.max(amount, 2500);
  }
  return { amount: Math.round(amount), needsReview };
}

/**
 * 所得割の非課税判定(地方税法附則第3条の3)。均等割の非課税判定とは別制度で、
 * 級地区分に依存せず全国一律(resident-tax-standard.jsonのincomeLevyExemption参照)。
 * 判定は所得控除前の総所得金額等(totalIncome)で行う。
 * @param {number} totalIncome 総所得金額等(所得控除前)
 * @param {{ hasSameHouseholdSpouse: boolean, dependentCount: number }} context dependentCountは16歳未満を含む扶養親族の全人数
 * @param {Object} incomeLevyExemption resident-tax-standard.jsonのincomeLevyExemption
 * @returns {boolean}
 */
function isIncomeLevyExempt(totalIncome, context, incomeLevyExemption) {
  const personCount = 1 + (context.hasSameHouseholdSpouse ? 1 : 0) + context.dependentCount;
  const hasSpouseOrDependent = context.hasSameHouseholdSpouse || context.dependentCount > 0;
  const threshold = incomeLevyExemption.baseAmountPerPerson * personCount
    + incomeLevyExemption.addition
    + (hasSpouseOrDependent ? incomeLevyExemption.dependentOrSpouseAddition : 0);
  return totalIncome <= threshold;
}

/**
 * 個人住民税(所得割+均等割+森林環境税)を計算する。会社員・フリーランス共通。
 * 所得の種類ごとの計算(給与所得控除・所得金額調整控除、または事業所得の簡易計算)は
 * 呼び出し側(income-by-type.js)で済ませ、その結果である合計所得金額を受け取る。
 * 前提: 入力年収が前年も同水準だったと仮定した概算(住民税は前年所得課税のため)。
 * @param {number} totalIncome 合計所得金額(所得の種類ごとの計算を終えた後の値)
 * @param {SimpleInput} input
 * @param {number} socialInsuranceTotal
 * @param {RateBundle} rates
 * @returns {ResidentTaxResult & { adjustmentCreditNeedsReview: boolean }}
 */
export function calculateResidentTax(totalIncome, input, socialInsuranceTotal, rates) {
  const basicDeduction = lookupBasicDeduction(totalIncome, rates.basicDeduction.residentTax);

  const spousal = calculateSpousalDeduction(
    totalIncome,
    input.spouse,
    rates.spousalDeduction.residentTax,
    rates.spousalDeduction.spouseIncomeRequirement,
    rates.salaryIncomeDeduction
  );
  const spousalDeduction = spousal.deduction;

  const dependent = calculateDependentDeduction(input.childrenAges, rates.dependentDeduction.residentTax);
  const dependentDeduction = dependent.total;

  const totalDeductions = basicDeduction + socialInsuranceTotal + spousalDeduction + dependentDeduction;
  const taxableIncome = truncateTo1000(totalIncome - totalDeductions);

  // 同一生計配偶者の判定: 配偶者控除の適用可否(本人所得1,000万円超で不適用)とは独立して、
  // 配偶者の合計所得金額のみで判定する(spousal.spouseTotalIncomeは本人所得に関わらず常に算出済み)。
  const hasSameHouseholdSpouse = input.spouse.hasSpouse
    && spousal.spouseTotalIncome <= rates.spousalDeduction.spouseIncomeRequirement.maxTotalIncome;
  // 扶養親族の数(16歳未満を含む全年齢)。扶養控除の対象人数(dependent.generalCount+specificCount、
  // 16歳未満を除く)とは別カウントであることに注意。
  const dependentCountForExemption = input.childrenAges.length;
  const incomeLevyExempt = isIncomeLevyExempt(
    totalIncome,
    { hasSameHouseholdSpouse, dependentCount: dependentCountForExemption },
    rates.residentTaxStandard.incomeLevyExemption
  );

  let incomeLevyBeforeCredit = 0;
  let credit = { amount: 0, needsReview: false };
  let incomeLevy = 0;
  if (!incomeLevyExempt) {
    incomeLevyBeforeCredit = Math.round(taxableIncome * rates.residentTaxStandard.incomeLeviedRate.total);
    credit = calculateAdjustmentCredit(
      taxableIncome,
      {
        spousalType: spousal.type,
        dependentGeneralCount: dependent.generalCount,
        dependentSpecificCount: dependent.specificCount
      },
      rates.residentTaxStandard
    );
    incomeLevy = truncateTo100(Math.max(0, incomeLevyBeforeCredit - credit.amount));
  }
  const perCapitaLevy = rates.residentTaxStandard.perCapitaLevy.total;
  const forestEnvironmentTax = rates.residentTaxStandard.forestEnvironmentTax.amount;
  const total = incomeLevy + perCapitaLevy + forestEnvironmentTax;

  return {
    basicDeduction,
    socialInsuranceDeduction: socialInsuranceTotal,
    spousalDeduction,
    dependentDeduction,
    taxableIncome,
    incomeLevyBeforeCredit,
    adjustmentCredit: credit.amount,
    incomeLevy,
    incomeLevyExempt,
    perCapitaLevy,
    forestEnvironmentTax,
    total,
    adjustmentCreditNeedsReview: credit.needsReview
  };
}
