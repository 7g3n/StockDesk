import { zodResolver } from '@hookform/resolvers/zod';
import { productFormSchema, toDisplayMessage, type ProductFormValues } from '@stockdesk/core';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button, Field, InlineError, Input, Modal, Select, Textarea } from '@/components/ui';

import { toProductFormValues, useCreateProduct, useUpdateProduct, type Product } from './api';

const EMPTY_VALUES: ProductFormValues = {
  sku: '',
  name: '',
  description: '',
  unitPrice: 0,
  costPrice: 0,
  lowStockThreshold: 0,
  status: 'active',
  leadTimeDays: null,
};

/**
 * 商品の登録・編集フォーム。
 *
 * 在庫数の入力欄が無いのは意図的。
 * 在庫は「登録時に打ち込む数値」ではなく「入荷・注文・調整の結果」なので、
 * この画面から直接書き換えられないようにしてある（在庫調整ダイアログが担当する）。
 */
export function ProductFormDialog({
  open,
  onClose,
  product,
}: {
  open: boolean;
  onClose: () => void;
  product?: Product | undefined;
}) {
  const isEdit = Boolean(product);
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: EMPTY_VALUES,
  });

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    reset(product ? toProductFormValues(product) : EMPTY_VALUES);
  }, [open, product, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      if (product) {
        await updateProduct.mutateAsync({ id: product.id, values });
      } else {
        await createProduct.mutateAsync(values);
      }
      onClose();
    } catch (error) {
      setFormError(toDisplayMessage(error));
    }
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? '商品を編集' : '商品を登録'}
      description={
        isEdit
          ? 'SKU の変更は過去の伝票には反映されません。'
          : '在庫数は登録後に入荷として記録します。'
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="SKU"
            htmlFor="sku"
            required
            error={errors.sku?.message}
            hint="半角英数字と . _ - が使えます"
          >
            <Input id="sku" placeholder="BLND-200" {...register('sku')} />
          </Field>

          <Field label="取り扱い状態" htmlFor="status" error={errors.status?.message}>
            <Select id="status" {...register('status')}>
              <option value="active">取り扱い中</option>
              <option value="archived">取り扱い終了</option>
            </Select>
          </Field>
        </div>

        <Field label="商品名" htmlFor="name" required error={errors.name?.message}>
          <Input id="name" placeholder="スペシャルティ豆 ブレンド 200g" {...register('name')} />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            label="販売価格（円）"
            htmlFor="unitPrice"
            required
            error={errors.unitPrice?.message}
          >
            <Input
              id="unitPrice"
              type="number"
              min={0}
              step={1}
              className="tabular"
              {...register('unitPrice', { valueAsNumber: true })}
            />
          </Field>

          <Field label="原価（円）" htmlFor="costPrice" error={errors.costPrice?.message}>
            <Input
              id="costPrice"
              type="number"
              min={0}
              step={1}
              className="tabular"
              {...register('costPrice', { valueAsNumber: true })}
            />
          </Field>

          <Field
            label="在庫アラート閾値"
            htmlFor="lowStockThreshold"
            error={errors.lowStockThreshold?.message}
            hint="この数以下で警告"
          >
            <Input
              id="lowStockThreshold"
              type="number"
              min={0}
              step={1}
              className="tabular"
              {...register('lowStockThreshold', { valueAsNumber: true })}
            />
          </Field>
        </div>

        <Field
          label="リードタイム（日）"
          htmlFor="leadTimeDays"
          error={errors.leadTimeDays?.message}
          hint="発注から入荷までの日数。空欄なら店舗の既定値を使います（発注推奨の計算に使用）"
        >
          <Input
            id="leadTimeDays"
            type="number"
            min={0}
            step={1}
            placeholder="店舗の既定値を使う"
            className="tabular"
            // 空欄は「未設定」。0 と区別する必要があるので null に変換する。
            {...register('leadTimeDays', {
              setValueAs: (value) => (value === '' || value === null ? null : Number(value)),
            })}
          />
        </Field>

        <Field label="説明" htmlFor="description" error={errors.description?.message}>
          <Textarea id="description" rows={2} {...register('description')} />
        </Field>

        <InlineError message={formError} />

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" loading={isSubmitting}>
            {isEdit ? '保存する' : '登録する'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
