import { formatJpy, formatNumber, toDisplayMessage } from '@stockdesk/core';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { PageHeader } from '@/components/AppShell';
import { useCan } from '@/features/auth/permissions';
import {
  Button,
  Card,
  EmptyState,
  ErrorBlock,
  Input,
  LoadingBlock,
  Select,
  Td,
  Th,
} from '@/components/ui';

import { useCustomerSummaries, type CustomerSort } from './api';
import { CustomerFormDialog } from './CustomerFormDialog';

const SORT_LABELS: Record<CustomerSort, string> = {
  total_amount: '累計購入額が多い順',
  last_ordered_at: '最終注文が新しい順',
  name: '名前順',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('ja-JP');
}

/**
 * 顧客一覧。
 *
 * 既定の並びを「累計購入額が多い順」にしているのは、
 * 小規模ショップで顧客一覧を開く動機のほとんどが
 * 「よく買ってくれている人を確認する」ことだという想定による。
 * 名前順は探すための並びであって、眺めるための並びではない。
 */
export function CustomersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('q') ?? '';
  const rawSort = searchParams.get('sort') ?? 'total_amount';
  const sort = (['total_amount', 'last_ordered_at', 'name'] as const).includes(
    rawSort as CustomerSort,
  )
    ? (rawSort as CustomerSort)
    : 'total_amount';

  const customers = useCustomerSummaries({ search, sort });
  const canWrite = useCan('customer:write');
  const [dialogOpen, setDialogOpen] = useState(false);

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="顧客"
        description="注文履歴と紐付いた顧客の一覧です。累計購入額と最終注文日は注文から自動で集計されます。"
        action={
          canWrite ? (
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              顧客を登録
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          type="search"
          placeholder="顧客名・メールアドレスで検索"
          defaultValue={search}
          onChange={(event) => updateParam('q', event.target.value || null)}
          className="max-w-xs"
          aria-label="顧客を検索"
        />
        <Select
          value={sort}
          onChange={(event) => updateParam('sort', event.target.value)}
          className="max-w-56"
          aria-label="並び順"
        >
          {Object.entries(SORT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <span className="ml-auto text-xs text-slate-500">
          {customers.data ? `${formatNumber(customers.data.length)} 件` : ''}
        </span>
      </div>

      <Card>
        {customers.isPending ? (
          <LoadingBlock />
        ) : customers.isError ? (
          <ErrorBlock message={toDisplayMessage(customers.error)} />
        ) : customers.data.length === 0 ? (
          <EmptyState
            title="顧客がまだ登録されていません"
            description="注文の取り込み時にも、メールアドレスをもとに自動で登録されます。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <Th>顧客名</Th>
                  <Th>連絡先</Th>
                  <Th align="right">注文数</Th>
                  <Th align="right">累計購入額</Th>
                  <Th>初回注文</Th>
                  <Th>最終注文</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {customers.data.map((customer) => (
                  <tr key={customer.customer_id} className="hover:bg-slate-50/60">
                    <Td>
                      <Link
                        to={`/customers/${customer.customer_id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {customer.name}
                      </Link>
                    </Td>
                    <Td className="text-xs text-slate-500">
                      {customer.email ?? '—'}
                      {customer.phone && <span className="ml-2">{customer.phone}</span>}
                    </Td>
                    <Td align="right">{formatNumber(customer.order_count)}</Td>
                    <Td align="right" className="font-medium">
                      {formatJpy(customer.total_amount)}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-slate-500">
                      {formatDate(customer.first_ordered_at)}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-slate-500">
                      {formatDate(customer.last_ordered_at)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CustomerFormDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
