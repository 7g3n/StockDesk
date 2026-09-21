import { zodResolver } from '@hookform/resolvers/zod';
import { customerFormSchema, toDisplayMessage, type CustomerFormValues } from '@stockdesk/core';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button, Field, InlineError, Input, Modal, Textarea } from '@/components/ui';

import { toCustomerFormValues, useCreateCustomer, useUpdateCustomer, type Customer } from './api';

const EMPTY_VALUES: CustomerFormValues = {
  name: '',
  email: '',
  phone: '',
  postalCode: '',
  address: '',
  note: '',
};

/**
 * 顧客の登録・編集。
 *
 * メールアドレスは CSV 取り込みの名寄せキーになる（同じメールなら同じ顧客とみなす）。
 * そのためここで重複を登録しようとすると DB の一意制約で弾かれる。
 * その場合のエラー文言は errors.ts が変換する。
 */
export function CustomerFormDialog({
  open,
  onClose,
  customer,
}: {
  open: boolean;
  onClose: () => void;
  customer?: Customer | undefined;
}) {
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CustomerFormValues>({
    resolver: zodResolver(customerFormSchema),
    defaultValues: EMPTY_VALUES,
  });

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    reset(customer ? toCustomerFormValues(customer) : EMPTY_VALUES);
  }, [open, customer, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      if (customer) {
        await updateCustomer.mutateAsync({ id: customer.id, values });
      } else {
        await createCustomer.mutateAsync(values);
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
      title={customer ? '顧客を編集' : '顧客を登録'}
      description="メールアドレスは、外部データを取り込むときの顧客の突合に使われます。"
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="顧客名" htmlFor="name" required error={errors.name?.message}>
          <Input id="name" placeholder="山田 太郎" {...register('name')} />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="メールアドレス"
            htmlFor="email"
            error={errors.email?.message}
            hint="取り込み時の名寄せに使います"
          >
            <Input id="email" type="email" {...register('email')} />
          </Field>

          <Field label="電話番号" htmlFor="phone" error={errors.phone?.message}>
            <Input id="phone" type="tel" {...register('phone')} />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="郵便番号" htmlFor="postalCode" error={errors.postalCode?.message}>
            <Input id="postalCode" placeholder="150-0001" {...register('postalCode')} />
          </Field>

          <Field
            label="住所"
            htmlFor="address"
            error={errors.address?.message}
            className="sm:col-span-2"
          >
            <Input id="address" {...register('address')} />
          </Field>
        </div>

        <Field label="メモ" htmlFor="note" error={errors.note?.message}>
          <Textarea id="note" rows={2} {...register('note')} />
        </Field>

        <InlineError message={formError} />

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" loading={isSubmitting}>
            {customer ? '保存する' : '登録する'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
