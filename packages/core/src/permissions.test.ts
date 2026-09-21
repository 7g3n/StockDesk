import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  USER_ROLES,
  can,
  isReadOnlyRole,
  permissionsOf,
  type Permission,
  type UserRole,
} from './permissions.js';

/**
 * 権限表は DB 側（RLS ポリシーと assert_write_access / assert_owner_access）にも
 * 同じものがある。ここでは全 21 通り（7操作 × 3役割）を明示的に書き出し、
 * 「許可したつもりのない操作が通っていないか」を網羅的に確認する。
 *
 * 片方だけを変更するとこのテストが落ちるので、両者のずれに気付ける。
 */
const EXPECTED: Record<Permission, readonly UserRole[]> = {
  'order:write': ['owner', 'staff'],
  'stock:adjust': ['owner', 'staff'],
  'customer:write': ['owner', 'staff'],
  'product:write': ['owner'],
  'data:import': ['owner'],
  'member:manage': ['owner'],
  'settings:write': ['owner'],
};

describe('権限表', () => {
  it('全組み合わせが表どおりに判定される', () => {
    for (const permission of Object.keys(EXPECTED) as Permission[]) {
      for (const role of USER_ROLES) {
        expect(can(role, permission), `${role} / ${permission}`).toBe(
          EXPECTED[permission].includes(role),
        );
      }
    }
  });

  it('定義されている操作に過不足がない', () => {
    // 操作を足したときにテストの表を更新し忘れないようにする。
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe('役割ごとの範囲', () => {
  it('owner はすべての操作ができる', () => {
    expect(permissionsOf('owner')).toHaveLength(Object.keys(PERMISSIONS).length);
  });

  it('staff は日々の業務ができる', () => {
    expect(permissionsOf('staff').sort()).toEqual([
      'customer:write',
      'order:write',
      'stock:adjust',
    ]);
  });

  it('staff は商品マスタを触れない', () => {
    // 価格と原価は売上・粗利の計算根拠なので owner に限る。
    expect(can('staff', 'product:write')).toBe(false);
  });

  it('staff は一括取り込みができない', () => {
    // 1回の操作で大量の注文と在庫移動が発生し、巻き戻しが最も重いため。
    expect(can('staff', 'data:import')).toBe(false);
  });

  it('viewer は何も書けない', () => {
    expect(permissionsOf('viewer')).toHaveLength(0);
    expect(isReadOnlyRole('viewer')).toBe(true);
  });

  it('owner と staff は読み取り専用ではない', () => {
    expect(isReadOnlyRole('owner')).toBe(false);
    expect(isReadOnlyRole('staff')).toBe(false);
  });
});

describe('役割が分からないとき', () => {
  it('null は許可しない', () => {
    // 読み込み中に一瞬ボタンが出て、押したら失敗する状態を作らない。
    for (const permission of Object.keys(EXPECTED) as Permission[]) {
      expect(can(null, permission), permission).toBe(false);
      expect(can(undefined, permission), permission).toBe(false);
    }
  });

  it('null は読み取り専用として扱う', () => {
    expect(isReadOnlyRole(null)).toBe(true);
    expect(isReadOnlyRole(undefined)).toBe(true);
  });
});
