// @ts-check
import { calculateSocialInsurance } from './social-insurance.js';
import { calculateIncomeTax } from './income-tax.js';
import { calculateResidentTax } from './resident-tax.js';

/** @typedef {import('./types.js').SimpleInput} SimpleInput */
/** @typedef {import('./types.js').DetailInput} DetailInput */
/** @typedef {import('./types.js').RateBundle} RateBundle */
/** @typedef {import('./types.js').CalcResult} CalcResult */

/**
 * 詳細入力モード(第2弾)の項目デフォルト値。未入力は「なし」として扱う。
 * @type {Required<DetailInput>}
 */
const DEFAULT_DETAIL = {
  idecoAnnualPayment: 0,
  lifeInsurancePayment: 0,
  earthquakeInsurancePayment: 0,
  medicalExpense: 0,
  hasMortgageDeduction: false,
  mortgageYearEndBalance: 0,
  expenseRate: 0,
  expenseAmount: 0,
  blueReturnDeduction: 'none',
  kyosaiAnnualPayment: 0,
  bonusCount: 0,
  bonusRatio: 0
};

/**
 * かんたん入力8項目(+将来の詳細入力項目)から、所得税・住民税・社会保険料・手取り額を計算する。
 * UIから独立した純粋関数。第1弾では会社員(employmentType: 'employee')のみ対応。
 * @param {SimpleInput} input
 * @param {RateBundle} rates
 * @param {Partial<DetailInput>} [detail] 詳細入力(第2弾)。今回のセッションでは未使用。
 * @returns {CalcResult}
 */
export function calculateTakeHome(input, rates, detail = {}) {
  if (input.employmentType !== 'employee') {
    throw new Error('第1弾ではフリーランス・自営業の計算は未対応です(スコープ外)。');
  }

  // 詳細入力項目は第1弾では未使用だが、将来の拡張のためマージしておく。
  const _mergedDetail = { ...DEFAULT_DETAIL, ...detail };

  const socialInsurance = calculateSocialInsurance(input, rates);
  const incomeTax = calculateIncomeTax(input, socialInsurance.total, rates);
  const residentTax = calculateResidentTax(input, socialInsurance.total, rates);

  const takeHomeAnnual = input.annualIncome - incomeTax.total - residentTax.total - socialInsurance.total;
  const takeHomeMonthly = Math.floor(takeHomeAnnual / 12);

  const assumptions = [
    '標準報酬月額は「年収÷12」と仮定して社会保険料を計算しています(賞与を考慮した按分は詳細入力モードで対応予定です)。',
    '所得税は今年も前年と同水準の年収が続く前提、住民税は入力年収が前年も同水準だった前提の概算です。',
    '配偶者控除・配偶者特別控除は、配偶者の年齢が不明なため老人控除対象配偶者(70歳以上)の判定を行わず、一般区分の金額で計算しています。',
    '配偶者の合計所得金額は、入力された配偶者の年収に給与所得控除を適用して推定しています。'
  ];
  if (residentTax.adjustmentCreditNeedsReview) {
    assumptions.push('住民税の調整控除額は、基礎控除に係る人的控除差が未確定のため暫定値で計算しています(要確認)。');
  }

  return {
    socialInsurance,
    incomeTax,
    residentTax,
    takeHomeAnnual,
    takeHomeMonthly,
    assumptions
  };
}
