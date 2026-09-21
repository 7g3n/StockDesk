/**
 * 外部EC の注文 CSV を、取り込み用のデータに変換する。
 *
 * ここは Phase 2 で最も壊れやすい場所なので、副作用のない変換として切り出してテストする。
 * DB への書き込み（在庫の引き当てを含む）は import_orders RPC の責務で、
 * このモジュールは「CSV をどう読むか」だけを決める。
 *
 * 想定する CSV は1行1明細で、同じ注文番号の行が複数並ぶ形。
 * 外部ECの注文エクスポートはほぼこの形になる。
 *
 *   注文番号,注文日時,顧客名,メールアドレス,SKU,数量,単価,送料
 *   EC-1001,2026-09-01 10:30,山田 太郎,taro@example.com,BLND-200,2,1480,550
 *   EC-1001,2026-09-01 10:30,山田 太郎,taro@example.com,FLTR-100,1,680,550
 *   EC-1002,2026-09-02 09:00,鈴木 花子,hanako@example.com,DRIP-10,3,2200,550
 */

/** 取り込み1件分の明細。 */
export type ImportOrderItem = {
  sku: string;
  quantity: number;
  /** CSV に単価があればその値。無ければ null（DB 側で商品マスタの価格を使う）。 */
  unitPrice: number | null;
};

/** 取り込み1件分の注文。import_orders RPC にそのまま渡せる形。 */
export type ImportOrder = {
  externalOrderId: string;
  /** ISO8601（オフセット付き）。 */
  orderedAt: string;
  customerName: string;
  customerEmail: string;
  phone: string;
  postalCode: string;
  address: string;
  shippingFee: number;
  note: string;
  channel: string;
  items: ImportOrderItem[];
};

/**
 * 取り込めない行の報告。
 *
 * line は「CSV ファイルの行番号」。ヘッダーを1行目として数える。
 * 配列の添字ではなく行番号を返すのは、利用者が Excel で開いて直すときに
 * その番号がそのまま使えるようにするため。
 */
export type ImportIssue = {
  line: number;
  column?: string;
  message: string;
};

export type ImportParseResult = {
  orders: ImportOrder[];
  issues: ImportIssue[];
  /** ヘッダーを除いたデータ行数。 */
  totalRows: number;
};

/**
 * 列名の対応表。
 *
 * 外部サービスごとに列名は微妙に違う（「注文番号」「受注番号」「オーダーID」…）。
 * 完全一致を要求すると、利用者は毎回ヘッダーを書き換えることになるので、
 * よくある表記を受け入れる。ただし推測はしない（列名が無ければエラーにする）。
 */
const COLUMN_ALIASES = {
  externalOrderId: ['注文番号', '受注番号', 'オーダーID', 'order_id', 'order_number'],
  orderedAt: ['注文日時', '受注日時', '注文日', 'ordered_at', 'order_date'],
  customerName: ['顧客名', '購入者名', 'お名前', 'customer_name'],
  customerEmail: ['メールアドレス', 'メール', 'email', 'customer_email'],
  phone: ['電話番号', 'tel', 'phone'],
  postalCode: ['郵便番号', 'postal_code', 'zip'],
  address: ['住所', '配送先住所', 'address'],
  sku: ['SKU', '商品コード', '品番', 'sku'],
  quantity: ['数量', '個数', 'quantity', 'qty'],
  unitPrice: ['単価', '販売価格', 'unit_price', 'price'],
  shippingFee: ['送料', 'shipping_fee'],
  note: ['備考', 'メモ', 'note'],
  channel: ['販売チャネル', 'チャネル', 'channel'],
} as const satisfies Record<string, readonly string[]>;

type FieldName = keyof typeof COLUMN_ALIASES;

const REQUIRED_FIELDS: readonly FieldName[] = [
  'externalOrderId',
  'orderedAt',
  'customerName',
  'sku',
  'quantity',
];

const FIELD_LABELS: Record<FieldName, string> = {
  externalOrderId: '注文番号',
  orderedAt: '注文日時',
  customerName: '顧客名',
  customerEmail: 'メールアドレス',
  phone: '電話番号',
  postalCode: '郵便番号',
  address: '住所',
  sku: 'SKU',
  quantity: '数量',
  unitPrice: '単価',
  shippingFee: '送料',
  note: '備考',
  channel: '販売チャネル',
};

/** ヘッダー行から、各項目が何列目にあたるかを決める。 */
function resolveColumns(headers: readonly string[]): Partial<Record<FieldName, string>> {
  const normalized = new Map(headers.map((header) => [header.toLowerCase(), header]));
  const resolved: Partial<Record<FieldName, string>> = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [
    FieldName,
    readonly string[],
  ][]) {
    for (const alias of aliases) {
      const match = normalized.get(alias.toLowerCase());
      if (match !== undefined) {
        resolved[field] = match;
        break;
      }
    }
  }

  return resolved;
}

/**
 * 日時の解釈。
 *
 * タイムゾーンを持たない表記（"2026-09-01 10:30"）は **JST とみなす**。
 * 日本のECのエクスポートはほぼタイムゾーンを持たず、かつ日本時間で出力されるため。
 * ここを UTC とみなすと、取り込んだ注文が9時間前にずれ、
 * 日別売上が前日に計上されるという分かりにくい形で壊れる。
 *
 * オフセットが明示されていればそれを尊重する。
 */
export function parseOrderedAt(input: string): string | null {
  const value = input.trim();
  if (value === '') return null;

  // オフセットや Z が明示されている場合はそのまま解釈する。
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const match = value.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!match) return null;

  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  const pad = (text: string, length = 2) => text.padStart(length, '0');

  const iso =
    `${year}-${pad(month!)}-${pad(day!)}` + `T${pad(hour)}:${pad(minute)}:${pad(second)}+09:00`;

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;

  // "2026-02-31" のような存在しない日付は Date が繰り上げてしまうので、
  // 解釈結果を JST に戻して元の日付と一致するか確かめる。
  const roundTrip = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed);

  if (roundTrip !== `${year}-${pad(month!)}-${pad(day!)}`) return null;

  return parsed.toISOString();
}

/** 整数として読む。空文字は null（未指定）。 */
function parseInteger(input: string): number | null | 'invalid' {
  const value = input.trim().replace(/,/g, '');
  if (value === '') return null;
  if (!/^-?\d+$/.test(value)) return 'invalid';
  return Number.parseInt(value, 10);
}

/**
 * 注文 CSV を取り込み用のデータに変換する。
 *
 * 注文単位の項目（日時・顧客名・送料など）は、その注文の最初の行の値を採用する。
 * 同じ注文の行同士で食い違っていたらエラーとして報告する。
 * 黙って片方を採用すると、送料が二重計上されたファイルなどを見逃すため。
 */
export function parseOrderCsvRows(table: {
  headers: readonly string[];
  rows: readonly Record<string, string>[];
}): ImportParseResult {
  const columns = resolveColumns(table.headers);
  const issues: ImportIssue[] = [];

  const missing = REQUIRED_FIELDS.filter((field) => columns[field] === undefined);
  if (missing.length > 0) {
    return {
      orders: [],
      issues: [
        {
          line: 1,
          message: `必要な列がありません: ${missing.map((field) => FIELD_LABELS[field]).join('、')}`,
        },
      ],
      totalRows: table.rows.length,
    };
  }

  const get = (row: Record<string, string>, field: FieldName): string => {
    const column = columns[field];
    return column === undefined ? '' : (row[column] ?? '');
  };

  const byExternalId = new Map<string, { order: ImportOrder; firstLine: number }>();

  table.rows.forEach((row, rowIndex) => {
    // +2 はヘッダー行の分と、1始まりにする分。
    const line = rowIndex + 2;

    const externalOrderId = get(row, 'externalOrderId').trim();
    const sku = get(row, 'sku').trim();

    // 完全な空行は黙って飛ばす。Excel が末尾に空行を残すことがあるため。
    if (externalOrderId === '' && sku === '' && get(row, 'customerName').trim() === '') {
      return;
    }

    if (externalOrderId === '') {
      issues.push({ line, column: '注文番号', message: '注文番号が空です' });
      return;
    }

    if (sku === '') {
      issues.push({ line, column: 'SKU', message: 'SKU が空です' });
      return;
    }

    const quantity = parseInteger(get(row, 'quantity'));
    if (quantity === 'invalid' || quantity === null) {
      issues.push({ line, column: '数量', message: '数量を整数で入力してください' });
      return;
    }
    if (quantity <= 0) {
      issues.push({ line, column: '数量', message: '数量は 1 以上で入力してください' });
      return;
    }

    const unitPrice = parseInteger(get(row, 'unitPrice'));
    if (unitPrice === 'invalid') {
      issues.push({ line, column: '単価', message: '単価を整数で入力してください' });
      return;
    }
    if (unitPrice !== null && unitPrice < 0) {
      issues.push({ line, column: '単価', message: '単価に負の値は指定できません' });
      return;
    }

    const shippingFee = parseInteger(get(row, 'shippingFee'));
    if (shippingFee === 'invalid') {
      issues.push({ line, column: '送料', message: '送料を整数で入力してください' });
      return;
    }
    if (shippingFee !== null && shippingFee < 0) {
      issues.push({ line, column: '送料', message: '送料に負の値は指定できません' });
      return;
    }

    const existing = byExternalId.get(externalOrderId);

    if (existing) {
      // 注文単位の項目が食い違っていないか確かめる。
      const orderedAt = parseOrderedAt(get(row, 'orderedAt'));
      if (orderedAt !== null && orderedAt !== existing.order.orderedAt) {
        issues.push({
          line,
          column: '注文日時',
          message: `同じ注文番号 ${externalOrderId} の行で注文日時が一致しません`,
        });
        return;
      }

      if (shippingFee !== null && shippingFee !== existing.order.shippingFee) {
        issues.push({
          line,
          column: '送料',
          message: `同じ注文番号 ${externalOrderId} の行で送料が一致しません`,
        });
        return;
      }

      existing.order.items.push({ sku, quantity, unitPrice });
      return;
    }

    const orderedAtRaw = get(row, 'orderedAt');
    const orderedAt = parseOrderedAt(orderedAtRaw);
    if (orderedAt === null) {
      issues.push({
        line,
        column: '注文日時',
        message:
          orderedAtRaw.trim() === ''
            ? '注文日時が空です'
            : `注文日時を解釈できません: ${orderedAtRaw}`,
      });
      return;
    }

    const customerName = get(row, 'customerName').trim();
    if (customerName === '') {
      issues.push({ line, column: '顧客名', message: '顧客名が空です' });
      return;
    }

    byExternalId.set(externalOrderId, {
      firstLine: line,
      order: {
        externalOrderId,
        orderedAt,
        customerName,
        customerEmail: get(row, 'customerEmail').trim(),
        phone: get(row, 'phone').trim(),
        postalCode: get(row, 'postalCode').trim(),
        address: get(row, 'address').trim(),
        shippingFee: shippingFee ?? 0,
        note: get(row, 'note').trim(),
        channel: get(row, 'channel').trim() || 'imported',
        items: [{ sku, quantity, unitPrice }],
      },
    });
  });

  return {
    orders: [...byExternalId.values()].map((entry) => entry.order),
    issues,
    totalRows: table.rows.length,
  };
}

/** import_orders RPC に渡す形（snake_case）に変換する。 */
export function toImportPayload(orders: readonly ImportOrder[]): unknown[] {
  return orders.map((order) => ({
    external_order_id: order.externalOrderId,
    ordered_at: order.orderedAt,
    customer_name: order.customerName,
    customer_email: order.customerEmail,
    phone: order.phone,
    postal_code: order.postalCode,
    address: order.address,
    shipping_fee: order.shippingFee,
    note: order.note,
    channel: order.channel,
    items: order.items.map((item) => ({
      sku: item.sku,
      quantity: item.quantity,
      unit_price: item.unitPrice,
    })),
  }));
}

/** 取り込み前の確認画面に出す集計。 */
export function summarizeImport(orders: readonly ImportOrder[]): {
  orderCount: number;
  itemCount: number;
  totalQuantity: number;
  skus: string[];
} {
  const skus = new Set<string>();
  let itemCount = 0;
  let totalQuantity = 0;

  for (const order of orders) {
    for (const item of order.items) {
      skus.add(item.sku);
      itemCount += 1;
      totalQuantity += item.quantity;
    }
  }

  return {
    orderCount: orders.length,
    itemCount,
    totalQuantity,
    skus: [...skus].sort(),
  };
}
