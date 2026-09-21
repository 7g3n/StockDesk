/**
 * Slack 通知の本文組み立て。
 *
 * 送信は Cloudflare Worker が行う（apps/cron）。ここは文字列を作るだけなので、
 * Slack に繋がずにテストできる。通知の文面は「見た瞬間に何をすべきか分かるか」が
 * すべてなので、目で確認するだけでなくテストで固定しておきたい部分でもある。
 *
 * 通知の設計方針:
 *   - 1回の通知に用件はひとつ。在庫と注文を混ぜない。
 *   - 先頭に件数を出す。開かなくても規模が分かるようにする。
 *   - 行動が決まっているものを上に出す（発注が必要な商品 → 様子見の商品）。
 */

import { formatJpy, formatNumber } from './money.js';
import {
  REORDER_CONFIDENCE_LABELS,
  isUrgent,
  needsReorder,
  type ReorderSuggestion,
} from './reorder.js';
import { STOCK_LEVEL_LABELS, type StockAlert } from './stock.js';

/**
 * Slack への投稿内容。
 *
 * text は blocks があっても省略しない。
 * blocks だけだと、モバイルの通知バナーに本文が出ず「StockDesk から通知」
 * としか表示されない。text は通知一覧で読まれる唯一の文字列になる。
 */
export type SlackMessage = {
  text: string;
  blocks: SlackBlock[];
};

type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string; emoji: boolean } }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] }
  | { type: 'divider' };

/** Slack の mrkdwn で特別な意味を持つ文字を無効化する。商品名に < > & が入りうる。 */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function header(text: string): SlackBlock {
  return { type: 'header', text: { type: 'plain_text', text, emoji: false } };
}

function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string): SlackBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

/**
 * 在庫アラートの通知。
 *
 * 在庫水準（切れている / 残りわずか）に加えて、発注推奨から
 * 「あと何日で尽きるか」を添える。在庫数だけでは、それが急ぎかどうか判断できない
 * （残り20個でも1日10個売れるなら2日しかもたない）。
 */
export function buildLowStockMessage(
  alerts: readonly StockAlert[],
  suggestions: readonly ReorderSuggestion[],
  options: { shopName: string; appUrl?: string },
): SlackMessage {
  const byProductId = new Map(suggestions.map((suggestion) => [suggestion.productId, suggestion]));

  const lines = alerts.map((alert) => {
    const suggestion = byProductId.get(alert.product.id);
    const level = STOCK_LEVEL_LABELS[alert.level];

    const parts = [
      `*${escapeMrkdwn(alert.product.sku)}* ${escapeMrkdwn(alert.product.name)}`,
      `　${level}・在庫 ${formatNumber(alert.product.stockQuantity)}（閾値 ${formatNumber(alert.product.lowStockThreshold)}）`,
    ];

    if (suggestion?.daysUntilStockout !== null && suggestion !== undefined) {
      const urgent = isUrgent(suggestion) ? '　:warning: 入荷が間に合いません' : '';
      parts.push(
        `　あと約 ${formatNumber(suggestion.daysUntilStockout!)} 日（${REORDER_CONFIDENCE_LABELS[suggestion.confidence]}）` +
          `・推奨発注数 ${formatNumber(suggestion.recommendedQuantity)}${urgent}`,
      );
    }

    return parts.join('\n');
  });

  const text = `${options.shopName} 在庫アラート ${alerts.length} 件`;

  const blocks: SlackBlock[] = [
    header(`在庫アラート ${alerts.length} 件`),
    section(lines.join('\n\n')),
  ];

  if (options.appUrl) {
    blocks.push(context(`<${options.appUrl}/products?alerts=1|商品一覧で確認する>`));
  }

  return { text, blocks };
}

export type LargeOrderInfo = {
  orderNumber: string;
  externalOrderId: string | null;
  customerName: string;
  totalAmount: number;
  channelName: string;
  itemSummary: string;
  orderedAt: string;
};

/**
 * 大口注文の通知。
 *
 * 金額と中身を1行で読めるようにする。大口注文で運営者が最初に判断するのは
 * 「在庫は足りるか」「梱包・配送をどうするか」なので、
 * 金額よりも品目と点数が読めることを優先している。
 */
export function buildLargeOrderMessage(
  order: LargeOrderInfo,
  options: { shopName: string; threshold: number; appUrl?: string },
): SlackMessage {
  const text =
    `${options.shopName} 大口注文 ${formatJpy(order.totalAmount)}` +
    `（${order.customerName} 様 / ${order.orderNumber}）`;

  const blocks: SlackBlock[] = [
    header(`大口注文 ${formatJpy(order.totalAmount)}`),
    section(
      [
        `*${escapeMrkdwn(order.customerName)}* 様`,
        `${escapeMrkdwn(order.itemSummary)}`,
        `注文番号 \`${order.externalOrderId ?? order.orderNumber}\`・${escapeMrkdwn(order.channelName)}`,
      ].join('\n'),
    ),
    context(`${formatJpy(options.threshold)} 以上の注文を通知しています`),
  ];

  if (options.appUrl) {
    blocks.push(context(`<${options.appUrl}/orders|注文一覧で確認する>`));
  }

  return { text, blocks };
}

/** 通知の重複を防ぐ鍵。DB の notifications.dedupe_key と対応する。 */
export function lowStockDedupeKey(dateKey: string): string {
  // 在庫アラートは1日1回。同じ日に何度走っても2回目以降は送らない。
  return `low_stock:${dateKey}`;
}

export function largeOrderDedupeKey(orderId: string): string {
  // 大口注文は注文ごとに1回。
  return `large_order:${orderId}`;
}

/** 発注が必要な商品だけを、通知に載せる順（緊急 → 通常）に並べる。 */
export function selectReorderHighlights(
  suggestions: readonly ReorderSuggestion[],
  limit = 5,
): ReorderSuggestion[] {
  return suggestions
    .filter(needsReorder)
    .sort((a, b) => {
      const aUrgent = isUrgent(a);
      const bUrgent = isUrgent(b);
      if (aUrgent !== bUrgent) return aUrgent ? -1 : 1;
      return (a.daysUntilStockout ?? Infinity) - (b.daysUntilStockout ?? Infinity);
    })
    .slice(0, limit);
}
