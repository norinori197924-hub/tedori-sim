import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateIncomeAdjustmentDeduction } from '../../src/calc/income-adjustment.js';

test('所得金額調整控除(国税庁「令和7年分 年末調整のしかた」p.37の計算例)', () => {
  // (8,765,432円 − 8,500,000円) × 10% = 26,543.2円 → 切り上げ
  const actual = calculateIncomeAdjustmentDeduction(8765432, [10]);
  assert.equal(actual, 26544);
});

test('給与収入850万円以下では適用されない', () => {
  assert.equal(calculateIncomeAdjustmentDeduction(8500000, [10]), 0);
});

test('23歳未満の扶養親族がいない場合は適用されない', () => {
  assert.equal(calculateIncomeAdjustmentDeduction(9000000, [25]), 0);
});

test('扶養親族がいない場合は適用されない', () => {
  assert.equal(calculateIncomeAdjustmentDeduction(9000000, []), 0);
});

test('給与収入が1,000万円を超える部分は頭打ちになる', () => {
  const at10m = calculateIncomeAdjustmentDeduction(10000000, [10]);
  const above10m = calculateIncomeAdjustmentDeduction(15000000, [10]);
  assert.equal(at10m, above10m);
  assert.equal(at10m, 150000);
});
