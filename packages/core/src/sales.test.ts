import { describe, expect, it } from 'vitest';

import {
  buildDailySeries,
  buildMonthlySeries,
  lastNDateKeys,
  lastNMonthKeys,
  niceAxisMax,
  sumSalesPoints,
  type DailySalesRow,
} from './sales.js';

const row = (date: string, total: number, orders = 1): DailySalesRow => ({
  sales_date: date,
  order_count: orders,
  total_amount: total,
  shipping_amount: 550,
  item_amount: total - 550,
});

describe('期間の生成', () => {
  it('直近 n 日を古い順に返す', () => {
    expect(lastNDateKeys('2026-09-05', 3)).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
  });

  it('月をまたいでも正しく遡る', () => {
    expect(lastNDateKeys('2026-03-02', 3)).toEqual(['2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('うるう年を正しく扱う', () => {
    expect(lastNDateKeys('2028-03-01', 2)).toEqual(['2028-02-29', '2028-03-01']);
  });

  it('直近 n ヶ月を月初で返す', () => {
    expect(lastNMonthKeys('2026-09-15', 3)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
  });

  it('年をまたいでも正しく遡る', () => {
    expect(lastNMonthKeys('2026-02-01', 3)).toEqual(['2025-12-01', '2026-01-01', '2026-02-01']);
  });
});

describe('売上系列の組み立て', () => {
  it('売上が無かった日を 0 で埋める', () => {
    // ここを埋めないと、売れなかった日がグラフから消えて詰められ、
    // 「毎日売れている」ように見える。推移のグラフで最も誤解を招く壊れ方。
    const series = buildDailySeries(
      [row('2026-09-01', 4190), row('2026-09-03', 2330)],
      lastNDateKeys('2026-09-03', 3),
    );

    expect(series.map((point) => point.totalAmount)).toEqual([4190, 0, 2330]);
    expect(series[1]?.orderCount).toBe(0);
  });

  it('期間の側を正とし、期間外のデータは含めない', () => {
    const series = buildDailySeries(
      [row('2026-08-20', 99999), row('2026-09-01', 4190)],
      lastNDateKeys('2026-09-02', 2),
    );
    expect(series.map((point) => point.key)).toEqual(['2026-09-01', '2026-09-02']);
    expect(series.map((point) => point.totalAmount)).toEqual([4190, 0]);
  });

  it('タイムスタンプ付きの日付でも突き合わせる', () => {
    // DB のドライバが 'YYYY-MM-DD' ではなく日時を返しても系列が崩れないこと。
    const series = buildDailySeries(
      [row('2026-09-01T00:00:00.000Z', 4190)],
      lastNDateKeys('2026-09-01', 1),
    );
    expect(series[0]?.totalAmount).toBe(4190);
  });

  it('軸ラベルは 月/日 の形にする', () => {
    const series = buildDailySeries([], lastNDateKeys('2026-09-05', 1));
    expect(series[0]?.label).toBe('9/5');
  });

  it('月別の軸ラベルは 月 の形にする', () => {
    const series = buildMonthlySeries([], lastNMonthKeys('2026-09-01', 1));
    expect(series[0]?.label).toBe('9月');
  });

  it('データが空でも期間の長さぶんの系列を返す', () => {
    expect(buildDailySeries([], lastNDateKeys('2026-09-30', 30))).toHaveLength(30);
  });
});

describe('期間の合計', () => {
  it('合計と平均注文単価を出す', () => {
    const series = buildDailySeries(
      [row('2026-09-01', 4000, 2), row('2026-09-02', 2000, 1)],
      lastNDateKeys('2026-09-02', 2),
    );
    const totals = sumSalesPoints(series);
    expect(totals.orderCount).toBe(3);
    expect(totals.totalAmount).toBe(6000);
    expect(totals.averageOrderValue).toBe(2000);
  });

  it('注文が無い期間の平均は 0（0 除算を外に漏らさない）', () => {
    const totals = sumSalesPoints(buildDailySeries([], lastNDateKeys('2026-09-02', 2)));
    expect(totals.averageOrderValue).toBe(0);
    expect(totals.totalAmount).toBe(0);
  });

  it('平均は四捨五入した整数にする', () => {
    const series = buildDailySeries([row('2026-09-01', 1000, 3)], lastNDateKeys('2026-09-01', 1));
    expect(sumSalesPoints(series).averageOrderValue).toBe(333);
  });
});

describe('グラフの縦軸', () => {
  it('きりのよい値まで切り上げる', () => {
    expect(niceAxisMax(4190)).toBe(5000);
    expect(niceAxisMax(12000)).toBe(20000);
    expect(niceAxisMax(39800)).toBe(50000);
    expect(niceAxisMax(95000)).toBe(100000);
  });

  it('ちょうどの値はそのまま上限にする', () => {
    expect(niceAxisMax(5000)).toBe(5000);
    expect(niceAxisMax(1000)).toBe(1000);
  });

  it('すべて 0 のときも 1 を返す（0 で割らない）', () => {
    expect(niceAxisMax(0)).toBe(1);
    expect(niceAxisMax(-5)).toBe(1);
  });
});
