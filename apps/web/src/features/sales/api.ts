/**
 * 売上集計のデータアクセス。
 *
 * 集計は DB のビューが行う。ここがやるのは期間の切り出しと、
 * 欠けている日を 0 で埋めた系列への変換（core の buildDailySeries）だけ。
 *
 * Phase 1 のダッシュボードのように全注文を取得して数えることはしない。
 * 30日ぶんの棒グラフを描くのに数百件の注文をブラウザへ運ぶ必要はない。
 */
import type { DailySalesRow, MonthlySalesRow, ProductSalesRow } from '@stockdesk/core';
import {
  buildDailySeries,
  buildMonthlySeries,
  lastNDateKeys,
  lastNMonthKeys,
  sumSalesPoints,
  toStockDeskError,
} from '@stockdesk/core';
import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

/**
 * 「今日」を JST の 'YYYY-MM-DD' で得る。
 *
 * DB のビューは JST で日付を切っている。ブラウザの時計が別のタイムゾーンでも
 * 同じ日付に揃わないと、期間の端が1日ずれる。
 */
export function todayInJst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function useDailySales(days: number) {
  return useQuery({
    queryKey: queryKeys.sales.daily(days),
    queryFn: async () => {
      const dateKeys = lastNDateKeys(todayInJst(), days);
      const from = dateKeys[0]!;
      const to = dateKeys[dateKeys.length - 1]!;

      // 期間で絞ってから取得する。ビューは全期間を集計するが、
      // 画面に運ぶのは表示する期間だけでよい。
      const { data, error } = await supabase
        .from('daily_sales')
        .select('*')
        .gte('sales_date', from)
        .lte('sales_date', to)
        .order('sales_date');

      if (error) throw toStockDeskError(error);

      const points = buildDailySeries((data ?? []) as DailySalesRow[], dateKeys);
      return { points, totals: sumSalesPoints(points) };
    },
  });
}

export function useMonthlySales(months: number) {
  return useQuery({
    queryKey: queryKeys.sales.monthly(months),
    queryFn: async () => {
      const monthKeys = lastNMonthKeys(todayInJst(), months);
      const from = monthKeys[0]!;
      const to = monthKeys[monthKeys.length - 1]!;

      const { data, error } = await supabase
        .from('monthly_sales')
        .select('*')
        .gte('month_start', from)
        .lte('month_start', to)
        .order('month_start');

      if (error) throw toStockDeskError(error);

      const points = buildMonthlySeries((data ?? []) as MonthlySalesRow[], monthKeys);
      return { points, totals: sumSalesPoints(points) };
    },
  });
}

/**
 * 商品別売上ランキング。
 *
 * 並べ替えを DB に任せるのは、上位20件だけを運べば足りるため。
 * 全件を取得してブラウザで sort すると、商品が増えたときに素直に遅くなる。
 */
export function useProductSales(limit = 20) {
  return useQuery({
    queryKey: queryKeys.sales.products,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('product_sales')
        .select('*')
        .order('amount', { ascending: false })
        .limit(limit);

      if (error) throw toStockDeskError(error);
      return (data ?? []) as ProductSalesRow[];
    },
  });
}
