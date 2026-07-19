import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateNationalHealthInsurance } from '../../src/calc/national-health-insurance.js';
import { loadRates } from './helpers/load-rates.mjs';

const rates = loadRates('chiba');
const nhi = rates.nationalHealthInsurance;

/**
 * 以下は市川市の公式料率(令和8年度)を用いて手計算した検証用設例。
 * ブラウザ版(src/calc/test.html)で同じ設例を実行し、27/27件成功を確認済み。
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
  const result = calculateNationalHealthInsurance(5000000, input, nhi);
  assert.equal(result.medical, 375150);
  assert.equal(result.support, 95630);
  assert.equal(result.care, 0);
  assert.equal(result.childSupport, 12511);
  assert.equal(result.total, 483291);
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
  const result = calculateNationalHealthInsurance(6000000, input, nhi);
  assert.equal(result.medical, 486150);
  assert.equal(result.support, 141030);
  assert.equal(result.care, 127785);
  assert.equal(result.childSupport, 18911);
  assert.equal(result.total, 773876);
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
  const result = calculateNationalHealthInsurance(3000000, input, nhi);
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
  const result = calculateNationalHealthInsurance(3000000, input, nhi);
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
  const result = calculateNationalHealthInsurance(3000000, input, nhi);
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
  const result = calculateNationalHealthInsurance(100000000, input, nhi);
  assert.equal(result.medical, nhi.medical.cap);
  assert.equal(result.support, nhi.support.cap);
  assert.equal(result.care, nhi.care.cap);
  assert.equal(result.childSupport, nhi.childSupport.cap);
});
