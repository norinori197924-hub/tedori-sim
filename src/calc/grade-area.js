// @ts-check

/**
 * 生活保護法の級地区分(1級地-1〜3級地-2の6区分)の枝番付きコードから、
 * 地方税の実務慣行に合わせた上位3区分(1〜3)の数値を取り出す。
 * 告示の生データ("1-1"、"3-2"等)をそのままJSONに転記できるようにし、
 * 頭一桁への丸め処理はこの関数側で行う(転記時に人間が丸めると転記ミスの
 * 温床になるため)。
 * @param {string} rawCode 例: "1-1", "2-2", "3-1"
 * @returns {1|2|3}
 */
export function parseGradeAreaCode(rawCode) {
  const head = Number(String(rawCode).split('-')[0]);
  if (head !== 1 && head !== 2 && head !== 3) {
    throw new Error(`不正な級地区分コードです: ${rawCode}`);
  }
  return head;
}

/**
 * 市区町村の級地区分(1〜3級地)を、grade-area.jsonのマスタから解決する。
 * exceptionsに登録が無い市区町村はdefaultGrade(3級地)にフォールバックするが、
 * これは「3級地であることが確認された」わけではなく「未登録」であることを
 * gradeAreaStatusで区別して呼び出し元に伝える。1級地・2級地の自治体を
 * 未登録のまま3級地係数で計算すると、本来より低い非課税限度額を適用してしまい
 * (=過大課税側の誤差)、安全側の誤差ではないため、確定データと未登録データを
 * 同じ扱いにしてはならない。
 * @param {string} prefectureCode
 * @param {string} municipalityCode
 * @param {Object} gradeAreaData grade-area.jsonの内容
 * @returns {{ grade: 1|2|3, gradeAreaStatus: 'registered'|'unregistered' }}
 */
export function resolveGradeArea(prefectureCode, municipalityCode, gradeAreaData) {
  const prefEntry = gradeAreaData.prefectures[prefectureCode];
  const rawCode = prefEntry?.exceptions?.[municipalityCode];
  if (rawCode !== undefined) {
    return { grade: parseGradeAreaCode(rawCode), gradeAreaStatus: 'registered' };
  }
  return { grade: gradeAreaData.defaultGrade, gradeAreaStatus: 'unregistered' };
}
