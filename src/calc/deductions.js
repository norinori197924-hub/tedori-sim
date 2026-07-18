// @ts-check
import { calculateSalaryIncome } from './salary-income.js';

/** @typedef {import('./types.js').SpouseInput} SpouseInput */

/**
 * 合計所得金額から基礎控除額を求める。
 * @param {number} totalIncome
 * @param {Object} basicDeductionTable basic-deduction.json の incomeTax または residentTax
 * @returns {number}
 */
export function lookupBasicDeduction(totalIncome, basicDeductionTable) {
  for (const b of basicDeductionTable.brackets) {
    if (b.maxTotalIncome === null || totalIncome <= b.maxTotalIncome) return b.deduction;
  }
  return 0;
}

/**
 * 配偶者控除・配偶者特別控除を求める。
 * かんたん入力には配偶者の年齢がないため、老人控除対象配偶者(70歳以上)の判定は行わず、
 * 一般区分の金額を一律適用する(仮定としてUIに明示すること)。
 * 配偶者の「合計所得金額」は、配偶者も給与所得者であると仮定し、入力された配偶者の年収に
 * 給与所得控除を適用して算出する。
 * @param {number} taxpayerTotalIncome 納税者本人の合計所得金額
 * @param {SpouseInput} spouse
 * @param {Object} spousalDataForType spousal-deduction.json の incomeTax または residentTax
 * @param {Object} spouseIncomeRequirement spousal-deduction.json の spouseIncomeRequirement
 * @param {Object} salaryIncomeDeductionTable
 * @returns {{ deduction: number, spouseTotalIncome: number, type: 'none'|'spousalDeduction'|'spousalSpecialDeduction' }}
 */
export function calculateSpousalDeduction(
  taxpayerTotalIncome,
  spouse,
  spousalDataForType,
  spouseIncomeRequirement,
  salaryIncomeDeductionTable
) {
  if (!spouse.hasSpouse) return { deduction: 0, spouseTotalIncome: 0, type: 'none' };

  const spouseAnnualIncome = spouse.spouseIncome ?? 0;
  const spouseTotalIncome = calculateSalaryIncome(spouseAnnualIncome, salaryIncomeDeductionTable);

  if (taxpayerTotalIncome > 10000000) return { deduction: 0, spouseTotalIncome, type: 'none' };

  if (spouseTotalIncome <= spouseIncomeRequirement.maxTotalIncome) {
    for (const row of spousalDataForType.spousalDeduction.brackets) {
      if (row.maxTaxpayerIncome === null || taxpayerTotalIncome <= row.maxTaxpayerIncome) {
        return { deduction: row.general, spouseTotalIncome, type: 'spousalDeduction' };
      }
    }
    return { deduction: 0, spouseTotalIncome, type: 'none' };
  }

  const bandIndex = taxpayerTotalIncome <= 9000000 ? 0 : taxpayerTotalIncome <= 9500000 ? 1 : 2;
  for (const row of spousalDataForType.spousalSpecialDeduction.brackets) {
    if (spouseTotalIncome >= row.minSpouseIncome && spouseTotalIncome <= row.maxSpouseIncome) {
      return { deduction: row.amounts[bandIndex], spouseTotalIncome, type: 'spousalSpecialDeduction' };
    }
  }
  return { deduction: 0, spouseTotalIncome, type: 'none' };
}

/**
 * 子供の年齢から扶養控除額の合計を求める。16歳未満は対象外。
 * かんたん入力に親等の被扶養者情報はないため、子供のみを対象とする。
 * @param {number[]} childrenAges
 * @param {Object} dependentDataForType dependent-deduction.json の incomeTax または residentTax
 * @returns {{ total: number, generalCount: number, specificCount: number }}
 */
export function calculateDependentDeduction(childrenAges, dependentDataForType) {
  let total = 0;
  let generalCount = 0;
  let specificCount = 0;
  for (const age of childrenAges) {
    if (age < 16) continue;
    const [minAge, maxAge] = dependentDataForType.specific.ageRange;
    if (age >= minAge && age <= maxAge) {
      total += dependentDataForType.specific.amount;
      specificCount += 1;
    } else {
      total += dependentDataForType.general;
      generalCount += 1;
    }
  }
  return { total, generalCount, specificCount };
}
