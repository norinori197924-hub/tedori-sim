// @ts-check

/**
 * 所得金額調整控除(子ども・特別障害者等を有する者等の場合)を計算する。
 * 給与収入850万円超で、23歳未満の扶養親族を有する場合等に適用され、給与所得の金額から
 * 追加で控除する。所得税・住民税で共通(地方税法でも同様の控除がある)。
 * かんたん入力には障害者情報がないため、23歳未満の扶養親族の有無のみで判定する。
 * @param {number} annualIncome 給与収入金額(年収)
 * @param {number[]} childrenAges
 * @returns {number}
 */
export function calculateIncomeAdjustmentDeduction(annualIncome, childrenAges) {
  if (annualIncome <= 8500000) return 0;
  const hasQualifyingChild = childrenAges.some((age) => age < 23);
  if (!hasQualifyingChild) return 0;

  const base = Math.min(annualIncome, 10000000) - 8500000;
  const amount = base * 0.1;
  return Math.ceil(amount);
}
