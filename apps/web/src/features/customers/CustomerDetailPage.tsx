import { countsAsSales, formatJpy, formatNumber, toDisplayMessage } from '@stockdesk/core';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { PageHeader } from '@/components/AppShell';
import { OrderStatusBadge } from '@/components/badges';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Td,
  Th,
} from '@/components/ui';

import { useCustomer, useCustomerOrders } from './api';
import { CustomerFormDialog } from './CustomerFormDialog';

function DefinitionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-20 shrink-0 text-slate-500">{label}</dt>
      <dd className="text-slate-800">{value || '—'}</dd>
    </div>
  );
}

/**
 * 顧客詳細。
 *
 * 注文履歴を顧客側から見る画面。
 * ここで出す累計はキャンセルを除いて数える（売上として数えるかどうかの判定は
 * packages/core の countsAsSales() が持つ。DB のビューと同じ規則）。
 */
export function CustomerDetailPage() {
  const { customerId } = useParams<{ customerId: string }>();
  const customer = useCustomer(customerId);
  const orders = useCustomerOrders(customerId);
  const [dialogOpen, setDialogOpen] = useState(false);

  const totals = useMemo(() => {
    const rows = orders.data ?? [];
    const counted = rows.filter((order) => countsAsSales(order.status));
    return {
      orderCount: counted.length,
      totalAmount: counted.reduce((sum, order) => sum + order.total_amount, 0),
      cancelledCount: rows.length - counted.length,
    };
  }, [orders.data]);

  if (customer.isPending) {
    return (
      <Card>
        <LoadingBlock />
      </Card>
    );
  }

  if (customer.isError) {
    return (
      <Card>
        <ErrorBlock message={toDisplayMessage(customer.error)} />
      </Card>
    );
  }

  const data = customer.data;

  return (
    <>
      <div className="mb-3">
        <Link to="/customers" className="text-sm text-brand-600 hover:underline">
          ← 顧客一覧に戻る
        </Link>
      </div>

      <PageHeader
        title={data.name}
        description={data.email ?? 'メールアドレス未登録'}
        action={<Button onClick={() => setDialogOpen(true)}>編集</Button>}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5">
          <Card className="p-5">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">連絡先</h2>
            <dl className="divide-y divide-slate-100">
              <DefinitionRow label="メール" value={data.email ?? ''} />
              <DefinitionRow label="電話" value={data.phone} />
              <DefinitionRow label="郵便番号" value={data.postal_code} />
              <DefinitionRow label="住所" value={data.address} />
            </dl>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">取引実績</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-slate-500">注文数</p>
                <p className="tabular text-2xl font-bold text-slate-900">
                  {formatNumber(totals.orderCount)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">累計購入額</p>
                <p className="tabular text-2xl font-bold text-slate-900">
                  {formatJpy(totals.totalAmount)}
                </p>
              </div>
            </div>
            {totals.cancelledCount > 0 && (
              <p className="mt-3 text-xs text-slate-500">
                ほかにキャンセル {formatNumber(totals.cancelledCount)} 件（集計には含みません）
              </p>
            )}
          </Card>

          {data.note && (
            <Card className="p-5">
              <h2 className="mb-2 text-sm font-semibold text-slate-900">メモ</h2>
              <p className="whitespace-pre-wrap text-sm text-slate-700">{data.note}</p>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="注文履歴"
              description="この顧客に紐付いた注文です。キャンセルも履歴として残します。"
            />
            {orders.isPending ? (
              <LoadingBlock />
            ) : orders.isError ? (
              <ErrorBlock message={toDisplayMessage(orders.error)} />
            ) : orders.data.length === 0 ? (
              <EmptyState title="注文がまだありません" />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <Th>注文番号</Th>
                      <Th>注文日</Th>
                      <Th>内容</Th>
                      <Th>ステータス</Th>
                      <Th align="right">合計</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {orders.data.map((order) => (
                      <tr key={order.id}>
                        <Td>
                          <Link
                            to={`/orders/${order.id}`}
                            className="font-mono text-xs font-medium text-brand-700 hover:underline"
                          >
                            {order.order_number}
                          </Link>
                        </Td>
                        <Td className="whitespace-nowrap text-xs text-slate-500">
                          {new Date(order.ordered_at).toLocaleDateString('ja-JP')}
                        </Td>
                        <Td className="max-w-48 truncate text-xs text-slate-600">
                          {order.order_items
                            .map((item) => `${item.product_name} × ${item.quantity}`)
                            .join('、')}
                        </Td>
                        <Td>
                          <OrderStatusBadge status={order.status} />
                        </Td>
                        <Td align="right" className="font-medium">
                          {formatJpy(order.total_amount)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>

      <CustomerFormDialog open={dialogOpen} onClose={() => setDialogOpen(false)} customer={data} />
    </>
  );
}
