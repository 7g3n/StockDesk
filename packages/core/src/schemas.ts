/**
 * 入力値の検証スキーマ（zod）。
 *
 * DB にも CHECK 制約があるのに画面側でも検証するのは、目的が違うため:
 *   DB   ... 不正なデータを「保存させない」（最終防衛線）
 *   zod  ... 不正な入力を「送る前に気付かせる」（入力欄ごとの案内）
 *
 * 両者は同じ境界値（0以上、1以上など）を持つ。ここを直したら 0001_schema.sql の
 * CHECK 制約も合わせて直す。
 *
 * packages/core に置いているのは、Phase 2 の CSV インポートと
 * Cloudflare Worker 側でも同じ規則で検証したいため。
 */

import { z } from 'zod';
import { MANUAL_STOCK_REASONS } from './stock.js';

/** 金額は円単位の整数。小数入力は誤りとして弾く（丸めて受け入れない）。 */
const jpyAmount = z
  .number({ invalid_type_error: '数値を入力してください' })
  .int('円単位の整数で入力してください')
  .min(0, '0 以上で入力してください')
  .max(99_999_999, '金額が大きすぎます');

export const productFormSchema = z
  .object({
    // SKU は伝票・CSV・外部モールとの突合キーになるため、書式を狭く保つ。
    sku: z
      .string()
      .trim()
      .min(1, 'SKU は必須です')
      .max(64, 'SKU は 64 文字以内で入力してください')
      .regex(/^[A-Za-z0-9._-]+$/, 'SKU は半角英数字と . _ - のみ使用できます'),
    name: z.string().trim().min(1, '商品名は必須です').max(200, '商品名が長すぎます'),
    description: z.string().max(2000, '説明が長すぎます').default(''),
    unitPrice: jpyAmount,
    costPrice: jpyAmount,
    lowStockThreshold: z
      .number({ invalid_type_error: '数値を入力してください' })
      .int('整数で入力してください')
      .min(0, '0 以上で入力してください')
      .max(100_000, '値が大きすぎます'),
    status: z.enum(['active', 'archived']),
    // 発注から入荷までの日数。空欄なら店舗の既定値を使う（Phase 4）。
    leadTimeDays: z
      .number({ invalid_type_error: '数値を入力してください' })
      .int('整数で入力してください')
      .min(0, '0 以上で入力してください')
      .max(365, '値が大きすぎます')
      .nullable(),
  })
  .refine((value) => value.costPrice <= value.unitPrice, {
    // 原価が売価を上回る登録は、多くの場合は入力ミス。保存はできるが警告したいので
    // ここでは「入力ミスの検出」として弾く（意図的な赤字販売は説明欄に記録する運用）。
    path: ['costPrice'],
    message: '原価が販売価格を上回っています。入力を確認してください',
  });

export type ProductFormValues = z.infer<typeof productFormSchema>;

export const stockAdjustmentSchema = z
  .object({
    productId: z.string().uuid(),
    reason: z.enum(MANUAL_STOCK_REASONS),
    // 符号付き。0 は「何も起きていない」ので受け付けない。
    delta: z
      .number({ invalid_type_error: '数値を入力してください' })
      .int('整数で入力してください')
      .refine((value) => value !== 0, '増減数を入力してください'),
    note: z.string().max(500, 'メモが長すぎます').default(''),
  })
  .refine((value) => value.reason !== 'purchase_received' || value.delta > 0, {
    path: ['delta'],
    message: '入荷は増加（プラス）で記録してください',
  });

export type StockAdjustmentValues = z.infer<typeof stockAdjustmentSchema>;

export const orderItemInputSchema = z.object({
  productId: z.string().uuid('商品を選択してください'),
  quantity: z
    .number({ invalid_type_error: '数量を入力してください' })
    .int('整数で入力してください')
    .min(1, '数量は 1 以上で入力してください')
    .max(9_999, '数量が大きすぎます'),
});

export type OrderItemInput = z.infer<typeof orderItemInputSchema>;

export const orderFormSchema = z.object({
  customerName: z.string().trim().min(1, '顧客名は必須です').max(200, '顧客名が長すぎます'),
  customerId: z.string().uuid().nullable().default(null),
  // 空欄可。空文字は「未入力」として扱い、入っていれば書式を確認する。
  customerEmail: z.union([z.literal(''), z.string().email('メールアドレスの形式が不正です')]),
  shippingAddress: z.string().max(500, '住所が長すぎます').default(''),
  shippingFee: jpyAmount,
  note: z.string().max(1000, 'メモが長すぎます').default(''),
  items: z.array(orderItemInputSchema).min(1, '商品を 1 つ以上追加してください'),
});

export type OrderFormValues = z.infer<typeof orderFormSchema>;

export const customerFormSchema = z.object({
  name: z.string().trim().min(1, '顧客名は必須です').max(200, '顧客名が長すぎます'),
  // メールは任意。電話のみの顧客がいるため必須にしない。
  // ただし入っている場合は、取り込み時の名寄せキーになるので書式を確認する。
  email: z.union([z.literal(''), z.string().trim().email('メールアドレスの形式が不正です')]),
  phone: z.string().trim().max(50, '電話番号が長すぎます').default(''),
  postalCode: z.string().trim().max(20, '郵便番号が長すぎます').default(''),
  address: z.string().trim().max(500, '住所が長すぎます').default(''),
  note: z.string().max(1000, 'メモが長すぎます').default(''),
});

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

export const credentialsSchema = z.object({
  email: z.string().trim().min(1, 'メールアドレスを入力してください').email('形式が不正です'),
  password: z.string().min(6, 'パスワードは 6 文字以上で入力してください'),
});

export type Credentials = z.infer<typeof credentialsSchema>;
