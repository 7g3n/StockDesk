/**
 * 業務エラーの型と、DB から返るエラーの変換。
 *
 * supabase-js は Postgres の例外を { message, code, details } という平板な形で返す。
 * それをそのまま画面に出すと "INSUFFICIENT_STOCK: BLND-200 の在庫が..." のような
 * 内部向け文字列が利用者に見えてしまうため、ここで型付きのエラーに変換する。
 *
 * DB 側の raise exception のメッセージ先頭コードと、ここの ERROR_CODES を対応させている
 * （0002_functions.sql を参照）。
 */

export const ERROR_CODES = [
  'INSUFFICIENT_STOCK',
  'INVALID_STATUS_TRANSITION',
  'PRODUCT_NOT_FOUND',
  'PRODUCT_ARCHIVED',
  'ORDER_NOT_FOUND',
  'INVALID_ORDER',
  'INVALID_REASON',
  'INVALID_DELTA',
  'UNAUTHENTICATED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 利用者に見せる既定の文言。DB からの詳細メッセージがあればそちらを優先する。 */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  INSUFFICIENT_STOCK: '在庫が不足しています。',
  INVALID_STATUS_TRANSITION: 'このステータスへは変更できません。',
  PRODUCT_NOT_FOUND: '商品が見つかりません。',
  PRODUCT_ARCHIVED: '取り扱いを終了した商品は注文できません。',
  ORDER_NOT_FOUND: '注文が見つかりません。',
  INVALID_ORDER: '注文内容に不備があります。',
  INVALID_REASON: 'この理由では在庫を調整できません。',
  INVALID_DELTA: '増減数が不正です。',
  UNAUTHENTICATED: 'ログインが必要です。',
};

export class StockDeskError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.code = code;
    this.name = 'StockDeskError';
  }
}

export class InsufficientStockError extends StockDeskError {
  constructor(message?: string) {
    super('INSUFFICIENT_STOCK', message);
    this.name = 'InsufficientStockError';
  }
}

export class OrderStatusTransitionError extends StockDeskError {
  constructor(message?: string) {
    super('INVALID_STATUS_TRANSITION', message);
    this.name = 'OrderStatusTransitionError';
  }
}

/** "CODE: 詳細" 形式のメッセージからコードと本文を切り出す。 */
function parseCodedMessage(message: string): { code: ErrorCode; detail: string } | null {
  const separator = message.indexOf(':');
  if (separator === -1) return null;

  const candidate = message.slice(0, separator).trim();
  if (!(ERROR_CODES as readonly string[]).includes(candidate)) return null;

  return {
    code: candidate as ErrorCode,
    detail: message.slice(separator + 1).trim(),
  };
}

/**
 * DB / ネットワーク由来の例外を、画面に出せる形に正規化する。
 *
 * 想定外のエラーを握り潰して「エラーが発生しました」に丸めると原因調査ができなくなるので、
 * 該当しないものは元のメッセージを保ったまま返す。
 */
export function toStockDeskError(error: unknown): StockDeskError | Error {
  if (error instanceof StockDeskError) return error;

  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);

  const parsed = parseCodedMessage(message);
  if (!parsed) {
    return error instanceof Error ? error : new Error(message);
  }

  if (parsed.code === 'INSUFFICIENT_STOCK') {
    return new InsufficientStockError(parsed.detail || undefined);
  }
  if (parsed.code === 'INVALID_STATUS_TRANSITION') {
    return new OrderStatusTransitionError(parsed.detail || undefined);
  }
  return new StockDeskError(parsed.code, parsed.detail || undefined);
}

/** 画面表示用のメッセージ。トーストやフォームのエラー欄にそのまま出せる文字列を返す。 */
export function toDisplayMessage(error: unknown): string {
  const normalized = toStockDeskError(error);

  // Postgres の一意制約違反は業務的には「SKU の重複」なので、専用の文言にする。
  if (!(normalized instanceof StockDeskError)) {
    const raw =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
    if (raw === '23505') return 'その SKU はすでに登録されています。';
    if (raw === '42501') return 'この操作を行う権限がありません。';
  }

  return normalized.message;
}

export function isErrorCode(error: unknown, code: ErrorCode): boolean {
  return error instanceof StockDeskError && error.code === code;
}
