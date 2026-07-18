// @ts-check
import { roundPremiumHalf } from './rounding.js';

/** @typedef {import('./types.js').SimpleInput} SimpleInput */
/** @typedef {import('./types.js').RateBundle} RateBundle */
/** @typedef {import('./types.js').SocialInsuranceResult} SocialInsuranceResult */
/** @typedef {import('./types.js').RateGradeRow} RateGradeRow */

/**
 * 報酬月額から標準報酬月額等級を引き当てる。
 * @param {number} remuneration
 * @param {Array<RateGradeRow & Record<string, unknown>>} grades
 * @returns {RateGradeRow & Record<string, unknown>}
 */
function lookupGrade(remuneration, grades) {
  for (const g of grades) {
    const minOk = g.minRemuneration === null || remuneration >= g.minRemuneration;
    const maxOk = g.maxRemuneration === null || remuneration < g.maxRemuneration;
    if (minOk && maxOk) return g;
  }
  throw new Error(`標準報酬月額等級が見つかりません(報酬月額: ${remuneration}円)`);
}

/**
 * 会社員の社会保険料(健康保険・介護保険・厚生年金・雇用保険・子ども子育て支援金)を計算する。
 * 第1弾では「年収÷12を報酬月額とみなす」仮定を用いる(ボーナス反映は詳細入力モードで対応)。
 * @param {SimpleInput} input
 * @param {RateBundle} rates
 * @returns {SocialInsuranceResult}
 */
export function calculateSocialInsurance(input, rates) {
  const monthlyRemunerationAssumed = Math.floor(input.annualIncome / 12);

  const healthGradeRow = lookupGrade(monthlyRemunerationAssumed, rates.kyokaiKenpo.grades);
  const pensionGradeRow = lookupGrade(monthlyRemunerationAssumed, rates.employeesPension.grades);

  const careInsuranceApplied = input.age >= 40 && input.age <= 64;

  const healthPremiumHalfRaw = careInsuranceApplied
    ? healthGradeRow.healthPremiumWithCareHalf
    : healthGradeRow.healthPremiumHalf;
  const healthPremiumHalf = roundPremiumHalf(healthPremiumHalfRaw);
  const healthInsuranceAnnual = healthPremiumHalf * 12;

  const childcareSupportHalf = roundPremiumHalf(healthGradeRow.childcareSupportHalf);
  const childcareSupportAnnual = childcareSupportHalf * 12;

  const pensionPremiumHalf = roundPremiumHalf(pensionGradeRow.premiumHalf);
  const pensionAnnual = pensionPremiumHalf * 12;

  const employmentInsuranceRate = rates.employmentInsurance.generalBusiness.employeeRate;
  const employmentInsuranceAnnual = roundPremiumHalf(input.annualIncome * employmentInsuranceRate);

  const total = healthInsuranceAnnual + pensionAnnual + employmentInsuranceAnnual + childcareSupportAnnual;

  return {
    monthlyRemunerationAssumed,
    healthGrade: healthGradeRow.grade,
    pensionGrade: pensionGradeRow.grade,
    careInsuranceApplied,
    healthInsuranceAnnual,
    pensionAnnual,
    employmentInsuranceAnnual,
    childcareSupportAnnual,
    total
  };
}
