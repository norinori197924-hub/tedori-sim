// @ts-check

/**
 * 型定義のみを提供するモジュール。実行時のコードは持たない。
 * 詳細入力モード(第2弾)の項目もあらかじめ定義し、計算エンジンが
 * 両モードに対応できる構造にしておく(CLAUDE.md 4章の方針)。
 */

/**
 * @typedef {Object} SpouseInput
 * @property {boolean} hasSpouse
 * @property {number|null} spouseIncome 配偶者の年収(額面)。未入力はnull。
 */

/**
 * @typedef {Object} SimpleInput かんたん入力8項目
 * @property {number} age 年齢(その年12/31時点)
 * @property {string} prefectureCode 都道府県コード(JIS X0402準拠、2桁)
 * @property {string} municipalityCode 市区町村コード(JIS X0402準拠、5桁)
 * @property {number} numberOfChildren 子供の数
 * @property {number[]} childrenAges 子供の年齢(各人、その年12/31時点)
 * @property {'employee'|'freelance'} employmentType 雇用形態。第1弾はemployeeのみ対応。
 * @property {number} annualIncome 額面の年収(昨年、円)
 * @property {SpouseInput} spouse
 */

/**
 * @typedef {Object} DetailInput 詳細入力(第2弾)の追加項目。未入力はすべて「なし」として計算する。
 * @property {number} [idecoAnnualPayment] iDeCo・企業型DCの年間掛金
 * @property {number} [lifeInsurancePayment] 生命保険料の年間支払額
 * @property {number} [earthquakeInsurancePayment] 地震保険料の年間支払額
 * @property {number} [medicalExpense] 医療費の年間支払額
 * @property {boolean} [hasMortgageDeduction] 住宅ローン控除の有無
 * @property {number} [mortgageYearEndBalance] 住宅ローン年末残高
 * @property {number} [expenseRate] 経費率(フリーランスのみ)
 * @property {number} [expenseAmount] 経費額(フリーランスのみ)
 * @property {'none'|'10man'|'55man'|'65man'} [blueReturnDeduction] 青色申告控除区分(フリーランスのみ)
 * @property {number} [kyosaiAnnualPayment] 小規模企業共済の年間掛金(フリーランスのみ)
 * @property {number} [bonusCount] ボーナスの回数(会社員のみ)
 * @property {number} [bonusRatio] ボーナスが年収に占める比率(会社員のみ)
 */

/**
 * @typedef {Object} RateGradeRow 標準報酬月額等級表の1行
 * @property {number} grade 等級
 * @property {number|null} pensionGrade 対応する厚生年金等級(健康保険等級表のみに存在。無関係な等級はundefined)
 * @property {number|null} minRemuneration 報酬月額の下限(以上)。最下位等級はnull。
 * @property {number|null} maxRemuneration 報酬月額の上限(未満)。最上位等級はnull。
 * @property {number} standardMonthlyRemuneration 標準報酬月額
 */

/**
 * @typedef {Object} KyokaiKenpoRateFile kyokai-kenpo/*.json の構造
 * @property {string} prefecture
 * @property {string} prefectureCode
 * @property {number} healthInsuranceRate
 * @property {number} careInsuranceRate
 * @property {number} healthInsuranceRateWithCare
 * @property {{rate:number}} childcareSupportContribution
 * @property {Array<RateGradeRow & {healthPremiumTotal:number, healthPremiumHalf:number, healthPremiumWithCareTotal:number, healthPremiumWithCareHalf:number, childcareSupportTotal:number, childcareSupportHalf:number}>} grades
 */

/**
 * @typedef {Object} EmployeesPensionRateFile employees-pension.json の構造
 * @property {number} rate
 * @property {number} employeeShareRate
 * @property {Array<RateGradeRow & {premiumTotal:number, premiumHalf:number}>} grades
 */

/**
 * @typedef {Object} RateBundle 計算エンジンに渡す料率データ一式(UI側でJSONをfetchして組み立てる)
 * @property {Object} incomeTaxBrackets
 * @property {Object} salaryIncomeDeduction
 * @property {{incomeTax:Object, residentTax:Object}} basicDeduction
 * @property {{incomeTax:Object, residentTax:Object, spouseIncomeRequirement:Object}} spousalDeduction
 * @property {{incomeTax:Object, residentTax:Object}} dependentDeduction
 * @property {Object} residentTaxStandard
 * @property {EmployeesPensionRateFile} employeesPension
 * @property {Object} employmentInsurance
 * @property {KyokaiKenpoRateFile} kyokaiKenpo 計算対象の都道府県1件分
 */

/**
 * @typedef {Object} SocialInsuranceResult
 * @property {number} monthlyRemunerationAssumed 年収÷12で仮定した報酬月額
 * @property {number} healthGrade
 * @property {number} pensionGrade
 * @property {boolean} careInsuranceApplied 介護保険第2号被保険者(40〜64歳)に該当するか
 * @property {number} healthInsuranceAnnual 健康保険料(介護保険料込みの場合はその分も含む、年額)
 * @property {number} pensionAnnual 厚生年金保険料(年額)
 * @property {number} employmentInsuranceAnnual 雇用保険料(年額)
 * @property {number} childcareSupportAnnual 子ども・子育て支援金(年額)
 * @property {number} total 本人負担合計(年額)
 */

/**
 * @typedef {Object} IncomeTaxResult
 * @property {number} salaryIncomeDeduction
 * @property {number} incomeAdjustmentDeduction 所得金額調整控除(給与収入850万円超・23歳未満の扶養親族等がいる場合)
 * @property {number} salaryIncome
 * @property {number} basicDeduction
 * @property {number} socialInsuranceDeduction
 * @property {number} spousalDeduction
 * @property {number} dependentDeduction
 * @property {number} taxableIncome
 * @property {number} incomeTaxBeforeSurtax
 * @property {number} reconstructionSurtax
 * @property {number} total
 */

/**
 * @typedef {Object} ResidentTaxResult
 * @property {number} incomeAdjustmentDeduction
 * @property {number} salaryIncome
 * @property {number} basicDeduction
 * @property {number} socialInsuranceDeduction
 * @property {number} spousalDeduction
 * @property {number} dependentDeduction
 * @property {number} taxableIncome
 * @property {number} incomeLevyBeforeCredit
 * @property {number} adjustmentCredit
 * @property {number} incomeLevy
 * @property {number} perCapitaLevy
 * @property {number} forestEnvironmentTax
 * @property {number} total
 */

/**
 * @typedef {Object} CalcResult
 * @property {SocialInsuranceResult} socialInsurance
 * @property {IncomeTaxResult} incomeTax
 * @property {ResidentTaxResult} residentTax
 * @property {number} takeHomeAnnual
 * @property {number} takeHomeMonthly
 * @property {string[]} assumptions 計算上の仮定・注記(UIで概算表記と併せて表示する)
 */

export {};
