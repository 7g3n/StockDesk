import { zodResolver } from '@hookform/resolvers/zod';
import {
  calcOrderTotal,
  findStockShortages,
  formatJpy,
  formatNumber,
  orderFormSchema,
  toDisplayMessage,
  type OrderFormValues,
} from '@stockdesk/core';
import { useEffect, useMemo, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';

import { Button, Field, InlineError, Input, Modal, Select, Textarea } from '@/components/ui';
import { useProducts } from '@/features/products/api';

import { useCreateOrder } from './api';

const EMPTY_VALUES: OrderFormValues = {
  customerName: '',
  customerId: null,
  customerEmail: '',
  shippingAddress: '',
  shippingFee: 550,
  note: '',
  items: [{ productId: '', quantity: 1 }],
};

/**
 * 注文の手動登録。
 *
 * Phase 1 では自社ECの注文を運営者が手で入力する想定（Phase 2 の CSV 取り込みで自動化する）。
 *
 * この画面の要点は、確定前に在庫の充足を確認して見せること。
 * 最終的な判定は DB が行うが、送信してからエラーになるより、
 * 数量を入れた時点で「足りない」と分かる方が入力のやり直しが少ない。
 */
export function NewOrderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createOrder = useCreateOrder();
  const products = useProducts({});
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<OrderFormValues>({
    resolver: zodResolver(orderFormSchema),
    defaultValues: EMPTY_VALUES,
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    reset(EMPTY_VALUES);
  }, [open, reset]);

  const watchedItems = watch('items');
  const shippingFee = watch('shippingFee');

  // 取り扱い中の商品だけを選べるようにする。終了した商品は DB 側でも弾かれる。
  const sellableProducts = useMemo(
    () => (products.data ?? []).filter((product) => product.status === 'active'),
    [products.data],
  );

  const productById = useMemo(
    () => new Map(sellableProducts.map((product) => [product.id, product])),
    [sellableProducts],
  );

  const lines = useMemo(
    () =>
      (watchedItems ?? []).map((item) => {
        const product = item?.productId ? productById.get(item.productId) : undefined;
        const quantity = Number.isFinite(item?.quantity) ? item.quantity : 0;
        return {
          product,
          quantity,
          unitPrice: product?.unit_price ?? 0,
          subtotal: (product?.unit_price ?? 0) * quantity,
        };
      }),
    [watchedItems, productById],
  );

  const total = calcOrderTotal(
    lines.map((line) => ({ unitPrice: line.unitPrice, quantity: line.quantity })),
    Number.isFinite(shippingFee) ? shippingFee : 0,
  );

  // 同じ商品が複数行に分かれていても合算して判定される（core の findStockShortages が担当）。
  const shortages = useMemo(() => {
    const requirements = lines
      .filter((line) => line.product && line.quantity > 0)
      .map((line) => ({
        productId: line.product!.id,
        sku: line.product!.sku,
        quantity: line.quantity,
      }));
    const available = new Map(sellableProducts.map((p) => [p.id, p.stock_quantity]));
    return findStockShortages(requirements, available);
  }, [lines, sellableProducts]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await createOrder.mutateAsync(values);
      onClose();
    } catch (error) {
      setFormError(toDisplayMessage(error));
    }
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="注文を登録"
      description="登録した時点で、対象商品の在庫が自動的に引き当てられます。"
      widthClassName="max-w-3xl"
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="顧客名"
            htmlFor="customerName"
            required
            error={errors.customerName?.message}
          >
            <Input id="customerName" placeholder="佐藤 美咲" {...register('customerName')} />
          </Field>
          <Field
            label="メールアドレス"
            htmlFor="customerEmail"
            error={errors.customerEmail?.message}
          >
            <Input id="customerEmail" type="email" {...register('customerEmail')} />
          </Field>
        </div>

        <Field label="配送先住所" htmlFor="shippingAddress" error={errors.shippingAddress?.message}>
          <Input id="shippingAddress" {...register('shippingAddress')} />
        </Field>

        {/* ---- 明細 ---- */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">注文明細</h3>
            <Button size="sm" type="button" onClick={() => append({ productId: '', quantity: 1 })}>
              行を追加
            </Button>
          </div>

          <div className="space-y-2">
            {fields.map((field, index) => {
              const line = lines[index];
              return (
                <div key={field.id} className="flex items-start gap-2">
                  <div className="flex-1">
                    <Select
                      aria-label={`商品 ${index + 1}`}
                      {...register(`items.${index}.productId`)}
                    >
                      <option value="">商品を選択</option>
                      {sellableProducts.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.sku} / {product.name}（在庫{' '}
                          {formatNumber(product.stock_quantity)}）
                        </option>
                      ))}
                    </Select>
                    {errors.items?.[index]?.productId && (
                      <p className="mt-1 text-xs text-red-600">
                        {errors.items[index]?.productId?.message}
                      </p>
                    )}
                  </div>

                  <div className="w-24">
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      className="tabular"
                      aria-label={`数量 ${index + 1}`}
                      {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                    />
                    {errors.items?.[index]?.quantity && (
                      <p className="mt-1 text-xs text-red-600">
                        {errors.items[index]?.quantity?.message}
                      </p>
                    )}
                  </div>

                  <div className="tabular w-28 pt-2 text-right text-sm text-slate-600">
                    {line?.product ? formatJpy(line.subtotal) : '—'}
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="mt-1"
                    aria-label={`${index + 1} 行目を削除`}
                    disabled={fields.length === 1}
                    onClick={() => remove(index)}
                  >
                    削除
                  </Button>
                </div>
              );
            })}
          </div>

          {errors.items?.root && (
            <p className="mt-2 text-xs text-red-600">{errors.items.root.message}</p>
          )}
        </div>

        {/* ---- 在庫不足の事前警告 ---- */}
        {shortages.length > 0 && (
          <div role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-medium">在庫が不足しています</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {shortages.map((shortage) => (
                <li key={shortage.productId}>
                  {shortage.sku}: 在庫 {formatNumber(shortage.available)} に対して{' '}
                  {formatNumber(shortage.quantity)} 必要（{formatNumber(shortage.shortfall)} 不足）
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="送料（円）" htmlFor="shippingFee" error={errors.shippingFee?.message}>
            <Input
              id="shippingFee"
              type="number"
              min={0}
              step={1}
              className="tabular"
              {...register('shippingFee', { valueAsNumber: true })}
            />
          </Field>

          <div className="flex items-end justify-end">
            <div className="text-right">
              <p className="text-xs text-slate-500">合計金額</p>
              <p className="tabular text-2xl font-bold text-slate-900">{formatJpy(total)}</p>
            </div>
          </div>
        </div>

        <Field label="備考" htmlFor="note" error={errors.note?.message}>
          <Textarea id="note" rows={2} {...register('note')} />
        </Field>

        <InlineError message={formError} />

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={isSubmitting}
            disabled={shortages.length > 0}
          >
            注文を登録して在庫を引き当てる
          </Button>
        </div>
      </form>
    </Modal>
  );
}
