import { ORDER_STATUS_LABELS, formatJpy, formatNumber, toDisplayMessage } from '@stockdesk/core';
import { Link, useParams } from 'react-router-dom';

import { PageHeader } from '@/components/AppShell';
import { OrderStatusBadge } from '@/components/badges';
import { Button, Card, CardHeader, ErrorBlock, LoadingBlock, Td, Th } from '@/components/ui';
import { useCan } from '@/features/auth/permissions';

import { useOrder } from './api';
import { OrderStatusActions } from './OrderStatusActions';

function DefinitionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-24 shrink-0 text-slate-500">{label}</dt>
      <dd className="text-slate-800">{value || '—'}</dd>
    </div>
  );
}

/**
 * 注文詳細。
 *
 * 伝票として読める形（誰に・何を・いくらで・今どの工程か）を1画面に収める。
 * 明細に出しているのは注文時点のスナップショットであり、
 * 商品マスタを後から変更してもこの表示は変わらない。
 */
export function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const order = useOrder(orderId);
  const canWrite = useCan('order:write');

  if (order.isPending) {
    return (
      <Card>
        <LoadingBlock />
      </Card>
    );
  }

  if (order.isError) {
    return (
      <Card>
        <ErrorBlock message={toDisplayMessage(order.error)} />
      </Card>
    );
  }

  const data = order.data;
  const itemsTotal = data.order_items.reduce((sum, item) => sum + item.subtotal, 0);

  return (
    <>
      <div className="mb-3">
        <Link to="/orders" className="text-sm text-brand-600 hover:underline">
          ← 注文一覧に戻る
        </Link>
      </div>

      <PageHeader
        title={data.order_number}
        description={`受付日時 ${new Date(data.ordered_at).toLocaleString('ja-JP')}`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <OrderStatusBadge status={data.status} />
            {/* 帳票は閲覧のみの権限でも出せる。刷るだけでデータは変わらないため */}
            <Button
              size="sm"
              onClick={() =>
                window.open(`/print/delivery-note?ids=${data.id}`, '_blank', 'noopener')
              }
            >
              納品書
            </Button>
            <Button
              size="sm"
              onClick={() =>
                window.open(`/print/shipping-label?ids=${data.id}`, '_blank', 'noopener')
              }
            >
              出荷ラベル
            </Button>
            {/* 詳細画面では前進とキャンセルの両方を出す（一覧は前進のみ） */}
            {canWrite && (
              <OrderStatusActions
                orderId={data.id}
                status={data.status}
                size="md"
                showAllTransitions
              />
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="注文明細"
              description="単価・商品名は注文時点の内容を保存しています。"
            />
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <Th>SKU</Th>
                    <Th>商品名</Th>
                    <Th align="right">単価</Th>
                    <Th align="right">数量</Th>
                    <Th align="right">小計</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.order_items.map((item) => (
                    <tr key={item.id}>
                      <Td className="font-mono text-xs text-slate-600">{item.sku}</Td>
                      <Td>{item.product_name}</Td>
                      <Td align="right">{formatJpy(item.unit_price)}</Td>
                      <Td align="right">{formatNumber(item.quantity)}</Td>
                      <Td align="right" className="font-medium">
                        {formatJpy(item.subtotal)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-slate-200 bg-slate-50">
                  <tr>
                    <Td className="text-xs text-slate-500">小計</Td>
                    <Td>{''}</Td>
                    <Td>{''}</Td>
                    <Td>{''}</Td>
                    <Td align="right">{formatJpy(itemsTotal)}</Td>
                  </tr>
                  <tr>
                    <Td className="text-xs text-slate-500">送料</Td>
                    <Td>{''}</Td>
                    <Td>{''}</Td>
                    <Td>{''}</Td>
                    <Td align="right">{formatJpy(data.shipping_fee)}</Td>
                  </tr>
                  <tr>
                    <Td className="text-xs font-semibold text-slate-700">合計</Td>
                    <Td>{''}</Td>
                    <Td>{''}</Td>
                    <Td>{''}</Td>
                    <Td align="right" className="text-base font-bold text-slate-900">
                      {formatJpy(data.total_amount)}
                    </Td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="p-5">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">配送先</h2>
            <dl className="divide-y divide-slate-100">
              <DefinitionRow label="顧客名" value={data.customer_name} />
              <DefinitionRow label="メール" value={data.customer_email} />
              <DefinitionRow label="住所" value={data.shipping_address} />
            </dl>
          </Card>

          <Card className="p-5">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">処理状況</h2>
            <dl className="divide-y divide-slate-100">
              <DefinitionRow label="ステータス" value={ORDER_STATUS_LABELS[data.status]} />
              <DefinitionRow
                label="在庫引当"
                value={data.stock_committed ? '引き当て済み' : '未引き当て / 解除済み'}
              />
              <DefinitionRow
                label="発送日時"
                value={data.shipped_at ? new Date(data.shipped_at).toLocaleString('ja-JP') : ''}
              />
              <DefinitionRow
                label="完了日時"
                value={data.completed_at ? new Date(data.completed_at).toLocaleString('ja-JP') : ''}
              />
              <DefinitionRow
                label="取消日時"
                value={data.cancelled_at ? new Date(data.cancelled_at).toLocaleString('ja-JP') : ''}
              />
              <DefinitionRow label="販売チャネル" value={data.channel} />
            </dl>
          </Card>

          {data.note && (
            <Card className="p-5">
              <h2 className="mb-2 text-sm font-semibold text-slate-900">備考</h2>
              <p className="whitespace-pre-wrap text-sm text-slate-700">{data.note}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
