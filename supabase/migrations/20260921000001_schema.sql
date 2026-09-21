-- =============================================================================
-- StockDesk / Phase 1 スキーマ
--
-- 設計の骨子（詳細は docs/schema.md）:
--   1. 金額は integer（円）。小数通貨を持たない JPY 前提で、浮動小数の誤差を構造的に排除する。
--   2. 在庫は stock_movements（追記専用の台帳）を真実とし、products.stock_quantity は
--      同一トランザクション内で更新される集計キャッシュとして扱う。
--   3. 注文明細は SKU・商品名・単価を「発注時点の値」として複写する（スナップショット）。
--      商品マスタの価格改定が過去の注文金額を書き換えてはならないため。
-- =============================================================================

-- gen_random_uuid() 用。Supabase では既定で有効だが、明示しておく。
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- enum 型
-- 文字列カラム + CHECK ではなく enum を使う。取りうる値が業務上固定で、
-- 型名そのものがドメイン語彙になるため。値の追加は ALTER TYPE で行う。
-- -----------------------------------------------------------------------------
create type user_role as enum ('owner', 'staff', 'viewer');
create type product_status as enum ('active', 'archived');

-- 注文ステータス。受付 → 出荷準備 → 発送済み → 完了。cancelled は途中離脱。
-- 遷移規則そのものは 0002_functions.sql の is_valid_order_transition() に置く。
create type order_status as enum ('pending', 'preparing', 'shipped', 'completed', 'cancelled');

-- 在庫が動いた「理由」。台帳を後から読んで意味が分かることが台帳の存在意義なので、
-- 自由記述の note とは別に、集計可能な enum を必ず持たせる。
create type stock_movement_reason as enum (
  'order_allocated',    -- 注文受付による引き当て（−）
  'order_cancelled',    -- 注文キャンセルによる引き当て解除（＋）
  'purchase_received',  -- 仕入れ入荷（＋）
  'manual_adjustment',  -- 棚卸などの手動調整（±）
  'return'              -- 返品による戻し（＋）
);

-- -----------------------------------------------------------------------------
-- profiles: auth.users の拡張
-- Phase 3 の権限管理（管理者/スタッフ/閲覧のみ）の受け皿を先に作っておく。
-- Phase 1 では role を参照せず「認証済みなら全操作可」とし、RLS の絞り込みは Phase 3 で足す。
-- -----------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  role user_role not null default 'staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- products: SKU マスタ
-- -----------------------------------------------------------------------------
create table products (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  name text not null,
  description text not null default '',
  unit_price integer not null check (unit_price >= 0),
  cost_price integer not null default 0 check (cost_price >= 0),

  -- stock_movements の集計キャッシュ。直接 UPDATE せず、必ず apply_stock_movement() 経由で更新する。
  -- 不変条件:
  --   stock_quantity = (select coalesce(sum(delta), 0) from stock_movements where product_id = products.id)
  -- 突合クエリは docs/schema.md に記載。
  stock_quantity integer not null default 0 check (stock_quantity >= 0),

  -- この値「以下」になったらダッシュボードで警告する。
  -- 0 は「警告しない」ではなく「在庫切れ(0)のみ警告」を意味する。
  low_stock_threshold integer not null default 0 check (low_stock_threshold >= 0),

  status product_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- SKU は取り扱い終了(archived)の商品も含めて一意。再利用を許すと過去伝票との突合が壊れるため、
-- あえて status を条件に含む部分索引にはしない。
create unique index products_sku_key on products (sku);
create index products_status_idx on products (status);
create index products_name_idx on products (name);

-- -----------------------------------------------------------------------------
-- customers: 顧客マスタ
-- 本格利用は Phase 2 だが、orders から参照する FK を後付けするとデータ移行が必要になるため
-- Phase 1 の時点でテーブルだけ用意しておく。
-- -----------------------------------------------------------------------------
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text not null default '',
  postal_code text not null default '',
  address text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- メールは任意入力（電話のみの顧客がいる）なので NULL 可。入っている場合だけ大小無視で一意。
create unique index customers_email_key on customers (lower(email)) where email is not null;

-- -----------------------------------------------------------------------------
-- orders: 注文ヘッダ
-- -----------------------------------------------------------------------------
create sequence order_number_seq;

create table orders (
  id uuid primary key default gen_random_uuid(),

  -- 人が電話口で読み上げられる番号。UUID は業務上の識別子として使えないので別に持つ。
  order_number text not null unique,

  -- 顧客が削除されても注文履歴は残す。売上集計（Phase 2）の対象から消えてはいけない。
  customer_id uuid references customers (id) on delete set null,

  -- 顧客情報のスナップショット。引っ越し後に過去の伝票の宛先が書き換わると誤出荷の元になる。
  customer_name text not null,
  customer_email text not null default '',
  shipping_address text not null default '',

  status order_status not null default 'pending',

  -- 外部ECからの取り込み（Phase 2 CSV / Phase 3 モール連携）で「実際の注文日時」を保持するため、
  -- created_at（レコード作成日時）とは別に持つ。
  ordered_at timestamptz not null default now(),

  shipping_fee integer not null default 0 check (shipping_fee >= 0),

  -- order_items.subtotal の合計 + shipping_fee。RPC 内で計算して確定させる集計キャッシュ。
  total_amount integer not null default 0 check (total_amount >= 0),

  -- 在庫引き当て済みフラグ。キャンセル時の二重戻し・再引き当てを防ぐ冪等性の要。
  stock_committed boolean not null default false,

  -- Phase 3 の複数販売チャネル統合の受け皿。Phase 1 は自社EC固定。
  channel text not null default 'own_store',

  note text not null default '',
  shipped_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index orders_status_idx on orders (status);
create index orders_ordered_at_idx on orders (ordered_at desc);
create index orders_customer_idx on orders (customer_id);

-- -----------------------------------------------------------------------------
-- order_items: 注文明細
-- -----------------------------------------------------------------------------
create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,

  -- 商品が削除されても明細は残す（スナップショット列だけで伝票を再現できる）。
  product_id uuid references products (id) on delete set null,

  -- 発注時点のスナップショット。
  sku text not null,
  product_name text not null,
  unit_price integer not null check (unit_price >= 0),

  quantity integer not null check (quantity > 0),

  -- 生成列にすることで、単価×数量と食い違う小計が物理的に存在しえないようにする。
  subtotal integer generated always as (unit_price * quantity) stored,

  created_at timestamptz not null default now()
);

create index order_items_order_idx on order_items (order_id);
create index order_items_product_idx on order_items (product_id);

-- -----------------------------------------------------------------------------
-- stock_movements: 在庫増減台帳（追記専用）
--
-- 「現在いくつあるか」ではなく「なぜこの数になったか」を保持する。
-- 棚卸の突合、誤操作の追跡、Phase 4 の発注推奨（販売ペース算出）がすべてこの1枚に乗る。
-- UPDATE / DELETE は RLS と GRANT で禁止する（0003_rls.sql）。
-- -----------------------------------------------------------------------------
create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id) on delete cascade,

  -- 符号付き。0 は「何も起きていない」ので記録しない。
  delta integer not null check (delta <> 0),

  -- 増減後の残高。台帳だけを時系列に読めば当時の在庫が分かるようにするための非正規化。
  quantity_after integer not null check (quantity_after >= 0),

  reason stock_movement_reason not null,
  order_id uuid references orders (id) on delete set null,
  note text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index stock_movements_product_idx on stock_movements (product_id, created_at desc);
create index stock_movements_order_idx on stock_movements (order_id);
create index stock_movements_created_at_idx on stock_movements (created_at desc);

-- -----------------------------------------------------------------------------
-- updated_at の自動更新
-- アプリ側で now() を書くと、更新経路が増えるたびに書き忘れが発生する。DB で担保する。
-- -----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on profiles
  for each row execute function set_updated_at();
create trigger products_set_updated_at before update on products
  for each row execute function set_updated_at();
create trigger customers_set_updated_at before update on customers
  for each row execute function set_updated_at();
create trigger orders_set_updated_at before update on orders
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- サインアップ時に profiles を自動作成する
-- 最初の1人を owner にする（自分でECを始めた人が管理者）。以降は staff。
-- -----------------------------------------------------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_first boolean;
begin
  select not exists (select 1 from public.profiles) into v_is_first;

  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    case when v_is_first then 'owner'::user_role else 'staff'::user_role end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
