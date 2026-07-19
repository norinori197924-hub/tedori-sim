// @ts-check
import { truncateYen } from './rounding.js';

/** @typedef {import('./types.js').SimpleInput} SimpleInput */
/** @typedef {import('./types.js').NationalHealthInsuranceResult} NationalHealthInsuranceResult */

const RESIDENT_TAX_BASIC_DEDUCTION = 430000;

/**
 * 賦課限度額で頭打ちにする。
 * @param {number} amount
 * @param {number} cap
 */
function applyCap(amount, cap) {
  return Math.min(amount, cap);
}

/**
 * 医療分・支援分のように、全加入者を対象とする区分の年額を計算する。
 * @param {{incomeRate:number, perCapitaAmount:number, perHouseholdAmount:number, cap:number}} section
 * @param {number} assessableIncome
 * @param {number} householdCount
 */
function calculateUniformSection(section, assessableIncome, householdCount) {
  const incomeLevy = truncateYen(assessableIncome * section.incomeRate);
  const amount = incomeLevy + section.perCapitaAmount * householdCount + section.perHouseholdAmount;
  return applyCap(amount, section.cap);
}

/**
 * 国民健康保険料(税)を計算する。
 * かんたん入力の簡易化方針(ユーザー承認済み):
 * - 所得割は本人の所得のみで計算し、配偶者の所得は反映しない
 * - 均等割・平等割の世帯人数には、本人・配偶者(いる場合)・子供全員を含める
 * - 介護分(40〜64歳)の対象者判定は本人の年齢のみで行い、配偶者は対象外とみなす
 * - 子ども・子育て支援納付金分の均等割は、本人・配偶者を18歳以上、子供は年齢で判定する
 * @param {number} totalIncome 本人の合計所得金額(事業所得。フリーランスの簡易モードでは年収そのまま)
 * @param {SimpleInput} input
 * @param {Object} nationalHealthInsuranceRate municipalities/index.jsonの該当自治体のnationalHealthInsurance
 * @returns {NationalHealthInsuranceResult}
 */
export function calculateNationalHealthInsurance(totalIncome, input, nationalHealthInsuranceRate) {
  const assessableIncome = Math.max(0, totalIncome - RESIDENT_TAX_BASIC_DEDUCTION);
  const householdCount = 1 + (input.spouse.hasSpouse ? 1 : 0) + input.numberOfChildren;
  const careEligibleCount = input.age >= 40 && input.age < 65 ? 1 : 0;

  const adultsOver18 = 1 + (input.spouse.hasSpouse ? 1 : 0);
  const childrenUnder18 = input.childrenAges.filter((age) => age < 18).length;
  const childrenOver18 = input.childrenAges.filter((age) => age >= 18).length;
  const childSupportOver18Count = adultsOver18 + childrenOver18;
  const childSupportUnder18Count = childrenUnder18;

  const medical = calculateUniformSection(nationalHealthInsuranceRate.medical, assessableIncome, householdCount);
  const support = calculateUniformSection(nationalHealthInsuranceRate.support, assessableIncome, householdCount);

  let care = 0;
  if (careEligibleCount > 0) {
    const careSection = nationalHealthInsuranceRate.care;
    const incomeLevy = truncateYen(assessableIncome * careSection.incomeRate);
    const amount = incomeLevy + careSection.perCapitaAmount * careEligibleCount + careSection.perHouseholdAmount;
    care = applyCap(amount, careSection.cap);
  }

  const childSupportSection = nationalHealthInsuranceRate.childSupport;
  const childSupportIncomeLevy = truncateYen(assessableIncome * childSupportSection.incomeRate);
  const childSupportAmount =
    childSupportIncomeLevy +
    childSupportSection.perCapitaAmountOver18 * childSupportOver18Count +
    childSupportSection.perCapitaAmountUnder18 * childSupportUnder18Count +
    childSupportSection.perHouseholdAmount;
  const childSupport = applyCap(childSupportAmount, childSupportSection.cap);

  return {
    medical,
    support,
    care,
    childSupport,
    total: medical + support + care + childSupport
  };
}
