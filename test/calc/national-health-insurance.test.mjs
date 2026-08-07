import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateNationalHealthInsurance } from '../../src/calc/national-health-insurance.js';
import { loadRates } from './helpers/load-rates.mjs';

const rates = loadRates('chiba');
const nhi = rates.nationalHealthInsurance;

/**
 * 以下は市川市の公式料率(令和8年度)を用いて手計算した検証用設例。
 * ブラウザ版(src/calc/test.html)で同じ設例を実行し、27/27件成功を確認済み。
 *
 * 2026-07-25、childSupport(子ども・子育て支援納付金分)のperCapitaAmountUnder18/Over18を
 * 市川市公式ページの再確認に基づき修正した(under18: 100円→0円、over18: 2,000円→2,100円。
 * 詳細はCLAUDE.md 11.7章)。これに伴いchildSupport・totalの期待値を再計算した。
 */

test('手計算設例A: 単身38歳・年収500万円', () => {
  const input = {
    age: 38,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'freelance',
    annualIncome: 5000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  // assessableIncome = 5,000,000 - 430,000 = 4,570,000
  // childSupport = truncateYen(4,570,000 × 0.0023) + 2,100円(18歳以上1人) = 10,511 + 2,100 = 12,611
  // 判定所得500万円は低所得軽減の基準額を大きく超えるため軽減なし(multiplier=1)
  const result = calculateNationalHealthInsurance(5000000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.medical, 375150);
  assert.equal(result.support, 95630);
  assert.equal(result.care, 0);
  assert.equal(result.childSupport, 12611);
  assert.equal(result.total, 483391);
  assert.equal(result.lowIncomeReduction.level, 'none');
});

test('手計算設例B: 配偶者あり・子供2人(10歳,20歳)・45歳・年収600万円', () => {
  const input = {
    age: 45,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 2,
    childrenAges: [10, 20],
    employmentType: 'freelance',
    annualIncome: 6000000,
    spouse: { hasSpouse: true, spouseIncome: 0 }
  };
  // assessableIncome = 6,000,000 - 430,000 = 5,570,000、世帯4人、介護分・子ども支援分の年齢区分あり
  // childSupport = truncateYen(5,570,000 × 0.0023) + 2,100円×3人(本人・配偶者・20歳の子=18歳以上)
  //              + 0円×1人(10歳の子=18歳未満) = 12,811 + 6,300 + 0 = 19,111
  const result = calculateNationalHealthInsurance(6000000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.medical, 486150);
  assert.equal(result.support, 141030);
  assert.equal(result.care, 127785);
  assert.equal(result.childSupport, 19111);
  assert.equal(result.total, 774076);
  assert.equal(result.lowIncomeReduction.level, 'none');
});

test('40歳未満は介護分が0円になる', () => {
  const input = {
    age: 39,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'freelance',
    annualIncome: 3000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  const result = calculateNationalHealthInsurance(3000000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.care, 0);
});

test('65歳以上は介護分が0円になる(介護保険第2号被保険者は40〜64歳)', () => {
  const input = {
    age: 65,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'freelance',
    annualIncome: 3000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  const result = calculateNationalHealthInsurance(3000000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.care, 0);
});

test('配偶者の年齢は不明のため介護分の対象判定には使わない(本人が対象外なら配偶者の年齢に関わらず0円)', () => {
  const input = {
    age: 30,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'freelance',
    annualIncome: 3000000,
    spouse: { hasSpouse: true, spouseIncome: 0 }
  };
  const result = calculateNationalHealthInsurance(3000000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.care, 0);
});

test('賦課限度額で頭打ちになる(年収が極端に高い場合)', () => {
  const input = {
    age: 45,
    prefectureCode: '12',
    municipalityCode: '12203',
    numberOfChildren: 0,
    childrenAges: [],
    employmentType: 'freelance',
    annualIncome: 100000000,
    spouse: { hasSpouse: false, spouseIncome: null }
  };
  const result = calculateNationalHealthInsurance(100000000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.medical, nhi.medical.cap);
  assert.equal(result.support, nhi.support.cap);
  assert.equal(result.care, nhi.care.cap);
  assert.equal(result.childSupport, nhi.childSupport.cap);
});

/**
 * 低所得世帯向け軽減(7割・5割・2割)の手計算設例(市川市・令和8年度)。
 * CLAUDE.md 11.8章の設計方針に基づく。基準額(7割=43万円、5割=43万円+31万円×被保険者数、
 * 2割=43万円+57万円×被保険者数、いずれも給与所得者等が2人以上の場合+10万円×(人数-1))は
 * 全国一律の法定値として計算エンジン内の定数で保持している。
 */

function nhiInput(overrides = {}) {
  return {
    age: 38,
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

test('低所得軽減#1: 7割・未就学児なし(単身38歳・年収40万円)', () => {
  const input = nhiInput({ annualIncome: 400000 });
  const result = calculateNationalHealthInsurance(400000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '70');
  assert.equal(result.lowIncomeReduction.threshold70, 430000);
  assert.equal(result.medical, 9720);
  assert.equal(result.support, 2640);
  assert.equal(result.care, 0);
  assert.equal(result.childSupport, 630);
  assert.equal(result.total, 12990);
});

test('低所得軽減#2: 7割・未就学児あり(本人+子1人5歳・年収40万円)', () => {
  const input = nhiInput({ annualIncome: 400000, numberOfChildren: 1, childrenAges: [5] });
  const result = calculateNationalHealthInsurance(400000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '70');
  assert.equal(result.medical, 11520);
  assert.equal(result.support, 3960);
  assert.equal(result.care, 0);
  assert.equal(result.childSupport, 630);
  assert.equal(result.total, 16110);
});

test('低所得軽減#3: 5割・未就学児なし(単身38歳・年収70万円)', () => {
  const input = nhiInput({ annualIncome: 700000 });
  const result = calculateNationalHealthInsurance(700000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '50');
  assert.equal(result.lowIncomeReduction.threshold50, 740000);
  assert.equal(result.medical, 36450);
  assert.equal(result.support, 9530);
  assert.equal(result.care, 0);
  assert.equal(result.childSupport, 1671);
  assert.equal(result.total, 47651);
});

test('低所得軽減#4: 5割・未就学児あり(本人+子1人5歳・年収100万円)', () => {
  const input = nhiInput({ annualIncome: 1000000, numberOfChildren: 1, childrenAges: [5] });
  const result = calculateNationalHealthInsurance(1000000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '50');
  assert.equal(result.medical, 61950);
  assert.equal(result.support, 17430);
  assert.equal(result.care, 0);
  assert.equal(result.childSupport, 2361);
  assert.equal(result.total, 81741);
});

test('低所得軽減#5: 2割・未就学児なし(単身38歳・年収90万円)', () => {
  const input = nhiInput({ annualIncome: 900000 });
  const result = calculateNationalHealthInsurance(900000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '20');
  assert.equal(result.lowIncomeReduction.threshold20, 1000000);
  assert.equal(result.medical, 61170);
  assert.equal(result.support, 15970);
  assert.equal(result.care, 0);
  assert.equal(result.childSupport, 2761);
  assert.equal(result.total, 79901);
});

test('低所得軽減#6: 2割・未就学児あり(本人+子1人5歳・年収150万円)', () => {
  const input = nhiInput({ annualIncome: 1500000, numberOfChildren: 1, childrenAges: [5] });
  const result = calculateNationalHealthInsurance(1500000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '20');
  assert.equal(result.medical, 110970);
  assert.equal(result.support, 30890);
  assert.equal(result.care, 0);
  assert.equal(result.childSupport, 4141);
  assert.equal(result.total, 146001);
});

test('低所得軽減#7: 配偶者の所得が判定所得に合算される(本人年収20万円だが配偶者200万円で2割止まり)', () => {
  const input = nhiInput({ annualIncome: 200000, spouse: { hasSpouse: true, spouseIncome: 2000000 } });
  const result = calculateNationalHealthInsurance(200000, input, nhi, rates.salaryIncomeDeduction);
  // 配偶者の合計所得金額 = 2,000,000 - 740,000(給与所得控除、収入220万円以下は一律74万円) = 1,260,000
  // judgmentIncome = 200,000(本人) + 1,260,000(配偶者) = 1,460,000
  assert.equal(result.lowIncomeReduction.judgmentIncome, 1460000);
  assert.equal(result.lowIncomeReduction.level, '20');
  assert.equal(result.medical, 35520);
  assert.equal(result.support, 14080);
  assert.equal(result.care, 0);
  assert.equal(result.childSupport, 3360);
  assert.equal(result.total, 52960);
});

test('低所得軽減 境界値: 判定所得430,000円ちょうどは7割(以下で該当)', () => {
  const input = nhiInput({ annualIncome: 430000 });
  const result = calculateNationalHealthInsurance(430000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '70');
  assert.equal(result.medical, 9720);
  assert.equal(result.support, 2640);
  assert.equal(result.childSupport, 630);
  assert.equal(result.total, 12990);
});

test('低所得軽減 境界値: 判定所得430,001円は5割', () => {
  const input = nhiInput({ annualIncome: 430001 });
  const result = calculateNationalHealthInsurance(430001, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '50');
  assert.equal(result.medical, 16200);
  assert.equal(result.support, 4400);
  assert.equal(result.childSupport, 1050);
  assert.equal(result.total, 21650);
});

test('低所得軽減 境界値: 判定所得740,000円ちょうどは5割(以下で該当)', () => {
  const input = nhiInput({ annualIncome: 740000 });
  const result = calculateNationalHealthInsurance(740000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '50');
  assert.equal(result.medical, 39450);
  assert.equal(result.support, 10290);
  assert.equal(result.childSupport, 1763);
  assert.equal(result.total, 51503);
});

test('低所得軽減 境界値: 判定所得740,001円は2割', () => {
  const input = nhiInput({ annualIncome: 740001 });
  const result = calculateNationalHealthInsurance(740001, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '20');
  assert.equal(result.medical, 49170);
  assert.equal(result.support, 12930);
  assert.equal(result.childSupport, 2393);
  assert.equal(result.total, 64493);
});

test('低所得軽減 境界値: 判定所得1,000,000円ちょうどは2割(以下で該当)', () => {
  const input = nhiInput({ annualIncome: 1000000 });
  const result = calculateNationalHealthInsurance(1000000, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '20');
  assert.equal(result.medical, 68670);
  assert.equal(result.support, 17870);
  assert.equal(result.childSupport, 2991);
  assert.equal(result.total, 89531);
});

test('低所得軽減 境界値: 判定所得1,000,001円は軽減なし', () => {
  const input = nhiInput({ annualIncome: 1000001 });
  const result = calculateNationalHealthInsurance(1000001, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, 'none');
  assert.equal(result.medical, 75150);
  assert.equal(result.support, 19630);
  assert.equal(result.childSupport, 3411);
  assert.equal(result.total, 98191);
});

test('低所得軽減: 被保険者数の影響(同一判定所得1,000,001円、単身は軽減なし)', () => {
  const input = nhiInput({ annualIncome: 1000001 });
  const result = calculateNationalHealthInsurance(1000001, input, nhi, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, 'none');
  assert.equal(result.total, 98191);
});

test('低所得軽減: 被保険者数の影響(同一判定所得1,000,001円、本人+子1人〔10歳〕は2割基準額を跨がず5割該当)', () => {
  const input = nhiInput({ annualIncome: 1000001, numberOfChildren: 1, childrenAges: [10] });
  const result = calculateNationalHealthInsurance(1000001, input, nhi, rates.salaryIncomeDeduction);
  // 5割基準額 = 430,000 + 310,000×2 = 1,050,000。単身なら軽減なしの所得でも、世帯2人だと5割に該当する。
  assert.equal(result.lowIncomeReduction.level, '50');
  assert.equal(result.lowIncomeReduction.threshold50, 1050000);
  assert.equal(result.medical, 64950);
  assert.equal(result.support, 19630);
  assert.equal(result.childSupport, 2361);
  assert.equal(result.total, 86941);
});

test('低所得軽減: 端数処理の順序(軽減乗数のtruncateYen→未就学児floorの二重適用、合成レートで検証)', () => {
  const customRate = {
    medical: { incomeRate: 0, perCapitaAmount: 10019, perHouseholdAmount: 0, cap: 999999999 },
    support: { incomeRate: 0, perCapitaAmount: 0, perHouseholdAmount: 0, cap: 999999999 },
    care: { incomeRate: 0, perCapitaAmount: 0, perHouseholdAmount: 0, cap: 999999999 },
    childSupport: { incomeRate: 0, perCapitaAmountUnder18: 0, perCapitaAmountOver18: 0, perHouseholdAmount: 0, cap: 999999999 }
  };
  const input = nhiInput({ annualIncome: 400000, numberOfChildren: 1, childrenAges: [5] });
  const result = calculateNationalHealthInsurance(400000, input, customRate, rates.salaryIncomeDeduction);
  // 10,019 × 0.3 = 3,005.7 → truncateYen → 3,005(四捨五入なら3,006)
  // 3,005 × 0.5 = 1,502.5 → floor → 1,502(四捨五入なら1,503)
  // perCapitaLevy = 3,005×1(本人) + 1,502×1(未就学児) = 4,507
  assert.equal(result.medical, 4507);
});

test('低所得軽減: 平等割・介護分にも軽減乗数が適用される(札幌市。全区分で平等割が非ゼロ)', () => {
  const sapporo = loadRates('01100').nationalHealthInsurance;
  const input = nhiInput({ age: 45, annualIncome: 400000 });
  const result = calculateNationalHealthInsurance(400000, input, sapporo, rates.salaryIncomeDeduction);
  assert.equal(result.lowIncomeReduction.level, '70');
  assert.equal(result.medical, 15927);
  assert.equal(result.support, 4902);
  assert.equal(result.care, 4071);
  assert.equal(result.childSupport, 630);
  assert.equal(result.total, 25530);
});
