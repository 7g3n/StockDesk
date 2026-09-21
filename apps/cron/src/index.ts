/**
 * 定期処理（Cloudflare Workers + Cron Triggers）。
 *
 *   1. 在庫アラート — 閾値を下回った商品を、発注推奨とあわせて Slack に流す
 *   2. 大口注文 — 基準額以上の注文が入ったら Slack に流す
 *
 * なぜ Worker なのか:
 *   ブラウザを開いている間しか動かない処理では「朝いちばんに発注すべきもの」は届かない。
 *   常駐サーバーを持たない構成なので、定期実行だけを Cloudflare の Cron Triggers に任せる。
 *
 * 判定ロジックはすべて @stockdesk/core にある。画面と同じ関数を使うので、
 * 「ダッシュボードには出ているのに通知が来ない」というずれが起きない。
 *
 * 通知の冪等性:
 *   Cron は同じ時刻に二度走ることがあり、手動実行や再デプロイでも重複しうる。
 *   同じ在庫切れを1日に何度も Slack に流すと、運営者は通知を見なくなる。
 *   送る前に claim_notification() で「これから送る」と記録し、
 *   既に記録があれば送らない。詳細は migration の該当箇所を参照。
 */
import type { Database } from '@stockdesk/core';
import {
  buildLargeOrderMessage,
  buildLowStockMessage,
  collectStockAlerts,
  collectReorderSuggestions,
  largeOrderDedupeKey,
  lowStockDedupeKey,
  type AlertableProduct,
  type LargeOrderInfo,
  type ReorderSettings,
  type SlackMessage,
  type StockVelocityRow,
} from '@stockdesk/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Env = {
  SUPABASE_URL: string;
  /** service_role キー。`wrangler secret put SUPABASE_SERVICE_ROLE_KEY` で登録する。 */
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Slack の Incoming Webhook。未設定ならログ出力のみになる。 */
  SLACK_WEBHOOK_URL?: string;
  /** 通知内のリンク先。未設定ならリンクを出さない。 */
  APP_URL?: string;
};

type Client = SupabaseClient<Database>;

function createSupabaseClient(env: Env): Client {
  // 定期処理にはログインユーザーがいないため service_role で接続する。
  // このキーは Worker の secret としてのみ存在し、ブラウザには決して渡らない。
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** JST の 'YYYY-MM-DD'。通知の重複判定を日本の日付で区切るため。 */
function todayInJst(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

async function loadShopSettings(supabase: Client) {
  const { data, error } = await supabase.from('shop_settings').select('*').single();
  if (error) throw new Error(`店舗設定の取得に失敗しました: ${error.message}`);
  return data;
}

async function loadStockVelocity(
  supabase: Client,
  windowDays: number,
): Promise<StockVelocityRow[]> {
  const { data, error } = await supabase.rpc('stock_velocity', { p_window_days: windowDays });
  if (error) throw new Error(`販売実績の取得に失敗しました: ${error.message}`);
  return (data ?? []) as unknown as StockVelocityRow[];
}

/**
 * 通知を「これから送る」と宣言する。
 *
 * 既に同じ鍵で記録があれば false（= 送らない）。
 * 判定と記録を別のクエリに分けず、DB 側の一意制約で決めている。
 */
async function claimNotification(
  supabase: Client,
  kind: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_notification', {
    p_kind: kind,
    p_dedupe_key: dedupeKey,
    p_payload: payload,
  });
  if (error) throw new Error(`通知の記録に失敗しました: ${error.message}`);
  return data === true;
}

/**
 * Slack へ送る。
 *
 * Webhook が未設定なら、組み立てた内容をログに出して終わる。
 * 通知先が無いだけで定期処理全体を失敗させない
 * （在庫の判定そのものは動いていてほしい）。
 */
async function sendToSlack(env: Env, message: SlackMessage): Promise<'sent' | 'skipped'> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.log('[slack 未設定のため送信せず]', message.text);
    console.log(JSON.stringify(message, null, 2));
    return 'skipped';
  }

  const response = await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack への送信に失敗しました: ${response.status} ${await response.text()}`);
  }

  return 'sent';
}

export type CheckResult = {
  lowStock: { alerts: number; notified: boolean; reason?: string };
  largeOrders: { found: number; notified: number };
};

/**
 * 在庫アラートの確認と通知。
 *
 * アラートの判定は画面と同じ collectStockAlerts()、
 * 発注推奨も画面と同じ collectReorderSuggestions() を使う。
 */
async function checkLowStock(
  env: Env,
  supabase: Client,
  shop: Awaited<ReturnType<typeof loadShopSettings>>,
  now: Date,
): Promise<CheckResult['lowStock']> {
  const settings: ReorderSettings = {
    windowDays: 30,
    defaultLeadTimeDays: shop.default_lead_time_days,
    coverDays: shop.default_cover_days,
    minObservationDays: 7,
  };

  const rows = await loadStockVelocity(supabase, settings.windowDays);

  const products: AlertableProduct[] = rows.map((row) => ({
    id: row.product_id,
    sku: row.sku,
    name: row.name,
    stockQuantity: row.stock_quantity,
    lowStockThreshold: row.low_stock_threshold,
  }));

  const alerts = collectStockAlerts(products);

  if (alerts.length === 0) {
    return { alerts: 0, notified: false, reason: 'アラート対象なし' };
  }

  const dedupeKey = lowStockDedupeKey(todayInJst(now));
  const claimed = await claimNotification(supabase, 'low_stock', dedupeKey, {
    count: alerts.length,
    skus: alerts.map((alert) => alert.product.sku),
  });

  if (!claimed) {
    return { alerts: alerts.length, notified: false, reason: '本日は通知済み' };
  }

  const suggestions = collectReorderSuggestions(rows, settings, now);

  const message = buildLowStockMessage(alerts, suggestions, {
    shopName: shop.shop_name,
    ...(env.APP_URL ? { appUrl: env.APP_URL } : {}),
  });

  await sendToSlack(env, message);

  return { alerts: alerts.length, notified: true };
}

/**
 * 大口注文の確認と通知。
 *
 * 「前回からの差分」を時刻で追わず、注文ごとに通知済みかを見る。
 * 前回実行時刻を持つ方式は、実行が飛んだときに取りこぼし、
 * 二度走ったときに重複する。注文ごとの記録なら、いつ何度走っても結果が同じになる。
 *
 * 対象を直近の注文に絞るのは、初回実行で過去の全注文が一斉に流れるのを防ぐため。
 */
async function checkLargeOrders(
  env: Env,
  supabase: Client,
  shop: Awaited<ReturnType<typeof loadShopSettings>>,
  now: Date,
): Promise<CheckResult['largeOrders']> {
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .gte('total_amount', shop.large_order_threshold)
    .gte('created_at', since)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw new Error(`注文の取得に失敗しました: ${error.message}`);

  const orders = data ?? [];
  let notified = 0;

  // 通知にはチャネルの表示名を出す。コード（own_store）のままでは
  // 受け取った人に伝わらない。件数が少ないので一度に引いて対応表にする。
  const { data: channels } = await supabase.from('sales_channels').select('code, name');
  const channelNames = new Map((channels ?? []).map((channel) => [channel.code, channel.name]));

  for (const order of orders) {
    const claimed = await claimNotification(
      supabase,
      'large_order',
      largeOrderDedupeKey(order.id),
      { order_number: order.order_number, total_amount: order.total_amount },
    );

    if (!claimed) continue;

    const items = order.order_items;
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const summary =
      items.length === 0
        ? '明細なし'
        : items.length === 1
          ? `${items[0]!.product_name} × ${items[0]!.quantity}`
          : `${items[0]!.product_name} ほか ${items.length - 1} 種（計 ${totalQuantity} 点）`;

    const info: LargeOrderInfo = {
      orderNumber: order.order_number,
      externalOrderId: order.external_order_id,
      customerName: order.customer_name,
      totalAmount: order.total_amount,
      channelName: channelNames.get(order.channel) ?? order.channel,
      itemSummary: summary,
      orderedAt: order.ordered_at,
    };

    await sendToSlack(
      env,
      buildLargeOrderMessage(info, {
        shopName: shop.shop_name,
        threshold: shop.large_order_threshold,
        ...(env.APP_URL ? { appUrl: env.APP_URL } : {}),
      }),
    );

    notified += 1;
  }

  return { found: orders.length, notified };
}

/** 定期処理の本体。fetch ハンドラからも呼べるように切り出してある。 */
export async function runChecks(env: Env, now = new Date()): Promise<CheckResult> {
  const supabase = createSupabaseClient(env);
  const shop = await loadShopSettings(supabase);

  // 在庫と大口注文は別々の用件なので、通知も別々に送る（1通知1用件）。
  const lowStock = await checkLowStock(env, supabase, shop, now);
  const largeOrders = await checkLargeOrders(env, supabase, shop, now);

  return { lowStock, largeOrders };
}

export default {
  /**
   * Cron Triggers から呼ばれる入口。wrangler.toml の crons で JST 09:00 に設定している。
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runChecks(env)
        .then((result) => {
          console.log('定期チェック完了', JSON.stringify(result));
        })
        .catch((error: unknown) => {
          // 失敗しても次回の実行で回復する（通知は記録していなければ再送される）。
          console.error('定期チェックに失敗しました', error);
          throw error;
        }),
    );
  },

  /**
   * 手動確認用。`wrangler dev` 中に GET すると、その時点の判定結果を返す。
   * 定期実行を待たずに動作を確かめられるようにしておく。
   *
   * 通知の記録も本番と同じように行うので、2回目は「通知済み」になる。
   */
  async fetch(_request: Request, env: Env): Promise<Response> {
    try {
      const result = await runChecks(env);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
