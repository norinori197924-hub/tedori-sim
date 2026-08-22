// @ts-check
import { calculateTakeHome } from '../calc/engine.js';

const RATES_BASE = './src/data/rates/2026/';
const MUNICIPALITIES_URL = './src/data/municipalities/index.json';
const GRADE_AREA_URL = './src/data/municipalities/grade-area.json';
const DEFAULT_RESULT_TITLE = '計算結果';
/**
 * 会社員モードの年収下限(円)。給与所得控除額(55万円)を下回る年収で
 * 社会保険に加入する正社員は現実には存在しないため、この額未満はエラーとする。
 * 扶養内パート等(103万・106万・130万円前後)の入力はこの下限より十分大きいため影響しない。
 */
const EMPLOYEE_MIN_ANNUAL_INCOME = 500000;

const prefRateSection = document.getElementById('pref-rate-section');
const prefRateTable = document.getElementById('pref-rate-table');

const prefectureSelect = document.getElementById('prefecture');
const municipalitySelect = document.getElementById('municipality');
const form = document.getElementById('calc-form');
const formErrors = document.getElementById('form-errors');
const resultBody = document.getElementById('result-body');
const resultTitle = document.getElementById('result-title');
const resultBadge = document.getElementById('result-badge');
const badgeCoverage = document.getElementById('badge-coverage');
const coverageMeterFill = document.getElementById('coverage-meter-fill');
const coverageChips = document.getElementById('coverage-chips');
const employmentButtons = Array.from(document.querySelectorAll('[data-employment]'));

const annualIncomeInput = document.getElementById('annualIncome');
const ageInput = document.getElementById('age');
const numberOfChildrenSelect = document.getElementById('numberOfChildren');
const childrenAgesField = document.getElementById('childrenAgesField');
const childrenAgesContainer = document.getElementById('childrenAgesContainer');
const hasSpouseSelect = document.getElementById('hasSpouse');
const spouseIncomeInput = document.getElementById('spouseIncome');

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
  renderCoverage();

  const prefectures = [...new Set(municipalities.map((m) => m.prefecture))];
  prefectureSelect.innerHTML =
    '<option value="" selected disabled hidden>選択してください</option>' +
    prefectures.map((p) => `<option value="${p}">${p}</option>`).join('');
  updateMunicipalityOptions();
  prefectureSelect.addEventListener('change', updateMunicipalityOptions);
  await renderPrefectureRateSection().catch((err) => {
    // 料率ファイルが未整備でも初期化全体を止めない
    console.error(err);
  });
}

/**
 * 対応済みの都道府県を、対応市区町村数の多い順にチップで表示する。
 * 表示内容は自治体データそのものから生成する（手書きの一覧を持たない）。
 */
function renderCoverage() {
  if (coverageMeterFill) {
    const ratio = (municipalities.length / totalMunicipalityCount) * 100;
    coverageMeterFill.style.width = `${Math.min(100, ratio).toFixed(1)}%`;
  }
  if (!coverageChips) return;

  const counts = new Map();
  for (const m of municipalities) {
    counts.set(m.prefecture, (counts.get(m.prefecture) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  coverageChips.innerHTML = sorted
    .map(([prefecture, count]) => `<span class="pref-chip">${prefecture}<em>（${count}）</em></span>`)
    .join('');
}

async function renderPrefectureRateSection() {
  const confirmedPrefectures = [];
  const seen = new Set();
  for (const m of municipalities) {
    if (m.kyokaiKenpoStatus === 'confirmed' && !seen.has(m.prefecture)) {
      seen.add(m.prefecture);
      confirmedPrefectures.push(m);
    }
  }
  if (confirmedPrefectures.length === 0) return;

  const withRates = await Promise.all(
    confirmedPrefectures.map(async (m) => {
      const rates = await fetchJson('./' + m.kyokaiKenpoRatesFile.replace(/^rates\//, 'src/data/rates/'));
      return { prefecture: m.prefecture, rates };
    })
  );
  withRates.sort((a, b) => b.rates.healthInsuranceRate - a.rates.healthInsuranceRate);

  prefRateTable.innerHTML = withRates
    .map(({ prefecture, rates }) => `
      <div class="pref-rate-row">
        <span class="pref-rate-name">${prefecture}</span>
        <span class="pref-rate-value">${(rates.healthInsuranceRate * 100).toFixed(2)}%</span>
      </div>
    `)
    .join('');
  prefRateSection.hidden = false;
}

function updateMunicipalityOptions() {
  const selectedPrefecture = prefectureSelect.value;
  if (!selectedPrefecture) {
    municipalitySelect.innerHTML = '<option value="" selected disabled hidden>先に都道府県を選択してください</option>';
    return;
  }
  const options = municipalities.filter((m) => m.prefecture === selectedPrefecture);
  municipalitySelect.innerHTML =
    '<option value="" selected disabled hidden>選択してください</option>' +
    options.map((m) => `<option value="${m.municipalityCode}">${m.municipality}</option>`).join('');
}

function getChildAgeInputs() {
  return Array.from(childrenAgesContainer.querySelectorAll('.child-age-input'));
}

/**
 * 子供の数に応じて年齢入力欄を1人ずつ生成し直す。
 * 人数を減らした場合は末尾の余分な欄を削除し、増やした場合は既存の入力値を保持したまま
 * 空欄を追加する(人数が同じ場合は何もしない)。
 */
function updateChildrenAgesFields() {
  const numberOfChildren = Number(numberOfChildrenSelect.value);

  if (numberOfChildren === 0) {
    childrenAgesContainer.innerHTML = '';
    childrenAgesField.hidden = true;
    return;
  }
  childrenAgesField.hidden = false;

  const existingValues = getChildAgeInputs().map((el) => el.value);

  childrenAgesContainer.innerHTML = '';
  for (let i = 0; i < numberOfChildren; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const label = document.createElement('label');
    label.setAttribute('for', `childAge-${i}`);
    label.textContent = `${i + 1}人目の年齢`;

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.id = `childAge-${i}`;
    input.className = 'child-age-input';
    input.placeholder = '例: 7';
    input.value = existingValues[i] ?? '';
    input.addEventListener('input', () => setFieldError(input, false));

    wrap.appendChild(label);
    wrap.appendChild(input);
    childrenAgesContainer.appendChild(wrap);
  }
}

function updateSpouseIncomeAvailability() {
  const hasSpouse = hasSpouseSelect.value === 'yes';
  spouseIncomeInput.disabled = !hasSpouse;
  if (!hasSpouse) spouseIncomeInput.value = '';
}

function getSelectedMunicipality() {
  const code = municipalitySelect.value;
  const found = municipalities.find((m) => m.municipalityCode === code);
  if (!found) throw new Error('市区町村が選択されていません。');
  return found;
}

/**
 * 全角数字(０-９)を半角に変換する。
 * @param {string} raw
 * @returns {string}
 */
function normalizeDigits(raw) {
  return raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * 「500万」のように数字以外の文字が混じった入力を、末尾の不正な文字が黙って
 * 切り捨てられた小さな数値として誤って受理しないよう、全角→半角変換後に
 * 数字のみで構成されているかを厳密にチェックする(0以上の整数のみを許可)。
 * 桁区切りのカンマ(半角・全角とも)は3桁ごとの位置を問わず除去してから判定する
 * (このアプリ自身が自動挿入するカンマは常に正しい位置に入るため、位置の妥当性
 * チェックまでは行わない)。
 * @param {string} raw
 * @returns {number|null} 不正な場合はnull
 */
function parseStrictInteger(raw) {
  const normalized = normalizeDigits(raw.trim()).replace(/[,、]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
}

/**
 * 半角数字のみの文字列に、3桁ごとの桁区切りカンマを挿入する。
 * @param {string} digitsOnly
 * @returns {string}
 */
function formatWithCommas(digitsOnly) {
  if (digitsOnly === '') return '';
  return digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 年収系の入力欄に、カーソル位置を保ったまま桁区切りカンマをリアルタイムで反映する。
 * 単純な文字数の差分でカーソルを補正するとカンマの増減でズレるため、
 * 「カーソルより前に数字が何個あったか」を基準に新しいカーソル位置を求める。
 * @param {HTMLInputElement} el
 */
function formatIncomeInputWithCommas(el) {
  const prevValue = el.value;
  const cursor = el.selectionStart ?? prevValue.length;
  const normalized = normalizeDigits(prevValue);

  // カンマ(全角の「、」含む)・数字以外の文字が混じっている場合、それを黙って除去して
  // 整形してしまうと「500万」のような不正な入力が気づかれないまま受理されてしまう
  // (type="number"の末尾切り捨てバグと同種の問題)。整形せず入力をそのまま残し、
  // 送信時のparseStrictInteger()による明示的なエラー表示に委ねる。
  if (/[^\d,、]/.test(normalized)) return;

  const digitsBeforeCursor = normalized.slice(0, cursor).replace(/\D/g, '').length;
  const allDigits = normalized.replace(/\D/g, '');
  const newValue = formatWithCommas(allDigits);

  let newCursor = 0;
  let digitsSeen = 0;
  while (newCursor < newValue.length && digitsSeen < digitsBeforeCursor) {
    if (/\d/.test(newValue[newCursor])) digitsSeen++;
    newCursor++;
  }

  el.value = newValue;
  el.setSelectionRange(newCursor, newCursor);
}

function setFieldError(el, hasError) {
  const wrap = el.closest('.field');
  if (wrap) wrap.classList.toggle('has-error', hasError);
}

function clearAllFieldErrors() {
  [annualIncomeInput, ageInput, spouseIncomeInput, prefectureSelect, municipalitySelect, ...getChildAgeInputs()].forEach(
    (el) => setFieldError(el, false)
  );
  formErrors.hidden = true;
  formErrors.innerHTML = '';
}

function showFormErrors(labels) {
  formErrors.innerHTML = `次の項目を確認してください：${labels.join('、')}`;
  formErrors.hidden = false;
}

/**
 * 送信前の入力チェック。問題があった項目を { el, label } の配列で返す(空配列なら問題なし)。
 * @param {'employee'|'freelance'} employmentType
 * @returns {{el: HTMLElement, label: string}[]}
 */
function validateForm(employmentType) {
  const errors = [];

  if (annualIncomeInput.value.trim() === '') {
    errors.push({ el: annualIncomeInput, label: '額面の年収' });
  } else {
    const v = parseStrictInteger(annualIncomeInput.value);
    if (v === null) {
      errors.push({ el: annualIncomeInput, label: '額面の年収（半角数字のみで入力してください。例: 5000000）' });
    } else if (employmentType === 'employee' && v < EMPLOYEE_MIN_ANNUAL_INCOME) {
      errors.push({
        el: annualIncomeInput,
        label: `額面の年収（会社員の場合、給与所得控除額(55万円)を下回る年収50万円未満は入力できません。実際にはありえない年収のためです。扶養内パート等の年収はそのまま入力してください）`
      });
    } else {
      annualIncomeInput.value = formatWithCommas(String(v));
    }
  }

  if (ageInput.value.trim() === '') {
    errors.push({ el: ageInput, label: '年齢' });
  } else {
    const v = parseStrictInteger(ageInput.value);
    if (v === null) {
      errors.push({ el: ageInput, label: '年齢（半角数字のみで入力してください。例: 38）' });
    } else if (v < 15 || v > 100) {
      errors.push({ el: ageInput, label: '年齢（15〜100の範囲で入力してください）' });
    } else {
      ageInput.value = String(v);
    }
  }

  if (!spouseIncomeInput.disabled && spouseIncomeInput.value.trim() !== '') {
    const v = parseStrictInteger(spouseIncomeInput.value);
    if (v === null) {
      errors.push({ el: spouseIncomeInput, label: '配偶者の年収（半角数字のみで入力してください。例: 3000000）' });
    } else {
      spouseIncomeInput.value = formatWithCommas(String(v));
    }
  }

  if (prefectureSelect.value === '') {
    errors.push({ el: prefectureSelect, label: '都道府県' });
  } else if (municipalitySelect.value === '') {
    errors.push({ el: municipalitySelect, label: '市区町村' });
  }

  getChildAgeInputs().forEach((el, i) => {
    const label = `${i + 1}人目の年齢`;
    if (el.value.trim() === '') {
      errors.push({ el, label });
      return;
    }
    const v = parseStrictInteger(el.value);
    if (v === null || v < 0 || v > 30) {
      errors.push({ el, label: `${label}（0〜30の半角数字で入力してください）` });
    } else {
      el.value = String(v);
    }
  });

  return errors;
}

/**
 * @param {'employee'|'freelance'} employmentType
 */
function readInput(employmentType) {
  const municipality = getSelectedMunicipality();
  const numberOfChildren = Number(document.getElementById('numberOfChildren').value);
  const childrenAges = getChildAgeInputs().map((el) => Number(el.value));
  const hasSpouse = document.getElementById('hasSpouse').value === 'yes';
  const spouseIncomeRaw = document.getElementById('spouseIncome').value.replace(/,/g, '');

  /** @type {import('../calc/types.js').SimpleInput} */
  const input = {
    age: Number(document.getElementById('age').value),
    prefectureCode: municipality.prefectureCode,
    municipalityCode: municipality.municipalityCode,
    numberOfChildren,
    childrenAges,
    employmentType,
    annualIncome: Number(document.getElementById('annualIncome').value.replace(/,/g, '')),
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
    dependentDeduction, residentTaxStandard, employeesPension, employmentInsurance,
    nationalPension, gradeArea
  ] = await Promise.all([
    fetchJson(RATES_BASE + 'income-tax-brackets.json'),
    fetchJson(RATES_BASE + 'salary-income-deduction.json'),
    fetchJson(RATES_BASE + 'basic-deduction.json'),
    fetchJson(RATES_BASE + 'spousal-deduction.json'),
    fetchJson(RATES_BASE + 'dependent-deduction.json'),
    fetchJson(RATES_BASE + 'resident-tax-standard.json'),
    fetchJson(RATES_BASE + 'employees-pension.json'),
    fetchJson(RATES_BASE + 'employment-insurance.json'),
    fetchJson(RATES_BASE + 'national-pension.json'),
    fetchJson(GRADE_AREA_URL)
  ]);

  let kyokaiKenpo = null;
  if (municipality.kyokaiKenpoStatus === 'confirmed') {
    kyokaiKenpo = await fetchJson('./' + municipality.kyokaiKenpoRatesFile.replace(/^rates\//, 'src/data/rates/'));
  }

  let nationalHealthInsurance = null;
  if (municipality.nationalHealthInsuranceStatus === 'confirmed') {
    nationalHealthInsurance = await fetchJson(
      './' + municipality.nationalHealthInsuranceFile.replace(/^rates\//, 'src/data/rates/')
    );
  }

  return {
    incomeTaxBrackets, salaryIncomeDeduction, basicDeduction, spousalDeduction,
    dependentDeduction, residentTaxStandard, employeesPension, employmentInsurance, kyokaiKenpo,
    nationalPension, nationalHealthInsurance, gradeArea
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

  const negativeTakeHomeWarning = result.takeHomeAnnual < 0
    ? `<div class="result-warning">⚠ 手取り額がマイナスになっています。入力した年収に対して税・社会保険料の合計が上回っており、通常は起こらない入力の組み合わせです。年収・年齢・配偶者の年収などの入力内容をご確認ください。</div>`
    : '';

  const netPct = pct(result.takeHomeAnnual);
  const shaPct = pct(result.socialInsurance.total);
  const juuPct = pct(result.residentTax.total);
  const s1 = netPct;
  const s2 = s1 + shaPct;
  const s3 = s2 + juuPct;
  const donutGradient = `conic-gradient(var(--c-net) 0 ${s1}%,var(--c-sha) ${s1}% ${s2}%,var(--c-juu) ${s2}% ${s3}%,var(--c-tax) ${s3}% 100%)`;
  const deductionTotal = result.incomeTax.total + result.residentTax.total + result.socialInsurance.total;

  resultBody.innerHTML = `
    ${negativeTakeHomeWarning}
    <div class="result-hero">
      <div class="cap">
        <span>毎月の手取り（12等分）</span>
        <span class="cond">${municipality.prefecture}${municipality.municipality}・${employmentLabel(employmentType)}・${input.age}歳</span>
      </div>
      <div class="takehome">
        <span class="v">${Math.round(result.takeHomeMonthly).toLocaleString('ja-JP')}</span><span class="u">円</span>
      </div>
      <div class="takehome-sub">
        <span>年間の手取り <b>${Math.round(result.takeHomeAnnual).toLocaleString('ja-JP')}</b> 円</span>
        <span>額面に対して <b>${netPct.toFixed(1)}</b> %</span>
      </div>
    </div>

    <div class="flow-label"><span>額面 ${formatYen(income)} の内訳</span><span>引かれた合計 <b>${formatYen(deductionTotal)}</b></span></div>
    <div class="flow">
      <div class="donut" style="background:${donutGradient}">
        <div class="donut-hole">
          <span class="p">${netPct.toFixed(1)}<i>%</i></span>
          <span class="t">が手取り</span>
        </div>
      </div>
      <div class="flow-legend">
        <div><i class="sw-net"></i><span>手取り</span><b>${formatYen(result.takeHomeAnnual)}</b></div>
        <div><i class="sw-sha"></i><span>社会保険料</span><b>${formatYen(result.socialInsurance.total)}</b></div>
        <div><i class="sw-juu"></i><span>住民税</span><b>${formatYen(result.residentTax.total)}</b></div>
        <div><i class="sw-tax"></i><span>所得税</span><b>${formatYen(result.incomeTax.total)}</b></div>
      </div>
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

function isEmploymentTypeAvailable(employmentType, municipality) {
  return employmentType === 'employee'
    ? municipality.kyokaiKenpoStatus === 'confirmed'
    : municipality.nationalHealthInsuranceStatus === 'confirmed';
}

function unavailableMessage(employmentType, municipality) {
  const dataName = employmentType === 'employee' ? '協会けんぽ料率' : '国民健康保険料';
  return `${municipality.prefecture}${municipality.municipality}の${dataName}はまだ整備できていません（データ未整備）。${employmentLabel(
    employmentType === 'employee' ? 'freelance' : 'employee'
  )}としての計算のみご利用いただけます。`;
}

async function handleSubmit(event) {
  event.preventDefault();
  clearAllFieldErrors();
  resultTitle.textContent = DEFAULT_RESULT_TITLE;

  const employmentType = selectedEmploymentType;
  const errors = validateForm(employmentType);
  if (errors.length > 0) {
    errors.forEach(({ el }) => setFieldError(el, true));
    showFormErrors(errors.map(({ label }) => label));
    errors[0].el.focus();
    return;
  }

  resultBody.innerHTML = '<div class="placeholder">計算中…</div>';
  try {
    const otherType = employmentType === 'employee' ? 'freelance' : 'employee';
    const { input, municipality } = readInput(employmentType);

    if (!isEmploymentTypeAvailable(employmentType, municipality)) {
      resultBody.innerHTML = `<div class="placeholder">${unavailableMessage(employmentType, municipality)}</div>`;
      return;
    }

    const rates = await loadRates(municipality);
    const result = calculateTakeHome(input, rates);
    const otherAvailable = isEmploymentTypeAvailable(otherType, municipality);
    const otherResult = otherAvailable ? calculateTakeHome({ ...input, employmentType: otherType }, rates) : null;
    renderResult(employmentType, input, municipality, result, otherResult);
  } catch (err) {
    resultBody.innerHTML = `<div class="placeholder" style="color:var(--red)">エラー: ${err.message}</div>`;
    console.error(err);
  }
}

form.addEventListener('submit', handleSubmit);
initEmploymentButtons();

numberOfChildrenSelect.addEventListener('change', updateChildrenAgesFields);
updateChildrenAgesFields();

hasSpouseSelect.addEventListener('change', updateSpouseIncomeAvailability);
updateSpouseIncomeAvailability();

[annualIncomeInput, spouseIncomeInput].forEach((el) => {
  el.addEventListener('input', () => {
    formatIncomeInputWithCommas(el);
    setFieldError(el, false);
  });
});
ageInput.addEventListener('input', () => setFieldError(ageInput, false));
[prefectureSelect, municipalitySelect].forEach((el) => {
  el.addEventListener('change', () => setFieldError(el, false));
});

initMunicipalities().catch((err) => {
  resultBody.innerHTML = `<div class="placeholder" style="color:var(--red)">自治体データの読み込みに失敗しました: ${err.message}</div>`;
  console.error(err);
});
