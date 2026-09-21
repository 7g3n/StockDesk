import { describe, expect, it } from 'vitest';

import { generateMockChannelOrders, type MockChannelOptions } from './channel-mock.js';
import { summarizeImport } from './order-import.js';

const BASE: MockChannelOptions = {
  channelCode: 'mall_a',
  orderPrefix: 'SKR',
  skus: ['BLND-200', 'ETHI-200', 'DRIP-10'],
  date: '2026-09-21',
  count: 3,
};

describe('チャネル連携のモック', () => {
  it('指定した件数の注文を作る', () => {
    expect(generateMockChannelOrders(BASE)).toHaveLength(3);
  });

  it('同じチャネル・同じ日なら常に同じ結果になる', () => {
    // ここが決定的でないと、再同期のたびに別の注文が増え続ける。
    // 実 API のポーリングでも同じ注文を何度も受け取るので、
    // 「2回目は何も起きない」ことが確かめたい挙動になる。
    expect(generateMockChannelOrders(BASE)).toEqual(generateMockChannelOrders(BASE));
  });

  it('日が変われば別の注文番号になる', () => {
    const today = generateMockChannelOrders(BASE);
    const tomorrow = generateMockChannelOrders({ ...BASE, date: '2026-09-22' });
    const overlap = today
      .map((order) => order.externalOrderId)
      .filter((id) => tomorrow.some((order) => order.externalOrderId === id));
    expect(overlap).toHaveLength(0);
  });

  it('チャネルが違えば注文番号が衝突しない', () => {
    // 接頭辞を分けているのは、モールごとの注文番号が偶然重なると
    // 片方が「取り込み済み」として飛ばされてしまうため。
    const a = generateMockChannelOrders(BASE);
    const b = generateMockChannelOrders({ ...BASE, channelCode: 'mall_b', orderPrefix: 'MNT' });
    const ids = new Set([...a, ...b].map((order) => order.externalOrderId));
    expect(ids.size).toBe(a.length + b.length);
  });

  it('注文番号は接頭辞・日付・連番の形にする', () => {
    expect(generateMockChannelOrders(BASE)[0]?.externalOrderId).toBe('SKR-20260921-01');
  });

  it('注文日時を JST のオフセット付きで返す', () => {
    // タイムゾーンを省くと、取り込み側の解釈に委ねることになる。
    for (const order of generateMockChannelOrders(BASE)) {
      expect(order.orderedAt).toMatch(/^2026-09-21T\d{2}:\d{2}:00\+09:00$/);
    }
  });

  it('チャネルのコードを注文に付ける', () => {
    for (const order of generateMockChannelOrders(BASE)) {
      expect(order.channel).toBe('mall_a');
    }
  });

  it('明細の SKU は渡したものだけを使う', () => {
    const summary = summarizeImport(generateMockChannelOrders(BASE));
    for (const sku of summary.skus) {
      expect(BASE.skus).toContain(sku);
    }
  });

  it('同じ注文の中で同じ SKU を重複させない', () => {
    for (const order of generateMockChannelOrders({ ...BASE, count: 20 })) {
      const skus = order.items.map((item) => item.sku);
      expect(new Set(skus).size).toBe(skus.length);
    }
  });

  it('数量は 1 以上', () => {
    for (const order of generateMockChannelOrders({ ...BASE, count: 20 })) {
      for (const item of order.items) {
        expect(item.quantity).toBeGreaterThan(0);
      }
    }
  });

  it('単価は指定せず、商品マスタの価格を使わせる', () => {
    for (const order of generateMockChannelOrders(BASE)) {
      for (const item of order.items) {
        expect(item.unitPrice).toBeNull();
      }
    }
  });

  it('必ず1件以上の明細を持つ', () => {
    // 明細が空の注文を作ると create_order が INVALID_ORDER で落ち、
    // 同期全体が中止される。
    for (const order of generateMockChannelOrders({ ...BASE, count: 20 })) {
      expect(order.items.length).toBeGreaterThan(0);
    }
  });

  it('対象 SKU が無ければ何も作らない', () => {
    expect(generateMockChannelOrders({ ...BASE, skus: [] })).toHaveLength(0);
  });
});
