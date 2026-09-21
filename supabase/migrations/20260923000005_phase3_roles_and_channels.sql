-- =============================================================================
-- StockDesk / Phase 3: 権限管理・店舗設定・販売チャネル
--
-- Phase 1 で profiles.role を用意し、列単位の GRANT で「staff が自分を owner に
-- 昇格できない」ところまでは塞いであった。ここで role を実際に効かせる。
--
-- 権限の線引き（判断の基準）:
--   金額に関わる操作と、取り返しのつきにくい一括操作は owner に限る。
--   日々の出荷業務は staff が回せる。閲覧のみの viewer は何も書けない。
--
--   操作                          viewer  staff  owner
--   閲覧（商品・注文・顧客・売上）   ○      ○      ○
--   注文の登録・ステータス変更       ×      ○      ○
--   在庫の調整                      ×      ○      ○
--   顧客の登録・編集                ×      ○      ○
--   商品の登録・編集（価格・原価）   ×      ×      ○
--   CSV / チャネルの一括取り込み     ×      ×      ○
--   メンバーの役割変更・店舗設定     ×      ×      ○
--
--   商品マスタを owner に限るのは、価格と原価が売上・粗利の計算根拠そのものだから。
--   一括取り込みを owner に限るのは、1回の操作で大量の注文と在庫移動が発生し、
--   間違えたときの巻き戻しが最も重いため。
--
-- この表は packages/core/src/permissions.ts にも同じものがある。
-- 役割はいつもどおり、DB 側が「守らせる」、TS 側が「見せる（ボタンを出さない）」。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 役割の判定
--
-- SECURITY DEFINER にするのは、RLS ポリシーの中から profiles を読むため。
-- ポリシー評価の中でさらにポリシーが評価される構造を避ける
-- （Supabase で RLS が再帰する典型的な事故）。
--
-- 定期処理（Cloudflare Workers）は service_role で接続し profiles を持たないので、
-- そちらは無条件に許可する。service_role キーは Worker の secret としてのみ存在する。
-- -----------------------------------------------------------------------------
create or replace function current_actor_role() returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function has_any_role(variadic p_roles user_role[]) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role user_role;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
begin
  if v_jwt_role = 'service_role' then
    return true;
  end if;

  select role into v_role from profiles where id = auth.uid();

  if v_role is null then
    return false;
  end if;

  return v_role = any (p_roles);
end;
$$;

-- 書き込み操作の入口。viewer をここで止める。
create or replace function assert_write_access() returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform assert_authenticated();

  if not has_any_role('owner', 'staff') then
    raise exception 'FORBIDDEN: この操作を行う権限がありません（閲覧のみの権限です）'
      using errcode = '42501';
  end if;

  return auth.uid();
end;
$$;

-- 管理者専用の操作の入口。
create or replace function assert_owner_access() returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform assert_authenticated();

  if not has_any_role('owner') then
    raise exception 'FORBIDDEN: この操作は管理者のみが行えます'
      using errcode = '42501';
  end if;

  return auth.uid();
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. create_order を「公開ラッパー + 内部実装」に分ける
--
-- 権限の確認を足すためだけに 90 行の関数をマイグレーションごと複製し続けるのは
-- 保守できない。ここで一度だけ本体を create_order_internal に移し、
-- 公開側は権限を見て委譲するだけにする。
--
-- 以降、業務ロジックの変更は internal 側だけを触ればよく、
-- 権限の変更は公開側だけを触ればよい。
--
-- import_orders は自分で owner を確認したうえで internal を呼ぶ（二重確認を避ける）。
-- -----------------------------------------------------------------------------
create or replace function create_order_internal(
  p_customer_name text,
  p_items jsonb,
  p_customer_id uuid default null,
  p_customer_email text default '',
  p_shipping_address text default '',
  p_shipping_fee integer default 0,
  p_note text default '',
  p_ordered_at timestamptz default now(),
  p_channel text default 'own_store'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_order_id uuid;
  v_order_number text;
  v_item record;
  v_product record;
  v_unit_price integer;
  v_items_total integer := 0;
begin
  if coalesce(trim(p_customer_name), '') = '' then
    raise exception 'INVALID_ORDER: 顧客名は必須です';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'INVALID_ORDER: 注文明細が空です';
  end if;

  if coalesce(p_shipping_fee, 0) < 0 then
    raise exception 'INVALID_ORDER: 送料に負の値は指定できません';
  end if;

  v_order_number := 'SD-'
    || to_char(coalesce(p_ordered_at, now()) at time zone 'Asia/Tokyo', 'YYYYMMDD')
    || '-'
    || lpad(nextval('order_number_seq')::text, 4, '0');

  insert into orders (
    order_number, customer_id, customer_name, customer_email, shipping_address,
    status, ordered_at, shipping_fee, total_amount, stock_committed, channel, note, created_by
  )
  values (
    v_order_number, p_customer_id, trim(p_customer_name), coalesce(p_customer_email, ''),
    coalesce(p_shipping_address, ''), 'pending', coalesce(p_ordered_at, now()),
    coalesce(p_shipping_fee, 0), 0, true, coalesce(p_channel, 'own_store'),
    coalesce(p_note, ''), v_actor
  )
  returning id into v_order_id;

  -- product_id の昇順で処理する。ロック取得順を固定してデッドロックを避けるため。
  for v_item in
    select
      (elem ->> 'product_id')::uuid as product_id,
      (elem ->> 'quantity')::integer as quantity,
      (elem ->> 'unit_price')::integer as unit_price
    from jsonb_array_elements(p_items) as elem
    order by (elem ->> 'product_id')::uuid
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'INVALID_ORDER: 数量は 1 以上で指定してください';
    end if;

    select id, sku, name, unit_price, status
      into v_product
    from products
    where id = v_item.product_id
    for update;

    if not found then
      raise exception 'PRODUCT_NOT_FOUND: 商品が見つかりません (%)', v_item.product_id;
    end if;

    if v_product.status <> 'active' then
      raise exception 'PRODUCT_ARCHIVED: % は取り扱いを終了しています', v_product.sku;
    end if;

    -- 単価は明示があればそれを、無ければマスタの現在価格を複写する（Phase 2）。
    v_unit_price := coalesce(v_item.unit_price, v_product.unit_price);

    if v_unit_price < 0 then
      raise exception 'INVALID_ORDER: 単価に負の値は指定できません';
    end if;

    insert into order_items (order_id, product_id, sku, product_name, unit_price, quantity)
    values (v_order_id, v_product.id, v_product.sku, v_product.name, v_unit_price, v_item.quantity);

    perform apply_stock_movement(
      v_product.id,
      -v_item.quantity,
      'order_allocated',
      v_order_id,
      v_order_number || ' の引き当て'
    );

    v_items_total := v_items_total + (v_unit_price * v_item.quantity);
  end loop;

  update orders
     set total_amount = v_items_total + coalesce(p_shipping_fee, 0)
   where id = v_order_id;

  return v_order_id;
end;
$$;

comment on function create_order_internal is
  '注文作成の本体。権限は呼び出し側で確認する。直接は公開しない。';

-- 公開側。権限を見て委譲するだけ。
create or replace function create_order(
  p_customer_name text,
  p_items jsonb,
  p_customer_id uuid default null,
  p_customer_email text default '',
  p_shipping_address text default '',
  p_shipping_fee integer default 0,
  p_note text default '',
  p_ordered_at timestamptz default now(),
  p_channel text default 'own_store'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_write_access();

  return create_order_internal(
    p_customer_name, p_items, p_customer_id, p_customer_email, p_shipping_address,
    p_shipping_fee, p_note, p_ordered_at, p_channel
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. 既存 RPC に権限確認を入れる
-- -----------------------------------------------------------------------------
create or replace function adjust_stock(
  p_product_id uuid,
  p_delta integer,
  p_reason stock_movement_reason,
  p_note text default ''
) returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_write_access();

  if p_reason not in ('manual_adjustment', 'purchase_received', 'return') then
    raise exception 'INVALID_REASON: % は手動調整では指定できません', p_reason;
  end if;

  return apply_stock_movement(p_product_id, p_delta, p_reason, null, p_note);
end;
$$;

create or replace function update_order_status(
  p_order_id uuid,
  p_next_status order_status,
  p_note text default ''
) returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders;
  v_item record;
  v_result orders;
begin
  perform assert_write_access();

  select * into v_order from orders where id = p_order_id for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND: 注文が見つかりません (%)', p_order_id;
  end if;

  if not is_valid_order_transition(v_order.status, p_next_status) then
    raise exception 'INVALID_STATUS_TRANSITION: % から % へは変更できません',
      v_order.status, p_next_status;
  end if;

  if p_next_status = 'cancelled' and v_order.stock_committed then
    for v_item in
      select product_id, quantity
      from order_items
      where order_id = p_order_id and product_id is not null
      order by product_id
    loop
      perform apply_stock_movement(
        v_item.product_id,
        v_item.quantity,
        'order_cancelled',
        p_order_id,
        v_order.order_number || ' のキャンセルによる戻し'
      );
    end loop;
  end if;

  update orders
     set status = p_next_status,
         stock_committed = case when p_next_status = 'cancelled' then false else stock_committed end,
         shipped_at = case when p_next_status = 'shipped' then now() else shipped_at end,
         completed_at = case when p_next_status = 'completed' then now() else completed_at end,
         cancelled_at = case when p_next_status = 'cancelled' then now() else cancelled_at end,
         note = case when coalesce(p_note, '') = '' then note else p_note end
   where id = p_order_id
  returning * into v_result;

  return v_result;
end;
$$;

-- 一括取り込みは owner に限る。1回の操作で大量の注文と在庫移動が発生するため。
create or replace function import_orders(p_orders jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order jsonb;
  v_item jsonb;
  v_external text;
  v_email text;
  v_customer_id uuid;
  v_order_id uuid;
  v_items jsonb;
  v_product_id uuid;
  v_sku text;
  v_created integer := 0;
  v_skipped integer := 0;
  v_numbers text[] := array[]::text[];
begin
  perform assert_owner_access();

  if p_orders is null or jsonb_typeof(p_orders) <> 'array' or jsonb_array_length(p_orders) = 0 then
    raise exception 'INVALID_IMPORT: 取り込む注文がありません';
  end if;

  for v_order in select * from jsonb_array_elements(p_orders)
  loop
    v_external := nullif(trim(coalesce(v_order ->> 'external_order_id', '')), '');

    -- 既に取り込み済みなら何もしない（冪等性）
    if v_external is not null
       and exists (select 1 from orders where external_order_id = v_external) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- メールアドレスでの名寄せ
    v_email := nullif(trim(lower(coalesce(v_order ->> 'customer_email', ''))), '');
    v_customer_id := null;

    if v_email is not null then
      select id into v_customer_id from customers where lower(email) = v_email;

      if not found then
        insert into customers (name, email, phone, postal_code, address)
        values (
          trim(coalesce(v_order ->> 'customer_name', '')),
          v_email,
          coalesce(v_order ->> 'phone', ''),
          coalesce(v_order ->> 'postal_code', ''),
          coalesce(v_order ->> 'address', '')
        )
        returning id into v_customer_id;
      end if;
    end if;

    v_items := '[]'::jsonb;

    for v_item in select * from jsonb_array_elements(v_order -> 'items')
    loop
      v_sku := trim(coalesce(v_item ->> 'sku', ''));

      select id into v_product_id from products where sku = v_sku;

      if not found then
        raise exception 'PRODUCT_NOT_FOUND: SKU % は登録されていません（注文 %）',
          v_sku, coalesce(v_external, '(番号なし)');
      end if;

      v_items := v_items || jsonb_build_object(
        'product_id', v_product_id,
        'quantity', (v_item ->> 'quantity')::integer,
        'unit_price', (v_item ->> 'unit_price')::integer
      );
    end loop;

    -- 権限は上で確認済みなので内部実装を直接呼ぶ。
    v_order_id := create_order_internal(
      coalesce(v_order ->> 'customer_name', ''),
      v_items,
      v_customer_id,
      coalesce(v_order ->> 'customer_email', ''),
      coalesce(v_order ->> 'address', ''),
      coalesce((v_order ->> 'shipping_fee')::integer, 0),
      coalesce(v_order ->> 'note', ''),
      coalesce((v_order ->> 'ordered_at')::timestamptz, now()),
      coalesce(nullif(v_order ->> 'channel', ''), 'imported')
    );

    update orders set external_order_id = v_external where id = v_order_id;

    select array_append(v_numbers, order_number) into v_numbers
    from orders where id = v_order_id;

    v_created := v_created + 1;
  end loop;

  return jsonb_build_object(
    'created', v_created,
    'skipped', v_skipped,
    'order_numbers', to_jsonb(v_numbers)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. メンバーの役割変更
--
-- 最後の owner を降格させない。
-- これを許すと誰も権限を変更できない状態になり、DB に直接触れる人以外
-- 復旧できなくなる。権限管理を入れるときに最初に塞ぐべき穴。
-- -----------------------------------------------------------------------------
create or replace function set_member_role(p_user_id uuid, p_role user_role)
returns profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_count integer;
  v_target_role user_role;
  v_profile profiles;
begin
  perform assert_owner_access();

  select role into v_target_role from profiles where id = p_user_id;

  if not found then
    raise exception 'USER_NOT_FOUND: 対象のメンバーが見つかりません';
  end if;

  if v_target_role = 'owner' and p_role <> 'owner' then
    select count(*) into v_owner_count from profiles where role = 'owner';

    if v_owner_count <= 1 then
      raise exception 'LAST_OWNER: 管理者が不在になるため、この変更はできません';
    end if;
  end if;

  update profiles set role = p_role where id = p_user_id returning * into v_profile;

  return v_profile;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. 店舗設定（納品書の差出人に使う）
--
-- 単一行テーブル。id に CHECK を付けて2行目を作れないようにする。
-- 設定用の key-value テーブルにしないのは、項目ごとに型が決まっていて
-- 増減もしないため。列で持つ方が型で守れる。
-- -----------------------------------------------------------------------------
create table shop_settings (
  id boolean primary key default true check (id),
  shop_name text not null default '',
  postal_code text not null default '',
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  note text not null default '',
  updated_at timestamptz not null default now()
);

create trigger shop_settings_set_updated_at before update on shop_settings
  for each row execute function set_updated_at();

insert into shop_settings (id, shop_name) values (true, 'StockDesk ストア');

-- -----------------------------------------------------------------------------
-- 6. 販売チャネル
--
-- orders.channel は Phase 1 から text で持っていた。ここでマスタを作り FK を張る。
-- 外部モール連携（Phase 3 ではモック）で増えていく想定なので、
-- enum ではなくテーブルにする。enum の値追加はマイグレーションが必要になるため。
-- -----------------------------------------------------------------------------
create table sales_channels (
  code text primary key,
  name text not null,
  -- 取り込みの external_order_id に付ける接頭辞。チャネル間で番号が衝突しないようにする。
  order_prefix text not null default '',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger sales_channels_set_updated_at before update on sales_channels
  for each row execute function set_updated_at();

insert into sales_channels (code, name, order_prefix, sort_order) values
  ('own_store', '自社EC', 'EC', 10),
  ('imported',  'CSV取り込み', 'CSV', 20),
  ('mall_a',    'さくらモール', 'SKR', 30),
  ('mall_b',    'みなとマーケット', 'MNT', 40);

-- 既存の注文がすべてマスタに載っていることを確認してから FK を張る。
alter table orders
  add constraint orders_channel_fkey
  foreign key (channel) references sales_channels (code)
  on update cascade;

create index orders_channel_idx on orders (channel);

-- -----------------------------------------------------------------------------
-- 7. RLS の張り替え
--
-- Phase 1 の「認証済みなら全操作可」を、役割ごとの条件に置き換える。
-- 読み取りは全員に開く（閲覧のみの権限が成立しなくなるため）。
-- -----------------------------------------------------------------------------
drop policy products_all on products;
drop policy customers_all on customers;
drop policy orders_all on orders;
drop policy order_items_all on order_items;

-- 読み取りは認証済み全員。
create policy products_select on products for select to authenticated using (true);
create policy customers_select on customers for select to authenticated using (true);
create policy orders_select on orders for select to authenticated using (true);
create policy order_items_select on order_items for select to authenticated using (true);

-- 商品マスタは owner のみ。価格と原価が売上・粗利の計算根拠になるため。
create policy products_write on products
  for all to authenticated
  using (has_any_role('owner'))
  with check (has_any_role('owner'));

-- 顧客は日常業務の範囲。
create policy customers_write on customers
  for all to authenticated
  using (has_any_role('owner', 'staff'))
  with check (has_any_role('owner', 'staff'));

-- 注文の直接 UPDATE は備考・宛先の修正のみ（列単位の GRANT で限定済み）。
create policy orders_update on orders
  for update to authenticated
  using (has_any_role('owner', 'staff'))
  with check (has_any_role('owner', 'staff'));

alter table shop_settings enable row level security;
alter table sales_channels enable row level security;

create policy shop_settings_select on shop_settings for select to authenticated using (true);
create policy shop_settings_update on shop_settings
  for update to authenticated
  using (has_any_role('owner'))
  with check (has_any_role('owner'));

create policy sales_channels_select on sales_channels for select to authenticated using (true);
create policy sales_channels_write on sales_channels
  for all to authenticated
  using (has_any_role('owner'))
  with check (has_any_role('owner'));

-- 設定行とチャネルは増やさせない（単一行 / マスタはマイグレーションで管理する）。
revoke insert, delete on shop_settings from authenticated, anon;

-- -----------------------------------------------------------------------------
-- 8. 権限
-- -----------------------------------------------------------------------------
-- 内部実装は公開しない。
revoke all on function create_order_internal(
  text, jsonb, uuid, text, text, integer, text, timestamptz, text
) from public, anon, authenticated;

revoke all on function assert_write_access() from public, anon;
revoke all on function assert_owner_access() from public, anon;
grant execute on function assert_write_access() to authenticated;
grant execute on function assert_owner_access() to authenticated;

revoke all on function set_member_role(uuid, user_role) from public, anon;
grant execute on function set_member_role(uuid, user_role) to authenticated;

grant execute on function current_actor_role() to authenticated;
grant execute on function has_any_role(user_role[]) to authenticated;
