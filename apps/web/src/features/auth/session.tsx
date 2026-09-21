/**
 * ログイン状態の保持。
 *
 * Supabase Auth のセッションは localStorage に永続化され、トークンは自動更新される。
 * アプリ側で持つべきなのは「今ログインしているか」だけなので、Context は最小限にする。
 *
 * 認可（誰が何をできるか）はここではなく DB の RLS が持つ。
 * この Context は画面の出し分けに使うだけで、防御には使わない。
 */
import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { supabase } from '@/lib/supabase';

type SessionState = {
  session: Session | null;
  /** 初回のセッション復元が終わるまで true。未ログイン画面の一瞬のちらつきを防ぐために使う。 */
  loading: boolean;
};

const SessionContext = createContext<SessionState>({ session: null, loading: true });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ session: null, loading: true });

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) setState({ session: data.session, loading: false });
    });

    // ログアウトやトークン失効を他タブ含めて拾う。
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ session, loading: false });
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo(() => state, [state]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}
