// @ts-check
import { calculateTakeHome } from '../calc/engine.js';

const RATES_BASE = './src/data/rates/2026/';
const MUNICIPALITIES_URL = './src/data/municipalities/index.json';

const prefectureSelect = document.getElementById('prefecture');
const municipalitySelect = document.getElementById('municipality');
const form = document.getElementById('calc-form');
const resultBody = document.getElementById('result-body');
const resultTitle = document.getElementById('result-title');
const resultBadge = document.getElementById('result-badge');
const badgeCoverage = document.getElementById('badge-coverage');
const employmentButtons = Array.from(document.querySelectorAll('[data-employment]'));

/** @type {Array<any>} */
let municipalities = [];
let totalMunicipalityCount = 1741;

/** @type {'employee'|'freelance'} */
let selectedEmploymentType = 'employee';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`データの取得に失敗しました: ${url}`);
  return res.json();
}

function formatYen(n) {
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

function initEmploymentButtons() {
  employmentButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedEmploymentType = btn.dataset.employment;
      employmentButtons.forEach((b) => b.classList.toggle('on', b === btn));
    });
  });
}

async function initMunicipalities() {
  const data = await fetchJson(MUNICIPALITIES_URL);
  municipalities = data.municipalities;
  totalMunicipalityCount = data.totalMunicipalityCount ?? 1741;
  badgeCoverage.textContent = `${municipalities.length} / ${totalMunicipalityCount.toLocaleString('ja-JP')}`;

  const prefectures = [...new Set(municipalities.map((m) => m.prefecture))];
  prefectureSelect.innerHTML = prefectures.map((p) => `<option value="${p}">${p}</option>`).join('');
  updateMunicipalityOptions();
  prefectureSelect.addEventListener('change', updateMunicipalityOptions);
}

function updateMunicipalityOptions() {
  const selectedPrefecture = prefectureSelect.value;
  const options = municipalities.filter((m) => m.prefecture === selectedPrefecture);
  municipalitySelect.innerHTML = options
    .map((m) => `<option value="${m.municipalityCode}">${m.municipality}</option>`)
    .join('');
}

function getSelectedMunicipality() {
  const code = municipalitySelect.value;
  const found = municipalities.find((m) => m.municipalityCode === code);
  if (!found) throw new Error('市区町村が選択されていません。');
  return found;
}

function parseChildrenAges(text, numberOfChildren) {
  const ages = text
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
  if (ages.some((a) => Number.isNaN(a) || a < 0 || a > 30)) {
    throw new Error('子供の年齢は0〜30の数値をカンマ区切りで入力してください。');
  }
  if (ages.length !== numberOfChildren) {
    throw new Error(`子供の数(${numberOfChildren}人)と、入力された年齢の数(${ages.length}件)が一致しません。`);
  }
  return ages;
}

/**
 * @param {'employee'|'freelance'} employmentType
 */
function readInput(employmentType) {
  const municipality = getSelectedMunicipality();
  const numberOfChildren = Number(document.getElementById('numberOfChildren').value);
  const childrenAges = parseChildrenAges(document.getElementById('childrenAges').value, numberOfChildren);
  const hasSpouse = document.getElementById('hasSpouse').value === 'yes';
  const spouseIncomeRaw = document.getElementById('spouseIncome').value;

  /** @type {import('../calc/types.js').SimpleInput} */
  const input = {
    age: Number(document.getElementById('age').value),
    prefectureCode: municipality.prefectureCode,
    municipalityCode: municipality.municipalityCode,
    numberOfChildren,
    childrenAges,
    employmentType,
    annualIncome: Number(document.getElementById('annualIncome').value),
    spouse: {
      hasSpouse,
      spouseIncome: hasSpouse && spouseIncomeRaw !== '' ? Number(spouseIncomeRaw) : null
    }
  };

  if (!Number.isFinite(input.age) || input.age < 15 || input.age > 100) {
    throw new Error('年齢は15〜100の範囲で入力してください。');
  }
  if (!Number.isFinite(input.annualIncome) || input.annualIncome < 0) {
    throw new Error('額面の年収を正しく入力してください。');
  }

  return { input, municipality };
}

async function loadRates(municipality) {
  const [
    incomeTaxBrackets, salaryIncomeDeduction, basicDeduction, spousalDeduction,
    dependentDeduction, residentTaxStandard, employeesPension, employmentInsurance, kyokaiKenpo,
    nationalPension
  ] = await Promise.all([
    fetchJson(RATES_BASE + 'income-tax-brackets.json'),
    fetchJson(RATES_BASE + 'salary-income-deduction.json'),
    fetchJson(RATES_BASE + 'basic-deduction.json'),
    fetchJson(RATES_BASE + 'spousal-deduction.json'),
    fetchJson(RATES_BASE + 'dependent-deduction.json'),
    fetchJson(RATES_BASE + 'resident-tax-standard.json'),
    fetchJson(RATES_BASE + 'employees-pension.json'),
    fetchJson(RATES_BASE + 'employment-insurance.json'),
    fetchJson('./' + municipality.kyokaiKenpoRatesFile.replace(/^rates\//, 'src/data/rates/')),
    fetchJson(RATES_BASE + 'national-pension.json')
  ]);

  let nationalHealthInsurance = null;
  if (municipality.nationalHealthInsuranceStatus === 'confirmed') {
    nationalHealthInsurance = await fetchJson(
      './' + municipality.nationalHealthInsuranceFile.replace(/^rates\//, 'src/data/rates/')
    );
  }

  return {
    incomeTaxBrackets, salaryIncomeDeduction, basicDeduction, spousalDeduction,
    dependentDeduction, residentTaxStandard, employeesPension, employmentInsurance, kyokaiKenpo,
    nationalPension, nationalHealthInsurance
  };
}

function employmentLabel(employmentType) {
  return employmentType === 'employee' ? '会社員' : 'フリーランス・自営業';
}

function renderLedgerRows(employmentType, result, municipality) {
  const si = result.socialInsurance;
  if (employmentType === 'employee') {
    const childcareBadge = '<span class="tag new">新設(令和8年4月分〜)</span>';
    return `
      <tr><td>社会保険料 合計<br><span class="src">出典：協会けんぽ・日本年金機構・厚生労働省</span></td><td class="v minus">− ${formatYen(si.total)}</td></tr>
      <tr class="sub"><td>健康保険・介護保険（協会けんぽ・${municipality.prefecture}料率）<span class="tag city">都道府県別</span></td><td class="v minus">− ${formatYen(si.healthInsuranceAnnual)}</td></tr>
      <tr class="sub"><td>厚生年金</td><td class="v minus">− ${formatYen(si.pensionAnnual)}</td></tr>
      <tr class="sub"><td>雇用保険</td><td class="v minus">− ${formatYen(si.employmentInsuranceAnnual)}</td></tr>
      <tr class="sub"><td>子ども・子育て支援金${childcareBadge}</td><td class="v minus">− ${formatYen(si.childcareSupportAnnual)}</td></tr>
    `;
  }
  const nhi = si.nationalHealthInsurance;
  const np = si.nationalPension;
  return `
    <tr><td>国民健康保険料＋国民年金 合計<br><span class="src">出典：${municipality.prefecture}${municipality.municipality}・日本年金機構</span></td><td class="v minus">− ${formatYen(si.total)}</td></tr>
    <tr class="sub"><td>国保・医療分<span class="tag city">${municipality.municipality}料率</span></td><td class="v minus">− ${formatYen(nhi.medical)}</td></tr>
    <tr class="sub"><td>国保・後期高齢者支援金分</td><td class="v minus">− ${formatYen(nhi.support)}</td></tr>
    <tr class="sub"><td>国保・介護分（40〜64歳のみ）</td><td class="v minus">− ${formatYen(nhi.care)}</td></tr>
    <tr class="sub"><td>国保・子ども子育て支援納付金分<span class="tag new">新設(令和8年度〜)</span></td><td class="v minus">− ${formatYen(nhi.childSupport)}</td></tr>
    <tr class="sub"><td>国民年金保険料</td><td class="v minus">− ${formatYen(np.total)}</td></tr>
  `;
}

function renderCompareCard(currentType, currentResult, otherType, otherResult) {
  if (!otherResult) {
    return `
      <div class="compare">
        <h3>もし、同じ年収で${employmentLabel(otherType)}だったら</h3>
        <p class="note">この自治体の国民健康保険料が未整備のため、比較を表示できません。</p>
      </div>
    `;
  }
  const diff = currentResult.takeHomeAnnual - otherResult.takeHomeAnnual;
  const diffAbs = formatYen(Math.abs(diff));
  const diffText = diff === 0
    ? '手取りの差はありません。'
    : diff > 0
      ? `${employmentLabel(currentType)}の方が、手取りが年 <b>${diffAbs}</b> 多くなります。`
      : `${employmentLabel(otherType)}の方が、手取りが年 <b>${diffAbs}</b> 多くなります。`;

  return `
    <div class="compare">
      <h3>もし、同じ年収で${employmentLabel(otherType)}だったら</h3>
      <div class="vs">
        <div class="side"><div class="r">${employmentLabel(currentType)}（いま）</div><div class="a" style="color:var(--green)">${formatYen(currentResult.takeHomeAnnual)}</div></div>
        <div class="mid">対</div>
        <div class="side"><div class="r">${employmentLabel(otherType)}（比較）</div><div class="a">${formatYen(otherResult.takeHomeAnnual)}</div></div>
        <div class="diff">${diffText}</div>
      </div>
      <p class="note">※ フリーランス側はかんたん入力の簡易計算（経費・青色申告控除なし）です。両方とも概算であり、正確な比較には詳細入力モード（第2弾）をご利用ください。</p>
    </div>
  `;
}

function renderResult(employmentType, input, municipality, result, otherResult) {
  const income = input.annualIncome;
  const pct = (n) => Math.max(0, Math.min(100, (n / income) * 100));

  resultTitle.textContent = `計算結果 — ${municipality.prefecture}${municipality.municipality}・${employmentLabel(employmentType)}・年収${(income / 10000).toLocaleString('ja-JP')}万円の場合`;

  const otherType = employmentType === 'employee' ? 'freelance' : 'employee';

  resultBody.innerHTML = `
    <div class="flow-label"><span>あなたの年収の行き先</span><b>${formatYen(income)}</b></div>
    <div class="bar">
      <div class="b-tax" style="width:${pct(result.incomeTax.total)}%">${pct(result.incomeTax.total) > 6 ? '所得税' : ''}</div>
      <div class="b-juu" style="width:${pct(result.residentTax.total)}%">${pct(result.residentTax.total) > 6 ? '住民税' : ''}</div>
      <div class="b-sha" style="width:${pct(result.socialInsurance.total)}%">${pct(result.socialInsurance.total) > 6 ? '社会保険' : ''}</div>
      <div class="b-net" style="width:${pct(result.takeHomeAnnual)}%">手取り ${Math.round(pct(result.takeHomeAnnual))}%</div>
    </div>
    <div class="bar-cap"><span>■ 出ていくお金（税・社保）</span><span>■ 残るお金（手取り）</span></div>

    <div class="takehome">
      <span class="l">手取り額</span>
      <span class="v">${formatYen(result.takeHomeAnnual)}</span>
      <span class="m">／年（月あたり ${formatYen(result.takeHomeMonthly)}）</span>
    </div>

    <table class="ledger">
      <tr><th>項目</th><th style="text-align:right">年額</th></tr>
      <tr><td>所得税<br><span class="src">出典：国税庁 令和8年分速算表</span></td><td class="v minus">− ${formatYen(result.incomeTax.total)}</td></tr>
      <tr><td>住民税（所得割＋均等割＋森林環境税）<br><span class="src">出典：総務省・東京都主税局 等 標準税率</span></td><td class="v minus">− ${formatYen(result.residentTax.total)}</td></tr>
      ${renderLedgerRows(employmentType, result, municipality)}
      <tr><td><b>手取り</b></td><td class="v" style="color:var(--green);font-weight:600">${formatYen(result.takeHomeAnnual)}</td></tr>
    </table>

    ${renderCompareCard(employmentType, result, otherType, otherResult)}

    <div class="assumptions">
      <h3>この計算の前提・注記</h3>
      <ul>${result.assumptions.map((a) => `<li>${a}</li>`).join('')}</ul>
    </div>
  `;
}

async function handleSubmit(event) {
  event.preventDefault();
  resultBody.innerHTML = '<div class="placeholder">計算中…</div>';
  try {
    const employmentType = selectedEmploymentType;
    const otherType = employmentType === 'employee' ? 'freelance' : 'employee';
    const { input, municipality } = readInput(employmentType);
    const nhiConfirmed = municipality.nationalHealthInsuranceStatus === 'confirmed';

    if (employmentType === 'freelance' && !nhiConfirmed) {
      resultBody.innerHTML = `<div class="placeholder">${municipality.prefecture}${municipality.municipality}の国民健康保険料はまだ整備できていません（データ未整備）。会社員としての計算のみご利用いただけます。</div>`;
      return;
    }

    const rates = await loadRates(municipality);
    const result = calculateTakeHome(input, rates);
    const otherResult = nhiConfirmed ? calculateTakeHome({ ...input, employmentType: otherType }, rates) : null;
    renderResult(employmentType, input, municipality, result, otherResult);
  } catch (err) {
    resultBody.innerHTML = `<div class="placeholder" style="color:var(--red)">エラー: ${err.message}</div>`;
    console.error(err);
  }
}

form.addEventListener('submit', handleSubmit);
initEmploymentButtons();
initMunicipalities().catch((err) => {
  resultBody.innerHTML = `<div class="placeholder" style="color:var(--red)">自治体データの読み込みに失敗しました: ${err.message}</div>`;
  console.error(err);
});
