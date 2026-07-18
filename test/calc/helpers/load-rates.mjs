import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RATES_DIR = path.join(__dirname, '../../../src/data/rates/2026');

function loadJson(relPath) {
  return JSON.parse(readFileSync(path.join(RATES_DIR, relPath), 'utf-8'));
}

/**
 * @param {'chiba'|'tokyo'|'hokkaido'} prefecture
 */
export function loadRates(prefecture = 'chiba') {
  return {
    incomeTaxBrackets: loadJson('income-tax-brackets.json'),
    salaryIncomeDeduction: loadJson('salary-income-deduction.json'),
    basicDeduction: loadJson('basic-deduction.json'),
    spousalDeduction: loadJson('spousal-deduction.json'),
    dependentDeduction: loadJson('dependent-deduction.json'),
    residentTaxStandard: loadJson('resident-tax-standard.json'),
    employeesPension: loadJson('employees-pension.json'),
    employmentInsurance: loadJson('employment-insurance.json'),
    kyokaiKenpo: loadJson(`kyokai-kenpo/${prefecture}.json`)
  };
}
