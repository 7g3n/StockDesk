/**
 * 金額の扱い。
 *
 * 金額は一貫して integer（円）で持つ。JPY に小数単位が無いこと、
 * および浮動小数の丸め誤差を集計で踏まないことが理由。
 * 将来 USD などを扱う場合は「最小単位の整数（セント）」に読み替えれば構造は変わらない。
 *
 * このモジュールは金額を扱う計算を一箇所に集め、画面ごとに掛け算の順序が違う、
 * といったズレが生まれないようにするためのもの。
 */

export type OrderLine = {
  unitPrice: number;
  quantity: number;
};

/** 明細1行の小計。DB では order_items.subtotal が生成列として同じ計算をしている。 */
export function lineSubtotal(line: OrderLine): number {
  return line.unitPrice * line.quantity;
}

export function sumSubtotals(lines: readonly OrderLine[]): number {
  return lines.reduce((total, line) => total + lineSubtotal(line), 0);
}

/** 注文合計 = 明細合計 + 送料。税は Phase 2 の売上集計と合わせて内税/外税を決める。 */
export function calcOrderTotal(lines: readonly OrderLine[], shippingFee = 0): number {
  return sumSubtotals(lines) + shippingFee;
}

const JPY_FORMATTER = new Intl.NumberFormat('ja-JP', {
  style: 'currency',
  currency: 'JPY',
  maximumFractionDigits: 0,
});

export function formatJpy(amount: number): string {
  return JPY_FORMATTER.format(amount);
}

const NUMBER_FORMATTER = new Intl.NumberFormat('ja-JP');

export function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}
