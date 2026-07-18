// @ts-check

/**
 * 給与収入金額から給与所得(合計所得金額相当)の正確な値(端数処理前)を求める。
 * 国税庁の速算表は「収入×90%-1,100,000円」のように給与所得を直接求める式であり、
 * 給与所得控除額を先に丸めてから差し引くと結果がずれるため、この関数では
 * 端数処理を一切行わない生の値を返す。
 * @param {number} income 給与収入金額(年収、円)
 * @param {Object} salaryIncomeDeductionTable salary-income-deduction.jsonの内容
 * @returns {number}
 */
function calculateSalaryIncomeRaw(income, salaryIncomeDeductionTable) {
  for (const b of salaryIncomeDeductionTable.brackets) {
    if (b.max === null || income <= b.max) {
      if (b.formula.type === 'fixed') return income - b.formula.amount;
      return income * (1 - b.formula.rate) - b.formula.addition;
    }
  }
  throw new Error(`給与所得控除の区分が見つかりません(収入金額: ${income}円)`);
}

/**
 * 給与収入金額から給与所得(合計所得金額相当)を求める。
 * 国税庁の端数処理ルールにならい、1円未満は切り捨てる(四捨五入ではない)。
 * @param {number} income
 * @param {Object} salaryIncomeDeductionTable
 * @returns {number}
 */
export function calculateSalaryIncome(income, salaryIncomeDeductionTable) {
  const raw = calculateSalaryIncomeRaw(income, salaryIncomeDeductionTable);
  return Math.floor(Math.max(0, raw));
}

/**
 * 給与収入金額から給与所得控除額を求める(表示用)。
 * 給与所得(端数処理後)との差分として算出することで、収入金額 = 給与所得控除額 + 給与所得 の
 * 関係を常に保証する。
 * @param {number} income
 * @param {Object} salaryIncomeDeductionTable
 * @returns {number}
 */
export function lookupSalaryIncomeDeduction(income, salaryIncomeDeductionTable) {
  return income - calculateSalaryIncome(income, salaryIncomeDeductionTable);
}
