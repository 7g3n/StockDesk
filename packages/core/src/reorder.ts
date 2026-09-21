/**
 * 発注推奨。過去の販売ペースから、在庫切れまでの日数と発注すべき数量を見積もる。
 *
 * 新しいデータは要らない。Phase 1 で在庫を台帳として持ち、
 * 注文に ordered_at（実際の注文日時）を持たせた時点で材料は揃っている。
 *
 * 予測の方針:
 *
 *   移動平均や季節性のモデルは入れない。小規模ECの日次データは 0 の日が多く、
 *   凝ったモデルを載せても精度は出ない。それよりも、運営者が自分で検算できる
 *   単純な式であることを優先する。
 *
 *     「30日で60個売れた → 1日2個 → 在庫20個なら10日で切れる」
 *
 *   説明できない予測は、外れたときに使われなくなる。
 *   代わりに「どれくらい当てにしてよいか」を confidence として返し、
 *   数字だけが独り歩きしないようにする。
 */

/** stock_velocity() が返す行。 */
export type StockVelocityRow = {
  product_id: string;
  sku: string;
  name: string;
  stock_quantity: number;
  low_stock_threshold: number;
  /** 商品ごとのリードタイム。null なら店舗の既定値を使う。 */
  lead_time_days: number | null;
  /** 期間内の販売数（キャンセルを除く、注文日基準）。 */
  sold_quantity: number;
  /** いつから売れる状態だったか。null なら在庫移動も注文も無い。 */
  observed_from: string | null;
  last_sold_at: string | null;
};

export type ReorderSettings = {
  /** 販売実績を見る期間。 */
  windowDays: number;
  /** 商品側に指定が無いときのリードタイム。 */
  defaultLeadTimeDays: number;
  /** 入荷までの分に加えて、何日分の在庫を持ちたいか。 */
  coverDays: number;
  /** これ未満の観測日数では予測しない。 */
  minObservationDays: number;
};

export const DEFAULT_REORDER_SETTINGS: ReorderSettings = {
  windowDays: 30,
  defaultLeadTimeDays: 7,
  coverDays: 14,
  // 1週間分の実績が無い商品は予測しない。
  // 数日の実績から出した数字は、たまたま売れた日があっただけで大きく振れる。
  minObservationDays: 7,
};

/**
 * どれくらい当てにしてよいか。
 *
 *   high         … 3週間以上の実績があり、まとまった数が出ている
 *   medium       … 2週間以上の実績がある
 *   low          … 実績はあるが短い、または販売数が少ない
 *   insufficient … 予測しない（実績が足りない、または販売なし）
 */
export type ReorderConfidence = 'high' | 'medium' | 'low' | 'insufficient';

export const REORDER_CONFIDENCE_LABELS: Record<ReorderConfidence, string> = {
  high: '実績十分',
  medium: '参考値',
  low: 'ばらつき大',
  insufficient: '実績不足',
};

export type ReorderSuggestion = {
  productId: string;
  sku: string;
  name: string;
  stockQuantity: number;
  soldQuantity: number;
  /** 実際に売れる状態だった日数（期間の上限で切る）。 */
  observationDays: number;
  /** 1日あたりの販売数。予測しない場合は null。 */
  dailySalesRate: number | null;
  /** 在庫が尽きるまでの日数。予測しない場合と、販売が無い場合は null。 */
  daysUntilStockout: number | null;
  /** 在庫が尽きる見込みの日（JST の 'YYYY-MM-DD'）。 */
  stockoutOn: string | null;
  /** 発注を推奨する数量。0 なら当面不要。 */
  recommendedQuantity: number;
  /** この商品に適用したリードタイム。 */
  leadTimeDays: number;
  confidence: ReorderConfidence;
};

const MS_PER_DAY = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** JST の 'YYYY-MM-DD'。日付の境界は日本時間で切る（画面と集計に揃える）。 */
function toJstDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function decideConfidence(observationDays: number, soldQuantity: number): ReorderConfidence {
  if (observationDays >= 21 && soldQuantity >= 10) return 'high';
  if (observationDays >= 14 && soldQuantity >= 4) return 'medium';
  return 'low';
}

/**
 * 1商品ぶんの発注推奨を出す。
 *
 * asOf を引数に取るのは、テストで「今日」に依存しないようにするため。
 */
export function computeReorderSuggestion(
  row: StockVelocityRow,
  settings: ReorderSettings = DEFAULT_REORDER_SETTINGS,
  asOf: Date = new Date(),
): ReorderSuggestion {
  const leadTimeDays = row.lead_time_days ?? settings.defaultLeadTimeDays;

  // 実際に売れる状態だった日数。期間より長くは数えない。
  // 取り扱いを始めたばかりの商品を期間全体で割ると、販売ペースを過小評価する。
  //
  // 日数は整数に切り下げ、その値をそのまま計算に使う。
  // 端数を残して計算し、画面には切り下げた日数を出すと、
  // 「17個 ÷ 10日 = 1.7」のはずが 1.6 と表示され、検算が合わなくなる。
  // 運営者が自分で確かめられることを優先する設計なので、
  // 表示する数字と計算に使う数字を一致させる。
  const observationDays = row.observed_from
    ? Math.floor(Math.min(settings.windowDays, daysBetween(new Date(row.observed_from), asOf)))
    : 0;

  const base = {
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    stockQuantity: row.stock_quantity,
    soldQuantity: row.sold_quantity,
    observationDays,
    leadTimeDays,
  };

  // 実績が足りないときは予測しない。
  // 「まだ売れていない」と「もう売れない」は、この情報だけでは区別できない。
  // 無限の日数や 0 を返すより、予測しないことを明示する方が誤解が少ない。
  if (observationDays < settings.minObservationDays || row.sold_quantity <= 0) {
    return {
      ...base,
      dailySalesRate: null,
      daysUntilStockout: null,
      stockoutOn: null,
      recommendedQuantity: 0,
      confidence: 'insufficient',
    };
  }

  const dailySalesRate = row.sold_quantity / observationDays;

  // 切り捨てる。「あと2.9日」を3日と伝えると、切れた翌日に気付くことになる。
  const daysUntilStockout = Math.floor(row.stock_quantity / dailySalesRate);

  // 入荷までに売れる分 + 手元に置いておきたい分。
  const targetStock = Math.ceil(dailySalesRate * (leadTimeDays + settings.coverDays));
  const recommendedQuantity = Math.max(0, targetStock - row.stock_quantity);

  const stockoutAt = new Date(asOf.getTime() + daysUntilStockout * MS_PER_DAY);

  return {
    ...base,
    dailySalesRate,
    daysUntilStockout,
    stockoutOn: toJstDateKey(stockoutAt),
    recommendedQuantity,
    confidence: decideConfidence(observationDays, row.sold_quantity),
  };
}

/**
 * 一覧に出す並び。
 *
 * 発注が必要なものを先に、その中では在庫切れが近い順。
 * 運営者が上から順に手を打てば、間に合わなくなる順に片付く。
 * 予測できない商品は最後にまとめる（判断材料が無いので急かしても仕方がない）。
 */
export function collectReorderSuggestions(
  rows: readonly StockVelocityRow[],
  settings: ReorderSettings = DEFAULT_REORDER_SETTINGS,
  asOf: Date = new Date(),
): ReorderSuggestion[] {
  return rows
    .map((row) => computeReorderSuggestion(row, settings, asOf))
    .sort((a, b) => {
      const aNeeds = a.recommendedQuantity > 0;
      const bNeeds = b.recommendedQuantity > 0;
      if (aNeeds !== bNeeds) return aNeeds ? -1 : 1;

      if (a.daysUntilStockout === null && b.daysUntilStockout === null) {
        return a.sku.localeCompare(b.sku);
      }
      if (a.daysUntilStockout === null) return 1;
      if (b.daysUntilStockout === null) return -1;

      if (a.daysUntilStockout !== b.daysUntilStockout) {
        return a.daysUntilStockout - b.daysUntilStockout;
      }
      return a.sku.localeCompare(b.sku);
    });
}

/** 発注が必要な商品だけ。通知やダッシュボードの件数に使う。 */
export function needsReorder(suggestion: ReorderSuggestion): boolean {
  return suggestion.recommendedQuantity > 0;
}

/**
 * リードタイムの間に在庫が尽きるか。
 *
 * 「発注してももう間に合わない」ことを指す。
 * 単に在庫が少ないことより強い警告で、通知で先に出すべきもの。
 */
export function isUrgent(suggestion: ReorderSuggestion): boolean {
  return (
    suggestion.daysUntilStockout !== null && suggestion.daysUntilStockout <= suggestion.leadTimeDays
  );
}
