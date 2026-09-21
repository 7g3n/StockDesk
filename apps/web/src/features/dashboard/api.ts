/**
 * ダッシュボードの集計。
 *
 * Phase 1 では商品と直近注文を取得してクライアント側で集計する。
 * 小規模ショップ（商品数百点・注文数百件/月）の規模では往復1回で十分収まり、
 * 集計用のビューやマテリアライズドビューを先に作るのは早すぎる最適化になるため。
 *
 * Phase 2 で売上推移（日別・月別）を扱う段階で、集計は DB 側のビューに移す。
 * その判断の分岐点は「表示のために全件を取らなければならなくなったとき」。
 */
import type { AlertableProduct, ProductRow } from '@stockdesk/core';
import { collectStockAlerts, isOpenStatus, toStockDeskError } from '@stockdesk/core';
import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

export type DashboardProduct = AlertableProduct & { row: ProductRow };

function toAlertable(product: ProductRow): DashboardProduct {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    stockQuantity: product.stock_quantity,
    lowStockThreshold: product.low_stock_threshold,
    row: product,
  };
}

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard.summary,
    queryFn: async () => {
      // 取り扱い終了の商品はアラート対象にしない（発注する必要がないため）。
      const productsQuery = supabase.from('products').select('*').eq('status', 'active');
      const ordersQuery = supabase
        .from('orders')
        .select('*')
        .order('ordered_at', { ascending: false })
        .limit(50);

      const [products, orders] = await Promise.all([productsQuery, ordersQuery]);
      if (products.error) throw toStockDeskError(products.error);
      if (orders.error) throw toStockDeskError(orders.error);

      const productRows = products.data ?? [];
      const orderRows = orders.data ?? [];

      const alerts = collectStockAlerts(productRows.map(toAlertable));

      const openOrders = orderRows.filter((order) => isOpenStatus(order.status));

      // 在庫の評価額は原価ベース。売価ベースは「まだ売れていない金額」なので、
      // 資産としての在庫を見るなら原価で見るのが実態に近い。
      const inventoryValue = productRows.reduce(
        (sum, product) => sum + product.cost_price * product.stock_quantity,
        0,
      );

      return {
        alerts,
        openOrderCount: openOrders.length,
        pendingCount: orderRows.filter((order) => order.status === 'pending').length,
        outOfStockCount: alerts.filter((alert) => alert.level === 'out_of_stock').length,
        lowStockCount: alerts.filter((alert) => alert.level === 'low').length,
        inventoryValue,
        activeProductCount: productRows.length,
        recentOrders: orderRows.slice(0, 8),
      };
    },
  });
}
