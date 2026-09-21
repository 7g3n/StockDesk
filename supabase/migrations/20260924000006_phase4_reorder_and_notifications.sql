-- =============================================================================
-- StockDesk / Phase 4: 発注推奨と通知
--
--   1. 発注のリードタイム設定（商品ごと / 店舗既定）
--   2. stock_velocity() — 販売ペースの実績を返す RPC
--   3. notifications — 送信済み通知の記録。通知の冪等性を支える
--
-- 発注推奨に新しいデータ構造は要らない。Phase 1 で stock_movements を
-- 「追記専用の台帳」にした理由のひとつがこれで、販売履歴はすでに揃っている。
-- ここで足すのは「何日分の在庫を持ちたいか」という設定だけ。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. リードタイムと在庫カバー日数
--
-- 商品ごとの lead_time_days は NULL 可。NULL なら店舗の既定値を使う。
-- 全商品に個別設定を強いると運用されなくなるので、既定値で回り、
-- 特別な商品（輸入品など）だけ上書きする形にする。
-- -----------------------------------------------------------------------------
alter table products
  add column lead_time_days integer check (lead_time_days is null or lead_time_days >= 0);

comment on column products.lead_time_days is
  '発注から入荷までの日数。NULL なら shop_settings.default_lead_time_days を使う。';

alter table shop_settings
  add column default_lead_time_days integer not null default 7
    check (default_lead_time_days >= 0),
  -- 入荷までの分に加えて、どれだけ余裕を持って在庫を持つか。
  add column default_cover_days integer not null default 14
    check (default_cover_days >= 0),
  -- これ以上の金額の注文が入ったら通知する。
  add column large_order_threshold integer not null default 30000
    check (large_order_threshold >= 0);

-- 商品編集フォームからリードタイムを設定できるようにする（列単位の GRANT に追加）。
grant update (lead_time_days) on products to authenticated;

-- -----------------------------------------------------------------------------
-- 2. 販売ペースの実績
--
-- 予測そのものはここでは行わない。返すのは実績（期間内に何個売れたか、
-- いつから売れる状態だったか）だけで、そこから先の計算は
-- packages/core/src/reorder.ts が純粋関数として持つ。
--
-- DB も React も起動せずに検証できる状態を保つ、という Phase 1 からの方針。
-- 予測式は運営者に説明する対象なので、テストで固定しておきたい部分でもある。
--
-- 販売数を「在庫台帳」ではなく「注文」から数える理由:
--
--   台帳（stock_movements.created_at）は在庫が動いた時刻であって、売れた時刻ではない。
--   CSV やモールから過去の注文を取り込むと、在庫移動は取り込んだ瞬間に記録される。
--   台帳基準で数えると、半年前の注文が「今日まとめて売れた」ことになり、
--   販売ペースが跳ね上がって発注推奨が壊れる。
--
--   販売ペースは orders.ordered_at（実際に注文が入った日時）で測る。
--   Phase 1 で ordered_at と created_at を別の列にしておいた理由がここで効く。
--
--   キャンセルされた注文は除く。判定は売上集計のビューと同じ条件にしてある。
--
-- 観測開始（observed_from）:
--   新しい商品を期間全体で割ると販売ペースを過小評価する。
--   「いつから売れる状態だったか」を、最初の在庫移動（多くは初回入荷）と
--   最初の注文の早い方として返し、実際の販売可能期間で割れるようにする。
-- -----------------------------------------------------------------------------
create or replace function stock_velocity(p_window_days integer default 30)
returns table (
  product_id uuid,
  sku text,
  name text,
  stock_quantity integer,
  low_stock_threshold integer,
  lead_time_days integer,
  sold_quantity bigint,
  observed_from timestamptz,
  last_sold_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with sales as (
    select
      oi.product_id,
      sum(oi.quantity) filter (
        where o.ordered_at >= now() - make_interval(days => p_window_days)
      ) as sold_quantity,
      min(o.ordered_at) as first_ordered_at,
      max(o.ordered_at) as last_sold_at
    from order_items oi
    join orders o on o.id = oi.order_id
    where o.status <> 'cancelled'
      and oi.product_id is not null
    group by oi.product_id
  ),
  stocked as (
    select product_id, min(created_at) as first_movement_at
    from stock_movements
    group by product_id
  )
  select
    p.id,
    p.sku,
    p.name,
    p.stock_quantity,
    p.low_stock_threshold,
    p.lead_time_days,
    coalesce(s.sold_quantity, 0)::bigint as sold_quantity,
    least(st.first_movement_at, s.first_ordered_at) as observed_from,
    s.last_sold_at
  from products p
  left join sales s on s.product_id = p.id
  left join stocked st on st.product_id = p.id
  where p.status = 'active';
$$;

comment on function stock_velocity is
  '発注推奨のもとになる販売実績。予測の計算は packages/core が行う。';

-- -----------------------------------------------------------------------------
-- 3. 通知の記録
--
-- 通知は定期処理から送る。Cron は同じ時刻に二度走ることがあり、
-- 手動実行や再デプロイでも重複しうる。同じ在庫切れを1日に何度も
-- Slack に流すと、運営者は通知を見なくなる。
--
-- そこで「何を送ったか」を記録し、既に送っていれば送らない。
-- dedupe_key の形:
--   low_stock:2026-09-21          … 在庫アラートは1日1回
--   large_order:<order_id>        … 大口注文は注文ごとに1回
--
-- 送信と記録のどちらを先にするか:
--   先に送ると、送信成功後に記録へ失敗したとき二重送信になる。
--   先に記録すると、送信に失敗したとき通知が欠ける。
--   在庫アラートは翌日also届き、大口注文は画面で確認できるので、
--   欠けるより二重に鳴る方が実害が大きいと判断し「先に記録」を採る。
-- -----------------------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz not null default now()
);

create unique index notifications_dedupe_key on notifications (dedupe_key);
create index notifications_sent_at_idx on notifications (sent_at desc);

alter table notifications enable row level security;

-- 閲覧は認証済み全員（通知が飛んだか画面で確認できるようにする）。
-- 書き込みは claim_notification 経由のみ。
create policy notifications_select on notifications for select to authenticated using (true);

revoke insert, update, delete on notifications from authenticated, anon;

/**
 * 通知を「これから送る」と宣言する。
 *
 * 既に同じ dedupe_key が記録されていれば false を返す（= 送らない）。
 * 記録できたら true を返す（= 送ってよい）。
 *
 * insert ... on conflict do nothing により、同時に2つの Worker が
 * 走っても片方しか true を受け取らない。判定と記録を別々のクエリに
 * 分けると、その隙間で両方が「まだ送っていない」と判断しうる。
 */
create or replace function claim_notification(
  p_kind text,
  p_dedupe_key text,
  p_payload jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted boolean := false;
begin
  perform assert_authenticated();

  insert into notifications (kind, dedupe_key, payload)
  values (p_kind, p_dedupe_key, coalesce(p_payload, '{}'::jsonb))
  on conflict (dedupe_key) do nothing;

  get diagnostics v_inserted = row_count;

  return v_inserted;
end;
$$;

revoke all on function claim_notification(text, text, jsonb) from public, anon;
-- 通知を送るのは定期処理（service_role）。画面からは呼ばせない。
grant execute on function claim_notification(text, text, jsonb) to service_role;

revoke all on function stock_velocity(integer) from public, anon;
grant execute on function stock_velocity(integer) to authenticated, service_role;
