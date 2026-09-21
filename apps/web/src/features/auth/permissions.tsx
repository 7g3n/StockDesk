/**
 * ログイン中のユーザーの役割と、それに基づく画面の出し分け。
 *
 * ここで行うのは体験の調整であって、防御ではない。
 * 「押しても失敗するボタンを描かない」ためのもので、
 * 実際に操作を止めているのは DB の RLS と RPC の権限確認。
 *
 * この区別を保つために、画面側で権限を判定した結果を
 * サーバーに送る（「権限があります」と申告する）ことは一切しない。
 */
import type { Permission, UserRole } from '@stockdesk/core';
import { can, toStockDeskError } from '@stockdesk/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { queryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

import { useSession } from './session';

/** 自分のプロフィール（役割を含む）。 */
export function useMyProfile() {
  const { session } = useSession();
  const userId = session?.user.id;

  return useQuery({
    queryKey: queryKeys.members.me(userId ?? ''),
    enabled: Boolean(userId),
    // 役割が変わるのは稀なので、画面を移るたびに取りに行かない。
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId!)
        .single();
      if (error) throw toStockDeskError(error);
      return data;
    },
  });
}

/**
 * 自分の役割。読み込み中は null を返す。
 *
 * null のあいだ can() は常に false を返すので、
 * 読み込み中に一瞬ボタンが出てから消える、という動きにはならない。
 */
export function useMyRole(): UserRole | null {
  const profile = useMyProfile();
  return profile.data?.role ?? null;
}

export function useCan(permission: Permission): boolean {
  return can(useMyRole(), permission);
}

/**
 * 権限がある場合だけ子要素を描く。
 *
 * fallback を指定すると、権限が無いときにそれを描く
 * （「閲覧のみの権限では変更できません」のような説明を出す用）。
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useCan(permission) ? <>{children}</> : <>{fallback}</>;
}
