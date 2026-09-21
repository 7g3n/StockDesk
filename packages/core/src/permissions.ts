/**
 * 役割と権限。
 *
 * 同じ表が DB 側（RLS ポリシーと assert_write_access / assert_owner_access）にもある。
 * 役割はこれまでと同じで、DB が「守らせる」、ここは「見せる」。
 * 押しても失敗するボタンを描かないためのもので、防御ではない。
 *
 * 線引きの基準:
 *   金額に関わる操作と、取り返しのつきにくい一括操作は owner に限る。
 *   日々の出荷業務は staff が回せる。viewer は何も書けない。
 */

export const USER_ROLES = ['owner', 'staff', 'viewer'] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  owner: '管理者',
  staff: 'スタッフ',
  viewer: '閲覧のみ',
};

export const USER_ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  owner: 'すべての操作に加えて、商品マスタ・一括取り込み・メンバー管理ができます。',
  staff: '注文処理・在庫調整・顧客登録など、日々の業務ができます。',
  viewer: 'すべての情報を見られますが、変更はできません。',
};

/**
 * 権限の一覧と、それを持つ役割。
 *
 * 画面の単位（「注文ページ」など）ではなく操作の単位で定義する。
 * 画面単位にすると、同じページの中で閲覧はできるが更新はできない、という
 * 実際に必要な状態を表せない。
 */
export const PERMISSIONS = {
  /** 注文の登録とステータス変更。 */
  'order:write': ['owner', 'staff'],
  /** 在庫の手動調整（入荷・棚卸・返品）。 */
  'stock:adjust': ['owner', 'staff'],
  /** 顧客の登録と編集。 */
  'customer:write': ['owner', 'staff'],
  /** 商品マスタの登録と編集。価格と原価が売上・粗利の計算根拠になるため owner に限る。 */
  'product:write': ['owner'],
  /** CSV / チャネルからの一括取り込み。1回で大量の在庫が動くため owner に限る。 */
  'data:import': ['owner'],
  /** メンバーの役割変更。 */
  'member:manage': ['owner'],
  /** 店舗設定（納品書の差出人など）の変更。 */
  'settings:write': ['owner'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

/**
 * その役割がその操作を行えるか。
 *
 * role が null / undefined（読み込み中、プロフィール未作成）は false にする。
 * 「分からないときは許可しない」側に倒す。読み込み中に一瞬ボタンが出て、
 * 押したら失敗する、という状態を作らないため。
 */
export function can(role: UserRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly UserRole[]).includes(role);
}

/** その役割が持つ操作の一覧。メンバー管理画面での説明に使う。 */
export function permissionsOf(role: UserRole): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => can(role, permission));
}

/** 何も書けない役割か。画面全体を読み取り専用として扱う判断に使う。 */
export function isReadOnlyRole(role: UserRole | null | undefined): boolean {
  if (!role) return true;
  return permissionsOf(role).length === 0;
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}
