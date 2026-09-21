/**
 * 注文ステータスと、その遷移規則。
 *
 * 遷移規則は DB 側（is_valid_order_transition / update_order_status）にも同じものがある。
 * 二重管理に見えるが、役割が違う:
 *
 *   - DB 側 ... 規則を「守らせる」。UI を通らない更新でも破れない最終防衛線。
 *   - ここ  ... 規則を「見せる」。画面に出すボタンを、押せない遷移まで描かないために使う。
 *
 * 片方だけを直すと画面と実際の挙動がずれるため、変更時は両方を直す。
 * ずれていないことは order-status.test.ts の遷移表スナップショットで検知する。
 */

export const ORDER_STATUSES = [
  'pending',
  'preparing',
  'shipped',
  'completed',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '受付',
  preparing: '出荷準備',
  shipped: '発送済み',
  completed: '完了',
  cancelled: 'キャンセル',
};

/**
 * 許可された遷移。ここに無い組み合わせはすべて禁止（ホワイトリスト方式）。
 *
 * shipped からキャンセルできないのは意図的な設計判断。
 * 発送後の取り消しは「返品」であり、在庫は検品を経てから戻すべきで、
 * キャンセルと同じ即時戻しをしてはいけない。返品フローは別途設ける。
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['preparing', 'cancelled'],
  preparing: ['shipped', 'cancelled'],
  shipped: ['completed'],
  completed: [],
  cancelled: [],
};

/** 終端状態（これ以上変更できない）かどうか。 */
export function isTerminalStatus(status: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/** その状態から次に進める候補。画面のボタン生成にそのまま使う。 */
export function allowedNextStatuses(status: OrderStatus): readonly OrderStatus[] {
  return ALLOWED_TRANSITIONS[status];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * 通常フロー上の「次の一歩」。
 * 一覧画面で主要動作をワンクリックにするために、キャンセルを除いた前進のみを返す。
 */
export function nextForwardStatus(status: OrderStatus): OrderStatus | null {
  return ALLOWED_TRANSITIONS[status].find((next) => next !== 'cancelled') ?? null;
}

/**
 * この遷移で在庫が戻るか。
 *
 * 引き当てを解除するのはキャンセルのときだけ。
 * ただし実際に戻すかどうかは、その注文が引き当て済み（stock_committed）かにも依存するため、
 * 最終判断は shouldReleaseStock() を使う。
 */
export function isStockReleasingTransition(to: OrderStatus): boolean {
  return to === 'cancelled';
}

/**
 * 在庫を戻すべきか。
 * stock_committed が false の注文（既にキャンセル済み等）を二重に戻さないための冪等性判定で、
 * DB 側 update_order_status() の分岐と同じ条件を表す。
 */
export function shouldReleaseStock(to: OrderStatus, stockCommitted: boolean): boolean {
  return isStockReleasingTransition(to) && stockCommitted;
}

/** 売上として数えてよい状態か。Phase 2 の集計で「キャンセルを除く」判定に使う。 */
export function countsAsSales(status: OrderStatus): boolean {
  return status !== 'cancelled';
}

/** 出荷作業がまだ残っている状態か。ダッシュボードの「対応待ち」件数に使う。 */
export function isOpenStatus(status: OrderStatus): boolean {
  return status === 'pending' || status === 'preparing';
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}
