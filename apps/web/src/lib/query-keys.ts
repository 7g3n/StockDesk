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
    list: (filters: { status?: string; search?: string }) => ['orders', 'list', filters] as const,
    detail: (id: string) => ['orders', 'detail', id] as const,
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
] as const;
