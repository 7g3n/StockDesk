import {
  USER_ROLES,
  USER_ROLE_DESCRIPTIONS,
  USER_ROLE_LABELS,
  permissionsOf,
  toDisplayMessage,
  type UserRole,
} from '@stockdesk/core';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { PageHeader } from '@/components/AppShell';
import {
  Button,
  Card,
  CardHeader,
  ErrorBlock,
  Field,
  InlineError,
  Input,
  LoadingBlock,
  Select,
  Td,
  Th,
  Textarea,
  cn,
} from '@/components/ui';
import { useCan, useMyProfile } from '@/features/auth/permissions';
import { useRecentNotifications } from '@/features/reorder/api';

import {
  useMembers,
  useSetMemberRole,
  useShopSettings,
  useUpdateShopSettings,
  type ShopSettingsInput,
} from './api';

const PERMISSION_LABELS: Record<string, string> = {
  'order:write': '注文の登録・ステータス変更',
  'stock:adjust': '在庫の調整',
  'customer:write': '顧客の登録・編集',
  'product:write': '商品マスタの登録・編集',
  'data:import': '一括取り込み',
  'member:manage': 'メンバーの役割変更',
  'settings:write': '店舗設定の変更',
};

function RoleBadge({ role }: { role: UserRole }) {
  const style =
    role === 'owner'
      ? 'bg-brand-50 text-brand-700 ring-brand-100'
      : role === 'staff'
        ? 'bg-slate-100 text-slate-700 ring-slate-200'
        : 'bg-slate-50 text-slate-500 ring-slate-200';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        style,
      )}
    >
      {USER_ROLE_LABELS[role]}
    </span>
  );
}

function ShopSettingsForm() {
  const settings = useShopSettings();
  const updateSettings = useUpdateShopSettings();
  const canEdit = useCan('settings:write');
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { register, handleSubmit, reset, formState } = useForm<ShopSettingsInput>({
    defaultValues: {
      shopName: '',
      postalCode: '',
      address: '',
      phone: '',
      email: '',
      note: '',
      defaultLeadTimeDays: 7,
      defaultCoverDays: 14,
      largeOrderThreshold: 30000,
    },
  });

  useEffect(() => {
    if (!settings.data) return;
    reset({
      shopName: settings.data.shop_name,
      postalCode: settings.data.postal_code,
      address: settings.data.address,
      phone: settings.data.phone,
      email: settings.data.email,
      note: settings.data.note,
      defaultLeadTimeDays: settings.data.default_lead_time_days,
      defaultCoverDays: settings.data.default_cover_days,
      largeOrderThreshold: settings.data.large_order_threshold,
    });
  }, [settings.data, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setSaved(false);
    try {
      await updateSettings.mutateAsync(values);
      setSaved(true);
    } catch (error) {
      setFormError(toDisplayMessage(error));
    }
  });

  if (settings.isPending) return <LoadingBlock />;
  if (settings.isError) return <ErrorBlock message={toDisplayMessage(settings.error)} />;

  return (
    <form onSubmit={onSubmit} className="space-y-4 px-5 py-4" noValidate>
      <Field label="店舗名" htmlFor="shopName">
        <Input id="shopName" disabled={!canEdit} {...register('shopName')} />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="郵便番号" htmlFor="postalCode">
          <Input id="postalCode" disabled={!canEdit} {...register('postalCode')} />
        </Field>
        <Field label="住所" htmlFor="address" className="sm:col-span-2">
          <Input id="address" disabled={!canEdit} {...register('address')} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="電話番号" htmlFor="phone">
          <Input id="phone" disabled={!canEdit} {...register('phone')} />
        </Field>
        <Field label="メールアドレス" htmlFor="email">
          <Input id="email" type="email" disabled={!canEdit} {...register('email')} />
        </Field>
      </div>

      <Field
        label="納品書に添える一文"
        htmlFor="note"
        hint="「このたびはご注文ありがとうございました」など"
      >
        <Textarea id="note" rows={2} disabled={!canEdit} {...register('note')} />
      </Field>

      <div className="border-t border-slate-200 pt-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">発注と通知</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            label="既定のリードタイム（日）"
            htmlFor="defaultLeadTimeDays"
            hint="発注から入荷まで。商品ごとに上書きできます"
          >
            <Input
              id="defaultLeadTimeDays"
              type="number"
              min={0}
              step={1}
              className="tabular"
              disabled={!canEdit}
              {...register('defaultLeadTimeDays', { valueAsNumber: true })}
            />
          </Field>

          <Field
            label="在庫カバー日数"
            htmlFor="defaultCoverDays"
            hint="入荷後に持っておきたい日数分"
          >
            <Input
              id="defaultCoverDays"
              type="number"
              min={0}
              step={1}
              className="tabular"
              disabled={!canEdit}
              {...register('defaultCoverDays', { valueAsNumber: true })}
            />
          </Field>

          <Field
            label="大口注文の通知基準（円）"
            htmlFor="largeOrderThreshold"
            hint="この金額以上で Slack に通知します"
          >
            <Input
              id="largeOrderThreshold"
              type="number"
              min={0}
              step={1}
              className="tabular"
              disabled={!canEdit}
              {...register('largeOrderThreshold', { valueAsNumber: true })}
            />
          </Field>
        </div>
      </div>

      <InlineError message={formError} />
      {saved && <p className="text-sm text-emerald-700">保存しました。</p>}

      {canEdit ? (
        <div className="flex justify-end border-t border-slate-200 pt-4">
          <Button type="submit" variant="primary" loading={formState.isSubmitting}>
            保存する
          </Button>
        </div>
      ) : (
        <p className="border-t border-slate-200 pt-4 text-xs text-slate-500">
          店舗設定の変更は管理者のみが行えます。
        </p>
      )}
    </form>
  );
}

function MemberList() {
  const members = useMembers();
  const setRole = useSetMemberRole();
  const canManage = useCan('member:manage');
  const myProfile = useMyProfile();
  const [error, setError] = useState<string | null>(null);

  const change = async (userId: string, role: UserRole) => {
    setError(null);
    try {
      await setRole.mutateAsync({ userId, role });
    } catch (caught) {
      setError(toDisplayMessage(caught));
    }
  };

  if (members.isPending) return <LoadingBlock />;
  if (members.isError) return <ErrorBlock message={toDisplayMessage(members.error)} />;

  return (
    <>
      {error && (
        <div role="alert" className="mx-5 mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>メンバー</Th>
              <Th>役割</Th>
              <Th>できること</Th>
              {canManage && <Th align="right">変更</Th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.data.map((member) => (
              <tr key={member.id}>
                <Td>
                  <span className="font-medium text-slate-900">{member.display_name}</span>
                  {member.id === myProfile.data?.id && (
                    <span className="ml-2 text-xs text-slate-400">（自分）</span>
                  )}
                </Td>
                <Td>
                  <RoleBadge role={member.role} />
                </Td>
                <Td className="text-xs text-slate-500">
                  {permissionsOf(member.role).length === 0
                    ? '閲覧のみ'
                    : permissionsOf(member.role)
                        .map((permission) => PERMISSION_LABELS[permission])
                        .join('、')}
                </Td>
                {canManage && (
                  <Td align="right">
                    <Select
                      aria-label={`${member.display_name} の役割`}
                      value={member.role}
                      disabled={setRole.isPending}
                      onChange={(event) => void change(member.id, event.target.value as UserRole)}
                      className="ml-auto max-w-36"
                    >
                      {USER_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {USER_ROLE_LABELS[role]}
                        </option>
                      ))}
                    </Select>
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const NOTIFICATION_KIND_LABELS: Record<string, string> = {
  low_stock: '在庫アラート',
  large_order: '大口注文',
};

/**
 * 送信済み通知の一覧。
 *
 * 通知は定期処理から送られるので、運営者からは「本当に送られたのか」が見えない。
 * 記録を画面に出すことで、Slack に届かなかったときに
 * 「送っていない」のか「送ったが届いていない」のかを切り分けられる。
 */
function NotificationLog() {
  const notifications = useRecentNotifications();

  if (notifications.isPending) return <LoadingBlock />;
  if (notifications.isError) return <ErrorBlock message={toDisplayMessage(notifications.error)} />;
  if (notifications.data.length === 0) {
    return (
      <div className="px-5 py-8 text-center text-sm text-slate-500">
        まだ通知は送られていません。
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {notifications.data.map((notification) => (
        <li key={notification.id} className="flex items-center justify-between gap-3 px-5 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900">
              {NOTIFICATION_KIND_LABELS[notification.kind] ?? notification.kind}
            </p>
            <p className="truncate font-mono text-xs text-slate-400">{notification.dedupe_key}</p>
          </div>
          <span className="shrink-0 text-xs text-slate-500">
            {new Date(notification.sent_at).toLocaleString('ja-JP')}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 設定画面。
 *
 * メンバー管理を「管理者だけが見られるページ」にせず、全員が見られる一覧にしている。
 * 誰が何をできるかは、権限の無い人にとっても必要な情報だから
 * （「これは自分ではできない、誰に頼めばよいか」が分かる）。
 * 変更の操作だけを管理者に限る。
 */
export function SettingsPage() {
  return (
    <>
      <PageHeader
        title="設定"
        description="メンバーの役割と、伝票に印字する店舗情報を管理します。"
      />

      <div className="space-y-5">
        <Card>
          <CardHeader
            title="メンバー"
            description="役割ごとにできる操作が変わります。変更は管理者のみが行えます。"
          />
          <MemberList />
          <div className="border-t border-slate-200 bg-slate-50 px-5 py-4">
            <dl className="space-y-1.5">
              {USER_ROLES.map((role) => (
                <div key={role} className="flex gap-3 text-xs">
                  <dt className="w-16 shrink-0">
                    <RoleBadge role={role} />
                  </dt>
                  <dd className="text-slate-600">{USER_ROLE_DESCRIPTIONS[role]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="店舗情報"
            description="納品書の差出人欄に印字され、発注推奨と通知の基準にも使われます。"
          />
          <ShopSettingsForm />
        </Card>

        <Card>
          <CardHeader
            title="送信済みの通知"
            description="定期処理が Slack に送った通知の記録です。同じ内容は二度送られません。"
          />
          <NotificationLog />
        </Card>
      </div>
    </>
  );
}
