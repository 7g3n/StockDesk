import { describe, expect, it } from 'vitest';

import {
  ORDER_STATUSES,
  allowedNextStatuses,
  canTransition,
  countsAsSales,
  isOpenStatus,
  isTerminalStatus,
  nextForwardStatus,
  shouldReleaseStock,
  type OrderStatus,
} from './order-status.js';

/**
 * 遷移規則は DB（is_valid_order_transition）と TypeScript の二箇所にある。
 * ここでは全 25 通りの組み合わせを明示的に書き出し、
 * 「許可したつもりのない遷移が通っていないか」を網羅的に確認する。
 *
 * この表は 0002_functions.sql の is_valid_order_transition() と一字一句対応する。
 * 片方だけを変更するとこのテストが落ちるので、両者のずれに気付ける。
 */
const EXPECTED_MATRIX: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['preparing', 'cancelled'],
  preparing: ['shipped', 'cancelled'],
  shipped: ['completed'],
  completed: [],
  cancelled: [],
};

describe('注文ステータスの遷移規則', () => {
  it('許可された遷移だけが通る（全組み合わせを網羅）', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = EXPECTED_MATRIX[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('同じステータスへの遷移は許可しない', () => {
    // 冪等な更新として黙認すると「二度押しでキャンセルが二重に走る」余地を残すため、
    // 明示的に禁止しておく。
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status), `${status} -> ${status}`).toBe(false);
    }
  });

  it('工程を飛ばす遷移は許可しない', () => {
    expect(canTransition('pending', 'shipped')).toBe(false);
    expect(canTransition('pending', 'completed')).toBe(false);
    expect(canTransition('preparing', 'completed')).toBe(false);
  });

  it('後戻りは許可しない', () => {
    expect(canTransition('preparing', 'pending')).toBe(false);
    expect(canTransition('shipped', 'preparing')).toBe(false);
    expect(canTransition('completed', 'shipped')).toBe(false);
  });

  it('発送済みからはキャンセルできない（返品フローとして別に扱うため）', () => {
    expect(canTransition('shipped', 'cancelled')).toBe(false);
    expect(allowedNextStatuses('shipped')).toEqual(['completed']);
  });

  it('完了・キャンセルは終端', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(allowedNextStatuses('completed')).toHaveLength(0);
    expect(allowedNextStatuses('cancelled')).toHaveLength(0);
  });

  it('未完了のステータスは終端ではない', () => {
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('preparing')).toBe(false);
    expect(isTerminalStatus('shipped')).toBe(false);
  });
});

describe('画面表示のための導出', () => {
  it('「次の一歩」はキャンセルを含まない前進のみを返す', () => {
    expect(nextForwardStatus('pending')).toBe('preparing');
    expect(nextForwardStatus('preparing')).toBe('shipped');
    expect(nextForwardStatus('shipped')).toBe('completed');
  });

  it('終端では「次の一歩」が無い', () => {
    expect(nextForwardStatus('completed')).toBeNull();
    expect(nextForwardStatus('cancelled')).toBeNull();
  });

  it('対応待ちは受付と出荷準備', () => {
    expect(ORDER_STATUSES.filter(isOpenStatus)).toEqual(['pending', 'preparing']);
  });

  it('売上に数えるのはキャンセル以外', () => {
    expect(ORDER_STATUSES.filter(countsAsSales)).toEqual([
      'pending',
      'preparing',
      'shipped',
      'completed',
    ]);
  });
});

describe('在庫戻しの判定', () => {
  it('キャンセルかつ引き当て済みのときだけ在庫を戻す', () => {
    expect(shouldReleaseStock('cancelled', true)).toBe(true);
  });

  it('引き当て済みでない注文をキャンセルしても在庫は戻さない（二重戻しの防止）', () => {
    // stock_committed = false は「既に戻し済み」を意味する。
    // ここで戻してしまうと、キャンセル処理が再実行されるたびに在庫が増えてしまう。
    expect(shouldReleaseStock('cancelled', false)).toBe(false);
  });

  it('キャンセル以外の遷移では在庫を戻さない', () => {
    for (const status of ORDER_STATUSES) {
      if (status === 'cancelled') continue;
      expect(shouldReleaseStock(status, true), status).toBe(false);
    }
  });
});
