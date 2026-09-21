/**
 * 在庫の計算と評価。
 *
 * ここにあるのはすべて純粋関数で、DB も React も起動せずに検証できる。
 * 在庫増減の「実行」は DB 関数（apply_stock_movement）の責務で、
 * このモジュールが担うのは「判定」と「見積り」:
 *
 *   - 引き当て前に、その注文が通るかを画面側で先に判定する（サーバー往復前の早期エラー）
 *   - 在庫水準を三段階に評価してアラート表示に使う
 *   - 台帳から現在庫を再計算して突合する
 */

import { InsufficientStockError } from './errors.js';

/** 在庫の増減理由。DB の stock_movement_reason enum と一致させる。 */
export const STOCK_MOVEMENT_REASONS = [
  'order_allocated',
  'order_cancelled',
  'purchase_received',
  'manual_adjustment',
  'return',
] as const;

export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

export const STOCK_MOVEMENT_REASON_LABELS: Record<StockMovementReason, string> = {
  order_allocated: '注文引き当て',
  order_cancelled: 'キャンセル戻し',
  purchase_received: '入荷',
  manual_adjustment: '手動調整',
  return: '返品',
};

/** 手動調整の画面から選べる理由。注文由来の増減は注文処理からしか発生させない。 */
export const MANUAL_STOCK_REASONS = [
  'purchase_received',
  'manual_adjustment',
  'return',
] as const satisfies readonly StockMovementReason[];

export type ManualStockReason = (typeof MANUAL_STOCK_REASONS)[number];

/**
 * 在庫水準の三段階評価。
 *
 * 「0 かどうか」と「少ないかどうか」を分けるのは、運営者の取るべき行動が違うため。
 * 在庫切れは販売停止（売り越しの発生源）で、残りわずかは発注の合図にすぎない。
 */
export type StockLevel = 'out_of_stock' | 'low' | 'ok';

export const STOCK_LEVEL_LABELS: Record<StockLevel, string> = {
  out_of_stock: '在庫切れ',
  low: '残りわずか',
  ok: '十分',
};

/**
 * 閾値は「以下」で判定する（threshold = 10 なら 10 個でアラート）。
 * 「発注したい数量を下回ったら知らせてほしい」という運営者の語感に合わせた境界。
 *
 * threshold = 0 は「アラート不要」ではなく「在庫切れのときだけ知らせる」を意味する。
 */
export function evaluateStockLevel(quantity: number, lowStockThreshold: number): StockLevel {
  if (quantity <= 0) return 'out_of_stock';
  if (quantity <= lowStockThreshold) return 'low';
  return 'ok';
}

/** アラート対象（在庫切れ or 残りわずか）か。 */
export function needsRestockAlert(quantity: number, lowStockThreshold: number): boolean {
  return evaluateStockLevel(quantity, lowStockThreshold) !== 'ok';
}

/**
 * 在庫の増減を適用した結果を返す。負になる操作は例外にする。
 *
 * DB の apply_stock_movement と同じ規則をクライアント側に持つことで、
 * 注文フォームで確定前に不足を知らせられる。最終的な保証は DB 側にある。
 */
export function applyStockDelta(current: number, delta: number): number {
  const next = current + delta;
  if (next < 0) {
    throw new InsufficientStockError(
      `在庫が不足しています（在庫 ${current} / 要求 ${Math.abs(delta)}）`,
    );
  }
  return next;
}

/** 台帳（増減の並び）から現在庫を再計算する。products.stock_quantity との突合に使う。 */
export function replayStockLedger(movements: readonly { delta: number }[]): number {
  return movements.reduce((sum, movement) => sum + movement.delta, 0);
}

export type StockRequirement = {
  productId: string;
  sku: string;
  quantity: number;
};

export type StockShortage = StockRequirement & {
  available: number;
  shortfall: number;
};

/**
 * 注文明細に対して、在庫が足りているかをまとめて判定する。
 *
 * 同一商品が複数行に分かれている場合は合算して判定する。
 * 1行ずつ見ると「各行は足りているが合計では足りない」を見逃すため。
 */
export function findStockShortages(
  requirements: readonly StockRequirement[],
  availableByProductId: ReadonlyMap<string, number>,
): StockShortage[] {
  const requiredByProductId = new Map<string, StockRequirement>();

  for (const requirement of requirements) {
    const existing = requiredByProductId.get(requirement.productId);
    if (existing) {
      existing.quantity += requirement.quantity;
    } else {
      requiredByProductId.set(requirement.productId, { ...requirement });
    }
  }

  const shortages: StockShortage[] = [];
  for (const requirement of requiredByProductId.values()) {
    const available = availableByProductId.get(requirement.productId) ?? 0;
    if (requirement.quantity > available) {
      shortages.push({
        ...requirement,
        available,
        shortfall: requirement.quantity - available,
      });
    }
  }
  return shortages;
}

export type AlertableProduct = {
  id: string;
  sku: string;
  name: string;
  stockQuantity: number;
  lowStockThreshold: number;
};

export type StockAlert<T extends AlertableProduct = AlertableProduct> = {
  product: T;
  level: Exclude<StockLevel, 'ok'>;
};

/**
 * ダッシュボード用のアラート一覧。
 *
 * 並び順は「在庫切れ → 残りわずか」、その中では不足の深さ順。
 * 運営者が上から順に手を打てば被害の大きい順に片付くようにするため、
 * 単純な在庫数の昇順ではなく、閾値に対する不足量で並べる。
 */
export function collectStockAlerts<T extends AlertableProduct>(
  products: readonly T[],
): StockAlert<T>[] {
  const alerts: StockAlert<T>[] = [];

  for (const product of products) {
    const level = evaluateStockLevel(product.stockQuantity, product.lowStockThreshold);
    if (level !== 'ok') {
      alerts.push({ product, level });
    }
  }

  return alerts.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'out_of_stock' ? -1 : 1;
    const deficitA = a.product.lowStockThreshold - a.product.stockQuantity;
    const deficitB = b.product.lowStockThreshold - b.product.stockQuantity;
    if (deficitA !== deficitB) return deficitB - deficitA;
    return a.product.sku.localeCompare(b.product.sku);
  });
}
