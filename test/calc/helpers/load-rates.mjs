import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RATES_DIR = path.join(__dirname, '../../../src/data/rates/2026');
const DATA_DIR = path.join(__dirname, '../../../src/data');

function loadJson(relPath) {
  return JSON.parse(readFileSync(path.join(RATES_DIR, relPath), 'utf-8'));
}

const PREFECTURE_BY_MUNICIPALITY = {
  '12203': 'chiba',
  '13104': 'tokyo',
  '01100': 'hokkaido'
};

/**
 * @param {'12203'|'13104'|'01100'} municipalityCode 市川市/新宿区/札幌市のいずれか(既定は市川市)
 */
export function loadRates(municipalityCodeOrPrefecture = '12203') {
  // 既存呼び出し('chiba'等)との後方互換のため、都道府県名で渡された場合はそのままkyokai-kenpoの取得に使う。
  const prefecture = PREFECTURE_BY_MUNICIPALITY[municipalityCodeOrPrefecture] ?? municipalityCodeOrPrefecture;
  const municipalitiesData = JSON.parse(readFileSync(path.join(DATA_DIR, 'municipalities/index.json'), 'utf-8'));
  const municipality = municipalitiesData.municipalities.find(
    (m) => m.municipalityCode === municipalityCodeOrPrefecture
  ) ?? municipalitiesData.municipalities.find((m) => m.municipalityCode === '12203');

  return {
    incomeTaxBrackets: loadJson('income-tax-brackets.json'),
    salaryIncomeDeduction: loadJson('salary-income-deduction.json'),
    basicDeduction: loadJson('basic-deduction.json'),
    spousalDeduction: loadJson('spousal-deduction.json'),
    dependentDeduction: loadJson('dependent-deduction.json'),
    residentTaxStandard: loadJson('resident-tax-standard.json'),
    employeesPension: loadJson('employees-pension.json'),
    employmentInsurance: loadJson('employment-insurance.json'),
    kyokaiKenpo: loadJson(`kyokai-kenpo/${prefecture}.json`),
    nationalPension: loadJson('national-pension.json'),
    nationalHealthInsurance:
      municipality.nationalHealthInsuranceStatus === 'confirmed'
        ? JSON.parse(readFileSync(path.join(DATA_DIR, municipality.nationalHealthInsuranceFile), 'utf-8'))
        : null
  };
}
