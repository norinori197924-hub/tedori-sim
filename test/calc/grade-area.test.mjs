import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGradeAreaCode, resolveGradeArea } from '../../src/calc/grade-area.js';

test('parseGradeAreaCode: 6区分の枝番付きコードを頭一桁に丸める', () => {
  assert.equal(parseGradeAreaCode('1-1'), 1);
  assert.equal(parseGradeAreaCode('1-2'), 1);
  assert.equal(parseGradeAreaCode('2-1'), 2);
  assert.equal(parseGradeAreaCode('2-2'), 2);
  assert.equal(parseGradeAreaCode('3-1'), 3);
  assert.equal(parseGradeAreaCode('3-2'), 3);
});

test('parseGradeAreaCode: 不正なコードはエラーを投げる', () => {
  assert.throws(() => parseGradeAreaCode('4-1'));
  assert.throws(() => parseGradeAreaCode('abc'));
  assert.throws(() => parseGradeAreaCode(''));
});

test('resolveGradeArea: exceptionsが空(未収集)の場合、defaultGradeにフォールバックしunregisteredを返す', () => {
  const gradeAreaData = { defaultGrade: 3, prefectures: {} };
  const result = resolveGradeArea('13', '13101', gradeAreaData);
  assert.deepEqual(result, { grade: 3, gradeAreaStatus: 'unregistered' });
});

test('resolveGradeArea: 都道府県のエントリはあるが該当市区町村がexceptionsに無い場合もunregistered', () => {
  const gradeAreaData = {
    defaultGrade: 3,
    prefectures: { '13': { exceptions: { '13101': '1-1' } } }
  };
  // 13101(登録あり)ではなく別の市区町村コードを問い合わせる
  const result = resolveGradeArea('13', '13102', gradeAreaData);
  assert.deepEqual(result, { grade: 3, gradeAreaStatus: 'unregistered' });
});

test('resolveGradeArea: 1級地のダミーエントリが登録されている場合、registeredでgrade=1を返す', () => {
  const gradeAreaData = {
    defaultGrade: 3,
    prefectures: { '13': { exceptions: { '13101': '1-1' } } }
  };
  const result = resolveGradeArea('13', '13101', gradeAreaData);
  assert.deepEqual(result, { grade: 1, gradeAreaStatus: 'registered' });
});

test('resolveGradeArea: 2級地のダミーエントリが登録されている場合、registeredでgrade=2を返す', () => {
  const gradeAreaData = {
    defaultGrade: 3,
    prefectures: { '01': { exceptions: { '01202': '2-1' } } }
  };
  const result = resolveGradeArea('01', '01202', gradeAreaData);
  assert.deepEqual(result, { grade: 2, gradeAreaStatus: 'registered' });
});

test('resolveGradeArea: 3級地の枝番付きエントリが明示登録されている場合もregistered扱い(defaultとの偶然の値一致では区別できないため重要)', () => {
  const gradeAreaData = {
    defaultGrade: 3,
    prefectures: { '13': { exceptions: { '13101': '3-1' } } }
  };
  const result = resolveGradeArea('13', '13101', gradeAreaData);
  assert.deepEqual(result, { grade: 3, gradeAreaStatus: 'registered' });
});

test('resolveGradeArea: 未登録の都道府県を問い合わせてもエラーにならずunregisteredを返す', () => {
  const gradeAreaData = {
    defaultGrade: 3,
    prefectures: { '13': { exceptions: { '13101': '1-1' } } }
  };
  const result = resolveGradeArea('27', '27100', gradeAreaData);
  assert.deepEqual(result, { grade: 3, gradeAreaStatus: 'unregistered' });
});

test('実データ(grade-area.json)を読み込んでも例外が発生しない(現状はexceptions未収集のため全件unregistered)', async () => {
  const fs = await import('node:fs');
  const gradeAreaData = JSON.parse(
    fs.readFileSync(new URL('../../src/data/municipalities/grade-area.json', import.meta.url))
  );
  const result = resolveGradeArea('13', '13101', gradeAreaData);
  assert.equal(result.gradeAreaStatus, 'unregistered');
  assert.equal(result.grade, 3);
});
