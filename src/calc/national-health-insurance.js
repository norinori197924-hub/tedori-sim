// @ts-check
import { truncateYen } from './rounding.js';
import { calculateSalaryIncome } from './salary-income.js';

/** @typedef {import('./types.js').SimpleInput} SimpleInput */
/** @typedef {import('./types.js').NationalHealthInsuranceResult} NationalHealthInsuranceResult */

const RESIDENT_TAX_BASIC_DEDUCTION = 430000;

/**
 * 国保料の低所得世帯向け軽減(7割・5割・2割)の判定基準額を求めるための年度定数。
 * 「基礎控除相当額」「被保険者数に乗じる額」「給与所得者等の加算額」は、地方税法施行令に基づく
 * 全国一律の値であり、市区町村ごとに異なるものではない(自治体データ側〔national-health-insurance/*.json〕には
 * 持たせない)。
 * ただし、加算単価(5割軽減=31万円、2割軽減=57万円)は令和8年度の値として複数自治体の公表資料等から
 * 採用した暫定値であり、地方税法施行令原文への直接照会は未実施(CLAUDE.md 11.8章参照)。次年度以降の
 * 施行令改正時は必ず見直すこと。
 */
const LOW_INCOME_REDUCTION_COEFFICIENTS_2026 = {
  base: 430000,
  salaryEarnerAddition: 100000,
  fiftyPercentPerCapita: 310000,
  twentyPercentPerCapita: 570000
};

/** 「給与所得者等」に該当するとみなす給与収入(額面)のしきい値。 */
const SALARY_EARNER_INCOME_THRESHOLD = 550000;

/**
 * 賦課限度額で頭打ちにする。
 * @param {number} amount
 * @param {number} cap
 */
function applyCap(amount, cap) {
  return Math.min(amount, cap);
}

/**
 * 世帯内の「給与所得者等」の数を求める。
 * 本人はフリーランス(事業所得)のためこの関数の対象では常に該当しない
 * (給与所得者等の定義は給与収入・公的年金等所得に限られ、事業所得は含まれない。
 * 副業収入はSPEC.md 6章によりスコープ外)。
 * 配偶者は入力された年収(額面・収入ベース)がしきい値を超える場合のみ該当するとみなす
 * (このアプリには配偶者の雇用形態や年金受給の有無を入力する項目がないための簡易化)。
 * 子供の所得は入力項目がないため常に非該当として扱う。
 * @param {SimpleInput} input
 * @returns {number}
 */
function countSalaryEarners(input) {
  if (input.spouse.hasSpouse && (input.spouse.spouseIncome ?? 0) > SALARY_EARNER_INCOME_THRESHOLD) {
    return 1;
  }
  return 0;
}

/**
 * 軽減判定所得(世帯の総所得金額等の合計。43万円は差し引かない)を求める。
 * 配偶者の所得は、配偶者控除の判定と同じ方法(額面年収に給与所得控除を適用)で推定する。
 * 子供の所得は入力項目がないため常に0円として扱う。
 * @param {number} totalIncome 本人の合計所得金額(事業所得)
 * @param {SimpleInput} input
 * @param {Object} salaryIncomeDeductionTable salary-income-deduction.jsonの内容
 * @returns {number}
 */
function calculateJudgmentIncome(totalIncome, input, salaryIncomeDeductionTable) {
  let judgmentIncome = totalIncome;
  if (input.spouse.hasSpouse) {
    judgmentIncome += calculateSalaryIncome(input.spouse.spouseIncome ?? 0, salaryIncomeDeductionTable);
  }
  return judgmentIncome;
}

/**
 * 軽減判定所得・被保険者数・給与所得者等の数から、軽減区分と軽減乗数(負担割合)を求める。
 * 特定同一世帯所属者は当面0人として扱う(SPEC.md 5章に制約として明記)。
 * @param {number} judgmentIncome
 * @param {number} householdCount 被保険者数(特定同一世帯所属者は含めない、当面常に0人扱い)
 * @param {number} salaryEarnerCount
 * @returns {{level:'70'|'50'|'20'|'none', multiplier:number, threshold70:number, threshold50:number, threshold20:number}}
 */
function determineLowIncomeReduction(judgmentIncome, householdCount, salaryEarnerCount) {
  const c = LOW_INCOME_REDUCTION_COEFFICIENTS_2026;
  const salaryEarnerAddition = c.salaryEarnerAddition * Math.max(0, salaryEarnerCount - 1);
  const threshold70 = c.base + salaryEarnerAddition;
  const threshold50 = c.base + c.fiftyPercentPerCapita * householdCount + salaryEarnerAddition;
  const threshold20 = c.base + c.twentyPercentPerCapita * householdCount + salaryEarnerAddition;

  if (judgmentIncome <= threshold70) return { level: '70', multiplier: 0.3, threshold70, threshold50, threshold20 };
  if (judgmentIncome <= threshold50) return { level: '50', multiplier: 0.5, threshold70, threshold50, threshold20 };
  if (judgmentIncome <= threshold20) return { level: '20', multiplier: 0.8, threshold70, threshold50, threshold20 };
  return { level: 'none', multiplier: 1, threshold70, threshold50, threshold20 };
}

/**
 * 医療分・支援分のように、全加入者を対象とする区分の年額を計算する。
 * 低所得軽減(7割・5割・2割)を均等割・平等割に適用したうえで、未就学児(6歳に達する日以後の
 * 最初の3月31日まで、簡易的に6歳未満で判定)の均等割をさらに5割軽減する(全国一律の制度、
 * 令和4年度〜)。介護分・子ども子育て支援納付金分は未就学児軽減の対象外。
 * 適用順序: 低所得軽減 → 未就学児軽減(軽減後の金額にさらに乗じる)。
 * @param {{incomeRate:number, perCapitaAmount:number, perHouseholdAmount:number, cap:number}} section
 * @param {number} assessableIncome
 * @param {number} householdCount
 * @param {number} preschoolCount 未就学児(6歳未満)の人数
 * @param {number} reductionMultiplier 低所得軽減の負担割合(1=非該当、0.8=2割軽減、0.5=5割軽減、0.3=7割軽減)
 */
function calculateUniformSection(section, assessableIncome, householdCount, preschoolCount, reductionMultiplier) {
  const fullRateCount = householdCount - preschoolCount;
  const reducedPerCapitaAmount = truncateYen(section.perCapitaAmount * reductionMultiplier);
  const reducedPerHouseholdAmount = truncateYen(section.perHouseholdAmount * reductionMultiplier);
  const perCapitaLevy =
    reducedPerCapitaAmount * fullRateCount + Math.floor(reducedPerCapitaAmount * 0.5) * preschoolCount;
  const incomeLevy = truncateYen(assessableIncome * section.incomeRate);
  const amount = incomeLevy + perCapitaLevy + reducedPerHouseholdAmount;
  return applyCap(amount, section.cap);
}

/**
 * 国民健康保険料(税)を計算する。
 * かんたん入力の簡易化方針(ユーザー承認済み):
 * - 所得割は本人の所得のみで計算し、配偶者の所得は反映しない(ただし低所得軽減の判定所得には
 *   配偶者の所得を含める。軽減判定は世帯合算が法定のため)
 * - 均等割・平等割の世帯人数には、本人・配偶者(いる場合)・子供全員を含める
 * - 介護分(40〜64歳)の対象者判定は本人の年齢のみで行い、配偶者は対象外とみなす
 * - 子ども・子育て支援納付金分の均等割は、本人・配偶者を18歳以上、子供は年齢で判定する。
 *   18歳未満は年齢を問わず全国一律で均等割が全額軽減(0円)される法定制度のため
 *   (未就学児限定ではない。CLAUDE.md 11.7章、2026-07-25確認)、この区分は
 *   自治体データ側(perCapitaAmountUnder18=0)で表現しており、本関数に未就学児固有の
 *   軽減ロジックは不要
 * - 未就学児(6歳未満)の医療分・支援分の均等割を5割軽減する(全国一律制度、令和4年度〜)。
 *   介護分は年齢的に該当しないため対象外。子ども・子育て支援納付金分は上記のとおり
 *   別ルール(未就学児限定ではなく18歳未満一律0円)で対応済みのため、ここでの
 *   5割軽減ロジックは適用しない(対象外)
 * - 低所得世帯向け軽減(7割・5割・2割)を均等割・平等割に適用する(CLAUDE.md 11.8章)。
 *   特定同一世帯所属者は当面0人として扱う。給与所得者等の判定は、本人(フリーランス)は
 *   常に対象外、配偶者は入力年収(額面)が55万円を超える場合のみ該当とみなし、子供は
 *   常に非該当として扱う(このアプリの入力モデル上の制約。SPEC.md 5章参照)
 * @param {number} totalIncome 本人の合計所得金額(事業所得。フリーランスの簡易モードでは年収そのまま)
 * @param {SimpleInput} input
 * @param {Object} nationalHealthInsuranceRate municipalities/index.jsonの該当自治体のnationalHealthInsurance
 * @param {Object} salaryIncomeDeductionTable salary-income-deduction.jsonの内容(低所得軽減の判定所得計算に使用)
 * @returns {NationalHealthInsuranceResult}
 */
export function calculateNationalHealthInsurance(totalIncome, input, nationalHealthInsuranceRate, salaryIncomeDeductionTable) {
  const assessableIncome = Math.max(0, totalIncome - RESIDENT_TAX_BASIC_DEDUCTION);
  const householdCount = 1 + (input.spouse.hasSpouse ? 1 : 0) + input.numberOfChildren;
  const careEligibleCount = input.age >= 40 && input.age < 65 ? 1 : 0;
  const preschoolCount = input.childrenAges.filter((age) => age < 6).length;

  const adultsOver18 = 1 + (input.spouse.hasSpouse ? 1 : 0);
  const childrenUnder18 = input.childrenAges.filter((age) => age < 18).length;
  const childrenOver18 = input.childrenAges.filter((age) => age >= 18).length;
  const childSupportOver18Count = adultsOver18 + childrenOver18;
  const childSupportUnder18Count = childrenUnder18;

  const salaryEarnerCount = countSalaryEarners(input);
  const judgmentIncome = calculateJudgmentIncome(totalIncome, input, salaryIncomeDeductionTable);
  const reduction = determineLowIncomeReduction(judgmentIncome, householdCount, salaryEarnerCount);

  const medical = calculateUniformSection(
    nationalHealthInsuranceRate.medical,
    assessableIncome,
    householdCount,
    preschoolCount,
    reduction.multiplier
  );
  const support = calculateUniformSection(
    nationalHealthInsuranceRate.support,
    assessableIncome,
    householdCount,
    preschoolCount,
    reduction.multiplier
  );

  let care = 0;
  if (careEligibleCount > 0) {
    const careSection = nationalHealthInsuranceRate.care;
    const incomeLevy = truncateYen(assessableIncome * careSection.incomeRate);
    const reducedPerCapitaAmount = truncateYen(careSection.perCapitaAmount * reduction.multiplier);
    const reducedPerHouseholdAmount = truncateYen(careSection.perHouseholdAmount * reduction.multiplier);
    const amount = incomeLevy + reducedPerCapitaAmount * careEligibleCount + reducedPerHouseholdAmount;
    care = applyCap(amount, careSection.cap);
  }

  const childSupportSection = nationalHealthInsuranceRate.childSupport;
  const childSupportIncomeLevy = truncateYen(assessableIncome * childSupportSection.incomeRate);
  const reducedOver18 = truncateYen(childSupportSection.perCapitaAmountOver18 * reduction.multiplier);
  const reducedUnder18 = truncateYen(childSupportSection.perCapitaAmountUnder18 * reduction.multiplier);
  const reducedChildSupportHousehold = truncateYen(childSupportSection.perHouseholdAmount * reduction.multiplier);
  const childSupportAmount =
    childSupportIncomeLevy +
    reducedOver18 * childSupportOver18Count +
    reducedUnder18 * childSupportUnder18Count +
    reducedChildSupportHousehold;
  const childSupport = applyCap(childSupportAmount, childSupportSection.cap);

  return {
    medical,
    support,
    care,
    childSupport,
    total: medical + support + care + childSupport,
    lowIncomeReduction: {
      level: reduction.level,
      judgmentIncome,
      householdCount,
      salaryEarnerCount,
      threshold70: reduction.threshold70,
      threshold50: reduction.threshold50,
      threshold20: reduction.threshold20
    }
  };
}
