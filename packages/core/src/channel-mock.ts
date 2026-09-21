/**
 * 外部販売チャネル（モール等）からの注文取得のモック。
 *
 * 実 API ではなくモックだが、**境界は本番と同じにしてある**。
 * このモジュールが作るのは「外部から受け取った注文データ」（ImportOrder）で、
 * そこから先は CSV 取り込みとまったく同じ経路（import_orders RPC）を通る。
 *
 * 実 API に差し替えるとき、変わるのは「データの取得元」だけ。
 * 冪等性・在庫の引き当て・顧客の名寄せといった取り込みの規則は一切変わらない。
 * モックで作る意味はそこにあり、画面用のダミーデータを撒くことではない。
 *
 * 生成は決定的（同じ入力なら同じ出力）にしてある。理由は2つ:
 *   1. テストできる
 *   2. 同じ日に2回同期しても同じ external_order_id になり、2回目は取り込まれない。
 *      実 API のポーリングでも同じ注文を何度も受け取るので、
 *      そこで二重登録が起きないことこそ確かめたい挙動になる。
 */

import type { ImportOrder, ImportOrderItem } from './order-import.js';

/** 32bit の決定的な疑似乱数。seed が同じなら常に同じ並びを返す。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 文字列から安定した数値の種を作る。チャネルと日付が同じなら同じ種になる。 */
function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** モールから来る想定の購入者。実在の人物を模さないよう、汎用的な名前にしてある。 */
const MOCK_BUYERS = [
  {
    name: '青木 一郎',
    email: 'ichiro.aoki@example.com',
    postalCode: '060-0001',
    address: '北海道札幌市中央区北1条西1-1',
  },
  {
    name: '井上 さくら',
    email: 'sakura.inoue@example.com',
    postalCode: '231-0001',
    address: '神奈川県横浜市中区新港1-2-3',
  },
  {
    name: '上村 健',
    email: 'ken.uemura@example.com',
    postalCode: '460-0008',
    address: '愛知県名古屋市中区栄3-4-5',
  },
  {
    name: '江口 美和',
    email: 'miwa.eguchi@example.com',
    postalCode: '810-0001',
    address: '福岡県福岡市中央区天神2-3-4',
  },
  {
    name: '大谷 隆',
    email: 'takashi.otani@example.com',
    postalCode: '980-0021',
    address: '宮城県仙台市青葉区中央1-5-6',
  },
] as const;

export type MockChannelOptions = {
  /** チャネルのコード（sales_channels.code）。 */
  channelCode: string;
  /** external_order_id の接頭辞（sales_channels.order_prefix）。 */
  orderPrefix: string;
  /** 取り込み対象にできる SKU。実在の商品から渡す。 */
  skus: readonly string[];
  /** 対象日（JST の 'YYYY-MM-DD'）。注文番号と生成内容がこの日付に紐付く。 */
  date: string;
  /** 生成する注文数。 */
  count?: number;
  /** 送料。モールごとに固定という想定。 */
  shippingFee?: number;
};

/**
 * モックの注文を生成する。
 *
 * 単価は渡さない（null）。モール側の値引きを模す意味はここでは薄く、
 * 商品マスタの現在価格で記録される方が、在庫と売上の対応を追いやすいため。
 * CSV 取り込み側では単価を指定できる（Phase 2）。
 */
export function generateMockChannelOrders(options: MockChannelOptions): ImportOrder[] {
  const { channelCode, orderPrefix, skus, date, count = 3, shippingFee = 550 } = options;

  if (skus.length === 0) return [];

  const compactDate = date.replace(/-/g, '');
  const random = createRandom(seedFrom(`${channelCode}:${date}`));

  const orders: ImportOrder[] = [];

  for (let index = 0; index < count; index += 1) {
    const buyer = MOCK_BUYERS[Math.floor(random() * MOCK_BUYERS.length)]!;

    // 1注文あたり 1〜2 明細。
    const itemCount = 1 + Math.floor(random() * 2);
    const items: ImportOrderItem[] = [];
    const usedSkus = new Set<string>();

    for (let line = 0; line < itemCount; line += 1) {
      const sku = skus[Math.floor(random() * skus.length)]!;
      if (usedSkus.has(sku)) continue;
      usedSkus.add(sku);

      items.push({
        sku,
        quantity: 1 + Math.floor(random() * 2),
        unitPrice: null,
      });
    }

    // 注文時刻は 9:00〜20:59 の範囲に散らす。JST として解釈される形で書く。
    const hour = 9 + Math.floor(random() * 12);
    const minute = Math.floor(random() * 60);
    const pad = (value: number) => String(value).padStart(2, '0');

    orders.push({
      // 接頭辞・日付・連番で一意。同じ日に同じチャネルを再同期すると同じ番号になり、
      // import_orders 側で「取り込み済み」として飛ばされる。
      externalOrderId: `${orderPrefix}-${compactDate}-${pad(index + 1)}`,
      orderedAt: `${date}T${pad(hour)}:${pad(minute)}:00+09:00`,
      customerName: buyer.name,
      customerEmail: buyer.email,
      phone: '',
      postalCode: buyer.postalCode,
      address: buyer.address,
      shippingFee,
      note: '',
      channel: channelCode,
      items,
    });
  }

  return orders;
}
