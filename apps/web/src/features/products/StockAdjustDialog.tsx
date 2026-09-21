import { zodResolver } from '@hookform/resolvers/zod';
import {
  MANUAL_STOCK_REASONS,
  STOCK_MOVEMENT_REASON_LABELS,
  formatNumber,
  stockAdjustmentSchema,
  toDisplayMessage,
  type StockAdjustmentValues,
} from '@stockdesk/core';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  Button,
  Field,
  InlineError,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui';

import { useAdjustStock, useStockMovements, type Product } from './api';

/**
 * 在庫の手動調整。
 *
 * 「在庫数を新しい値に書き換える」ではなく「いくつ増減したかを記録する」形にしてある。
 * 前者は同時に別の注文が入ったときに相手の変更を上書きしてしまう（lost update）。
 * 増減で記録すれば、同時に起きても両方が正しく反映される。
 * この画面が台帳の思想をそのまま体現している部分。
 */
export function StockAdjustDialog({
  open,
  onClose,
  product,
}: {
  open: boolean;
  onClose: () => void;
  product: Product | undefined;
}) {
  const adjustStock = useAdjustStock();
  const movements = useStockMovements(open ? product?.id : undefined, 10);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<StockAdjustmentValues>({
    resolver: zodResolver(stockAdjustmentSchema),
    defaultValues: { productId: '', delta: 0, reason: 'purchase_received', note: '' },
  });

  useEffect(() => {
    if (!open || !product) return;
    setFormError(null);
    reset({ productId: product.id, delta: 0, reason: 'purchase_received', note: '' });
  }, [open, product, reset]);

  const delta = watch('delta');
  // 調整後の在庫を即座に見せる。符号の入力ミス（-10 のつもりで 10）に気付けるようにするため。
  const projected = product ? product.stock_quantity + (Number.isFinite(delta) ? delta : 0) : 0;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await adjustStock.mutateAsync({
        productId: values.productId,
        delta: values.delta,
        reason: values.reason,
        note: values.note,
      });
      onClose();
    } catch (error) {
      setFormError(toDisplayMessage(error));
    }
  });

  if (!product) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="在庫を調整"
      description={`${product.sku} / ${product.name}`}
      widthClassName="max-w-2xl"
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <input type="hidden" {...register('productId')} />

        <div className="flex items-center justify-between rounded-md bg-slate-50 px-4 py-3">
          <div>
            <p className="text-xs text-slate-500">現在の在庫</p>
            <p className="tabular text-xl font-semibold text-slate-900">
              {formatNumber(product.stock_quantity)}
            </p>
          </div>
          <svg viewBox="0 0 20 20" fill="currentColor" className="size-5 text-slate-400">
            <path d="M3 10a.75.75 0 0 1 .75-.75h9.69L10.22 6.03a.75.75 0 1 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06l3.22-3.22H3.75A.75.75 0 0 1 3 10Z" />
          </svg>
          <div className="text-right">
            <p className="text-xs text-slate-500">調整後</p>
            <p
              className={
                projected < 0
                  ? 'tabular text-xl font-semibold text-red-600'
                  : 'tabular text-xl font-semibold text-slate-900'
              }
            >
              {formatNumber(projected)}
            </p>
          </div>
        </div>

        {projected < 0 && (
          <p role="alert" className="text-xs text-red-600">
            在庫がマイナスになる調整は登録できません。
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="理由" htmlFor="reason" required error={errors.reason?.message}>
            <Select id="reason" {...register('reason')}>
              {MANUAL_STOCK_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {STOCK_MOVEMENT_REASON_LABELS[reason]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="増減数"
            htmlFor="delta"
            required
            error={errors.delta?.message}
            hint="増やす場合は正、減らす場合は負の数"
          >
            <Input
              id="delta"
              type="number"
              step={1}
              className="tabular"
              {...register('delta', { valueAsNumber: true })}
            />
          </Field>
        </div>

        <Field
          label="メモ"
          htmlFor="note"
          error={errors.note?.message}
          hint="棚卸日や仕入先など、後から理由を追える情報を残します"
        >
          <Textarea id="note" rows={2} {...register('note')} />
        </Field>

        <InlineError message={formError} />

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" loading={isSubmitting} disabled={projected < 0}>
            記録する
          </Button>
        </div>
      </form>

      <div className="mt-6 border-t border-slate-200 pt-4">
        <h3 className="mb-2 text-xs font-semibold text-slate-600">最近の増減履歴</h3>
        {movements.isPending ? (
          <div className="flex items-center gap-2 py-4 text-xs text-slate-500">
            <Spinner className="size-3.5" />
            読み込み中
          </div>
        ) : movements.data && movements.data.length > 0 ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {movements.data.map((movement) => (
              <li key={movement.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <span className="text-slate-700">
                    {STOCK_MOVEMENT_REASON_LABELS[movement.reason]}
                  </span>
                  {movement.note && (
                    <span className="ml-2 truncate text-xs text-slate-400">{movement.note}</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className={
                      movement.delta > 0
                        ? 'tabular text-sm font-medium text-emerald-700'
                        : 'tabular text-sm font-medium text-red-700'
                    }
                  >
                    {movement.delta > 0 ? '+' : ''}
                    {formatNumber(movement.delta)}
                  </span>
                  <span className="tabular w-12 text-right text-xs text-slate-500">
                    → {formatNumber(movement.quantity_after)}
                  </span>
                  <span className="w-28 text-right text-xs text-slate-400">
                    {new Date(movement.created_at).toLocaleString('ja-JP', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-xs text-slate-500">まだ増減の記録がありません。</p>
        )}
      </div>
    </Modal>
  );
}
