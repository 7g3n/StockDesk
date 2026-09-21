/**
 * 帳票に必要なデータの取得。
 *
 * 複数の注文をまとめて刷る（出荷準備中を一括でラベル印刷する）のが実際の運用なので、
 * 注文 ID の配列で取る。1件ずつ取ると、20件刷るのに20往復になる。
 */
import { toStockDeskError } from '@stockdesk/core';
import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

import type { OrderWithItems } from '../orders/api';

export function usePrintableOrders(orderIds: string[]) {
  return useQuery({
    queryKey: ['print', 'orders', orderIds],
    enabled: orderIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*, order_items(*)')
        .in('id', orderIds)
        .order('order_number');
      if (error) throw toStockDeskError(error);
      return (data ?? []) as OrderWithItems[];
    },
  });
}

export function useShopSettingsForPrint() {
  return useQuery({
    queryKey: ['print', 'shop'],
    queryFn: async () => {
      const { data, error } = await supabase.from('shop_settings').select('*').single();
      if (error) throw toStockDeskError(error);
      return data;
    },
  });
}

/** URL の ?ids=a,b,c を配列にする。 */
export function parseOrderIds(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
