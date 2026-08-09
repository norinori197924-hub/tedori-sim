// @ts-check
import { lookupBasicDeduction, calculateSpousalDeduction, calculateDependentDeduction } from './deductions.js';
import { truncateTo1000, truncateTo100 } from './rounding.js';
import { resolveGradeArea } from './grade-area.js';

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
 * 「基本額×人数+定額加算+(配偶者・扶養親族がいる場合のみ)加算額」という
 * 所得割・均等割の非課税限度額に共通する算式で、基準額(閾値)を求める。
 * 所得割(incomeLevyExemption)・均等割(perCapitaLevyExemption.byGrade[grade])は
 * それぞれ独立した制度・係数を持つため、判定関数(isIncomeLevyExempt/
 * isPerCapitaLevyExempt)自体は分けているが、算式の形は共通なのでここに集約する。
 * @param {number} personCount
 * @param {boolean} hasSpouseOrDependent
 * @param {{ baseAmountPerPerson: number, addition: number, dependentOrSpouseAddition: number }} coefficients
 * @returns {number}
 */
function computeNonTaxationThreshold(personCount, hasSpouseOrDependent, coefficients) {
  return coefficients.baseAmountPerPerson * personCount
    + coefficients.addition
    + (hasSpouseOrDependent ? coefficients.dependentOrSpouseAddition : 0);
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
  return totalIncome <= computeNonTaxationThreshold(personCount, hasSpouseOrDependent, incomeLevyExemption);
}

/**
 * 均等割の非課税判定(地方税法第295条3項→施行令47条の3→施行規則9条の3)。
 * 所得割と異なり全国一律の法定額ではなく、級地区分(1〜3級地)に応じた基準額を
 * 「参酌して」各市町村が条例で定める構造(resident-tax-standard.jsonの
 * perCapitaLevyExemption.status: "provisional"参照。実際の限度額は条例により
 * 異なりうる)。判定は所得控除前の総所得金額等(totalIncome)で行う。
 * @param {number} totalIncome 総所得金額等(所得控除前)
 * @param {{ hasSameHouseholdSpouse: boolean, dependentCount: number }} context
 * @param {{ baseAmountPerPerson: number, addition: number, dependentOrSpouseAddition: number }} gradeCoefficients perCapitaLevyExemption.byGrade[grade]
 * @returns {boolean}
 */
function isPerCapitaLevyExempt(totalIncome, context, gradeCoefficients) {
  const personCount = 1 + (context.hasSameHouseholdSpouse ? 1 : 0) + context.dependentCount;
  const hasSpouseOrDependent = context.hasSameHouseholdSpouse || context.dependentCount > 0;
  return totalIncome <= computeNonTaxationThreshold(personCount, hasSpouseOrDependent, gradeCoefficients);
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

  // 均等割の非課税判定には級地区分(1〜3級地)が必要。grade-area.jsonにまだ実データが
  // 収集されていない市区町村はdefaultGrade(3級地)にフォールバックするが、これは
  // 「3級地であることが確認された」わけではないため、gradeAreaStatusで区別して返す。
  const { grade, gradeAreaStatus } = resolveGradeArea(input.prefectureCode, input.municipalityCode, rates.gradeArea);
  const perCapitaLevyExemptionByGrade = rates.residentTaxStandard.perCapitaLevyExemption.byGrade;
  const perCapitaLevyExempt = isPerCapitaLevyExempt(
    totalIncome,
    { hasSameHouseholdSpouse, dependentCount: dependentCountForExemption },
    perCapitaLevyExemptionByGrade[String(grade)]
  );
  // 級地が未登録(3級地にフォールバック)の場合、実際の級地が1級地・2級地であれば
  // 非課税限度額がより高く、非課税になる可能性がある(3級地基準は最も低い=最も
  // 過大課税側に出る誤差)。1級地基準で判定し直した結果と食い違う場合のみ、
  // 「級地が確定すれば結果が変わりうる」ことを示すフラグを立てる。
  const perCapitaLevyGradeAmbiguous = gradeAreaStatus === 'unregistered'
    && !perCapitaLevyExempt
    && isPerCapitaLevyExempt(
      totalIncome,
      { hasSameHouseholdSpouse, dependentCount: dependentCountForExemption },
      perCapitaLevyExemptionByGrade['1']
    );

  const perCapitaLevy = perCapitaLevyExempt ? 0 : rates.residentTaxStandard.perCapitaLevy.total;
  // 森林環境税は均等割非課税者には課されないため、均等割と同時に非課税にする。
  const forestEnvironmentTax = perCapitaLevyExempt ? 0 : rates.residentTaxStandard.forestEnvironmentTax.amount;
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
    perCapitaLevyExempt,
    forestEnvironmentTax,
    total,
    adjustmentCreditNeedsReview: credit.needsReview,
    grade,
    gradeAreaStatus,
    perCapitaLevyGradeAmbiguous
  };
}
