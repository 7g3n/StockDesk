import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/AppShell';
import { Card, LoadingBlock } from '@/components/ui';
import { LoginPage } from '@/features/auth/LoginPage';
import { CustomerDetailPage } from '@/features/customers/CustomerDetailPage';
import { CustomersPage } from '@/features/customers/CustomersPage';
import { ChannelsPage } from '@/features/channels/ChannelsPage';
import { DataPage } from '@/features/data/DataPage';
import { PrintPage } from '@/features/print/PrintPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { SessionProvider, useSession } from '@/features/auth/session';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { OrderDetailPage } from '@/features/orders/OrderDetailPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
import { ProductsPage } from '@/features/products/ProductsPage';
import { SalesPage } from '@/features/sales/SalesPage';
import { isSupabaseConfigured } from '@/lib/env';

import { SetupNotice } from './SetupNotice';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 在庫は他の端末の操作でも変わる。画面に戻ったときに古い数値を見せない。
      refetchOnWindowFocus: true,
      // 数秒の間に複数画面が同じデータを要求するのは普通なので、短い staleTime で往復を減らす。
      staleTime: 10_000,
      retry: 1,
    },
    mutations: {
      // 書き込みは自動リトライしない。二重登録のリスクの方が大きい。
      retry: 0,
    },
  },
});

/** 未ログインならログイン画面、確認中はスピナー。 */
function AuthenticatedRoutes() {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingBlock label="セッションを確認しています" />
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  return (
    <Routes>
      {/*
        帳票はナビゲーションの外に置く。
        印刷用のレイアウトは画面の枠（ヘッダー・余白）と両立しないため、
        AppShell の中に入れない。
      */}
      <Route path="/print/delivery-note" element={<PrintPage doc="delivery-note" />} />
      <Route path="/print/shipping-label" element={<PrintPage doc="shipping-label" />} />
      <Route path="*" element={<AppRoutes />} />
    </Routes>
  );
}

function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/orders/:orderId" element={<OrderDetailPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/customers/:customerId" element={<CustomerDetailPage />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/data" element={<DataPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export function App() {
  // 接続先が未設定なら、白い画面ではなく手順を出す。
  if (!isSupabaseConfigured) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
        <Card className="w-full max-w-2xl p-6">
          <SetupNotice />
        </Card>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <AuthenticatedRoutes />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
