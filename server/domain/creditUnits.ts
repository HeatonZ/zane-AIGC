/**
 * 积分金额精度：内部一律用「厘」整数（1 分 = 100 厘），只在对外边界换算成两位小数。
 *
 * 直接对 0.05 这类分数做乘加会出现 0.15000000000000002、0.30000000000000004 这类尾数：
 * 账本、余额、结算与展示都不能接受。因此所有金额运算先转到整数厘域，再在边界转回分；
 * `fromUnits` 的除法结果始终落在两位小数上，不会把整数除法产生的尾数带出去。
 */
export const CREDIT_UNITS_PER_POINT = 100;

/** 分 → 厘：四舍五入到整数厘。 */
export function toUnits(points: number): number {
  if (!Number.isFinite(points)) throw new Error("积分金额必须是有限数字");
  return Math.round(points * CREDIT_UNITS_PER_POINT);
}

/** 厘 → 分：先归整到整数厘，再除以 100，结果最多两位小数。 */
export function fromUnits(units: number): number {
  if (!Number.isFinite(units)) throw new Error("积分金额必须是有限数字");
  return Math.round(units) / CREDIT_UNITS_PER_POINT;
}

/** 把任意来源（含历史快照里的浮点尾数）归一到两位小数。 */
export function normalizePoints(points: number): number {
  return fromUnits(toUnits(points));
}

/**
 * 是否最多两位小数。判据是「乘 100 后离整数不超过浮点噪声」，而不是
 * `round(v*100) === Number((v*100).toFixed(0))`：后者会把 0.145（14.4999…→14）和
 * 1.005（100.4999…→100）当成合法值，随后被静默截断成另一个价格。
 * 容差 1e-6 远小于最小计价单位 0.01，只吸收 0.1+0.2 这类二进制尾数。
 */
export function hasAtMostTwoDecimals(points: number): boolean {
  if (!Number.isFinite(points)) return false;
  const scaled = points * CREDIT_UNITS_PER_POINT;
  return Math.abs(scaled - Math.round(scaled)) <= 1e-6;
}

/** 对外展示用：固定两位小数并去掉多余的 0（0.05 / 12 / 12.5）。 */
export function formatPoints(points: number): string {
  return normalizePoints(points).toFixed(2).replace(/\.?0+$/, "");
}
