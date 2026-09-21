/**
 * 販売チャネルと、モール連携（モック）。
 *
 * 実 API ではないが、境界は本番と同じにしてある。
 * モックが作るのは「外部から受け取った注文データ」までで、
 * そこから先は CSV 取り込みとまったく同じ経路（import_orders RPC）を通る。
 *
 * 実 API に差し替えるとき変わるのは fetchChannelOrders の中身だけで、
 * 冪等性・在庫の引き当て・顧客の名寄せは一切変わらない。
 */
import type { ImportOrder, SalesChannelRow } from '@stockdesk/core';
import { generateMockChannelOrders, toStockDeskError } from '@stockdesk/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys, stockAffectedQueryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

import { todayInJst } from '../sales/api';

export type SalesChannel = SalesChannelRow;

export function useSalesChannels() {
  return useQuery({
    queryKey: queryKeys.channels.list,
    queryFn: async () => {
      const { data, error } = await supabase.from('sales_channels').select('*').order('sort_order');
      if (error) throw toStockDeskError(error);
      return data ?? [];
    },
  });
}

export function useToggleChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, isActive }: { code: string; isActive: boolean }) => {
      const { data, error } = await supabase
        .from('sales_channels')
        .update({ is_active: isActive })
        .eq('code', code)
        // RLS で弾かれた UPDATE は 0 行更新として返るため、
        // select().single() を付けて「変わっていないのに成功扱い」を防ぐ。
        .select()
        .single();
      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels.all });
    },
  });
}

/**
 * チャネルから注文を取得する（モック）。
 *
 * 実 API 連携ではここが HTTP の呼び出しになる。
 * 戻り値の形（ImportOrder[]）は変えないので、呼び出し側は影響を受けない。
 *
 * 取り扱い中の商品の SKU を渡すのは、外部モールにも同じ商品を出している、
 * という前提を模すため。
 */
async function fetchChannelOrders(channel: SalesChannel, count: number): Promise<ImportOrder[]> {
  const { data, error } = await supabase
    .from('products')
    .select('sku')
    .eq('status', 'active')
    .order('sku');

  if (error) throw toStockDeskError(error);

  return generateMockChannelOrders({
    channelCode: channel.code,
    orderPrefix: channel.order_prefix,
    skus: (data ?? []).map((product) => product.sku),
    date: todayInJst(),
    count,
  });
}

export type ChannelSyncResult = {
  created: number;
  skipped: number;
  order_numbers: string[];
};

/**
 * チャネルの同期。
 *
 * 取得したデータをそのまま import_orders に渡す。
 * 同じ日に2回同期しても、生成される external_order_id が同じなので
 * 2回目は「取り込み済み」として飛ばされる。
 * 実 API のポーリングでも同じ注文を繰り返し受け取るので、
 * この冪等性が連携の前提になる。
 */
export function useSyncChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ channel, count }: { channel: SalesChannel; count: number }) => {
      const orders = await fetchChannelOrders(channel, count);

      if (orders.length === 0) {
        return { created: 0, skipped: 0, order_numbers: [] } satisfies ChannelSyncResult;
      }

      const { data, error } = await supabase.rpc('import_orders', {
        p_orders: orders.map((order) => ({
          external_order_id: order.externalOrderId,
          ordered_at: order.orderedAt,
          customer_name: order.customerName,
          customer_email: order.customerEmail,
          phone: order.phone,
          postal_code: order.postalCode,
          address: order.address,
          shipping_fee: order.shippingFee,
          note: order.note,
          channel: order.channel,
          items: order.items.map((item) => ({
            sku: item.sku,
            quantity: item.quantity,
            unit_price: item.unitPrice,
          })),
        })),
      });

      if (error) throw toStockDeskError(error);
      return data as unknown as ChannelSyncResult;
    },
    onSuccess: () => {
      for (const key of stockAffectedQueryKeys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/** チャネル別の注文件数。連携が効いているかを一覧で見せる。 */
export function useChannelOrderCounts() {
  return useQuery({
    queryKey: [...queryKeys.channels.all, 'counts'],
    queryFn: async () => {
      const { data, error } = await supabase.from('orders').select('channel');
      if (error) throw toStockDeskError(error);

      const counts = new Map<string, number>();
      for (const row of data ?? []) {
        counts.set(row.channel, (counts.get(row.channel) ?? 0) + 1);
      }
      return counts;
    },
  });
}
