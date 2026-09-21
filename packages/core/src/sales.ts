/**
 * 売上集計の型と、表示のための整形。
 *
 * 集計そのものは DB のビュー（daily_sales / monthly_sales / product_sales）が行う。
 * Phase 1 ではクライアント側で集計していたが、売上推移は全注文を取得しないと
 * 描けないため、docs/decisions.md に書いた「判断が変わる条件」に到達した。
 *
 * このモジュールが担うのは、集計結果を「グラフに載せられる形」にすることだけ。
 */

export type DailySalesRow = {
  sales_date: string;
  order_count: number;
  total_amount: number;
  shipping_amount: number;
  item_amount: number;
};

export type MonthlySalesRow = {
  month_start: string;
  order_count: number;
  total_amount: number;
  shipping_amount: number;
  item_amount: number;
};

export type ProductSalesRow = {
  sku: string;
  product_name: string;
  product_id: string | null;
  quantity: number;
  amount: number;
  order_count: number;
  last_ordered_at: string | null;
};

export type SalesPoint = {
  /** 'YYYY-MM-DD'。日別はその日、月別は月初。 */
  key: string;
  /** グラフの軸に出す短いラベル。 */
  label: string;
  orderCount: number;
  totalAmount: number;
  itemAmount: number;
  shippingAmount: number;
};

const EMPTY_POINT = {
  orderCount: 0,
  totalAmount: 0,
  itemAmount: 0,
  shippingAmount: 0,
} as const;

/** 'YYYY-MM-DD' を作る。Date の getMonth() の 0 始まりを外に漏らさない。 */
function toDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 直近 n 日分の日付キー（古い順）。
 *
 * 基準日を引数に取るのは、テストで「今日」に依存しないようにするため。
 * 日付の計算は UTC で行い、JST への変換は呼び出し側（DB のビュー）が済ませている前提。
 * ここで扱う 'YYYY-MM-DD' は既に JST で切られた日付。
 */
export function lastNDateKeys(endDateKey: string, days: number): string[] {
  const end = new Date(`${endDateKey}T00:00:00Z`);
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - offset);
    keys.push(toDateKey(date));
  }
  return keys;
}

/** 直近 n ヶ月分の月初キー（古い順）。 */
export function lastNMonthKeys(endMonthKey: string, months: number): string[] {
  const end = new Date(`${endMonthKey.slice(0, 7)}-01T00:00:00Z`);
  const keys: string[] = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setUTCMonth(date.getUTCMonth() - offset);
    keys.push(toDateKey(date));
  }
  return keys;
}

/**
 * 集計結果を、欠けている期間を 0 で埋めた連続した系列にする。
 *
 * これをやらないと、売上が無かった日がグラフから消えて詰められ、
 * 「毎日売れている」ように見えてしまう。推移を見るためのグラフで
 * 最も誤解を招く壊れ方なので、期間の側を正としてデータを当てはめる。
 */
export function buildDailySeries(
  rows: readonly DailySalesRow[],
  dateKeys: readonly string[],
): SalesPoint[] {
  const byDate = new Map(rows.map((row) => [row.sales_date.slice(0, 10), row]));

  return dateKeys.map((key) => {
    const row = byDate.get(key);
    return {
      key,
      // 軸は「9/1」の形。年は期間の見出しに出すので軸では省く。
      label: `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`,
      ...(row
        ? {
            orderCount: row.order_count,
            totalAmount: row.total_amount,
            itemAmount: row.item_amount,
            shippingAmount: row.shipping_amount,
          }
        : EMPTY_POINT),
    };
  });
}

export function buildMonthlySeries(
  rows: readonly MonthlySalesRow[],
  monthKeys: readonly string[],
): SalesPoint[] {
  const byMonth = new Map(rows.map((row) => [row.month_start.slice(0, 10), row]));

  return monthKeys.map((key) => {
    const row = byMonth.get(key);
    return {
      key,
      label: `${Number(key.slice(5, 7))}月`,
      ...(row
        ? {
            orderCount: row.order_count,
            totalAmount: row.total_amount,
            itemAmount: row.item_amount,
            shippingAmount: row.shipping_amount,
          }
        : EMPTY_POINT),
    };
  });
}

export type SalesTotals = {
  orderCount: number;
  totalAmount: number;
  itemAmount: number;
  shippingAmount: number;
  /** 平均注文単価。注文が無い期間は 0（0 除算を呼び出し側に漏らさない）。 */
  averageOrderValue: number;
};

export function sumSalesPoints(points: readonly SalesPoint[]): SalesTotals {
  const totals = points.reduce(
    (accumulator, point) => ({
      orderCount: accumulator.orderCount + point.orderCount,
      totalAmount: accumulator.totalAmount + point.totalAmount,
      itemAmount: accumulator.itemAmount + point.itemAmount,
      shippingAmount: accumulator.shippingAmount + point.shippingAmount,
    }),
    { orderCount: 0, totalAmount: 0, itemAmount: 0, shippingAmount: 0 },
  );

  return {
    ...totals,
    averageOrderValue:
      totals.orderCount === 0 ? 0 : Math.round(totals.totalAmount / totals.orderCount),
  };
}

/**
 * グラフの縦軸の上限。
 *
 * 最大値をそのまま上限にすると、一番高い棒が天井に貼り付いて読みにくい。
 * 1 / 2 / 5 × 10^n のきりのよい値まで切り上げる。
 * すべて 0 のときは 1 を返す（0 で割らないため）。
 */
export function niceAxisMax(maxValue: number): number {
  if (maxValue <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(maxValue));
  const normalized = maxValue / magnitude;

  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}
