/**
 * 在庫アラートの定期チェック（Cloudflare Workers + Cron Triggers）。
 *
 * なぜ Worker なのか:
 *   ブラウザを開いている間しか動かない処理では「朝いちばんに発注すべきもの」は届かない。
 *   常駐サーバーを持たない構成なので、定期実行だけを Cloudflare の Cron Triggers に任せる。
 *
 * Phase 1 の範囲:
 *   判定（どの商品がアラート対象か）までを実装し、実際の送信は差し替え可能な形にしてある。
 *   判定ロジックは画面と同じ @stockdesk/core の collectStockAlerts を使うため、
 *   「ダッシュボードには出ているのにメールは来ない」というずれが起きない。
 *
 * Phase 4 でここに Slack 通知と発注推奨（販売ペースからの在庫切れ予測）を足す。
 * 予測に必要な販売履歴は stock_movements に揃っている。
 */
import { collectStockAlerts, STOCK_LEVEL_LABELS, type AlertableProduct } from '@stockdesk/core';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@stockdesk/core';

export type Env = {
  SUPABASE_URL: string;
  /** service_role キー。`wrangler secret put SUPABASE_SERVICE_ROLE_KEY` で登録する。 */
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALERT_MAIL_FROM?: string;
  ALERT_MAIL_TO?: string;
};

function createSupabaseClient(env: Env) {
  // 定期処理にはログインユーザーがいないため service_role で接続する。
  // このキーは Worker の secret としてのみ存在し、ブラウザには決して渡らない。
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function collectAlerts(env: Env) {
  const supabase = createSupabaseClient(env);

  const { data, error } = await supabase
    .from('products')
    .select('id, sku, name, stock_quantity, low_stock_threshold')
    .eq('status', 'active');

  if (error) {
    throw new Error(`商品の取得に失敗しました: ${error.message}`);
  }

  const products: AlertableProduct[] = (data ?? []).map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    stockQuantity: row.stock_quantity,
    lowStockThreshold: row.low_stock_threshold,
  }));

  return collectStockAlerts(products);
}

export function buildAlertMessage(alerts: Awaited<ReturnType<typeof collectAlerts>>): string {
  const lines = alerts.map(
    (alert) =>
      `- [${STOCK_LEVEL_LABELS[alert.level]}] ${alert.product.sku} ${alert.product.name}` +
      `（在庫 ${alert.product.stockQuantity} / 閾値 ${alert.product.lowStockThreshold}）`,
  );

  return [
    `StockDesk 在庫アラート（${alerts.length} 件）`,
    '',
    ...lines,
    '',
    '対応が必要な順に並べています。',
  ].join('\n');
}

export default {
  /**
   * Cron Triggers から呼ばれる入口。wrangler.toml の crons で JST 09:00 に設定している。
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const alerts = await collectAlerts(env);

        if (alerts.length === 0) {
          console.log('在庫アラートなし');
          return;
        }

        const message = buildAlertMessage(alerts);

        // Phase 1 はログ出力まで。
        // 送信手段（メール / Slack）は Phase 4 でここに差し込む。
        // 判定と送信を分けてあるので、送信先が増えてもこの関数は変わらない。
        console.log(message);
      })(),
    );
  },

  /**
   * 手動確認用。`wrangler dev` 中に GET すると、その時点のアラートを返す。
   * 定期実行を待たずに判定結果を確かめられるようにしておく。
   */
  async fetch(_request: Request, env: Env): Promise<Response> {
    const alerts = await collectAlerts(env);
    return new Response(buildAlertMessage(alerts), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
