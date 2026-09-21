/**
 * @stockdesk/core
 *
 * 業務ロジック・型・検証スキーマの単一の置き場。
 * web（画面）と cron（Cloudflare Workers）の両方がここを参照する。
 *
 * このパッケージは React にも Supabase にも依存しない。
 * DB を立てずにテストできることが、在庫と注文という壊れやすい部分の
 * 検証コストを下げる一番の近道だという判断による。
 */

export * from './order-status.js';
export * from './stock.js';
export * from './money.js';
export * from './errors.js';
export * from './schemas.js';
export * from './csv.js';
export * from './order-import.js';
export * from './sales.js';
export * from './permissions.js';
export * from './channel-mock.js';
export * from './database.types.js';
