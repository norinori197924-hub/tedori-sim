// @ts-check

/** @typedef {import('./types.js').SimpleInput} SimpleInput */
/** @typedef {import('./types.js').NationalPensionResult} NationalPensionResult */

/**
 * 国民年金保険料(第1号被保険者、全国一律・定額)を計算する。
 * 本人は20歳以上60歳未満の場合のみ賦課対象。配偶者は年齢が不明なため、
 * 配偶者がいる場合は第1号被保険者(20〜59歳)であると仮定して賦課する。
 * 子は対象外(20歳以上の子がいても計算に含めない簡略化)。
 * @param {SimpleInput} input
 * @param {Object} nationalPensionRate national-pension.json
 * @returns {NationalPensionResult}
 */
export function calculateNationalPension(input, nationalPensionRate) {
  const annual = nationalPensionRate.monthlyAmount * 12;
  const selfEligible = input.age >= 20 && input.age < 60;
  const selfAnnual = selfEligible ? annual : 0;
  const spouseAnnual = input.spouse.hasSpouse ? annual : 0;
  return { selfAnnual, spouseAnnual, total: selfAnnual + spouseAnnual };
}
