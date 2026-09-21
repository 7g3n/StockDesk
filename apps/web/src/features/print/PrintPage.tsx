import { formatJpy, formatNumber, toDisplayMessage } from '@stockdesk/core';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Button, Card, ErrorBlock, LoadingBlock } from '@/components/ui';

import { parseOrderIds, usePrintableOrders, useShopSettingsForPrint } from './api';
import type { OrderWithItems } from '../orders/api';
import './print.css';

type ShopSettings = {
  shop_name: string;
  postal_code: string;
  address: string;
  phone: string;
  email: string;
  note: string;
};

function formatPostalCode(value: string): string {
  return value ? `〒${value}` : '';
}

/**
 * 納品書。
 *
 * 明細に出すのは注文時点のスナップショット。
 * 商品マスタを後から変更しても、発行済みの伝票と食い違わない。
 */
function DeliveryNote({ order, shop }: { order: OrderWithItems; shop: ShopSettings }) {
  const itemsTotal = order.order_items.reduce((sum, item) => sum + item.subtotal, 0);

  return (
    <div className="print-sheet mx-auto mb-6 max-w-3xl bg-white p-10 shadow-sm ring-1 ring-slate-200">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-widest text-slate-900">納 品 書</h1>
      </div>

      <div className="mb-8 flex justify-between gap-8">
        <div className="flex-1">
          <p className="border-b border-slate-400 pb-1 text-lg font-medium text-slate-900">
            {order.customer_name} 様
          </p>
          {order.shipping_address && (
            <p className="mt-2 text-sm text-slate-700">{order.shipping_address}</p>
          )}
          <p className="mt-4 text-sm text-slate-600">下記のとおり納品いたしました。</p>
        </div>

        <div className="w-64 shrink-0 text-sm">
          <table className="w-full">
            <tbody>
              <tr>
                <td className="py-0.5 text-slate-500">注文番号</td>
                <td className="py-0.5 text-right font-mono text-slate-900">
                  {order.external_order_id ?? order.order_number}
                </td>
              </tr>
              <tr>
                <td className="py-0.5 text-slate-500">注文日</td>
                <td className="py-0.5 text-right text-slate-900">
                  {new Date(order.ordered_at).toLocaleDateString('ja-JP')}
                </td>
              </tr>
              <tr>
                <td className="py-0.5 text-slate-500">発行日</td>
                <td className="py-0.5 text-right text-slate-900">
                  {new Date().toLocaleDateString('ja-JP')}
                </td>
              </tr>
            </tbody>
          </table>

          <div className="mt-4 border-t border-slate-300 pt-3">
            <p className="font-medium text-slate-900">{shop.shop_name}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              {formatPostalCode(shop.postal_code)}
              {shop.address && (
                <>
                  <br />
                  {shop.address}
                </>
              )}
              {shop.phone && (
                <>
                  <br />
                  TEL {shop.phone}
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-y-2 border-slate-800 bg-slate-50">
            <th className="px-3 py-2 text-left font-medium text-slate-700">品番</th>
            <th className="px-3 py-2 text-left font-medium text-slate-700">品名</th>
            <th className="px-3 py-2 text-right font-medium text-slate-700">数量</th>
            <th className="px-3 py-2 text-right font-medium text-slate-700">単価</th>
            <th className="px-3 py-2 text-right font-medium text-slate-700">金額</th>
          </tr>
        </thead>
        <tbody>
          {order.order_items.map((item) => (
            <tr key={item.id} className="border-b border-slate-200">
              <td className="px-3 py-2 font-mono text-xs text-slate-600">{item.sku}</td>
              <td className="px-3 py-2 text-slate-900">{item.product_name}</td>
              <td className="tabular px-3 py-2 text-right">{formatNumber(item.quantity)}</td>
              <td className="tabular px-3 py-2 text-right">{formatJpy(item.unit_price)}</td>
              <td className="tabular px-3 py-2 text-right">{formatJpy(item.subtotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex justify-end">
        <table className="w-64 text-sm">
          <tbody>
            <tr>
              <td className="py-1 text-slate-600">小計</td>
              <td className="tabular py-1 text-right">{formatJpy(itemsTotal)}</td>
            </tr>
            <tr>
              <td className="py-1 text-slate-600">送料</td>
              <td className="tabular py-1 text-right">{formatJpy(order.shipping_fee)}</td>
            </tr>
            <tr className="border-t-2 border-slate-800">
              <td className="py-2 font-medium text-slate-900">合計</td>
              <td className="tabular py-2 text-right text-lg font-bold text-slate-900">
                {formatJpy(order.total_amount)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {shop.note && <p className="mt-8 text-sm text-slate-600">{shop.note}</p>}
      {order.note && <p className="mt-2 text-xs text-slate-500">備考: {order.note}</p>}
    </div>
  );
}

/**
 * 出荷ラベル。
 *
 * 宛先を大きく、それ以外は小さく。貼って読むものなので、
 * 離れた場所からでも宛名と郵便番号が読めることだけを優先する。
 * 品名を入れているのは、梱包時に中身と突き合わせるため。
 */
function ShippingLabel({ order, shop }: { order: OrderWithItems; shop: ShopSettings }) {
  const totalQuantity = order.order_items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className="print-label mb-4 break-inside-avoid rounded border border-slate-300 bg-white p-6">
      <div className="flex items-start justify-between border-b border-slate-200 pb-3">
        <span className="font-mono text-xs text-slate-500">
          {order.external_order_id ?? order.order_number}
        </span>
        <span className="text-xs text-slate-500">
          {new Date(order.ordered_at).toLocaleDateString('ja-JP')}
        </span>
      </div>

      <div className="py-4">
        {order.shipping_address ? (
          <>
            <p className="text-sm text-slate-600">{order.shipping_address}</p>
            <p className="mt-2 text-2xl font-bold text-slate-900">{order.customer_name} 様</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-bold text-slate-900">{order.customer_name} 様</p>
            <p className="mt-1 text-xs text-red-600">※ 配送先住所が未登録です</p>
          </>
        )}
      </div>

      <div className="border-t border-slate-200 pt-3">
        <p className="text-xs text-slate-500">
          品名: {order.order_items.map((item) => item.product_name).join('、')}（計{' '}
          {formatNumber(totalQuantity)} 点）
        </p>
        <p className="mt-2 text-xs text-slate-500">
          差出人: {shop.shop_name} {formatPostalCode(shop.postal_code)} {shop.address}
          {shop.phone && ` TEL ${shop.phone}`}
        </p>
      </div>
    </div>
  );
}

/**
 * 帳票の印刷画面。
 *
 * ルートを `/print/:doc?ids=...` にしているのは、複数の注文をまとめて刷るため。
 * 出荷準備の実務は「今日出す分をまとめて印刷する」なので、
 * 1件ずつ開いて印刷する作りでは使いものにならない。
 */
export function PrintPage({ doc }: { doc: 'delivery-note' | 'shipping-label' }) {
  const [searchParams] = useSearchParams();
  const orderIds = parseOrderIds(searchParams.get('ids'));

  const orders = usePrintableOrders(orderIds);
  const shop = useShopSettingsForPrint();

  const title = doc === 'delivery-note' ? '納品書' : '出荷ラベル';

  useEffect(() => {
    document.title = `${title} - StockDesk`;
    return () => {
      document.title = 'StockDesk';
    };
  }, [title]);

  if (orderIds.length === 0) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Card>
          <ErrorBlock message="印刷する注文が指定されていません。注文一覧から選択してください。" />
        </Card>
      </div>
    );
  }

  if (orders.isPending || shop.isPending) {
    return <LoadingBlock />;
  }

  if (orders.isError || shop.isError) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Card>
          <ErrorBlock message={toDisplayMessage(orders.error ?? shop.error)} />
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-slate-100 py-6">
      {/* 印刷時は消える操作バー */}
      <div className="print-hidden mx-auto mb-6 flex max-w-3xl items-center justify-between gap-4 px-4">
        <div>
          <h1 className="text-lg font-bold text-slate-900">{title}</h1>
          <p className="text-xs text-slate-500">
            {formatNumber(orders.data.length)} 件。印刷ダイアログで「PDF として保存」を選ぶと PDF
            になります。
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => window.close()}>閉じる</Button>
          <Button variant="primary" onClick={() => window.print()}>
            印刷する
          </Button>
        </div>
      </div>

      {doc === 'delivery-note' ? (
        orders.data.map((order) => <DeliveryNote key={order.id} order={order} shop={shop.data} />)
      ) : (
        <div className="print-sheet mx-auto grid max-w-3xl grid-cols-1 gap-4 px-4 sm:grid-cols-2">
          {orders.data.map((order) => (
            <ShippingLabel key={order.id} order={order} shop={shop.data} />
          ))}
        </div>
      )}
    </div>
  );
}
