import { describe, expect, it } from 'vitest';

import { computeReorderSuggestion, DEFAULT_REORDER_SETTINGS } from './reorder.js';
import {
  buildLargeOrderMessage,
  buildLowStockMessage,
  largeOrderDedupeKey,
  lowStockDedupeKey,
  selectReorderHighlights,
} from './slack.js';
import type { StockAlert } from './stock.js';

const NOW = new Date('2026-09-21T03:00:00Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

const ALERT: StockAlert = {
  level: 'low',
  product: {
    id: 'p1',
    sku: 'BLND-200',
    name: 'ブレンド 200g',
    stockQuantity: 8,
    lowStockThreshold: 12,
  },
};

const SUGGESTION = computeReorderSuggestion(
  {
    product_id: 'p1',
    sku: 'BLND-200',
    name: 'ブレンド 200g',
    stock_quantity: 8,
    low_stock_threshold: 12,
    lead_time_days: null,
    sold_quantity: 60,
    observed_from: daysAgo(30),
    last_sold_at: daysAgo(1),
  },
  DEFAULT_REORDER_SETTINGS,
  NOW,
);

describe('在庫アラートの通知', () => {
  const message = buildLowStockMessage([ALERT], [SUGGESTION], {
    shopName: 'テスト商店',
    appUrl: 'https://example.com',
  });

  it('text に件数を含める', () => {
    // blocks だけだと、モバイルの通知バナーに本文が出ない。
    // text は通知一覧で読まれる唯一の文字列になる。
    expect(message.text).toBe('テスト商店 在庫アラート 1 件');
  });

  it('SKU・在庫数・閾値を載せる', () => {
    const body = JSON.stringify(message.blocks);
    expect(body).toContain('BLND-200');
    expect(body).toContain('在庫 8');
    expect(body).toContain('閾値 12');
  });

  it('在庫切れまでの日数と推奨発注数を添える', () => {
    // 在庫数だけでは急ぎかどうか判断できない。
    // 残り20個でも1日10個売れるなら2日しかもたない。
    const body = JSON.stringify(message.blocks);
    expect(body).toContain('あと約 4 日');
    expect(body).toContain('推奨発注数 34');
  });

  it('入荷が間に合わない商品に警告を付ける', () => {
    // 1日2個・在庫8個 → 4日。リードタイム7日では間に合わない。
    expect(JSON.stringify(message.blocks)).toContain('入荷が間に合いません');
  });

  it('信頼度を併記して数字が独り歩きしないようにする', () => {
    expect(JSON.stringify(message.blocks)).toContain('実績十分');
  });

  it('予測できない商品では日数を書かない', () => {
    const unknown = computeReorderSuggestion(
      {
        product_id: 'p2',
        sku: 'NEW-01',
        name: '新商品',
        stock_quantity: 3,
        low_stock_threshold: 5,
        lead_time_days: null,
        sold_quantity: 0,
        observed_from: daysAgo(30),
        last_sold_at: null,
      },
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );
    const body = JSON.stringify(
      buildLowStockMessage(
        [{ level: 'low', product: { ...ALERT.product, id: 'p2', sku: 'NEW-01' } }],
        [unknown],
        { shopName: 'テスト商店' },
      ).blocks,
    );
    expect(body).not.toContain('あと約');
  });

  it('商品名の記号を無効化する', () => {
    // 商品名に < > & が入ると Slack の mrkdwn として解釈されてしまう。
    const body = JSON.stringify(
      buildLowStockMessage(
        [{ level: 'low', product: { ...ALERT.product, name: '<b>特価</b> & セット' } }],
        [],
        { shopName: 'テスト商店' },
      ).blocks,
    );
    expect(body).toContain('&lt;b&gt;');
    expect(body).toContain('&amp;');
  });

  it('アプリの URL があればリンクを付ける', () => {
    expect(JSON.stringify(message.blocks)).toContain('https://example.com/products?alerts=1');
  });

  it('URL が無ければリンクを付けない', () => {
    const withoutUrl = buildLowStockMessage([ALERT], [SUGGESTION], { shopName: 'テスト商店' });
    expect(JSON.stringify(withoutUrl.blocks)).not.toContain('http');
  });
});

describe('大口注文の通知', () => {
  const message = buildLargeOrderMessage(
    {
      orderNumber: 'SD-20260921-0001',
      externalOrderId: 'EC-1001',
      customerName: '株式会社みどり商会',
      totalAmount: 39800,
      channelName: '自社EC',
      itemSummary: 'ドリップバッグ 10個セット ほか 1 種（計 25 点）',
      orderedAt: NOW.toISOString(),
    },
    { shopName: 'テスト商店', threshold: 30000, appUrl: 'https://example.com' },
  );

  it('text に金額と顧客名を含める', () => {
    expect(message.text).toContain('￥39,800');
    expect(message.text).toContain('株式会社みどり商会');
  });

  it('品目と点数を載せる', () => {
    // 大口注文で最初に判断するのは「在庫は足りるか」「梱包をどうするか」。
    expect(JSON.stringify(message.blocks)).toContain('計 25 点');
  });

  it('外部注文番号があればそちらを載せる', () => {
    expect(JSON.stringify(message.blocks)).toContain('EC-1001');
  });

  it('外部注文番号が無ければ社内の注文番号を載せる', () => {
    const body = JSON.stringify(
      buildLargeOrderMessage(
        {
          orderNumber: 'SD-20260921-0002',
          externalOrderId: null,
          customerName: '佐藤',
          totalAmount: 50000,
          channelName: '自社EC',
          itemSummary: 'x',
          orderedAt: NOW.toISOString(),
        },
        { shopName: 'テスト商店', threshold: 30000 },
      ).blocks,
    );
    expect(body).toContain('SD-20260921-0002');
  });

  it('通知の基準額を添える', () => {
    expect(JSON.stringify(message.blocks)).toContain('￥30,000 以上');
  });
});

describe('重複防止の鍵', () => {
  it('在庫アラートは1日1回', () => {
    expect(lowStockDedupeKey('2026-09-21')).toBe('low_stock:2026-09-21');
  });

  it('大口注文は注文ごとに1回', () => {
    expect(largeOrderDedupeKey('abc-123')).toBe('large_order:abc-123');
  });
});

describe('通知に載せる発注推奨の選択', () => {
  const make = (sku: string, stock: number, sold: number, lead: number | null = null) =>
    computeReorderSuggestion(
      {
        product_id: sku,
        sku,
        name: sku,
        stock_quantity: stock,
        low_stock_threshold: 10,
        lead_time_days: lead,
        sold_quantity: sold,
        observed_from: daysAgo(30),
        last_sold_at: daysAgo(1),
      },
      DEFAULT_REORDER_SETTINGS,
      NOW,
    );

  it('発注が不要な商品は載せない', () => {
    const picked = selectReorderHighlights([make('ENOUGH', 500, 60), make('LOW', 10, 60)]);
    expect(picked.map((s) => s.sku)).toEqual(['LOW']);
  });

  it('間に合わないものを先に出す', () => {
    // URGENT は 2日（リードタイム7日に間に合わない）、SOON は 15日。
    const picked = selectReorderHighlights([make('SOON', 30, 60), make('URGENT', 5, 60)]);
    expect(picked.map((s) => s.sku)).toEqual(['URGENT', 'SOON']);
  });

  it('件数を絞る（通知が長くなりすぎないように）', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      make(`SKU-${String(index).padStart(2, '0')}`, 10, 60),
    );
    expect(selectReorderHighlights(many, 5)).toHaveLength(5);
  });
});
