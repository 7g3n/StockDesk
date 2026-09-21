/**
 * 顧客のデータアクセス。
 *
 * 一覧には customers テーブルではなく customer_summary ビューを使う。
 * 「この顧客は何回買って、いくら使ったか」は一覧で最初に知りたい情報で、
 * それを出すためだけに全注文を取得するのは Phase 1 で避けると決めた形。
 */
import type { CustomerFormValues, CustomerRow, CustomerSummaryView } from '@stockdesk/core';
import { toStockDeskError } from '@stockdesk/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

export type Customer = CustomerRow;
export type CustomerSummary = CustomerSummaryView;

function toCustomerRecord(values: CustomerFormValues) {
  return {
    name: values.name,
    // 空文字ではなく NULL で保存する。
    // 空文字のままだと lower(email) の一意索引に複数行が乗ってしまい、
    // 「メール未登録の顧客は1人しか作れない」という妙な制約になる。
    email: values.email === '' ? null : values.email,
    phone: values.phone,
    postal_code: values.postalCode,
    address: values.address,
    note: values.note,
  };
}

export function toCustomerFormValues(customer: Customer): CustomerFormValues {
  return {
    name: customer.name,
    email: customer.email ?? '',
    phone: customer.phone,
    postalCode: customer.postal_code,
    address: customer.address,
    note: customer.note,
  };
}

export type CustomerSort = 'total_amount' | 'last_ordered_at' | 'name';

export function useCustomerSummaries(filters: { search?: string; sort?: CustomerSort }) {
  return useQuery({
    queryKey: queryKeys.customers.list(filters),
    queryFn: async () => {
      let query = supabase.from('customer_summary').select('*');

      if (filters.search) {
        const pattern = `%${filters.search}%`;
        query = query.or(`name.ilike.${pattern},email.ilike.${pattern}`);
      }

      const sort = filters.sort ?? 'total_amount';
      query = query.order(sort, {
        ascending: sort === 'name',
        // 注文が無い顧客（NULL）は末尾に置く。上位に並ぶと一覧の意味が薄れる。
        nullsFirst: false,
      });

      const { data, error } = await query.limit(200);
      if (error) throw toStockDeskError(error);
      return data ?? [];
    },
  });
}

export function useCustomer(customerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.customers.detail(customerId ?? ''),
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .eq('id', customerId!)
        .single();
      if (error) throw toStockDeskError(error);
      return data;
    },
  });
}

/** 顧客の注文履歴。顧客詳細で「何をいつ買ったか」を見せる。 */
export function useCustomerOrders(customerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.customers.orders(customerId ?? ''),
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*, order_items(*)')
        .eq('customer_id', customerId!)
        .order('ordered_at', { ascending: false });
      if (error) throw toStockDeskError(error);
      return data ?? [];
    },
  });
}

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: CustomerFormValues) => {
      const { data, error } = await supabase
        .from('customers')
        .insert(toCustomerRecord(values))
        .select()
        .single();
      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
    },
  });
}

export function useUpdateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: CustomerFormValues }) => {
      const { data, error } = await supabase
        .from('customers')
        .update(toCustomerRecord(values))
        .eq('id', id)
        .select()
        .single();
      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
      // 注文一覧には顧客名のスナップショットが出るため、そちらは変わらない。
      // それでも詳細画面の紐付けは変わりうるので注文側も無効化する。
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });
    },
  });
}

/** 注文登録フォームで既存顧客を選ぶための軽い一覧。 */
export function useCustomerOptions() {
  return useQuery({
    queryKey: queryKeys.customers.options,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('id, name, email, address')
        .order('name')
        .limit(500);
      if (error) throw toStockDeskError(error);
      return data ?? [];
    },
  });
}
