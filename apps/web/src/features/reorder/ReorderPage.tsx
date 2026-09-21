import {
  REORDER_CONFIDENCE_LABELS,
  formatNumber,
  isUrgent,
  needsReorder,
  toDisplayMessage,
  type ReorderConfidence,
  type ReorderSuggestion,
} from '@stockdesk/core';
import { Link } from 'react-router-dom';

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

import { useReorderSuggestions } from './api';

const CONFIDENCE_STYLE: Record<ReorderConfidence, string> = {
  high: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  medium: 'bg-slate-100 text-slate-600 ring-slate-200',
  low: 'bg-amber-50 text-amber-800 ring-amber-200',
  insufficient: 'bg-slate-50 text-slate-400 ring-slate-200',
};

function ConfidenceBadge({ confidence }: { confidence: ReorderConfidence }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        CONFIDENCE_STYLE[confidence],
      )}
    >
      {REORDER_CONFIDENCE_LABELS[confidence]}
    </span>
  );
}

function DaysCell({ suggestion }: { suggestion: ReorderSuggestion }) {
  if (suggestion.daysUntilStockout === null) {
    return <span className="text-slate-400">—</span>;
  }

  const urgent = isUrgent(suggestion);

  return (
    <span className={urgent ? 'font-semibold text-red-700' : 'text-slate-900'}>
      {formatNumber(suggestion.daysUntilStockout)} 日
      {urgent && <span className="ml-1 text-xs font-normal">入荷が間に合いません</span>}
    </span>
  );
}

/**
 * 発注推奨。
 *
 * 予測は「30日で60個売れた → 1日2個 → 在庫20個なら10日」という単純な割り算で出している。
 * 移動平均や季節性のモデルを入れないのは、小規模ECの日次データでは精度が出ないうえ、
 * 運営者が検算できない数字は使われなくなるため。
 *
 * 代わりに、どれくらい当てにしてよいか（実績の量と期間）を必ず併記する。
 * 実績が1週間に満たない商品や、まったく売れていない商品は予測しない。
 */
export function ReorderPage() {
  const reorder = useReorderSuggestions();

  if (reorder.isPending) {
    return (
      <Card>
        <LoadingBlock />
      </Card>
    );
  }

  if (reorder.isError) {
    return (
      <Card>
        <ErrorBlock message={toDisplayMessage(reorder.error)} />
      </Card>
    );
  }

  const { suggestions, settings } = reorder.data;
  const needed = suggestions.filter(needsReorder);
  const urgent = needed.filter(isUrgent);
  const unknown = suggestions.filter((s) => s.confidence === 'insufficient');

  return (
    <>
      <PageHeader
        title="発注推奨"
        description={`直近 ${settings.windowDays} 日の販売実績から、在庫が尽きるまでの日数を見積もっています。`}
      />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">発注が必要</p>
          <p className="tabular mt-1 text-2xl font-bold text-slate-900">
            {formatNumber(needed.length)} 件
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">入荷が間に合わない</p>
          <p
            className={cn(
              'tabular mt-1 text-2xl font-bold',
              urgent.length > 0 ? 'text-red-700' : 'text-slate-900',
            )}
          >
            {formatNumber(urgent.length)} 件
          </p>
          <p className="mt-0.5 text-xs text-slate-400">リードタイム内に在庫が尽きます</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">既定のリードタイム</p>
          <p className="tabular mt-1 text-2xl font-bold text-slate-900">
            {formatNumber(settings.defaultLeadTimeDays)} 日
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            <Link to="/settings" className="text-brand-600 hover:underline">
              設定で変更
            </Link>
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500">在庫カバー日数</p>
          <p className="tabular mt-1 text-2xl font-bold text-slate-900">
            {formatNumber(settings.coverDays)} 日
          </p>
          <p className="mt-0.5 text-xs text-slate-400">入荷後に持っておきたい分</p>
        </Card>
      </div>

      <Card className="mb-5">
        <CardHeader
          title="発注の目安"
          description="発注が必要なものを先に、在庫切れが近い順に並べています。"
        />
        {suggestions.length === 0 ? (
          <EmptyState title="対象の商品がありません" />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <Th>SKU</Th>
                  <Th>商品名</Th>
                  <Th align="right">在庫</Th>
                  <Th align="right">販売ペース</Th>
                  <Th>在庫切れまで</Th>
                  <Th>予測日</Th>
                  <Th align="right">推奨発注数</Th>
                  <Th>信頼度</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {suggestions.map((suggestion) => (
                  <tr
                    key={suggestion.productId}
                    className={isUrgent(suggestion) ? 'bg-red-50/40' : undefined}
                  >
                    <Td className="font-mono text-xs text-slate-600">{suggestion.sku}</Td>
                    <Td className="font-medium text-slate-900">{suggestion.name}</Td>
                    <Td align="right">{formatNumber(suggestion.stockQuantity)}</Td>
                    <Td align="right" className="text-slate-600">
                      {suggestion.dailySalesRate === null
                        ? '—'
                        : `${suggestion.dailySalesRate.toFixed(1)} / 日`}
                    </Td>
                    <Td>
                      <DaysCell suggestion={suggestion} />
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-slate-500">
                      {suggestion.stockoutOn ?? '—'}
                    </Td>
                    <Td align="right">
                      {suggestion.recommendedQuantity > 0 ? (
                        <span className="font-semibold text-slate-900">
                          {formatNumber(suggestion.recommendedQuantity)}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>
                    <Td>
                      <ConfidenceBadge confidence={suggestion.confidence} />
                      <span className="ml-2 text-xs text-slate-400">
                        {formatNumber(suggestion.observationDays)}日 /{' '}
                        {formatNumber(suggestion.soldQuantity)}個
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-slate-900">この数字の出し方</h2>
        <div className="mt-2 space-y-2 text-sm text-slate-600">
          <p>
            直近 {settings.windowDays} 日の販売数を、その商品が売れる状態だった日数で割って
            1日あたりの販売ペースを出し、在庫数を割って残り日数としています。たとえば 「30日で60個 →
            1日2個 → 在庫20個なら10日」。
          </p>
          <p>
            推奨発注数は「リードタイム（{formatNumber(settings.defaultLeadTimeDays)}日）＋
            カバー日数（{formatNumber(settings.coverDays)}
            日）ぶん売れる量」から現在庫を引いた数です。
          </p>
          <p>
            移動平均や季節性は考慮していません。小規模の販売データでは精度が出にくいうえ、
            運営者が検算できない数字は使われなくなるためです。代わりに、どれくらいの実績に
            基づく数字かを信頼度として併記しています。
          </p>
          {unknown.length > 0 && (
            <p>
              実績が1週間に満たない商品と、期間内に売れていない商品 （{formatNumber(unknown.length)}{' '}
              件）は予測していません。
              「まだ売れていない」のか「もう売れない」のかは、このデータからは区別できないためです。
            </p>
          )}
        </div>
      </Card>
    </>
  );
}
