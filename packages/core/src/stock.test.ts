import { describe, expect, it } from 'vitest';

import { InsufficientStockError } from './errors.js';
import { calcOrderTotal, lineSubtotal } from './money.js';
import {
  applyStockDelta,
  collectStockAlerts,
  evaluateStockLevel,
  findStockShortages,
  needsRestockAlert,
  replayStockLedger,
  type AlertableProduct,
} from './stock.js';

describe('在庫の増減', () => {
  it('引き当てで在庫が減る', () => {
    expect(applyStockDelta(10, -3)).toBe(7);
  });

  it('入荷で在庫が増える', () => {
    expect(applyStockDelta(10, 5)).toBe(15);
  });

  it('ちょうど 0 になる引き当ては許可する', () => {
    // 在庫を売り切ることは正常な業務。0 を禁止すると最後の 1 個が永久に売れない。
    expect(applyStockDelta(3, -3)).toBe(0);
  });

  it('在庫を超える引き当ては拒否する', () => {
    expect(() => applyStockDelta(3, -4)).toThrow(InsufficientStockError);
  });

  it('拒否時のメッセージに在庫数と要求数が含まれる', () => {
    // 運営者が「いくつ足りないか」を即座に判断できることが復旧の速さに直結する。
    expect(() => applyStockDelta(3, -4)).toThrow(/在庫 3 \/ 要求 4/);
  });

  it('在庫 0 からの引き当ては拒否する', () => {
    expect(() => applyStockDelta(0, -1)).toThrow(InsufficientStockError);
  });
});

describe('台帳からの再計算', () => {
  it('増減を順に適用した結果が現在庫になる', () => {
    // 入荷 50 → 注文 -2 → 注文 -15 → キャンセル +2
    const movements = [{ delta: 50 }, { delta: -2 }, { delta: -15 }, { delta: 2 }];
    expect(replayStockLedger(movements)).toBe(35);
  });

  it('台帳が空なら 0', () => {
    expect(replayStockLedger([])).toBe(0);
  });

  it('キャンセルで在庫が元に戻る', () => {
    // products.stock_quantity と台帳の合計が一致することが、
    // DB 側 verify_stock_integrity() が検査している不変条件そのもの。
    const afterOrder = [{ delta: 20 }, { delta: -5 }];
    const afterCancel = [...afterOrder, { delta: 5 }];
    expect(replayStockLedger(afterOrder)).toBe(15);
    expect(replayStockLedger(afterCancel)).toBe(20);
  });
});

describe('在庫水準の評価', () => {
  it('0 は在庫切れ', () => {
    expect(evaluateStockLevel(0, 5)).toBe('out_of_stock');
  });

  it('閾値ちょうどは「残りわずか」（境界を含む）', () => {
    expect(evaluateStockLevel(5, 5)).toBe('low');
  });

  it('閾値を 1 つでも上回れば「十分」', () => {
    expect(evaluateStockLevel(6, 5)).toBe('ok');
  });

  it('閾値 0 は在庫切れのときだけ警告する', () => {
    expect(evaluateStockLevel(1, 0)).toBe('ok');
    expect(evaluateStockLevel(0, 0)).toBe('out_of_stock');
  });

  it('アラート対象は在庫切れと残りわずか', () => {
    expect(needsRestockAlert(0, 5)).toBe(true);
    expect(needsRestockAlert(5, 5)).toBe(true);
    expect(needsRestockAlert(6, 5)).toBe(false);
  });
});

describe('注文全体での在庫充足の判定', () => {
  const available = new Map([
    ['p1', 10],
    ['p2', 2],
  ]);

  it('すべて足りていれば不足なし', () => {
    const shortages = findStockShortages([{ productId: 'p1', sku: 'A', quantity: 10 }], available);
    expect(shortages).toHaveLength(0);
  });

  it('不足分と不足数を返す', () => {
    const shortages = findStockShortages([{ productId: 'p2', sku: 'B', quantity: 5 }], available);
    expect(shortages).toEqual([
      { productId: 'p2', sku: 'B', quantity: 5, available: 2, shortfall: 3 },
    ]);
  });

  it('同じ商品が複数行に分かれていても合算して判定する', () => {
    // 1行ずつ見ると 6 も 5 も在庫 10 以内で通ってしまうが、合計 11 では足りない。
    // 明細を分けて入力しただけで売り越しが起きてはいけない。
    const shortages = findStockShortages(
      [
        { productId: 'p1', sku: 'A', quantity: 6 },
        { productId: 'p1', sku: 'A', quantity: 5 },
      ],
      available,
    );
    expect(shortages).toHaveLength(1);
    expect(shortages[0]).toMatchObject({ productId: 'p1', quantity: 11, shortfall: 1 });
  });

  it('在庫情報が無い商品は 0 として扱う', () => {
    const shortages = findStockShortages(
      [{ productId: 'unknown', sku: 'X', quantity: 1 }],
      available,
    );
    expect(shortages[0]).toMatchObject({ available: 0, shortfall: 1 });
  });
});

describe('ダッシュボードのアラート一覧', () => {
  const product = (over: Partial<AlertableProduct> & { sku: string }): AlertableProduct => ({
    id: over.sku,
    name: over.sku,
    stockQuantity: 0,
    lowStockThreshold: 0,
    ...over,
  });

  it('十分な在庫の商品は含めない', () => {
    const alerts = collectStockAlerts([
      product({ sku: 'OK', stockQuantity: 50, lowStockThreshold: 10 }),
    ]);
    expect(alerts).toHaveLength(0);
  });

  it('在庫切れを先に、次に残りわずかを並べる', () => {
    const alerts = collectStockAlerts([
      product({ sku: 'LOW', stockQuantity: 3, lowStockThreshold: 10 }),
      product({ sku: 'ZERO', stockQuantity: 0, lowStockThreshold: 10 }),
    ]);
    expect(alerts.map((alert) => alert.product.sku)).toEqual(['ZERO', 'LOW']);
    expect(alerts[0]?.level).toBe('out_of_stock');
  });

  it('同じ水準では、閾値に対する不足が大きいものを先に並べる', () => {
    // 在庫数の昇順ではなく「あとどれだけ足りないか」で並べる。
    // 在庫 8（閾値 30）の方が、在庫 2（閾値 3）より発注の緊急度が高いという判断。
    const alerts = collectStockAlerts([
      product({ sku: 'NEAR', stockQuantity: 2, lowStockThreshold: 3 }),
      product({ sku: 'FAR', stockQuantity: 8, lowStockThreshold: 30 }),
    ]);
    expect(alerts.map((alert) => alert.product.sku)).toEqual(['FAR', 'NEAR']);
  });

  it('並び順が同点のときは SKU 順で安定させる', () => {
    const alerts = collectStockAlerts([
      product({ sku: 'B-01', stockQuantity: 1, lowStockThreshold: 5 }),
      product({ sku: 'A-01', stockQuantity: 1, lowStockThreshold: 5 }),
    ]);
    expect(alerts.map((alert) => alert.product.sku)).toEqual(['A-01', 'B-01']);
  });
});

describe('金額計算', () => {
  it('小計は単価 × 数量', () => {
    expect(lineSubtotal({ unitPrice: 1480, quantity: 3 })).toBe(4440);
  });

  it('合計は明細合計 + 送料', () => {
    const total = calcOrderTotal(
      [
        { unitPrice: 1480, quantity: 2 },
        { unitPrice: 680, quantity: 1 },
      ],
      550,
    );
    expect(total).toBe(1480 * 2 + 680 + 550);
  });

  it('送料なしでも合計が出る', () => {
    expect(calcOrderTotal([{ unitPrice: 2200, quantity: 15 }])).toBe(33000);
  });
});
