/**
 * TanStack Query のキーを一箇所に集める。
 *
 * 在庫は「商品一覧」「注文詳細」「ダッシュボード」の3画面に同時に現れる。
 * 注文を1件作れば、その3つすべてが古くなる。
 * キーを文字列リテラルで各所に散らすと、どこかの無効化を書き忘れて
 * 「一覧だけ古い在庫数を表示し続ける」が起きるため、キーと依存関係をここで管理する。
 */
export const queryKeys = {
  products: {
    all: ['products'] as const,
    list: (filters: { search?: string; onlyAlerts?: boolean }) =>
      ['products', 'list', filters] as const,
    detail: (id: string) => ['products', 'detail', id] as const,
    movements: (id: string) => ['products', 'movements', id] as const,
  },
  orders: {
    all: ['orders'] as const,
    list: (filters: { status?: string; search?: string; channel?: string }) =>
      ['orders', 'list', filters] as const,
    detail: (id: string) => ['orders', 'detail', id] as const,
  },
  customers: {
    all: ['customers'] as const,
    list: (filters: { search?: string; sort?: string }) => ['customers', 'list', filters] as const,
    detail: (id: string) => ['customers', 'detail', id] as const,
    orders: (id: string) => ['customers', 'orders', id] as const,
    options: ['customers', 'options'] as const,
  },
  sales: {
    all: ['sales'] as const,
    daily: (days: number) => ['sales', 'daily', days] as const,
    monthly: (months: number) => ['sales', 'monthly', months] as const,
    products: ['sales', 'products'] as const,
  },
  members: {
    all: ['members'] as const,
    list: ['members', 'list'] as const,
    me: (userId: string) => ['members', 'me', userId] as const,
  },
  settings: {
    all: ['settings'] as const,
    shop: ['settings', 'shop'] as const,
  },
  channels: {
    all: ['channels'] as const,
    list: ['channels', 'list'] as const,
  },
  dashboard: {
    all: ['dashboard'] as const,
    summary: ['dashboard', 'summary'] as const,
    alerts: ['dashboard', 'alerts'] as const,
  },
} as const;

/**
 * 在庫が動く操作のあとに無効化すべきキー群。
 *
 * 注文作成・ステータス変更・在庫調整はすべて在庫を動かしうるので、
 * 個別に書かずこの一覧を使う。
 */
export const stockAffectedQueryKeys = [
  queryKeys.products.all,
  queryKeys.orders.all,
  queryKeys.dashboard.all,
  // 注文が動けば売上集計と顧客の累計も変わる（Phase 2）。
  queryKeys.sales.all,
  queryKeys.customers.all,
] as const;
