/**
 * 発注推奨のデータ取得。
 *
 * DB からは実績（期間内の販売数と観測開始日）だけを取り、
 * 予測の計算は packages/core の純粋関数が行う。
 *
 * 予測式は運営者に説明する対象なので、DB も React も起動せずに
 * テストできる場所に置いておきたい、という Phase 1 からの方針による。
 */
import type { ReorderSettings, StockVelocityRow } from '@stockdesk/core';
import { collectReorderSuggestions, toStockDeskError } from '@stockdesk/core';
import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

const WINDOW_DAYS = 30;
const MIN_OBSERVATION_DAYS = 7;

export function useReorderSuggestions() {
  return useQuery({
    queryKey: queryKeys.reorder.list,
    queryFn: async () => {
      // 設定（リードタイム・カバー日数）と実績を同時に取る。
      const [settings, velocity] = await Promise.all([
        supabase.from('shop_settings').select('*').single(),
        supabase.rpc('stock_velocity', { p_window_days: WINDOW_DAYS }),
      ]);

      if (settings.error) throw toStockDeskError(settings.error);
      if (velocity.error) throw toStockDeskError(velocity.error);

      const reorderSettings: ReorderSettings = {
        windowDays: WINDOW_DAYS,
        defaultLeadTimeDays: settings.data.default_lead_time_days,
        coverDays: settings.data.default_cover_days,
        minObservationDays: MIN_OBSERVATION_DAYS,
      };

      const rows = (velocity.data ?? []) as unknown as StockVelocityRow[];

      return {
        settings: reorderSettings,
        suggestions: collectReorderSuggestions(rows, reorderSettings),
      };
    },
  });
}

/** 直近に送られた通知。設定画面で「通知が飛んでいるか」を確認できるようにする。 */
export function useRecentNotifications(limit = 10) {
  return useQuery({
    queryKey: queryKeys.notifications.list,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .order('sent_at', { ascending: false })
        .limit(limit);
      if (error) throw toStockDeskError(error);
      return data ?? [];
    },
  });
}
