import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const readJson = (relPath) => JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf-8'));

const master = readJson('src/data/municipalities/master.json');
const wards = readJson('src/data/municipalities/designated-city-wards.json');
const index = readJson('src/data/municipalities/index.json');

test('master.jsonは総務省公式データどおり1,747件、コード重複なし', () => {
  assert.equal(master.municipalities.length, 1747);
  const codes = new Set(master.municipalities.map((m) => m.code));
  assert.equal(codes.size, 1747);
});

test('master.jsonの種別内訳が市792/町743/村189/特別区23である', () => {
  const counts = { 市: 0, 町: 0, 村: 0, 特別区: 0 };
  for (const m of master.municipalities) {
    assert.ok(m.type in counts, `未知の種別: ${m.type}`);
    counts[m.type] += 1;
  }
  assert.deepEqual(counts, { 市: 792, 町: 743, 村: 189, 特別区: 23 });
});

test('master.jsonの各エントリが5桁コード・都道府県コードの整合性を持つ', () => {
  for (const m of master.municipalities) {
    assert.match(m.code, /^\d{5}$/, `不正なコード: ${m.code}`);
    assert.equal(m.code.slice(0, 2), m.prefectureCode);
  }
});

test('designated-city-wards.jsonの全区がparentCodeでmaster.jsonの実在コードを参照している', () => {
  const masterCodes = new Set(master.municipalities.map((m) => m.code));
  assert.ok(wards.wards.length > 0);
  for (const ward of wards.wards) {
    assert.ok(masterCodes.has(ward.parentCode), `親市コードがmaster.jsonに存在しない: ${ward.municipality} -> ${ward.parentCode}`);
  }
});

test('index.jsonの全municipalityCodeがmaster.jsonの同一都道府県・市区町村名と一致する', () => {
  const masterByCode = new Map(master.municipalities.map((m) => [m.code, m]));
  for (const m of index.municipalities) {
    const official = masterByCode.get(m.municipalityCode);
    assert.ok(official, `master.jsonに存在しないコード: ${m.prefecture}${m.municipality} (${m.municipalityCode})`);
    assert.equal(official.prefecture, m.prefecture);
    assert.equal(official.municipality, m.municipality);
  }
});

test('index.jsonのverificationStatusはverified/auto_unverified/not_availableのいずれかである', () => {
  const allowed = new Set(['verified', 'auto_unverified', 'not_available']);
  for (const m of index.municipalities) {
    assert.ok(allowed.has(m.verificationStatus), `不正なverificationStatus: ${m.municipality} -> ${m.verificationStatus}`);
  }
});
