import { formatNumber, toDisplayMessage } from '@stockdesk/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { PageHeader } from '@/components/AppShell';
import { Button, Card, CardHeader, ErrorBlock, LoadingBlock, cn } from '@/components/ui';
import { useCan } from '@/features/auth/permissions';

import {
  useChannelOrderCounts,
  useSalesChannels,
  useSyncChannel,
  useToggleChannel,
  type ChannelSyncResult,
  type SalesChannel,
} from './api';

function ChannelRow({ channel, orderCount }: { channel: SalesChannel; orderCount: number }) {
  const syncChannel = useSyncChannel();
  const toggleChannel = useToggleChannel();
  const canImport = useCan('data:import');
  const canManage = useCan('settings:write');

  const [result, setResult] = useState<ChannelSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 自社EC と CSV取り込みは「外部から取りに行く」対象ではない。
  // 前者は画面から直接登録され、後者はファイルを渡される側。
  const isSyncable = channel.code !== 'own_store' && channel.code !== 'imported';

  const sync = async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await syncChannel.mutateAsync({ channel, count: 3 }));
    } catch (caught) {
      setError(toDisplayMessage(caught));
    }
  };

  const toggle = async () => {
    setError(null);
    try {
      await toggleChannel.mutateAsync({ code: channel.code, isActive: !channel.is_active });
    } catch (caught) {
      setError(toDisplayMessage(caught));
    }
  };

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-900">{channel.name}</span>
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                channel.is_active
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  : 'bg-slate-100 text-slate-500 ring-slate-200',
              )}
            >
              {channel.is_active ? '有効' : '停止中'}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            コード <span className="font-mono">{channel.code}</span>
            {channel.order_prefix && (
              <>
                {' '}
                / 注文番号の接頭辞 <span className="font-mono">{channel.order_prefix}</span>
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            このチャネルの注文{' '}
            <Link
              to={`/orders?channel=${channel.code}`}
              className="font-medium text-brand-700 hover:underline"
            >
              {formatNumber(orderCount)} 件
            </Link>
          </p>
        </div>

        <div className="flex items-center gap-2">
          {canManage && (
            <Button size="sm" onClick={() => void toggle()} loading={toggleChannel.isPending}>
              {channel.is_active ? '停止する' : '有効にする'}
            </Button>
          )}
          {isSyncable && (
            <Button
              size="sm"
              variant="primary"
              disabled={!channel.is_active || !canImport}
              loading={syncChannel.isPending}
              onClick={() => void sync()}
            >
              注文を取り込む
            </Button>
          )}
        </div>
      </div>

      {!canImport && isSyncable && (
        <p className="mt-2 text-xs text-slate-500">取り込みは管理者のみが行えます。</p>
      )}

      {error && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <p className="font-medium">{formatNumber(result.created)} 件の注文を取り込みました</p>
          {result.skipped > 0 && (
            <p className="mt-0.5">
              {formatNumber(result.skipped)} 件は取り込み済みのため飛ばしました
            </p>
          )}
          {result.order_numbers.length > 0 && (
            <p className="mt-0.5 font-mono">{result.order_numbers.join('、')}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 販売チャネルの一覧と連携。
 *
 * 実 API ではなくモックだが、境界は本番と同じにしてある。
 * 「外部から注文データを受け取る」ところから先は、CSV 取り込みと同じ経路
 * （import_orders）を通る。実 API に差し替えるとき変わるのはデータの取得元だけで、
 * 冪等性・在庫の引き当て・顧客の名寄せといった規則は変わらない。
 *
 * モックをこの形にしたのは、連携で実際に難しいのが API の呼び出し方ではなく、
 * 「同じ注文を何度も受け取っても二重登録しない」ことの方だから。
 * 同じ日に2回取り込むと、2回目は 0 件になることで確かめられる。
 */
export function ChannelsPage() {
  const channels = useSalesChannels();
  const counts = useChannelOrderCounts();

  return (
    <>
      <PageHeader
        title="販売チャネル"
        description="自社EC と外部モールの注文を、ひとつの注文一覧に統合します。"
      />

      <Card className="mb-5">
        <CardHeader
          title="チャネル"
          description="外部モールとの連携は現時点ではモックです。取り込みの経路は CSV と共通です。"
        />
        {channels.isPending ? (
          <LoadingBlock />
        ) : channels.isError ? (
          <ErrorBlock message={toDisplayMessage(channels.error)} />
        ) : (
          <div className="divide-y divide-slate-100">
            {channels.data.map((channel) => (
              <ChannelRow
                key={channel.code}
                channel={channel}
                orderCount={counts.data?.get(channel.code) ?? 0}
              />
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-slate-900">この連携について</h2>
        <div className="mt-2 space-y-2 text-sm text-slate-600">
          <p>
            外部モールの API は実装していません。「注文を取り込む」を押すと、そのチャネルから
            注文データを受け取ったものとして扱い、CSV 取り込みとまったく同じ経路 （
            <span className="font-mono text-xs">import_orders</span>）で登録します。
          </p>
          <p>
            実 API に差し替えるときに変わるのはデータの取得元だけで、冪等性・在庫の引き当て・
            顧客の名寄せといった取り込みの規則は変わりません。連携で実際に難しいのは API
            の呼び出し方ではなく、同じ注文を何度も受け取っても二重登録しないことなので、
            そちらを本番と同じ形で作ってあります。
          </p>
          <p>
            確かめ方: 同じチャネルで続けて2回取り込むと、2回目は「0 件取り込み / 3 件スキップ」
            になります。
          </p>
        </div>
      </Card>
    </>
  );
}
