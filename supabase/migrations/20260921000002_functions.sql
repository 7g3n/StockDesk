-- =============================================================================
-- StockDesk / 業務ロジック（RPC 関数）
--
-- なぜ DB 関数に置くのか:
--   在庫の引き当ては「現在庫を読む → 引く → 書く」の read-modify-write で、
--   これをブラウザ（supabase-js）から3回の往復でやると、同時注文で確実に売り越しが起きる。
--   本システムは独自のサーバー層を持たない構成を採るため、不可分に実行すべき処理は
--   Postgres 関数（= 1トランザクション）に閉じ、行ロックで直列化する。
--
--   結果として「アプリを経由せずに在庫だけ書き換える」経路も塞げる（0003_rls.sql）。
--
-- エラー表現:
--   クライアントで分岐できるよう、メッセージ先頭に機械可読なコードを付ける。
--   例: 'INSUFFICIENT_STOCK: SKU-001 の在庫が不足しています（在庫 2 / 要求 5）'
--   TypeScript 側の対応表は packages/core/src/errors.ts。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 実行者の特定と認証チェック
-- SECURITY DEFINER 関数は RLS を迂回するため、入口で必ず認証を確認する。
-- 定期処理（Cloudflare Workers）は service_role で接続するので、そちらも許可する。
-- -----------------------------------------------------------------------------
create or replace function current_actor_id() returns uuid
language sql
stable
as $$
  select auth.uid();
$$;

create or replace function assert_authenticated() returns uuid
language plpgsql
stable
as $$
declare
  v_uid uuid := auth.uid();
  -- nullif を挟むのは、設定が空文字のときに ''::jsonb が例外になるため。
  -- 未設定（NULL）と空文字の両方を「ロール指定なし」として扱う。
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
begin
  if v_uid is null and v_role <> 'service_role' then
    raise exception 'UNAUTHENTICATED: この操作には認証が必要です'
      using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- -----------------------------------------------------------------------------
-- 在庫増減の唯一の入口
--
-- products.stock_quantity（キャッシュ）と stock_movements（台帳）を必ず同時に更新する。
-- 片方だけが進む状態を作らないために、この関数以外から両テーブルを書かない。
--
-- 行ロック: select ... for update により、同一商品への同時更新はここで直列化される。
-- -----------------------------------------------------------------------------
create or replace function apply_stock_movement(
  p_product_id uuid,
  p_delta integer,
  p_reason stock_movement_reason,
  p_order_id uuid default null,
  p_note text default ''
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
  v_current integer;
  v_next integer;
begin
  if p_delta = 0 then
    raise exception 'INVALID_DELTA: 増減数が 0 の在庫移動は記録しません';
  end if;

  -- ここで該当商品の行ロックを取る。以降、同じ商品を触る他トランザクションは待たされる。
  select sku, stock_quantity
    into v_sku, v_current
  from products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'PRODUCT_NOT_FOUND: 商品が見つかりません (%)', p_product_id;
  end if;

  v_next := v_current + p_delta;

  if v_next < 0 then
    raise exception 'INSUFFICIENT_STOCK: % の在庫が不足しています（在庫 % / 要求 %）',
      v_sku, v_current, abs(p_delta);
  end if;

  update products
     set stock_quantity = v_next
   where id = p_product_id;

  insert into stock_movements (product_id, delta, quantity_after, reason, order_id, note, created_by)
  values (p_product_id, p_delta, v_next, p_reason, p_order_id, coalesce(p_note, ''), current_actor_id());

  return v_next;
end;
$$;

-- -----------------------------------------------------------------------------
-- 手動の在庫調整（棚卸・入荷・返品）
--
-- apply_stock_movement をそのまま公開せず、理由を手動系に限定したラッパーを公開する。
-- order_allocated / order_cancelled は注文処理からしか発生してはならないため。
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
  perform assert_authenticated();

  if p_reason not in ('manual_adjustment', 'purchase_received', 'return') then
    raise exception 'INVALID_REASON: % は手動調整では指定できません', p_reason;
  end if;

  return apply_stock_movement(p_product_id, p_delta, p_reason, null, p_note);
end;
$$;

-- -----------------------------------------------------------------------------
-- 注文ステータスの遷移規則
--
-- 同じ規則を packages/core/src/order-status.ts にも持つ（画面で選べる遷移先を出すため）。
-- ただし「守らせる」のは常にこちら。UI を経由しない更新でも規則を破れないようにする。
--
--   pending(受付) ─→ preparing(出荷準備) ─→ shipped(発送済み) ─→ completed(完了)
--        └──────────→ cancelled ←────────┘
--
-- shipped からキャンセルできないのは意図的。発送済みの取り消しは返品処理であり、
-- 在庫の戻し方も（検品を挟むため）別物になる。Phase 4 で返品フローとして別に設ける。
-- -----------------------------------------------------------------------------
create or replace function is_valid_order_transition(
  p_from order_status,
  p_to order_status
) returns boolean
language sql
immutable
as $$
  select (p_from, p_to) in (
    ('pending',   'preparing'),
    ('pending',   'cancelled'),
    ('preparing', 'shipped'),
    ('preparing', 'cancelled'),
    ('shipped',   'completed')
  );
$$;

-- -----------------------------------------------------------------------------
-- 注文の作成（受付）と在庫引き当て
--
-- 引き当てタイミングの判断:
--   「受付時に引く」か「発送時に引く」かは業務設計上の分岐点。小規模EC で最も損失が大きいのは
--   売り越し（在庫がないのに受注してしまう）なので、受付時点で引き当てる方式を採る。
--   キャンセル時に戻し、二重処理は orders.stock_committed で防ぐ。
--
-- p_items の形式: [{"product_id": "uuid", "quantity": 2}, ...]
--   jsonb を使うのは、可変長の明細を1往復で渡すため。
-- -----------------------------------------------------------------------------
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
declare
  v_actor uuid;
  v_order_id uuid;
  v_order_number text;
  v_item record;
  v_product record;
  v_items_total integer := 0;
begin
  v_actor := assert_authenticated();

  if coalesce(trim(p_customer_name), '') = '' then
    raise exception 'INVALID_ORDER: 顧客名は必須です';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'INVALID_ORDER: 注文明細が空です';
  end if;

  if coalesce(p_shipping_fee, 0) < 0 then
    raise exception 'INVALID_ORDER: 送料に負の値は指定できません';
  end if;

  -- 番号は連番。日付を含めるのは、問い合わせ時に人が当たりを付けやすいため。
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

  -- product_id の昇順で処理する。複数商品をまたぐ注文が同時に走ったとき、
  -- ロックの取得順が注文ごとに違うとデッドロックするため、順序を固定する。
  for v_item in
    select
      (elem ->> 'product_id')::uuid as product_id,
      (elem ->> 'quantity')::integer as quantity
    from jsonb_array_elements(p_items) as elem
    order by (elem ->> 'product_id')::uuid
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'INVALID_ORDER: 数量は 1 以上で指定してください';
    end if;

    -- 明細に複写する値（SKU・商品名・単価）はこの時点のマスタから取る。
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

    insert into order_items (order_id, product_id, sku, product_name, unit_price, quantity)
    values (v_order_id, v_product.id, v_product.sku, v_product.name, v_product.unit_price, v_item.quantity);

    -- 在庫不足ならここで例外 → トランザクション全体がロールバックし、注文自体が作られない。
    -- 「注文は通ったが在庫だけ引けていない」という中途半端な状態は構造上ありえない。
    perform apply_stock_movement(
      v_product.id,
      -v_item.quantity,
      'order_allocated',
      v_order_id,
      v_order_number || ' の引き当て'
    );

    v_items_total := v_items_total + (v_product.unit_price * v_item.quantity);
  end loop;

  update orders
     set total_amount = v_items_total + coalesce(p_shipping_fee, 0)
   where id = v_order_id;

  return v_order_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 注文ステータスの変更
--
-- キャンセルに限り在庫を戻す。stock_committed を false に落とすことで、
-- 同じ注文に対してキャンセルが二重に走っても在庫が二重に戻ることはない。
-- -----------------------------------------------------------------------------
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
  perform assert_authenticated();

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

-- -----------------------------------------------------------------------------
-- 在庫キャッシュの突合
--
-- products.stock_quantity（キャッシュ）と stock_movements の合計（台帳）がずれていないかを検査する。
-- ずれていれば、それは「台帳を経由しない書き込み」があった証拠。
-- 運用時の点検と、マイグレーション後の確認に使う。
-- -----------------------------------------------------------------------------
create or replace function verify_stock_integrity()
returns table (
  product_id uuid,
  sku text,
  cached_quantity integer,
  ledger_quantity bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.sku,
    p.stock_quantity,
    coalesce(sum(m.delta), 0) as ledger_quantity
  from products p
  left join stock_movements m on m.product_id = p.id
  group by p.id, p.sku, p.stock_quantity
  having p.stock_quantity <> coalesce(sum(m.delta), 0);
$$;
