import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REORDER_SETTINGS,
  collectReorderSuggestions,
  computeReorderSuggestion,
  isUrgent,
  needsReorder,
  type StockVelocityRow,
} from './reorder.js';

const NOW = new Date('2026-09-21T03:00:00Z'); // JST 12:00

/** n 日前の時刻。 */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function row(over: Partial<StockVelocityRow> & { sku: string }): StockVelocityRow {
  return {
    product_id: over.sku,
    name: over.sku,
    stock_quantity: 0,
    low_stock_threshold: 0,
    lead_time_days: null,
    sold_quantity: 0,
    observed_from: daysAgo(30),
    last_sold_at: daysAgo(1),
    ...over,
  };
}

describe('販売ペースからの予測', () => {
  it('30日で60個なら1日2個、在庫20個で10日', () => {
    // 運営者が暗算で検算できることを意図した式。ここが崩れたら設計方針から外れている。
    const suggestion = computeReorderSuggestion(
      row({ sku: 'A', sold_quantity: 60, stock_quantity: 20, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.dailySalesRate).toBe(2);
    expect(suggestion.daysUntilStockout).toBe(10);
  });

  it('在庫切れの日を JST の日付で返す', () => {
    const suggestion = computeReorderSuggestion(
      row({ sku: 'A', sold_quantity: 60, stock_quantity: 20, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.stockoutOn).toBe('2026-10-01');
  });

  it('残日数は切り捨てる', () => {
    // 「あと2.9日」を3日と伝えると、切れた翌日に気付くことになる。
    const suggestion = computeReorderSuggestion(
      row({ sku: 'A', sold_quantity: 30, stock_quantity: 29, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.dailySalesRate).toBe(1);
    expect(suggestion.daysUntilStockout).toBe(29);
  });

  it('推奨発注数はリードタイム + カバー日数ぶんを満たす量', () => {
    // 1日2個・リードタイム7日・カバー14日 → 目標 42個。在庫20個なので 22個。
    const suggestion = computeReorderSuggestion(
      row({ sku: 'A', sold_quantity: 60, stock_quantity: 20, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.recommendedQuantity).toBe(22);
  });

  it('在庫が十分なら発注不要（0 を返す）', () => {
    const suggestion = computeReorderSuggestion(
      row({ sku: 'A', sold_quantity: 60, stock_quantity: 200, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.recommendedQuantity).toBe(0);
    expect(needsReorder(suggestion)).toBe(false);
  });

  it('商品ごとのリードタイムが店舗既定より優先される', () => {
    const suggestion = computeReorderSuggestion(
      row({
        sku: 'IMPORT',
        sold_quantity: 60,
        stock_quantity: 20,
        observed_from: daysAgo(30),
        lead_time_days: 30,
      }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.leadTimeDays).toBe(30);
    // 1日2個・(30 + 14)日 → 目標 88個。在庫20個なので 68個。
    expect(suggestion.recommendedQuantity).toBe(68);
  });
});

describe('新しい商品の扱い', () => {
  it('取り扱い開始からの日数で割る（期間全体で割らない）', () => {
    // 10日前に入荷して20個売れた → 1日2個。
    // 30日で割ると 0.67個/日 になり、発注が間に合わなくなる。
    const suggestion = computeReorderSuggestion(
      row({ sku: 'NEW', sold_quantity: 20, stock_quantity: 20, observed_from: daysAgo(10) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.observationDays).toBe(10);
    expect(suggestion.dailySalesRate).toBe(2);
  });

  it('観測日数は期間の上限で切る', () => {
    const suggestion = computeReorderSuggestion(
      row({ sku: 'OLD', sold_quantity: 60, stock_quantity: 20, observed_from: daysAgo(400) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.observationDays).toBe(30);
  });
});

describe('予測しない場合', () => {
  it('実績が1週間に満たなければ予測しない', () => {
    // 数日の実績から出した数字は、たまたま売れた日があっただけで大きく振れる。
    const suggestion = computeReorderSuggestion(
      row({ sku: 'FRESH', sold_quantity: 30, stock_quantity: 10, observed_from: daysAgo(2) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.confidence).toBe('insufficient');
    expect(suggestion.daysUntilStockout).toBeNull();
    expect(suggestion.dailySalesRate).toBeNull();
    expect(suggestion.recommendedQuantity).toBe(0);
  });

  it('販売実績が 0 なら予測しない', () => {
    // 「まだ売れていない」と「もう売れない」は、この情報だけでは区別できない。
    // 無限の日数を返すより、予測しないことを明示する。
    const suggestion = computeReorderSuggestion(
      row({ sku: 'DEAD', sold_quantity: 0, stock_quantity: 50, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.confidence).toBe('insufficient');
    expect(suggestion.daysUntilStockout).toBeNull();
  });

  it('在庫移動も注文も無い商品は予測しない', () => {
    const suggestion = computeReorderSuggestion(
      row({ sku: 'EMPTY', observed_from: null }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.observationDays).toBe(0);
    expect(suggestion.confidence).toBe('insufficient');
  });

  it('在庫が既に 0 でも予測は返す（0日として）', () => {
    const suggestion = computeReorderSuggestion(
      row({ sku: 'OUT', sold_quantity: 30, stock_quantity: 0, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.daysUntilStockout).toBe(0);
    expect(suggestion.recommendedQuantity).toBeGreaterThan(0);
  });
});

describe('表示と計算の一致', () => {
  it('販売ペースは、画面に出る観測日数で割った値と一致する', () => {
    // 端数を残して計算し、画面には切り下げた日数を出すと
    // 「17個 ÷ 10日 = 1.7」のはずが 1.6 と表示され、検算が合わなくなる。
    // 運営者が自分で確かめられることを優先しているので、ここは一致していなければならない。
    const suggestion = computeReorderSuggestion(
      row({ sku: 'A', sold_quantity: 17, stock_quantity: 28, observed_from: daysAgo(10.6) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.observationDays).toBe(10);
    expect(suggestion.dailySalesRate).toBeCloseTo(17 / 10, 10);
  });
});

describe('信頼度', () => {
  it('3週間以上かつまとまった数が出ていれば実績十分', () => {
    expect(
      computeReorderSuggestion(
        row({ sku: 'A', sold_quantity: 30, stock_quantity: 10, observed_from: daysAgo(25) }),
        DEFAULT_REORDER_SETTINGS,
        NOW,
      ).confidence,
    ).toBe('high');
  });

  it('2週間程度なら参考値', () => {
    expect(
      computeReorderSuggestion(
        row({ sku: 'A', sold_quantity: 8, stock_quantity: 10, observed_from: daysAgo(15) }),
        DEFAULT_REORDER_SETTINGS,
        NOW,
      ).confidence,
    ).toBe('medium');
  });

  it('期間が長くても販売数が少なければばらつき大', () => {
    // 30日で2個は、来月も2個とは限らない。
    expect(
      computeReorderSuggestion(
        row({ sku: 'A', sold_quantity: 2, stock_quantity: 10, observed_from: daysAgo(30) }),
        DEFAULT_REORDER_SETTINGS,
        NOW,
      ).confidence,
    ).toBe('low');
  });
});

describe('緊急の判定', () => {
  it('リードタイム内に尽きるなら緊急', () => {
    // 1日2個・在庫10個 → 5日。リードタイム7日では間に合わない。
    const suggestion = computeReorderSuggestion(
      row({ sku: 'A', sold_quantity: 60, stock_quantity: 10, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestion.daysUntilStockout).toBe(5);
    expect(isUrgent(suggestion)).toBe(true);
  });

  it('リードタイムより余裕があれば緊急ではない', () => {
    const suggestion = computeReorderSuggestion(
      row({ sku: 'A', sold_quantity: 60, stock_quantity: 40, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(isUrgent(suggestion)).toBe(false);
  });

  it('予測できない商品は緊急にしない', () => {
    const suggestion = computeReorderSuggestion(
      row({ sku: 'A', sold_quantity: 0, stock_quantity: 0, observed_from: daysAgo(30) }),
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(isUrgent(suggestion)).toBe(false);
  });
});

describe('一覧の並び', () => {
  it('発注が必要なものを先に、在庫切れが近い順に並べる', () => {
    const suggestions = collectReorderSuggestions(
      [
        row({ sku: 'ENOUGH', sold_quantity: 60, stock_quantity: 300, observed_from: daysAgo(30) }),
        row({ sku: 'SOON', sold_quantity: 60, stock_quantity: 10, observed_from: daysAgo(30) }),
        row({ sku: 'LATER', sold_quantity: 60, stock_quantity: 40, observed_from: daysAgo(30) }),
      ],
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestions.map((s) => s.sku)).toEqual(['SOON', 'LATER', 'ENOUGH']);
  });

  it('予測できない商品は最後にまとめる', () => {
    const suggestions = collectReorderSuggestions(
      [
        row({ sku: 'UNKNOWN', sold_quantity: 0, stock_quantity: 5, observed_from: daysAgo(30) }),
        row({ sku: 'SOON', sold_quantity: 60, stock_quantity: 10, observed_from: daysAgo(30) }),
      ],
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestions.map((s) => s.sku)).toEqual(['SOON', 'UNKNOWN']);
  });

  it('同点のときは SKU 順で安定させる', () => {
    const suggestions = collectReorderSuggestions(
      [
        row({ sku: 'B-01', sold_quantity: 60, stock_quantity: 10, observed_from: daysAgo(30) }),
        row({ sku: 'A-01', sold_quantity: 60, stock_quantity: 10, observed_from: daysAgo(30) }),
      ],
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    expect(suggestions.map((s) => s.sku)).toEqual(['A-01', 'B-01']);
  });
});
