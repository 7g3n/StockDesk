import { formatJpy, formatNumber, toDisplayMessage } from '@stockdesk/core';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '@/components/AppShell';
import { StockLevelBadge } from '@/components/badges';
import { Button, Card, EmptyState, ErrorBlock, Input, LoadingBlock, Td, Th } from '@/components/ui';

import { useProducts, type Product } from './api';
import { ProductFormDialog } from './ProductFormDialog';
import { StockAdjustDialog } from './StockAdjustDialog';

/**
 * 商品・在庫の一覧。
 *
 * この画面の主目的は「棚の状態を上から順に確認すること」なので、
 * カード状に並べず表にする。列は運営者が判断に使う順（SKU → 名前 → 在庫 → 価格）に並べ、
 * 数量と金額は桁を揃える（tabular）。
 */
export function ProductsPage() {
  // 検索条件を URL に持たせる。ブックマークでき、リロードしても条件が消えない。
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('q') ?? '';
  const onlyAlerts = searchParams.get('alerts') === '1';

  const products = useProducts({ search, onlyAlerts });

  const [formOpen, setFormOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [selected, setSelected] = useState<Product | undefined>(undefined);

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="商品・在庫"
        description="SKU ごとの在庫数と販売価格を管理します。在庫数は増減の記録を通じてのみ変更されます。"
        action={
          <Button
            variant="primary"
            onClick={() => {
              setSelected(undefined);
              setFormOpen(true);
            }}
          >
            商品を登録
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          type="search"
          placeholder="SKU・商品名で検索"
          defaultValue={search}
          onChange={(event) => updateParam('q', event.target.value || null)}
          className="max-w-xs"
          aria-label="商品を検索"
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={onlyAlerts}
            onChange={(event) => updateParam('alerts', event.target.checked ? '1' : null)}
            className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
          />
          在庫アラートのみ表示
        </label>
        <span className="ml-auto text-xs text-slate-500">
          {products.data ? `${formatNumber(products.data.length)} 件` : ''}
        </span>
      </div>

      <Card>
        {products.isPending ? (
          <LoadingBlock />
        ) : products.isError ? (
          <ErrorBlock message={toDisplayMessage(products.error)} />
        ) : products.data.length === 0 ? (
          <EmptyState
            title={onlyAlerts ? '在庫アラートの対象はありません' : '商品がまだ登録されていません'}
            description={
              onlyAlerts ? undefined : '「商品を登録」から最初の SKU を追加してください。'
            }
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
                  <Th align="right">販売価格</Th>
                  <Th align="right">原価</Th>
                  <Th align="right">操作</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {products.data.map((product) => (
                  <tr
                    key={product.id}
                    className={product.status === 'archived' ? 'bg-slate-50/60' : undefined}
                  >
                    <Td className="font-mono text-xs text-slate-600">{product.sku}</Td>
                    <Td>
                      <span className="font-medium text-slate-900">{product.name}</span>
                      {product.status === 'archived' && (
                        <span className="ml-2 text-xs text-slate-400">取り扱い終了</span>
                      )}
                    </Td>
                    <Td align="right">
                      <span className="font-semibold">{formatNumber(product.stock_quantity)}</span>
                    </Td>
                    <Td align="right" className="text-slate-400">
                      {formatNumber(product.low_stock_threshold)}
                    </Td>
                    <Td>
                      <StockLevelBadge
                        quantity={product.stock_quantity}
                        threshold={product.low_stock_threshold}
                      />
                    </Td>
                    <Td align="right">{formatJpy(product.unit_price)}</Td>
                    <Td align="right" className="text-slate-500">
                      {formatJpy(product.cost_price)}
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          onClick={() => {
                            setSelected(product);
                            setAdjustOpen(true);
                          }}
                        >
                          在庫調整
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSelected(product);
                            setFormOpen(true);
                          }}
                        >
                          編集
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ProductFormDialog open={formOpen} onClose={() => setFormOpen(false)} product={selected} />
      <StockAdjustDialog
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        product={selected}
      />
    </>
  );
}
