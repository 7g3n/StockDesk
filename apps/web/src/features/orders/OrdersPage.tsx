import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  formatJpy,
  formatNumber,
  toDisplayMessage,
  type OrderStatus,
} from '@stockdesk/core';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { PageHeader } from '@/components/AppShell';
import { OrderStatusBadge } from '@/components/badges';
import {
  Button,
  Card,
  EmptyState,
  ErrorBlock,
  Input,
  LoadingBlock,
  Td,
  Th,
  cn,
} from '@/components/ui';

import { useOrders, type OrderWithItems } from './api';
import { NewOrderDialog } from './NewOrderDialog';
import { OrderStatusActions } from './OrderStatusActions';

const STATUS_TABS = ['all', ...ORDER_STATUSES] as const;

const STATUS_TAB_LABELS: Record<(typeof STATUS_TABS)[number], string> = {
  all: 'すべて',
  ...ORDER_STATUS_LABELS,
};

/** 明細の要約。「BLND-200 ほか2点」のように、一覧で中身の見当がつくようにする。 */
function summarizeItems(order: OrderWithItems): string {
  const items = order.order_items;
  if (items.length === 0) return '—';
  const first = items[0]!;
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  if (items.length === 1) return `${first.product_name} × ${formatNumber(first.quantity)}`;
  return `${first.product_name} ほか ${items.length - 1} 種（計 ${formatNumber(totalQuantity)} 点）`;
}

/**
 * 注文一覧。
 *
 * 運営者の1日は「対応待ちの注文を上から片付ける」ことなので、
 * 既定の並びは新しい順、かつ各行で次の工程へ1クリックで進められるようにしてある。
 */
export function OrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawStatus = searchParams.get('status') ?? 'all';
  const status = (STATUS_TABS as readonly string[]).includes(rawStatus)
    ? (rawStatus as OrderStatus | 'all')
    : 'all';
  const search = searchParams.get('q') ?? '';

  const orders = useOrders({ status, search });
  const [dialogOpen, setDialogOpen] = useState(false);

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="注文"
        description="受付 → 出荷準備 → 発送済み → 完了 の順に進みます。キャンセルすると在庫が戻ります。"
        action={
          <Button variant="primary" onClick={() => setDialogOpen(true)}>
            注文を登録
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="ステータスで絞り込み">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={status === tab}
              onClick={() => updateParam('status', tab === 'all' ? null : tab)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition',
                status === tab
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50',
              )}
            >
              {STATUS_TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        <Input
          type="search"
          placeholder="注文番号・顧客名で検索"
          defaultValue={search}
          onChange={(event) => updateParam('q', event.target.value || null)}
          className="max-w-xs"
          aria-label="注文を検索"
        />
      </div>

      <Card>
        {orders.isPending ? (
          <LoadingBlock />
        ) : orders.isError ? (
          <ErrorBlock message={toDisplayMessage(orders.error)} />
        ) : orders.data.length === 0 ? (
          <EmptyState
            title="該当する注文がありません"
            description="条件を変えるか、「注文を登録」から追加してください。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <Th>注文番号</Th>
                  <Th>注文日</Th>
                  <Th>顧客</Th>
                  <Th>内容</Th>
                  <Th>ステータス</Th>
                  <Th align="right">合計</Th>
                  <Th align="right">次の操作</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orders.data.map((order) => (
                  <tr key={order.id} className="hover:bg-slate-50/60">
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
                    <Td className="font-medium text-slate-900">{order.customer_name}</Td>
                    <Td className="max-w-xs truncate text-xs text-slate-600">
                      {summarizeItems(order)}
                    </Td>
                    <Td>
                      <OrderStatusBadge status={order.status} />
                    </Td>
                    <Td align="right" className="font-medium">
                      {formatJpy(order.total_amount)}
                    </Td>
                    <Td align="right">
                      <OrderStatusActions orderId={order.id} status={order.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewOrderDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
