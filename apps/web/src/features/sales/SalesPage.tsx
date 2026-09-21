import { formatJpy, formatNumber, toDisplayMessage } from '@stockdesk/core';
import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '@/components/AppShell';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Td,
  Th,
  cn,
} from '@/components/ui';

import { useDailySales, useMonthlySales, useProductSales } from './api';
import { SalesChart } from './SalesChart';

const RANGES = {
  '30d': { label: '直近30日', unit: 'daily', size: 30 },
  '90d': { label: '直近90日', unit: 'daily', size: 90 },
  '12m': { label: '直近12ヶ月', unit: 'monthly', size: 12 },
} as const;

type RangeKey = keyof typeof RANGES;

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="tabular mt-1 text-2xl font-bold text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </Card>
  );
}

/**
 * 売上集計。
 *
 * 出す数字を「売上合計・注文数・平均注文単価・商品売上」の4つに絞っている。
 * 業務システムのダッシュボードは数字を増やすほど読まれなくなるので、
 * 打ち手に繋がるものだけを残す。
 *
 * 送料を分けて見せるのは、送料が運送会社に流れる金額で、
 * 商品の売れ行きを見るときには差し引いて考える必要があるため。
 */
export function SalesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawRange = searchParams.get('range') ?? '30d';
  const range = (Object.keys(RANGES) as RangeKey[]).includes(rawRange as RangeKey)
    ? (rawRange as RangeKey)
    : '30d';

  const config = RANGES[range];
  const isDaily = config.unit === 'daily';

  // 使わない方のクエリは enabled で止める。表示していない期間を取りにいかない。
  const daily = useDailySales(isDaily ? config.size : 30);
  const monthly = useMonthlySales(isDaily ? 12 : config.size);

  const series = isDaily ? daily : monthly;
  const products = useProductSales();

  return (
    <>
      <PageHeader
        title="売上"
        description="キャンセルを除いた注文を、日本時間の日付で集計しています。"
      />

      <div className="mb-4 flex flex-wrap gap-1">
        {(Object.keys(RANGES) as RangeKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              if (key === '30d') next.delete('range');
              else next.set('range', key);
              setSearchParams(next, { replace: true });
            }}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition',
              range === key
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50',
            )}
          >
            {RANGES[key].label}
          </button>
        ))}
      </div>

      {series.isPending ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : series.isError ? (
        <Card>
          <ErrorBlock message={toDisplayMessage(series.error)} />
        </Card>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="売上合計"
              value={formatJpy(series.data.totals.totalAmount)}
              hint={RANGES[range].label}
            />
            <StatCard
              label="注文数"
              value={`${formatNumber(series.data.totals.orderCount)} 件`}
              hint="キャンセルを除く"
            />
            <StatCard
              label="平均注文単価"
              value={formatJpy(series.data.totals.averageOrderValue)}
              hint="売上合計 ÷ 注文数"
            />
            <StatCard
              label="商品売上"
              value={formatJpy(series.data.totals.itemAmount)}
              hint={`送料 ${formatJpy(series.data.totals.shippingAmount)} を除く`}
            />
          </div>

          <Card className="mb-5 p-5">
            <h2 className="mb-1 text-sm font-semibold text-slate-900">売上推移</h2>
            <p className="mb-4 text-xs text-slate-500">
              棒にカーソルを合わせると、その{isDaily ? '日' : '月'}の内訳が出ます。
            </p>
            <SalesChart points={series.data.points} label={`${RANGES[range].label}の売上推移`} />
          </Card>
        </>
      )}

      <Card>
        <CardHeader
          title="商品別売上ランキング"
          description="SKU 単位の累計です。取り扱いを終了した商品の実績も残します。"
        />
        {products.isPending ? (
          <LoadingBlock />
        ) : products.isError ? (
          <ErrorBlock message={toDisplayMessage(products.error)} />
        ) : products.data.length === 0 ? (
          <EmptyState title="売上がまだありません" />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <Th align="right">順位</Th>
                  <Th>SKU</Th>
                  <Th>商品名</Th>
                  <Th align="right">販売数</Th>
                  <Th align="right">売上</Th>
                  <Th align="right">注文数</Th>
                  <Th>最終販売日</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {products.data.map((product, index) => (
                  <tr key={product.sku}>
                    <Td align="right" className="text-slate-400">
                      {index + 1}
                    </Td>
                    <Td className="font-mono text-xs text-slate-600">{product.sku}</Td>
                    <Td className="font-medium text-slate-900">{product.product_name}</Td>
                    <Td align="right">{formatNumber(product.quantity)}</Td>
                    <Td align="right" className="font-semibold">
                      {formatJpy(product.amount)}
                    </Td>
                    <Td align="right" className="text-slate-500">
                      {formatNumber(product.order_count)}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-slate-500">
                      {product.last_ordered_at
                        ? new Date(product.last_ordered_at).toLocaleDateString('ja-JP')
                        : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
