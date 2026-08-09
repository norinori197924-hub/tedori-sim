import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateResidentTax } from '../../src/calc/resident-tax.js';
import { calculateEmployeeIncome } from '../../src/calc/income-by-type.js';
import { loadRates } from './helpers/load-rates.mjs';

const rates = loadRates();

/**
 * 以下2件は、国税庁・総務省の公式計算例が見つからなかったため、確定済みの
 * 料率・控除額(src/data/rates/2026/*.json)を用いて手計算した検証用設例。
 * 住民税の調整控除は基礎控除の人的控除差が未確定(CLAUDE.md 9章参照)のため、
 * 現在のプレースホルダ値(0円)を前提とした結果になっている。人的控除差が
 * 確定した際は、このテストの期待値も合わせて更新すること。
 */

function residentTaxFor(input, socialInsuranceTotal) {
  const income = calculateEmployeeIncome(input, rates);
  return calculateResidentTax(income.totalIncome, input, socialInsuranceTotal, rates);
}

/**
 * 所得割の非課税限度額(地方税法附則第3条の3)の境界テスト用。
 * totalIncome(総所得金額等)を直接指定できるよう、給与所得控除の逆算を介さず
 * calculateResidentTaxを直接呼び出す。基準額は resident-tax-standard.json の
 * incomeLevyExemption(35万円×人数+10万円+32万円、令和8年度も据え置きと判断。
 * CLAUDE.md 9章の未確認事項一覧参照)。
 */
function residentTaxRaw(totalIncome, input, socialInsuranceTotal = 0) {
  return calculateResidentTax(totalIncome, input, socialInsuranceTotal, rates);
}

function baseInput(overrides = {}) {
  return {
    age: 30,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'freelance',
    annualIncome: 0,
    spouse: { hasSpouse: false, spouseIncome: null },
    ...overrides
  };
}

test('手計算設例1: 単身・子供なし・年収400万円・社会保険料50万円', () => {
  const input = {
    age: 40,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'employee',
    annualIncome: 4000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  // 給与所得 = 4,000,000×80%-440,000 = 2,760,000
  // 所得控除 = 基礎控除430,000 + 社会保険料500,000 = 930,000
  // 課税所得 = 2,760,000-930,000 = 1,830,000
  // 所得割(調整控除前) = 1,830,000×10% = 183,000
  // 人的控除差なし(配偶者・扶養控除0円)のため調整控除は0円
  // 均等割4,000円 + 森林環境税1,000円
  const result = residentTaxFor(input, 500000);
  assert.equal(result.taxableIncome, 1830000);
  assert.equal(result.incomeLevyBeforeCredit, 183000);
  assert.equal(result.adjustmentCredit, 0);
  assert.equal(result.total, 188000);
});

test('手計算設例2: 配偶者(専業)あり・子供1人(17歳)・年収600万円・社会保険料80万円', () => {
  const input = {
    age: 42,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 1,
    childrenAges: [17],
    employmentType: 'employee',
    annualIncome: 6000000,
    spouse: { hasSpouse: true, spouseIncome: 0 }
  };
  // 給与所得 = 6,000,000×80%-440,000 = 4,360,000
  // 所得控除 = 基礎控除430,000 + 社会保険料800,000 + 配偶者控除330,000 + 扶養控除(一般)330,000 = 1,890,000
  // 課税所得 = 4,360,000-1,890,000 = 2,470,000
  // 所得割(調整控除前) = 2,470,000×10% = 247,000
  // 調整控除: 人的控除差(配偶者50,000+扶養50,000=100,000)、課税所得200万円超のため
  //   {100,000-(2,470,000-2,000,000)}×5%はマイナスとなり、下限の2,500円を適用
  const result = residentTaxFor(input, 800000);
  assert.equal(result.taxableIncome, 2470000);
  assert.equal(result.incomeLevyBeforeCredit, 247000);
  assert.equal(result.adjustmentCredit, 2500);
  assert.equal(result.total, 249500);
});

test('子供0人・配偶者なしでも例外にならない', () => {
  const input = {
    age: 25,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'employee',
    annualIncome: 3000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  assert.doesNotThrow(() => residentTaxFor(input, 400000));
});

test('年収が極端に低い場合(100万円)でも住民税額はマイナスにならない', () => {
  const input = {
    age: 22,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'employee',
    annualIncome: 1000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  const result = residentTaxFor(input, 100000);
  assert.ok(result.total >= 0);
});

/**
 * 以下は所得割の非課税限度額(地方税法附則第3条の3)の境界テスト。
 * 基準額 = 35万円×(本人+同一生計配偶者+扶養親族の数) + 10万円 + 32万円(配偶者・扶養親族がいる場合のみ)。
 * 係数は令和8年度改正でも据え置きと判断(未確認事項。CLAUDE.md 9章・SPEC.md 5章参照)。
 * 均等割・森林環境税はこの判定と独立しており、常に課税される(このテストでは検証しない)。
 */

test('所得割非課税: 単身・総所得450,000円ちょうど → 非課税', () => {
  const result = residentTaxRaw(450000, baseInput());
  assert.equal(result.incomeLevyExempt, true);
  assert.equal(result.incomeLevyBeforeCredit, 0);
  assert.equal(result.adjustmentCredit, 0);
  assert.equal(result.incomeLevy, 0);
});

test('所得割非課税: 単身・総所得450,001円 → 課税(境界+1円)', () => {
  const result = residentTaxRaw(450001, baseInput());
  // 基礎控除430,000円のみ控除 → 課税所得 = truncateTo1000(450,001-430,000) = 20,000円
  // 所得割(調整控除前) = 20,000×10% = 2,000円。人的控除差なしのため調整控除0円。
  assert.equal(result.incomeLevyExempt, false);
  assert.equal(result.incomeLevy, 2000);
});

test('所得割非課税: 会社員・給与収入119万円(単身) → 総所得450,000円で非課税', () => {
  const input = baseInput({ employmentType: 'employee', annualIncome: 1190000 });
  const income = calculateEmployeeIncome(input, rates);
  assert.equal(income.totalIncome, 450000);
  const result = calculateResidentTax(income.totalIncome, input, 0, rates);
  assert.equal(result.incomeLevyExempt, true);
  assert.equal(result.incomeLevy, 0);
});

test('所得割非課税: 会社員・給与収入120万円(単身) → 総所得460,000円で課税(境界超過)', () => {
  const input = baseInput({ employmentType: 'employee', annualIncome: 1200000 });
  const income = calculateEmployeeIncome(input, rates);
  assert.equal(income.totalIncome, 460000);
  const result = calculateResidentTax(income.totalIncome, input, 0, rates);
  assert.equal(result.incomeLevyExempt, false);
});

test('所得割非課税: 扶養1人(10歳、16歳未満)・総所得1,120,000円ちょうど → 非課税', () => {
  // 16歳未満は扶養控除の対象外だが、非課税限度額の判定人数には算入する
  // (扶養控除ロジックのcountとは別カウント。誤って流用すると0人扱いになりバグる)。
  const input = baseInput({ numberOfChildren: 1, childrenAges: [10] });
  const result = residentTaxRaw(1120000, input);
  assert.equal(result.incomeLevyExempt, true);
});

test('所得割非課税: 扶養1人(10歳)・総所得1,120,001円 → 課税(境界+1円)', () => {
  const input = baseInput({ numberOfChildren: 1, childrenAges: [10] });
  const result = residentTaxRaw(1120001, input);
  assert.equal(result.incomeLevyExempt, false);
});

test('所得割非課税: 扶養3人(5歳・8歳・12歳、全員16歳未満)・総所得1,820,000円ちょうど → 非課税', () => {
  const input = baseInput({ numberOfChildren: 3, childrenAges: [5, 8, 12] });
  const result = residentTaxRaw(1820000, input);
  assert.equal(result.incomeLevyExempt, true);
});

test('所得割非課税: 扶養3人・総所得1,820,001円 → 課税(境界+1円)', () => {
  const input = baseInput({ numberOfChildren: 3, childrenAges: [5, 8, 12] });
  const result = residentTaxRaw(1820001, input);
  assert.equal(result.incomeLevyExempt, false);
});

test('所得割非課税: 同一生計配偶者(所得0円)・総所得1,120,000円ちょうど → 非課税', () => {
  // 本人+同一生計配偶者=2人は、本人+扶養親族1人と人数構成上まったく同じ(35万×2+10万+32万)
  // のため、上の「扶養1人」テストと同一の閾値1,120,000円になるのが数式上正しい。
  const input = baseInput({ spouse: { hasSpouse: true, spouseIncome: 0 } });
  const result = residentTaxRaw(1120000, input);
  assert.equal(result.incomeLevyExempt, true);
});

test('所得割非課税: 同一生計配偶者(所得0円)・総所得1,120,001円 → 課税(境界+1円)', () => {
  const input = baseInput({ spouse: { hasSpouse: true, spouseIncome: 0 } });
  const result = residentTaxRaw(1120001, input);
  assert.equal(result.incomeLevyExempt, false);
});

test('所得割非課税: 配偶者の所得が62万円超 → 同一生計配偶者に非該当、単身扱いの閾値(45万円)に戻る', () => {
  // spouseIncome=2,000,000 → 給与所得控除後の配偶者の合計所得金額 = 2,000,000-740,000 = 1,260,000円(>620,000円)
  // hasSpouse=trueだけで機械的に「配偶者あり」の閾値(102万円)を適用すると誤り、という回帰防止テスト。
  const input = baseInput({ spouse: { hasSpouse: true, spouseIncome: 2000000 } });
  const result = residentTaxRaw(700000, input);
  assert.equal(result.incomeLevyExempt, false);
});

test('所得割非課税: (対比)配偶者の所得が0円なら同一生計配偶者に該当、総所得700,000円でも非課税', () => {
  const input = baseInput({ spouse: { hasSpouse: true, spouseIncome: 0 } });
  const result = residentTaxRaw(700000, input);
  assert.equal(result.incomeLevyExempt, true);
});

/**
 * 以下は均等割の非課税限度額(地方税法第295条3項→施行令47条の3→施行規則9条の3)の境界テスト。
 * 基準額 = baseAmountPerPerson×人数 + addition(定額10万円) + dependentOrSpouseAddition(配偶者・扶養親族がいる場合)。
 * 係数は級地(1〜3級地)ごとに異なり、参酌基準(条例による差異がありうる暫定値)。
 * 該当時は均等割(perCapitaLevy)・森林環境税(forestEnvironmentTax)の両方が非課税になる。
 */

function ratesWithGrade(gradeCode, prefectureCode = '12', municipalityCode = '12203') {
  return {
    ...rates,
    gradeArea: {
      defaultGrade: 3,
      prefectures: { [prefectureCode]: { exceptions: { [municipalityCode]: gradeCode } } }
    }
  };
}

test('均等割非課税: 3級地(未登録・デフォルト)・単身・総所得380,000円ちょうど → 非課税(森林環境税も同時に非課税)', () => {
  const result = calculateResidentTax(380000, baseInput(), 0, rates);
  assert.equal(result.gradeAreaStatus, 'unregistered');
  assert.equal(result.grade, 3);
  assert.equal(result.perCapitaLevyExempt, true);
  assert.equal(result.perCapitaLevy, 0);
  assert.equal(result.forestEnvironmentTax, 0);
});

test('均等割非課税: 3級地・単身・総所得380,001円 → 課税(境界+1円、均等割4,000円+森林環境税1,000円)', () => {
  const result = calculateResidentTax(380001, baseInput(), 0, rates);
  assert.equal(result.perCapitaLevyExempt, false);
  assert.equal(result.perCapitaLevy, 4000);
  assert.equal(result.forestEnvironmentTax, 1000);
});

test('均等割非課税: 1級地(登録済み)・単身・総所得450,000円ちょうど → 非課税', () => {
  const result = calculateResidentTax(450000, baseInput(), 0, ratesWithGrade('1-1'));
  assert.equal(result.gradeAreaStatus, 'registered');
  assert.equal(result.grade, 1);
  assert.equal(result.perCapitaLevyExempt, true);
});

test('均等割非課税: 1級地・単身・総所得450,001円 → 課税(境界+1円)', () => {
  const result = calculateResidentTax(450001, baseInput(), 0, ratesWithGrade('1-2'));
  assert.equal(result.grade, 1);
  assert.equal(result.perCapitaLevyExempt, false);
});

test('均等割非課税: 2級地(登録済み)・単身・総所得415,000円ちょうど → 非課税', () => {
  const result = calculateResidentTax(415000, baseInput(), 0, ratesWithGrade('2-1'));
  assert.equal(result.grade, 2);
  assert.equal(result.perCapitaLevyExempt, true);
});

test('均等割非課税: 2級地・単身・総所得415,001円 → 課税(境界+1円)', () => {
  const result = calculateResidentTax(415001, baseInput(), 0, ratesWithGrade('2-2'));
  assert.equal(result.grade, 2);
  assert.equal(result.perCapitaLevyExempt, false);
});

test('均等割非課税: 3級地・扶養1人・総所得828,000円ちょうど → 非課税', () => {
  const input = baseInput({ numberOfChildren: 1, childrenAges: [10] });
  const result = calculateResidentTax(828000, input, 0, rates);
  assert.equal(result.perCapitaLevyExempt, true);
});

test('均等割非課税: 3級地・扶養1人・総所得828,001円 → 課税(境界+1円)', () => {
  const input = baseInput({ numberOfChildren: 1, childrenAges: [10] });
  const result = calculateResidentTax(828001, input, 0, rates);
  assert.equal(result.perCapitaLevyExempt, false);
});

test('均等割非課税: 級地未登録かつ3級地基準では課税だが1級地基準なら非課税 → perCapitaLevyGradeAmbiguous=true', () => {
  // 3級地基準(380,000円)は超過するが、1級地基準(450,000円)以下のため、
  // 実際の級地が1級地・2級地であれば非課税になりうる。
  const result = calculateResidentTax(400000, baseInput(), 0, rates);
  assert.equal(result.gradeAreaStatus, 'unregistered');
  assert.equal(result.perCapitaLevyExempt, false);
  assert.equal(result.perCapitaLevyGradeAmbiguous, true);
});

test('均等割非課税: 級地未登録でも、1級地基準でも明らかに課税な高所得ならperCapitaLevyGradeAmbiguous=false(ノイズ防止)', () => {
  const result = calculateResidentTax(5000000, baseInput(), 0, rates);
  assert.equal(result.gradeAreaStatus, 'unregistered');
  assert.equal(result.perCapitaLevyExempt, false);
  assert.equal(result.perCapitaLevyGradeAmbiguous, false);
});

test('均等割非課税: 級地未登録でも、3級地基準で既に非課税ならperCapitaLevyGradeAmbiguous=false(既に非課税なので級地確定を待つ必要がない)', () => {
  const result = calculateResidentTax(380000, baseInput(), 0, rates);
  assert.equal(result.perCapitaLevyExempt, true);
  assert.equal(result.perCapitaLevyGradeAmbiguous, false);
});

test('均等割非課税: 高所得(年収400万円相当)では級地に関わらず課税、均等割・森林環境税とも通常どおり', () => {
  const result = calculateResidentTax(2760000, baseInput({ annualIncome: 4000000 }), 500000, rates);
  assert.equal(result.perCapitaLevyExempt, false);
  assert.equal(result.perCapitaLevy, 4000);
  assert.equal(result.forestEnvironmentTax, 1000);
});
