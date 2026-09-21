-- =============================================================================
-- ローカル開発用のシードデータ（`supabase db reset` で流れる）
--
-- 注文は直接 INSERT せず create_order() を通す。
-- 手で INSERT すると在庫台帳を経由しないデータができてしまい、
-- verify_stock_integrity() が即座に不整合を報告する状態になるため。
--
-- 期間を約5週間に広げてある。数日ぶんのデータでは
--   - 売上推移のグラフが数本の棒にしかならない
--   - 発注推奨が「実績不足」ばかりになる（1週間未満は予測しない仕様のため）
-- となり、作った機能を確かめられない。
-- 開発用データは「機能を実演できるだけの期間と量」を持っている必要がある。
-- =============================================================================

-- seed は psql から postgres ロールで実行されるため auth.uid() が NULL になる。
-- assert_authenticated() を通すために、定期処理と同じ service_role として振る舞わせる。
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- -----------------------------------------------------------------------------
-- 商品マスタ
-- 在庫は台帳経由で積むため、ここでは stock_quantity を 0 のまま作る。
-- -----------------------------------------------------------------------------
insert into products (id, sku, name, description, unit_price, cost_price, low_stock_threshold, lead_time_days)
values
  ('11111111-1111-4111-8111-000000000001', 'BLND-200', 'スペシャルティ豆 ブレンド 200g', '深煎り。当店の定番。', 1480, 820, 12, null),
  ('11111111-1111-4111-8111-000000000002', 'ETHI-200', 'エチオピア イルガチェフェ 200g', '浅煎り。柑橘系の酸味。', 1780, 1020, 8, 30),
  ('11111111-1111-4111-8111-000000000003', 'DRIP-10', 'ドリップバッグ 10個セット', '贈答用。化粧箱入り。', 2200, 1150, 20, null),
  ('11111111-1111-4111-8111-000000000004', 'MUG-STD', 'オリジナルマグカップ', '容量 320ml。', 2800, 1400, 5, null),
  ('11111111-1111-4111-8111-000000000005', 'FLTR-100', 'ペーパーフィルター 100枚', '消耗品。回転が速い。', 680, 260, 30, null),
  ('11111111-1111-4111-8111-000000000006', 'GIFT-SET', 'ギフトセット（豆2種＋マグ）', '季節限定。', 6800, 3600, 3, null);

-- ETHI-200 だけリードタイムを 30 日にしてある。
-- 「商品ごとの設定が店舗の既定値を上書きする」ことを確かめられるようにするため（輸入品の想定）。

-- -----------------------------------------------------------------------------
-- 初期在庫（5週間前の仕入れ入荷として台帳に積む）
--
-- 数量は「5週間ぶん売れたあとに、FLTR-100 と GIFT-SET がアラート域に入る」よう
-- 逆算してある。在庫アラートと発注推奨を実際に動く状態で見せるため。
-- -----------------------------------------------------------------------------
select adjust_stock('11111111-1111-4111-8111-000000000001', 74, 'purchase_received', '初期在庫');
select adjust_stock('11111111-1111-4111-8111-000000000002', 33, 'purchase_received', '初期在庫');
select adjust_stock('11111111-1111-4111-8111-000000000003', 69, 'purchase_received', '初期在庫');
select adjust_stock('11111111-1111-4111-8111-000000000004', 30, 'purchase_received', '初期在庫');
select adjust_stock('11111111-1111-4111-8111-000000000005', 47, 'purchase_received', '初期在庫');
select adjust_stock('11111111-1111-4111-8111-000000000006', 18, 'purchase_received', '初期在庫');

-- 台帳の created_at を5週間前に寄せる。
-- 発注推奨は「いつから売れる状態だったか」を最初の在庫移動から判断するため、
-- 入荷が今日のままだと観測期間が 0 日になり、予測が出ない。
update stock_movements set created_at = now() - interval '35 days' where reason = 'purchase_received';

-- -----------------------------------------------------------------------------
-- 顧客
-- -----------------------------------------------------------------------------
insert into customers (id, name, email, phone, postal_code, address)
values
  ('22222222-2222-4222-8222-000000000001', '佐藤 美咲', 'misaki.sato@example.com', '090-0000-0001', '150-0001', '東京都渋谷区神宮前1-2-3'),
  ('22222222-2222-4222-8222-000000000002', '田中 亮', 'ryo.tanaka@example.com', '090-0000-0002', '530-0001', '大阪府大阪市北区梅田4-5-6'),
  ('22222222-2222-4222-8222-000000000003', '株式会社みどり商会', 'order@midori.example.com', '03-0000-0003', '104-0061', '東京都中央区銀座7-8-9'),
  ('22222222-2222-4222-8222-000000000004', '高橋 遥', 'haruka.takahashi@example.com', '090-0000-0004', '460-0008', '愛知県名古屋市中区栄3-1-2'),
  ('22222222-2222-4222-8222-000000000005', '中村 圭吾', 'keigo.nakamura@example.com', '090-0000-0005', '810-0001', '福岡県福岡市中央区天神5-6-7');

-- -----------------------------------------------------------------------------
-- 注文（約5週間ぶん）
--
-- create_order 経由なので在庫が自動で引き当てられる。
-- 生成は日付から決定的に決まるようにしてある（乱数を使わない）。
-- 毎回同じデータになる方が、画面の見え方やテストの前提が安定する。
-- -----------------------------------------------------------------------------
do $$
declare
  v_customers uuid[] := array[
    '22222222-2222-4222-8222-000000000001',
    '22222222-2222-4222-8222-000000000002',
    '22222222-2222-4222-8222-000000000004',
    '22222222-2222-4222-8222-000000000005'
  ];
  v_names text[] := array['佐藤 美咲', '田中 亮', '高橋 遥', '中村 圭吾'];
  v_emails text[] := array[
    'misaki.sato@example.com',
    'ryo.tanaka@example.com',
    'haruka.takahashi@example.com',
    'keigo.nakamura@example.com'
  ];
  v_addresses text[] := array[
    '東京都渋谷区神宮前1-2-3',
    '大阪府大阪市北区梅田4-5-6',
    '愛知県名古屋市中区栄3-1-2',
    '福岡県福岡市中央区天神5-6-7'
  ];
  v_products uuid[] := array[
    '11111111-1111-4111-8111-000000000001',
    '11111111-1111-4111-8111-000000000002',
    '11111111-1111-4111-8111-000000000003',
    '11111111-1111-4111-8111-000000000004',
    '11111111-1111-4111-8111-000000000005',
    '11111111-1111-4111-8111-000000000006'
  ];
  v_day integer;
  v_seq integer;
  v_orders_today integer;
  v_customer integer;
  v_product_a integer;
  v_product_b integer;
  v_items jsonb;
  v_order_id uuid;
  v_ordered_at timestamptz;
begin
  -- 34日前から昨日まで
  for v_day in reverse 34..1 loop
    -- 1日あたり 0〜2件。売れない日を混ぜないと、グラフが実態と違う見え方になる。
    v_orders_today := case
      when v_day % 5 = 0 then 0
      when v_day % 3 = 1 then 2
      else 1
    end;

    for v_seq in 1..v_orders_today loop
      v_customer := ((v_day + v_seq) % 4) + 1;
      -- 7 は 6 と互いに素。3 だと day*3 mod 6 が {0,3} しか取らず、選ばれない商品が出る。
      v_product_a := ((v_day * 7 + v_seq) % 6) + 1;
      v_product_b := ((v_day * 5 + v_seq * 2) % 6) + 1;

      v_ordered_at := date_trunc('day', now() - make_interval(days => v_day))
        + make_interval(hours => 9 + ((v_day + v_seq) % 11), mins => (v_day * 7) % 60);

      v_items := jsonb_build_array(
        jsonb_build_object(
          'product_id', v_products[v_product_a],
          'quantity', 1 + ((v_day + v_seq) % 3)
        )
      );

      -- 2品目は隔日程度。1品目だけの注文と混ざっている方が実際に近い。
      if v_product_b <> v_product_a and v_day % 2 = 0 then
        v_items := v_items || jsonb_build_object(
          'product_id', v_products[v_product_b],
          'quantity', 1
        );
      end if;

      v_order_id := create_order(
        v_names[v_customer],
        v_items,
        v_customers[v_customer],
        v_emails[v_customer],
        v_addresses[v_customer],
        550,
        '',
        v_ordered_at
      );

      -- 経過日数に応じて工程を進める。一覧でステータスが散っている状態を作る。
      if v_day >= 10 then
        perform update_order_status(v_order_id, 'preparing');
        perform update_order_status(v_order_id, 'shipped');
        perform update_order_status(v_order_id, 'completed');
      elsif v_day >= 5 then
        perform update_order_status(v_order_id, 'preparing');
        perform update_order_status(v_order_id, 'shipped');
      elsif v_day >= 3 then
        perform update_order_status(v_order_id, 'preparing');
      end if;
    end loop;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 個別に用意する注文
-- -----------------------------------------------------------------------------
do $$
declare
  v_wholesale uuid;
  v_cancelled uuid;
  v_today uuid;
begin
  -- 大口注文。Slack 通知（既定 30,000 円以上）の対象になる。
  v_wholesale := create_order(
    '株式会社みどり商会',
    '[{"product_id":"11111111-1111-4111-8111-000000000003","quantity":15},
      {"product_id":"11111111-1111-4111-8111-000000000005","quantity":10}]'::jsonb,
    '22222222-2222-4222-8222-000000000003',
    'order@midori.example.com', '東京都中央区銀座7-8-9', 0, '請求書払い', now() - interval '2 days'
  );
  perform update_order_status(v_wholesale, 'preparing');

  -- キャンセル分。在庫が戻ること（台帳に order_cancelled が残ること）を確認できる。
  v_cancelled := create_order(
    '田中 亮',
    '[{"product_id":"11111111-1111-4111-8111-000000000004","quantity":2}]'::jsonb,
    '22222222-2222-4222-8222-000000000002',
    'ryo.tanaka@example.com', '大阪府大阪市北区梅田4-5-6', 550, '', now() - interval '4 days'
  );
  perform update_order_status(v_cancelled, 'cancelled', 'お客様都合によるキャンセル');

  -- 本日の注文（受付のまま）。
  v_today := create_order(
    '佐藤 美咲',
    '[{"product_id":"11111111-1111-4111-8111-000000000006","quantity":1}]'::jsonb,
    '22222222-2222-4222-8222-000000000001',
    'misaki.sato@example.com', '東京都渋谷区神宮前1-2-3', 550, 'のし希望', now() - interval '3 hours'
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 店舗情報（納品書の差出人に印字される）
-- -----------------------------------------------------------------------------
update shop_settings set
  shop_name = '珈琲焙煎所 ストックデスク',
  postal_code = '150-0001',
  address = '東京都渋谷区神宮前1-2-3 StockDesk ビル 2F',
  phone = '03-1234-5678',
  email = 'shop@example.com',
  note = 'このたびはご注文いただきありがとうございました。またのご利用をお待ちしております。';

-- 後片付け: 以降のセッションに service_role の偽装を残さない。
select set_config('request.jwt.claims', '', false);
