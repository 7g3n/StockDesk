-- =============================================================================
-- StockDesk / Phase 2: 売上集計・顧客集計・外部データ取り込み
--
-- このマイグレーションで入れるもの:
--   1. orders.external_order_id — 外部EC/モールの注文番号。取り込みの冪等性の要。
--   2. create_order の拡張 — 明細に単価を明示できるようにする（取り込み用）。
--   3. import_orders — CSV 取り込みを1トランザクションで行う RPC。
--   4. 集計ビュー4本 — 日別 / 月別 / 商品別 / 顧客別。
--
-- Phase 1 ではダッシュボードの集計をクライアント側で行っていた。
-- 売上推移は「表示のために全注文を取得する」形になり、docs/decisions.md に書いた
-- 「判断が変わる条件」に到達したため、ここで集計を DB 側へ移す。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 外部注文番号
--
-- 同じ CSV を二度取り込んでも二重登録されないための鍵。
-- 自社ECの手入力注文には無いので NULL 可、入っている場合のみ一意。
-- -----------------------------------------------------------------------------
alter table orders add column external_order_id text;

create unique index orders_external_order_id_key
  on orders (external_order_id)
  where external_order_id is not null;

comment on column orders.external_order_id is
  '外部EC/モールでの注文番号。取り込みの重複判定に使う。自社EC手入力の注文では NULL。';

-- -----------------------------------------------------------------------------
-- 2. create_order の拡張: 明細単価の明示
--
-- 通常（画面からの登録）は商品マスタの現在価格をスナップショットする。
-- しかし外部データの取り込みでは「実際にその価格で売れた」履歴を持ち込むため、
-- マスタの現在価格で上書きしてはいけない。値引きやキャンペーン価格が消えてしまい、
-- 売上集計が実績と食い違う。
--
-- そこで p_items の各要素に unit_price があればそれを採用し、無ければマスタから取る。
-- 画面からは渡さない（UI に価格の手入力欄は設けない）。
--
-- 署名は Phase 1 と同一なので、grant はそのまま有効。
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
  v_unit_price integer;
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

    -- 単価の決定。明示されていればそれを、無ければマスタの現在価格を使う。
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

-- -----------------------------------------------------------------------------
-- 3. import_orders: 外部注文データの一括取り込み
--
-- 設計判断が3つある。
--
-- (a) 全件成功か、全件中止か
--     1行ずつコミットして「有効な行だけ取り込む」方が一見親切だが、
--     途中まで取り込まれたファイルを直して再実行したときに何が起きるかを
--     利用者が予測できない。取り込みは1トランザクションで、失敗したら何も残さない。
--     利用者は CSV を直して丸ごと流し直せばよい、という単純な規則にする。
--
-- (b) 重複の扱いはスキップ（エラーにしない）
--     external_order_id が既にある注文は飛ばす。
--     同じファイルを二度流すのは事故ではなく、よくある操作（途中で失敗した、
--     取り込めたか不安でもう一度流す）。エラーで止めるより、何もせず数を返す方が安全。
--     これにより取り込みは冪等になる。
--
-- (c) 顧客はメールアドレスで名寄せする
--     同じメールの顧客が既にいればその顧客に紐付け、無ければ作成する。
--     氏名での名寄せは同姓同名で誤結合するため使わない。
--     メールが空の行は顧客レコードを作らず、注文のスナップショットだけを残す。
--
-- 明細の商品は SKU で解決する。外部システムは product_id（UUID）を知らないため。
-- 解決を DB 側で行うのは、SKU から UUID への変換をクライアントに任せると
-- 取得と登録の間に商品が変わりうるため。
--
-- p_orders の形式:
--   [{
--     "external_order_id": "EC-1001",
--     "ordered_at": "2026-09-01T10:00:00+09:00",
--     "customer_name": "山田 太郎",
--     "customer_email": "taro@example.com",
--     "phone": "", "postal_code": "", "address": "",
--     "shipping_fee": 550, "note": "", "channel": "own_store",
--     "items": [{"sku": "BLND-200", "quantity": 2, "unit_price": 1480}]
--   }, ...]
-- -----------------------------------------------------------------------------
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
  perform assert_authenticated();

  if p_orders is null or jsonb_typeof(p_orders) <> 'array' or jsonb_array_length(p_orders) = 0 then
    raise exception 'INVALID_IMPORT: 取り込む注文がありません';
  end if;

  for v_order in select * from jsonb_array_elements(p_orders)
  loop
    v_external := nullif(trim(coalesce(v_order ->> 'external_order_id', '')), '');

    -- (b) 既に取り込み済みなら何もしない
    if v_external is not null
       and exists (select 1 from orders where external_order_id = v_external) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- (c) メールアドレスでの名寄せ
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

    -- 明細の SKU を product_id に解決する
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

    -- 取り込みも通常の注文作成と同じ経路を通す。
    -- 取り込みだけ在庫規則を緩めると「台帳が在庫の真実である」前提が崩れるため、
    -- 在庫不足ならここで例外になり、取り込み全体がロールバックする。
    v_order_id := create_order(
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
-- 4. 集計ビュー
--
-- security_invoker = on を付ける理由:
--   ビューは既定では「ビューの所有者」の権限で実行される（PG15 以降で切り替え可能）。
--   そのままだと、ビュー経由で参照したときに元テーブルの RLS が効かない。
--   本システムは権限の境界を DB に置いているので、ビューだけ例外にはできない。
--
-- 日付を JST で切る理由:
--   DB のタイムゾーンは UTC。ordered_at をそのまま ::date すると、
--   日本時間 9:00 より前の注文が前日に計上される。
--   「9月1日の売上」は日本の営業日で切られていなければ意味がないため、
--   Asia/Tokyo に変換してから日付にする。
--
-- キャンセル注文を除く理由:
--   キャンセルは売上ではない。判定条件は packages/core の countsAsSales() と対応する。
-- -----------------------------------------------------------------------------

create view daily_sales with (security_invoker = on) as
select
  (o.ordered_at at time zone 'Asia/Tokyo')::date as sales_date,
  count(*)::integer as order_count,
  sum(o.total_amount)::bigint as total_amount,
  sum(o.shipping_fee)::bigint as shipping_amount,
  -- 商品の売上。送料は運送会社に流れる金額なので、商品の実力を見るときは分けて見たい。
  sum(o.total_amount - o.shipping_fee)::bigint as item_amount
from orders o
where o.status <> 'cancelled'
group by 1;

comment on view daily_sales is
  '日別売上（JST基準・キャンセル除く）。sales_date で絞り込んで使う。';

create view monthly_sales with (security_invoker = on) as
select
  date_trunc('month', o.ordered_at at time zone 'Asia/Tokyo')::date as month_start,
  count(*)::integer as order_count,
  sum(o.total_amount)::bigint as total_amount,
  sum(o.shipping_fee)::bigint as shipping_amount,
  sum(o.total_amount - o.shipping_fee)::bigint as item_amount
from orders o
where o.status <> 'cancelled'
group by 1;

-- 商品別売上。
-- 集計の軸を product_id ではなく SKU にするのは、商品が削除されても
-- （order_items.product_id が NULL になっても）売上実績は残すべきだから。
-- SKU は伝票に複写された業務上の識別子で、こちらの方が実績の軸として安定している。
create view product_sales with (security_invoker = on) as
select
  oi.sku,
  (array_agg(oi.product_name order by o.ordered_at desc))[1] as product_name,
  (array_agg(oi.product_id order by o.ordered_at desc))[1] as product_id,
  sum(oi.quantity)::bigint as quantity,
  sum(oi.subtotal)::bigint as amount,
  count(distinct o.id)::integer as order_count,
  max(o.ordered_at) as last_ordered_at
from order_items oi
join orders o on o.id = oi.order_id
where o.status <> 'cancelled'
group by oi.sku;

comment on view product_sales is
  '商品別売上（SKU軸・キャンセル除く）。商品名は最新の注文時点の表記を代表として使う。';

-- 顧客別の実績。
-- 注文が1件も無い顧客も一覧に出したいので left join にする（登録直後の顧客が消えない）。
create view customer_summary with (security_invoker = on) as
select
  c.id as customer_id,
  c.name,
  c.email,
  c.phone,
  count(o.id) filter (where o.status <> 'cancelled')::integer as order_count,
  coalesce(sum(o.total_amount) filter (where o.status <> 'cancelled'), 0)::bigint as total_amount,
  min(o.ordered_at) filter (where o.status <> 'cancelled') as first_ordered_at,
  max(o.ordered_at) filter (where o.status <> 'cancelled') as last_ordered_at
from customers c
left join orders o on o.customer_id = c.id
group by c.id, c.name, c.email, c.phone;

-- -----------------------------------------------------------------------------
-- 5. 権限
-- -----------------------------------------------------------------------------
grant select on daily_sales, monthly_sales, product_sales, customer_summary to authenticated;

revoke all on function import_orders(jsonb) from public, anon;
grant execute on function import_orders(jsonb) to authenticated;
