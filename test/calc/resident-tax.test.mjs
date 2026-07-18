import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateResidentTax } from '../../src/calc/resident-tax.js';
import { loadRates } from './helpers/load-rates.mjs';

const rates = loadRates();

/**
 * 以下2件は、国税庁・総務省の公式計算例が見つからなかったため、確定済みの
 * 料率・控除額(src/data/rates/2026/*.json)を用いて手計算した検証用設例。
 * 住民税の調整控除は基礎控除の人的控除差が未確定(CLAUDE.md 9章参照)のため、
 * 現在のプレースホルダ値(0円)を前提とした結果になっている。人的控除差が
 * 確定した際は、このテストの期待値も合わせて更新すること。
 */

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
  const result = calculateResidentTax(input, 500000, rates);
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
  const result = calculateResidentTax(input, 800000, rates);
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
  assert.doesNotThrow(() => calculateResidentTax(input, 400000, rates));
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
  const result = calculateResidentTax(input, 100000, rates);
  assert.ok(result.total >= 0);
});
