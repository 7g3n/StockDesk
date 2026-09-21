/**
 * 注文のデータアクセス。
 *
 * 注文の作成とステータス変更は、どちらも通常のテーブル操作ではなく RPC を呼ぶ。
 * 在庫の増減と不可分に実行する必要があり、その保証はトランザクションでしか得られないため
 * （理由の詳細は supabase/migrations/..._functions.sql の冒頭コメント）。
 */
import type { OrderFormValues, OrderItemRow, OrderRow, OrderStatus } from '@stockdesk/core';
import { toStockDeskError } from '@stockdesk/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys, stockAffectedQueryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

export type Order = OrderRow;
export type OrderItem = OrderItemRow;
export type OrderWithItems = Order & { order_items: OrderItem[] };

export type OrderFilters = {
  status?: OrderStatus | 'all';
  search?: string;
};

async function fetchOrders(filters: OrderFilters): Promise<OrderWithItems[]> {
  // 一覧でも明細を取るのは、点数と代表商品名を出すため。
  // 注文あたりの明細は多くても数十行なので、件数分の追加クエリを避ける方が総合的に速い。
  let query = supabase
    .from('orders')
    .select('*, order_items(*)')
    .order('ordered_at', { ascending: false })
    .limit(100);

  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }

  if (filters.search) {
    const pattern = `%${filters.search}%`;
    query = query.or(`order_number.ilike.${pattern},customer_name.ilike.${pattern}`);
  }

  const { data, error } = await query;
  if (error) throw toStockDeskError(error);
  return (data ?? []) as OrderWithItems[];
}

export function useOrders(filters: OrderFilters) {
  return useQuery({
    queryKey: queryKeys.orders.list(filters),
    queryFn: () => fetchOrders(filters),
  });
}

export function useOrder(orderId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.orders.detail(orderId ?? ''),
    enabled: Boolean(orderId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*, order_items(*)')
        .eq('id', orderId!)
        .single();
      if (error) throw toStockDeskError(error);
      return data as OrderWithItems;
    },
  });
}

/**
 * 注文の作成。
 *
 * 明細をまとめて1回の RPC で送る。
 * 「注文ヘッダを作る → 明細を1行ずつ足す → 在庫を引く」と分割すると、
 * 途中で失敗したときに在庫だけ引かれた注文が残りうる。1往復にすればその状態は作れない。
 */
export function useCreateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: OrderFormValues) => {
      const { data, error } = await supabase.rpc('create_order', {
        p_customer_name: values.customerName,
        p_items: values.items.map((item) => ({
          product_id: item.productId,
          quantity: item.quantity,
        })),
        p_customer_id: values.customerId,
        p_customer_email: values.customerEmail,
        p_shipping_address: values.shippingAddress,
        p_shipping_fee: values.shippingFee,
        p_note: values.note,
      });
      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      // 注文が入れば在庫も変わる。在庫が映る画面をまとめて無効化する。
      for (const key of stockAffectedQueryKeys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/**
 * ステータス変更。
 *
 * 遷移の可否も在庫の戻しも DB 側が判断する。
 * 画面は「押せるボタンを出す」だけで、規則そのものは持たない。
 */
export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      orderId,
      nextStatus,
      note,
    }: {
      orderId: string;
      nextStatus: OrderStatus;
      note?: string;
    }) => {
      const { data, error } = await supabase.rpc('update_order_status', {
        p_order_id: orderId,
        p_next_status: nextStatus,
        p_note: note ?? '',
      });
      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      // キャンセルでは在庫が戻るため、注文だけでなく在庫関連もすべて無効化する。
      for (const key of stockAffectedQueryKeys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}
