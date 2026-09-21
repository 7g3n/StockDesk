-- =============================================================================
-- StockDesk / RLS と権限
--
-- 方針:
--   本システムはブラウザから Postgres に直接アクセスする（独自 API サーバーを持たない）。
--   したがって「何ができるか」の最終的な境界はアプリのコードではなく DB 側の権限になる。
--   画面で出し分けるのは体験のためであって、防御ではない。
--
--   Phase 1 では「認証済みなら業務データを操作できる」を基本線とし、
--   role（owner/staff/viewer）による絞り込みは Phase 3 でこのファイルを拡張して入れる。
--
--   ただし在庫台帳だけは Phase 1 から例外にする。後述。
-- =============================================================================

alter table profiles enable row level security;
alter table products enable row level security;
alter table customers enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table stock_movements enable row level security;

-- -----------------------------------------------------------------------------
-- profiles
-- 誰がスタッフかは全員が見えてよい（注文の担当者表示などに使う）。
-- 書き換えは自分の行だけ。role を自分で昇格できないよう、role 列の更新は Phase 3 で
-- owner 限定のポリシーを別途足す（Phase 1 では role を UI から触らせない）。
-- -----------------------------------------------------------------------------
create policy profiles_select on profiles
  for select to authenticated
  using (true);

create policy profiles_update_self on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- -----------------------------------------------------------------------------
-- products / customers / orders / order_items
-- 認証済みユーザーに CRUD を開く。
-- -----------------------------------------------------------------------------
create policy products_all on products
  for all to authenticated
  using (true) with check (true);

create policy customers_all on customers
  for all to authenticated
  using (true) with check (true);

create policy orders_all on orders
  for all to authenticated
  using (true) with check (true);

create policy order_items_all on order_items
  for all to authenticated
  using (true) with check (true);

-- -----------------------------------------------------------------------------
-- stock_movements: 読み取り専用
--
-- 台帳は「追記専用で、アプリから直接は書けない」ことに意味がある。
-- INSERT / UPDATE / DELETE のポリシーを一切作らない（= RLS により拒否される）ことで、
-- 在庫を動かす経路を apply_stock_movement()（SECURITY DEFINER）だけに絞る。
-- SECURITY DEFINER 関数は定義者（postgres）の権限で走るため RLS を通過できる。
-- -----------------------------------------------------------------------------
create policy stock_movements_select on stock_movements
  for select to authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- 列単位の権限
--
-- products.stock_quantity はキャッシュであり、台帳を伴わない書き換えは不整合そのもの。
-- RLS はテーブル単位なので、列単位の GRANT で塞ぐ。
-- これにより「商品編集フォームのついでに在庫数を直接 UPDATE する」実装が
-- そもそも通らなくなる（意図した制約であり、verify_stock_integrity() の前提でもある）。
--
-- 注意: Postgres ではテーブル単位の UPDATE 権限が全列への更新を含むため、
-- 列単位の REVOKE だけでは効かない。いったんテーブル単位の UPDATE を落としてから、
-- 更新を許す列だけを列挙して GRANT し直す必要がある。
-- updated_at はトリガ（set_updated_at）が書くため、ここに含めなくてよい。
-- 列権限は UPDATE 文の SET 句に現れた列に対してのみ検査される。
-- -----------------------------------------------------------------------------
revoke update on products from authenticated;
grant update (sku, name, description, unit_price, cost_price, low_stock_threshold, status)
  on products to authenticated;

-- 台帳へのテーブル権限自体も落としておく（RLS と二重の防御）。
revoke insert, update, delete on stock_movements from authenticated, anon;

-- 注文と明細も、作成は create_order() 経由に限定する。
-- 直接 INSERT できてしまうと「在庫を引かずに注文だけ存在する」状態を作れてしまい、
-- 引き当てをトランザクションに閉じた意味が無くなる。
-- 更新は伝票の付帯情報（備考・宛先）に限る。金額・ステータス・引当フラグは RPC の管轄。
revoke insert, update, delete on orders from authenticated, anon;
grant update (note, shipping_address, customer_email) on orders to authenticated;

revoke insert, update, delete on order_items from authenticated, anon;

-- profiles は自分の行だけ更新できるが（上の RLS ポリシー）、role は自分で変えられてはならない。
-- 放置すると staff が自分を owner に昇格できてしまい、Phase 3 の権限管理が成立しない。
-- 列権限で塞いでおき、role の変更は Phase 3 で owner 限定の RPC として公開する。
revoke insert, update, delete on profiles from authenticated, anon;
grant update (display_name) on profiles to authenticated;

-- -----------------------------------------------------------------------------
-- 関数の実行権限
--
-- apply_stock_movement は内部専用。理由 enum を無制限に指定できてしまうため直接は公開しない。
-- 外部に見せるのは adjust_stock / create_order / update_order_status の3つだけ。
-- -----------------------------------------------------------------------------
revoke all on function apply_stock_movement(uuid, integer, stock_movement_reason, uuid, text)
  from public, anon, authenticated;

revoke all on function adjust_stock(uuid, integer, stock_movement_reason, text) from public, anon;
grant execute on function adjust_stock(uuid, integer, stock_movement_reason, text) to authenticated;

revoke all on function create_order(text, jsonb, uuid, text, text, integer, text, timestamptz, text)
  from public, anon;
grant execute on function create_order(text, jsonb, uuid, text, text, integer, text, timestamptz, text)
  to authenticated;

revoke all on function update_order_status(uuid, order_status, text) from public, anon;
grant execute on function update_order_status(uuid, order_status, text) to authenticated;

revoke all on function verify_stock_integrity() from public, anon;
grant execute on function verify_stock_integrity() to authenticated, service_role;

grant execute on function is_valid_order_transition(order_status, order_status) to authenticated;
