import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { useSession } from '@/features/auth/session';
import { supabase } from '@/lib/supabase';

import { Button, cn } from './ui';

/**
 * 全画面共通の枠。
 *
 * 左にナビ、右に内容という配置は、項目が増えても崩れず、
 * 「今どこにいるか」が常に見えることを優先した結果。
 * Phase 2 以降で顧客・売上・設定が増える前提で、縦に伸ばせる形にしてある。
 */
const NAV_ITEMS = [
  { to: '/', label: 'ダッシュボード', end: true },
  { to: '/products', label: '商品・在庫', end: false },
  { to: '/orders', label: '注文', end: false },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const location = useLocation();

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-8">
            <span className="text-base font-bold tracking-tight text-slate-900">StockDesk</span>
            <nav className="flex items-center gap-1" aria-label="主要メニュー">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'rounded-md px-3 py-1.5 text-sm font-medium transition',
                      isActive
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:inline">{session?.user.email}</span>
            <Button size="sm" variant="ghost" onClick={() => void supabase.auth.signOut()}>
              ログアウト
            </Button>
          </div>
        </div>
      </header>

      {/* key にパスを渡し、画面遷移で内容が入れ替わったことをスクロール位置の面でも明確にする */}
      <main key={location.pathname} className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}
