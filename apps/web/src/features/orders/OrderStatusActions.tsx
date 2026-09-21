import {
  ORDER_STATUS_LABELS,
  allowedNextStatuses,
  nextForwardStatus,
  toDisplayMessage,
  type OrderStatus,
} from '@stockdesk/core';
import { useState } from 'react';

import { Button } from '@/components/ui';

import { useUpdateOrderStatus } from './api';

/**
 * ステータス変更の操作。
 *
 * 表示するボタンは allowedNextStatuses から作る。
 * 「押せるが実行すると失敗する」ボタンを画面に出さないための作りで、
 * 遷移表を1箇所（core）に置いた効果がそのまま出る部分。
 *
 * キャンセルだけは在庫が戻る＝取り返しのつく操作ではないため、確認を挟む。
 */
export function OrderStatusActions({
  orderId,
  status,
  size = 'sm',
  showAllTransitions = false,
}: {
  orderId: string;
  status: OrderStatus;
  size?: 'sm' | 'md';
  showAllTransitions?: boolean;
}) {
  const updateStatus = useUpdateOrderStatus();
  const [error, setError] = useState<string | null>(null);

  const forward = nextForwardStatus(status);
  const targets = showAllTransitions ? allowedNextStatuses(status) : forward ? [forward] : [];

  const run = async (next: OrderStatus) => {
    if (next === 'cancelled') {
      const confirmed = window.confirm(
        'この注文をキャンセルします。引き当てた在庫は商品に戻されます。よろしいですか？',
      );
      if (!confirmed) return;
    }

    setError(null);
    try {
      await updateStatus.mutateAsync({ orderId, nextStatus: next });
    } catch (caught) {
      setError(toDisplayMessage(caught));
    }
  };

  if (targets.length === 0) {
    return <span className="text-xs text-slate-400">操作なし</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        {targets.map((next) => (
          <Button
            key={next}
            size={size}
            variant={next === 'cancelled' ? 'danger' : 'primary'}
            loading={updateStatus.isPending && updateStatus.variables?.nextStatus === next}
            onClick={() => void run(next)}
          >
            {next === 'cancelled' ? 'キャンセル' : `${ORDER_STATUS_LABELS[next]}へ`}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
