// @ts-check
import { calculateSocialInsurance } from './social-insurance.js';
import { calculateNationalHealthInsurance } from './national-health-insurance.js';
import { calculateNationalPension } from './national-pension.js';
import { calculateEmployeeIncome, calculateFreelanceIncome } from './income-by-type.js';
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

const COMMON_ASSUMPTIONS = [
  '所得税は今年も前年と同水準の年収が続く前提、住民税は入力年収が前年も同水準だった前提の概算です。',
  '配偶者控除・配偶者特別控除は、配偶者の年齢が不明なため老人控除対象配偶者(70歳以上)の判定を行わず、一般区分の金額で計算しています。',
  '配偶者の合計所得金額は、入力された配偶者の年収に給与所得控除を適用して推定しています。'
];

/**
 * 会社員の手取りを計算する。
 * @param {SimpleInput} input
 * @param {RateBundle} rates
 * @returns {CalcResult}
 */
function calculateEmployeeTakeHome(input, rates) {
  const income = calculateEmployeeIncome(input, rates);
  const socialInsurance = calculateSocialInsurance(input, rates);
  const incomeTax = calculateIncomeTax(income.totalIncome, input, socialInsurance.total, rates);
  const residentTax = calculateResidentTax(income.totalIncome, input, socialInsurance.total, rates);

  const takeHomeAnnual = input.annualIncome - incomeTax.total - residentTax.total - socialInsurance.total;
  const takeHomeMonthly = Math.floor(takeHomeAnnual / 12);

  const assumptions = [
    '標準報酬月額は「年収÷12」と仮定して社会保険料を計算しています(賞与を考慮した按分は詳細入力モードで対応予定です)。',
    ...COMMON_ASSUMPTIONS
  ];
  if (residentTax.adjustmentCreditNeedsReview) {
    assumptions.push('住民税の調整控除額は、基礎控除に係る人的控除差が未確定のため暫定値で計算しています(要確認)。');
  }

  return { income, socialInsurance, incomeTax, residentTax, takeHomeAnnual, takeHomeMonthly, assumptions };
}

/**
 * フリーランス・自営業の手取りを計算する(かんたん入力の簡易モード)。
 * @param {SimpleInput} input
 * @param {RateBundle} rates
 * @returns {CalcResult}
 */
function calculateFreelanceTakeHome(input, rates) {
  const income = calculateFreelanceIncome(input);

  const nationalHealthInsurance = calculateNationalHealthInsurance(income.totalIncome, input, rates.nationalHealthInsurance);
  const nationalPension = calculateNationalPension(input, rates.nationalPension);
  const socialInsurance = {
    nationalHealthInsurance,
    nationalPension,
    total: nationalHealthInsurance.total + nationalPension.total
  };

  const incomeTax = calculateIncomeTax(income.totalIncome, input, socialInsurance.total, rates);
  const residentTax = calculateResidentTax(income.totalIncome, input, socialInsurance.total, rates);

  const takeHomeAnnual = input.annualIncome - incomeTax.total - residentTax.total - socialInsurance.total;
  const takeHomeMonthly = Math.floor(takeHomeAnnual / 12);

  const assumptions = [
    'かんたん入力では経費・青色申告控除を反映せず、「年収＝事業所得」として計算しています(詳細入力モードで経費率・青色申告控除に対応予定です)。',
    '国民健康保険料の所得割は本人の所得のみで計算しており、配偶者の所得は反映していません(簡易計算)。均等割・平等割の世帯人数には配偶者・子供を含めています。',
    '介護分(40〜64歳)の対象判定は本人の年齢のみで行っており、配偶者は年齢が不明なため対象外として計算しています。',
    '国民年金保険料は、配偶者がいる場合は年齢不明のまま第1号被保険者(20〜59歳)と仮定して算入しています。20歳以上の子がいる場合も、国民年金保険料の計算には含めていません。',
    ...COMMON_ASSUMPTIONS
  ];
  if (residentTax.adjustmentCreditNeedsReview) {
    assumptions.push('住民税の調整控除額は、基礎控除に係る人的控除差が未確定のため暫定値で計算しています(要確認)。');
  }

  return { income, socialInsurance, incomeTax, residentTax, takeHomeAnnual, takeHomeMonthly, assumptions };
}

/**
 * かんたん入力8項目(+将来の詳細入力項目)から、所得税・住民税・社会保険料・手取り額を計算する。
 * UIから独立した純粋関数。会社員(employee)・フリーランス(freelance)の両方に対応する。
 * @param {SimpleInput} input
 * @param {RateBundle} rates
 * @param {Partial<DetailInput>} [detail] 詳細入力(第2弾)。今回のセッションでは未使用。
 * @returns {CalcResult}
 */
export function calculateTakeHome(input, rates, detail = {}) {
  // 詳細入力項目は第1弾では未使用だが、将来の拡張のためマージしておく。
  const _mergedDetail = { ...DEFAULT_DETAIL, ...detail };

  if (input.employmentType === 'employee') {
    return calculateEmployeeTakeHome(input, rates);
  }
  if (input.employmentType === 'freelance') {
    return calculateFreelanceTakeHome(input, rates);
  }
  throw new Error(`未対応の雇用形態です: ${input.employmentType}`);
}
