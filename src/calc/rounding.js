// @ts-check

/**
 * 課税所得金額の端数処理(1,000円未満切り捨て)。所得税・住民税で共通のルール。
 * @param {number} amount
 * @returns {number}
 */
export function truncateTo1000(amount) {
  return Math.floor(Math.max(0, amount) / 1000) * 1000;
}

/**
 * 確定税額の端数処理(100円未満切り捨て)。国税通則法・地方税法上の一般的なルール。
 * @param {number} amount
 * @returns {number}
 */
export function truncateTo100(amount) {
  return Math.floor(Math.max(0, amount) / 100) * 100;
}

/**
 * 円未満切り捨て。
 * @param {number} amount
 * @returns {number}
 */
export function truncateYen(amount) {
  return Math.floor(amount);
}

/**
 * 社会保険料の被保険者負担分(表の折半額)の端数処理。
 * 給与から控除する場合のルール: 50銭以下切り捨て、50銭超は切り上げ。
 * (日本年金機構・協会けんぽの保険料額表の注記による)
 * @param {number} amount
 * @returns {number}
 */
export function roundPremiumHalf(amount) {
  const floor = Math.floor(amount);
  const fraction = amount - floor;
  return fraction <= 0.5 ? floor : floor + 1;
}
