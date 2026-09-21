import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  formatJpy,
  formatNumber,
  toDisplayMessage,
  type OrderStatus,
} from '@stockdesk/core';
import { useMemo, useState } from 'react';
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
  Select,
  Td,
  Th,
  cn,
} from '@/components/ui';
import { useCan } from '@/features/auth/permissions';
import { useSalesChannels } from '@/features/channels/api';

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
 *
 * Phase 3 で、複数選択して納品書・ラベルをまとめて印刷できるようにした。
 * 出荷の実務は「今日出す分をまとめて刷る」なので、1件ずつ開く作りでは回らない。
 */
export function OrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawStatus = searchParams.get('status') ?? 'all';
  const status = (STATUS_TABS as readonly string[]).includes(rawStatus)
    ? (rawStatus as OrderStatus | 'all')
    : 'all';
  const search = searchParams.get('q') ?? '';
  const channel = searchParams.get('channel') ?? '';

  const orders = useOrders({ status, search, channel });
  const channels = useSalesChannels();
  const canWrite = useCan('order:write');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const channelNames = useMemo(
    () => new Map((channels.data ?? []).map((row) => [row.code, row.name])),
    [channels.data],
  );

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const visibleIds = (orders.data ?? []).map((order) => order.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : visibleIds);
  };

  const toggleOne = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  // 別タブで開くのは、印刷後に一覧へ戻る手間を省くため。
  const openPrint = (doc: 'delivery-note' | 'shipping-label') => {
    window.open(`/print/${doc}?ids=${selectedIds.join(',')}`, '_blank', 'noopener');
  };

  return (
    <>
      <PageHeader
        title="注文"
        description="受付 → 出荷準備 → 発送済み → 完了 の順に進みます。キャンセルすると在庫が戻ります。"
        action={
          canWrite ? (
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              注文を登録
            </Button>
          ) : null
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

        <Select
          value={channel}
          onChange={(event) => updateParam('channel', event.target.value || null)}
          className="max-w-44"
          aria-label="販売チャネルで絞り込み"
        >
          <option value="">すべてのチャネル</option>
          {(channels.data ?? []).map((row) => (
            <option key={row.code} value={row.code}>
              {row.name}
            </option>
          ))}
        </Select>

        <Input
          type="search"
          placeholder="注文番号・顧客名で検索"
          defaultValue={search}
          onChange={(event) => updateParam('q', event.target.value || null)}
          className="max-w-xs"
          aria-label="注文を検索"
        />
      </div>

      {selectedIds.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-brand-50 px-4 py-3">
          <span className="text-sm font-medium text-brand-800">
            {formatNumber(selectedIds.length)} 件を選択中
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={() => setSelectedIds([])}>
              選択を解除
            </Button>
            <Button size="sm" onClick={() => openPrint('delivery-note')}>
              納品書を印刷
            </Button>
            <Button size="sm" variant="primary" onClick={() => openPrint('shipping-label')}>
              出荷ラベルを印刷
            </Button>
          </div>
        </div>
      )}

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
                  <th scope="col" className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="表示中の注文をすべて選択"
                      className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                    />
                  </th>
                  <Th>注文番号</Th>
                  <Th>注文日</Th>
                  <Th>チャネル</Th>
                  <Th>顧客</Th>
                  <Th>内容</Th>
                  <Th>ステータス</Th>
                  <Th align="right">合計</Th>
                  <Th align="right">次の操作</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orders.data.map((order) => (
                  <tr
                    key={order.id}
                    className={cn(
                      'hover:bg-slate-50/60',
                      selectedIds.includes(order.id) && 'bg-brand-50/40',
                    )}
                  >
                    <Td>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(order.id)}
                        onChange={() => toggleOne(order.id)}
                        aria-label={`${order.order_number} を選択`}
                        className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                      />
                    </Td>
                    <Td>
                      <Link
                        to={`/orders/${order.id}`}
                        className="font-mono text-xs font-medium text-brand-700 hover:underline"
                      >
                        {order.order_number}
                      </Link>
                      {order.external_order_id && (
                        <span className="ml-2 font-mono text-xs text-slate-400">
                          {order.external_order_id}
                        </span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-slate-500">
                      {new Date(order.ordered_at).toLocaleDateString('ja-JP')}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-slate-600">
                      {channelNames.get(order.channel) ?? order.channel}
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
                      {canWrite ? (
                        <OrderStatusActions orderId={order.id} status={order.status} />
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
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
