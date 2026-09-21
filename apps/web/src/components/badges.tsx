/**
 * 状態を表すバッジ。
 *
 * 色は補助であって情報ではない、という原則で作る。
 * 「赤い行＝在庫切れ」と覚えさせる代わりに、必ずラベル文字列を出す。
 */
import {
  ORDER_STATUS_LABELS,
  STOCK_LEVEL_LABELS,
  evaluateStockLevel,
  type OrderStatus,
  type StockLevel,
} from '@stockdesk/core';

import { cn } from './ui';

const BASE =
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset';

const STOCK_LEVEL_STYLE: Record<StockLevel, string> = {
  out_of_stock: 'bg-red-50 text-red-700 ring-red-200',
  low: 'bg-amber-50 text-amber-800 ring-amber-200',
  ok: 'bg-slate-50 text-slate-600 ring-slate-200',
};

export function StockLevelBadge({ quantity, threshold }: { quantity: number; threshold: number }) {
  const level = evaluateStockLevel(quantity, threshold);
  return <span className={cn(BASE, STOCK_LEVEL_STYLE[level])}>{STOCK_LEVEL_LABELS[level]}</span>;
}

/**
 * 工程の進みが一目で分かるよう、受付→出荷準備→発送済み→完了で色を段階的に濃くする。
 * キャンセルだけは進行から外れるのでグレーにして、完了と混同させない。
 */
const ORDER_STATUS_STYLE: Record<OrderStatus, string> = {
  pending: 'bg-brand-50 text-brand-700 ring-brand-100',
  preparing: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  shipped: 'bg-teal-50 text-teal-700 ring-teal-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 ring-slate-200',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={cn(BASE, ORDER_STATUS_STYLE[status])}>{ORDER_STATUS_LABELS[status]}</span>
  );
}
