import { formatJpy, formatNumber, toDisplayMessage } from '@stockdesk/core';
import { Link } from 'react-router-dom';

import { PageHeader } from '@/components/AppShell';
import { OrderStatusBadge, StockLevelBadge } from '@/components/badges';
import { Card, CardHeader, EmptyState, ErrorBlock, LoadingBlock, Td, Th } from '@/components/ui';

import { useDashboard } from './api';

function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  to,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger';
  to?: string;
}) {
  const toneClass =
    tone === 'danger' ? 'text-red-700' : tone === 'warning' ? 'text-amber-700' : 'text-slate-900';

  const content = (
    <Card className="p-4 transition hover:ring-slate-300">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`tabular mt-1 text-2xl font-bold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </Card>
  );

  return to ? <Link to={to}>{content}</Link> : content;
}

/**
 * ダッシュボード。
 *
 * 出す情報は「今すぐ手を打つべきこと」に絞る。
 * 売上のグラフは Phase 2 で足すが、Phase 1 の主役は在庫アラートと対応待ちの注文で、
 * この2つが埋もれないように最上段に置いている。
 */
export function DashboardPage() {
  const dashboard = useDashboard();

  if (dashboard.isPending) {
    return (
      <Card>
        <LoadingBlock />
      </Card>
    );
  }

  if (dashboard.isError) {
    return (
      <Card>
        <ErrorBlock message={toDisplayMessage(dashboard.error)} />
      </Card>
    );
  }

  const data = dashboard.data;

  return (
    <>
      <PageHeader title="ダッシュボード" description="在庫と注文の、今日の状況です。" />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="在庫切れ"
          value={`${formatNumber(data.outOfStockCount)} 件`}
          hint="販売を止める必要があります"
          tone={data.outOfStockCount > 0 ? 'danger' : 'default'}
          to="/products?alerts=1"
        />
        <StatCard
          label="残りわずか"
          value={`${formatNumber(data.lowStockCount)} 件`}
          hint="発注を検討してください"
          tone={data.lowStockCount > 0 ? 'warning' : 'default'}
          to="/products?alerts=1"
        />
        <StatCard
          label="対応待ちの注文"
          value={`${formatNumber(data.openOrderCount)} 件`}
          hint={`うち未着手 ${formatNumber(data.pendingCount)} 件`}
          to="/orders?status=pending"
        />
        <StatCard
          label="在庫評価額"
          value={formatJpy(data.inventoryValue)}
          hint={`取り扱い中 ${formatNumber(data.activeProductCount)} 商品・原価ベース`}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <CardHeader
              title="在庫アラート"
              description="在庫切れを先に、次に不足の大きいものから並べています。"
              action={
                <Link to="/products?alerts=1" className="text-xs text-brand-600 hover:underline">
                  商品一覧で見る
                </Link>
              }
            />
            {data.alerts.length === 0 ? (
              <EmptyState
                title="在庫は十分です"
                description="閾値を下回っている商品はありません。"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <Th>SKU</Th>
                      <Th>商品名</Th>
                      <Th align="right">在庫</Th>
                      <Th align="right">閾値</Th>
                      <Th>状態</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.alerts.map((alert) => (
                      <tr key={alert.product.id}>
                        <Td className="font-mono text-xs text-slate-600">{alert.product.sku}</Td>
                        <Td className="font-medium text-slate-900">{alert.product.name}</Td>
                        <Td align="right" className="font-semibold">
                          {formatNumber(alert.product.stockQuantity)}
                        </Td>
                        <Td align="right" className="text-slate-400">
                          {formatNumber(alert.product.lowStockThreshold)}
                        </Td>
                        <Td>
                          <StockLevelBadge
                            quantity={alert.product.stockQuantity}
                            threshold={alert.product.lowStockThreshold}
                          />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="最近の注文"
              action={
                <Link to="/orders" className="text-xs text-brand-600 hover:underline">
                  すべて見る
                </Link>
              }
            />
            {data.recentOrders.length === 0 ? (
              <EmptyState title="注文がまだありません" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.recentOrders.map((order) => (
                  <li key={order.id}>
                    <Link
                      to={`/orders/${order.id}`}
                      className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {order.customer_name}
                        </p>
                        <p className="font-mono text-xs text-slate-400">{order.order_number}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <OrderStatusBadge status={order.status} />
                        <span className="tabular w-20 text-right text-sm text-slate-700">
                          {formatJpy(order.total_amount)}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
