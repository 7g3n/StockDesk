/**
 * CSV の入出力。
 *
 * 文字コードの扱いをここに置いているのは、TextDecoder がブラウザの API で、
 * packages/core（環境に依存しない純粋関数の置き場）に持ち込みたくないため。
 * core は文字列しか扱わない。
 */
import type { ImportOrder } from '@stockdesk/core';
import {
  parseCsvWithHeader,
  parseOrderCsvRows,
  toCsvWithHeader,
  toImportPayload,
  toStockDeskError,
  type ImportParseResult,
} from '@stockdesk/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { stockAffectedQueryKeys } from '@/lib/query-keys';
import { supabase } from '@/lib/supabase';

/**
 * アップロードされたファイルを文字列として読む。
 *
 * 日本のEC・モールのエクスポートは CP932（Shift_JIS）が今も多い。
 * UTF-8 として読むと日本語が化け、列名が一致せず「必要な列がありません」になる。
 * 原因が文字コードだと気付きにくいので、UTF-8 で読んで文字化けの兆候があれば
 * Shift_JIS で読み直す。
 *
 * 判定に U+FFFD（置換文字）を使うのは、TextDecoder が fatal:false のとき
 * 復号できないバイトをこの文字に置き換えるため。UTF-8 として正しいファイルには現れない。
 */
export async function readCsvFile(file: File): Promise<{ text: string; encoding: string }> {
  const buffer = await file.arrayBuffer();

  const REPLACEMENT_CHARACTER = '�';

  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes(REPLACEMENT_CHARACTER)) {
    return { text: utf8, encoding: 'UTF-8' };
  }

  const sjis = new TextDecoder('shift_jis').decode(buffer);
  return { text: sjis, encoding: 'Shift_JIS' };
}

export function parseOrderImportFile(text: string): ImportParseResult {
  return parseOrderCsvRows(parseCsvWithHeader(text));
}

export type ImportResult = {
  created: number;
  skipped: number;
  order_numbers: string[];
};

/**
 * 取り込みの実行。
 *
 * 1回の RPC で全件を送り、DB 側の1トランザクションで処理する。
 * 途中で失敗したら何も残らない（部分的に取り込まれた状態を作らない）。
 */
export function useImportOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (orders: readonly ImportOrder[]) => {
      const { data, error } = await supabase.rpc('import_orders', {
        p_orders: toImportPayload(orders),
      });
      if (error) throw toStockDeskError(error);
      return data as unknown as ImportResult;
    },
    onSuccess: () => {
      for (const key of stockAffectedQueryKeys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/** ブラウザにファイルとして保存させる。 */
function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function timestamp(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replace(/-/g, '');
}

/**
 * 注文のエクスポート。
 *
 * 出力の単位を「1行1明細」にしているのは、取り込みと同じ形にするため。
 * エクスポートしたファイルをそのまま別環境に取り込めることが、
 * この機能が移行やバックアップに使えるかどうかの分かれ目になる。
 */
export async function exportOrdersCsv(): Promise<number> {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .order('ordered_at', { ascending: false });

  if (error) throw toStockDeskError(error);

  const rows = (data ?? []).flatMap((order) =>
    order.order_items.map((item) => ({
      注文番号: order.external_order_id ?? order.order_number,
      社内注文番号: order.order_number,
      注文日時: new Date(order.ordered_at).toISOString(),
      ステータス: order.status,
      顧客名: order.customer_name,
      メールアドレス: order.customer_email,
      住所: order.shipping_address,
      SKU: item.sku,
      商品名: item.product_name,
      数量: item.quantity,
      単価: item.unit_price,
      小計: item.subtotal,
      送料: order.shipping_fee,
      合計: order.total_amount,
      販売チャネル: order.channel,
      備考: order.note,
    })),
  );

  const csv = toCsvWithHeader(
    [
      { key: '注文番号', label: '注文番号' },
      { key: '社内注文番号', label: '社内注文番号' },
      { key: '注文日時', label: '注文日時' },
      { key: 'ステータス', label: 'ステータス' },
      { key: '顧客名', label: '顧客名' },
      { key: 'メールアドレス', label: 'メールアドレス' },
      { key: '住所', label: '住所' },
      { key: 'SKU', label: 'SKU' },
      { key: '商品名', label: '商品名' },
      { key: '数量', label: '数量' },
      { key: '単価', label: '単価' },
      { key: '小計', label: '小計' },
      { key: '送料', label: '送料' },
      { key: '合計', label: '合計' },
      { key: '販売チャネル', label: '販売チャネル' },
      { key: '備考', label: '備考' },
    ],
    rows,
  );

  download(`stockdesk-orders-${timestamp()}.csv`, csv);
  return rows.length;
}

export async function exportProductsCsv(): Promise<number> {
  const { data, error } = await supabase.from('products').select('*').order('sku');
  if (error) throw toStockDeskError(error);

  const rows = (data ?? []).map((product) => ({
    SKU: product.sku,
    商品名: product.name,
    説明: product.description,
    販売価格: product.unit_price,
    原価: product.cost_price,
    在庫数: product.stock_quantity,
    在庫アラート閾値: product.low_stock_threshold,
    取り扱い状態: product.status === 'active' ? '取り扱い中' : '取り扱い終了',
  }));

  const csv = toCsvWithHeader(
    [
      { key: 'SKU', label: 'SKU' },
      { key: '商品名', label: '商品名' },
      { key: '説明', label: '説明' },
      { key: '販売価格', label: '販売価格' },
      { key: '原価', label: '原価' },
      { key: '在庫数', label: '在庫数' },
      { key: '在庫アラート閾値', label: '在庫アラート閾値' },
      { key: '取り扱い状態', label: '取り扱い状態' },
    ],
    rows,
  );

  download(`stockdesk-products-${timestamp()}.csv`, csv);
  return rows.length;
}

export async function exportCustomersCsv(): Promise<number> {
  const { data, error } = await supabase
    .from('customer_summary')
    .select('*')
    .order('total_amount', { ascending: false });

  if (error) throw toStockDeskError(error);

  const rows = (data ?? []).map((customer) => ({
    顧客名: customer.name,
    メールアドレス: customer.email ?? '',
    電話番号: customer.phone,
    注文数: customer.order_count,
    累計購入額: customer.total_amount,
    初回注文日: customer.first_ordered_at ? new Date(customer.first_ordered_at).toISOString() : '',
    最終注文日: customer.last_ordered_at ? new Date(customer.last_ordered_at).toISOString() : '',
  }));

  const csv = toCsvWithHeader(
    [
      { key: '顧客名', label: '顧客名' },
      { key: 'メールアドレス', label: 'メールアドレス' },
      { key: '電話番号', label: '電話番号' },
      { key: '注文数', label: '注文数' },
      { key: '累計購入額', label: '累計購入額' },
      { key: '初回注文日', label: '初回注文日' },
      { key: '最終注文日', label: '最終注文日' },
    ],
    rows,
  );

  download(`stockdesk-customers-${timestamp()}.csv`, csv);
  return rows.length;
}
