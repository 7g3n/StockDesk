/**
 * メンバーと店舗設定のデータアクセス。
 */
import type { ProfileRow, ShopSettingsRow, UserRole } from '@stockdesk/core';
import { toStockDeskError } from '@stockdesk/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

export type Member = ProfileRow;
export type ShopSettings = ShopSettingsRow;

export function useMembers() {
  return useQuery({
    queryKey: queryKeys.members.list,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('role')
        .order('display_name');
      if (error) throw toStockDeskError(error);
      return data ?? [];
    },
  });
}

/**
 * 役割の変更。
 *
 * profiles を直接 UPDATE しないのは、role 列が列単位の GRANT で
 * 更新を禁止されているため（staff が自分を owner に昇格できないようにしている）。
 * 変更は set_member_role RPC のみが行う。最後の管理者を降格させない判定も
 * その中にある。
 */
export function useSetMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: UserRole }) => {
      const { data, error } = await supabase.rpc('set_member_role', {
        p_user_id: userId,
        p_role: role,
      });
      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members.all });
    },
  });
}

export function useShopSettings() {
  return useQuery({
    queryKey: queryKeys.settings.shop,
    queryFn: async () => {
      const { data, error } = await supabase.from('shop_settings').select('*').single();
      if (error) throw toStockDeskError(error);
      return data;
    },
  });
}

export type ShopSettingsInput = {
  shopName: string;
  postalCode: string;
  address: string;
  phone: string;
  email: string;
  note: string;
  // 発注推奨と通知の設定（Phase 4）
  defaultLeadTimeDays: number;
  defaultCoverDays: number;
  largeOrderThreshold: number;
};

export function useUpdateShopSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: ShopSettingsInput) => {
      const { data, error } = await supabase
        .from('shop_settings')
        .update({
          shop_name: values.shopName,
          postal_code: values.postalCode,
          address: values.address,
          phone: values.phone,
          email: values.email,
          note: values.note,
          default_lead_time_days: values.defaultLeadTimeDays,
          default_cover_days: values.defaultCoverDays,
          large_order_threshold: values.largeOrderThreshold,
        })
        .eq('id', true)
        // .select().single() を付けているのは、RLS で弾かれた UPDATE が
        // エラーではなく「0行更新」として返るため。
        // 付けないと、権限が無いのに「保存しました」と表示してしまう。
        .select()
        .single();

      if (error) throw toStockDeskError(error);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}
