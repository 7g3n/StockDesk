/**
 * 商品・在庫のデータアクセス。
 *
 * 画面から supabase を直接呼ばず、この層を挟む理由:
 *   - snake_case（DB）と camelCase（画面）の変換を一箇所に閉じる
 *   - 在庫を動かす操作のあとのキャッシュ無効化を書き忘れない
 *   - Phase 2 の CSV インポートなど、画面以外からも同じ入口を使えるようにする
 */
import type {
  ManualStockReason,
  ProductFormValues,
  ProductRow,
  StockMovementRow,
} from '@stockdesk/core';
import { toStockDeskError } from '@stockdesk/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys, stockAffectedQueryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

export type Product = ProductRow;

export type ProductFilters = {
  search?: string;
  /** 在庫アラート対象のみに絞る。ダッシュボードからの導線で使う。 */
  onlyAlerts?: boolean;
};

/** 画面のフォーム値を DB の列名に移す。ここ以外で列名を書かない。 */
function toProductRecord(values: ProductFormValues) {
  return {
    sku: values.sku,
    name: values.name,
    description: values.description,
    unit_price: values.unitPrice,
    cost_price: values.costPrice,
    low_stock_threshold: values.lowStockThreshold,
    status: values.status,
    lead_time_days: values.leadTimeDays,
  };
}

export function toProductFormValues(product: Product): ProductFormValues {
  return {
    sku: product.sku,
    name: product.name,
    description: product.description,
    unitPrice: product.unit_price,
    costPrice: product.cost_price,
    lowStockThreshold: product.low_stock_threshold,
    status: product.status,
    leadTimeDays: product.lead_time_days,
  };
}

async function fetchProducts(filters: ProductFilters): Promise<Product[]> {
  let query = supabase.from('products').select('*').order('sku');

  if (filters.search) {
    // SKU と商品名のどちらでも引けるようにする。運営者は品名で探すことも型番で探すこともある。
    const pattern = `%${filters.search}%`;
    query = query.or(`sku.ilike.${pattern},name.ilike.${pattern}`);
  }

  const { data, error } = await query;
  if (error) throw toStockDeskError(error);

  const products = data ?? [];
  if (!filters.onlyAlerts) return products;

  // 閾値との比較は列同士の比較になり PostgREST の filter では素直に書けないため、
  // 取得後に絞る。商品点数が数千を超えたらビュー（stock_alerts）を切る想定。
  return products.filter(
    (product) =>
      product.status === 'active' && product.stock_quantity <= product.low_stock_threshold,
  );
}

export function useProducts(filters: ProductFilters) {
  return useQuery({
    queryKey: queryKeys.products.list(filters),
    queryFn: () => fetchProducts(filters),
  });
}

export function useProduct(productId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.products.detail(productId ?? ''),
    enabled: Boolean(productId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('id', productId!)
        .single();
      if (error) throw toStockDeskError(error);
      return data;
    },
  });
}

export function useCreateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: ProductFormValues) => {
      const { data, error } = await supabase
        .from('products')
        .insert(toProductRecord(values))
        .select()
        .single();
      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products.all });
    },
  });
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: ProductFormValues }) => {
      // stock_quantity は意図的に含めない。在庫は台帳（adjust_stock）経由でしか動かさない。
      const { data, error } = await supabase
        .from('products')
        .update(toProductRecord(values))
        .eq('id', id)
        .select()
        .single();
      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}

export type StockAdjustmentInput = {
  productId: string;
  delta: number;
  reason: ManualStockReason;
  note: string;
};

/**
 * 在庫の手動調整。
 * RPC を呼ぶだけに見えるが、これが在庫を動かす唯一の経路であることが重要。
 * 更新後は在庫が映るすべての画面（商品・注文・ダッシュボード）を無効化する。
 */
export function useAdjustStock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StockAdjustmentInput) => {
      const { data, error } = await supabase.rpc('adjust_stock', {
        p_product_id: input.productId,
        p_delta: input.delta,
        p_reason: input.reason,
        p_note: input.note,
      });
      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      for (const key of stockAffectedQueryKeys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export type StockMovement = StockMovementRow;

/** 在庫の増減履歴。台帳をそのまま時系列で見せる（監査の入口）。 */
export function useStockMovements(productId: string | undefined, limit = 30) {
  return useQuery({
    queryKey: queryKeys.products.movements(productId ?? ''),
    enabled: Boolean(productId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('stock_movements')
        .select('*')
        .eq('product_id', productId!)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw toStockDeskError(error);
      return data ?? [];
    },
  });
}
