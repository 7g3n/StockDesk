# スキーマ設計

対象: `supabase/migrations/` 配下のマイグレーション。

## ER の概要

```
auth.users ──1:1── profiles

customers ──1:N── orders ──1:N── order_items ──N:1── products
                    │                                    │
                    └──────── stock_movements ───────────┘
                              （在庫増減の台帳）
```

`stock_movements` が `products` と `orders` の両方を参照するのは、在庫が動いた理由が「注文によるもの」か「手動によるもの」かを1枚のテーブルで表すため。注文由来なら `order_id` が入り、手動調整なら NULL になる。

---

## テーブル

### profiles

`auth.users` の拡張。Phase 3 の権限管理の受け皿として先に用意してある。

| 列             | 型        | 備考                                            |
| -------------- | --------- | ----------------------------------------------- |
| `id`           | uuid PK   | `auth.users(id)` を参照。ユーザー削除で連動削除 |
| `display_name` | text      | 未設定ならメールのローカル部を使う              |
| `role`         | user_role | `owner` / `staff` / `viewer`                    |

サインアップ時にトリガ `handle_new_user()` が自動で作成する。**最初の1人が owner**、以降は staff。自分でECを始めた人が管理者になる、という運用を前提にしている。

Phase 1 では `role` を参照しない（認証済みなら全操作可）。役割ごとの制限は Phase 3 で RLS ポリシーを追加して入れる。アプリ側の分岐ではなく RLS で入れるのは、画面を経由しない操作でも制限が効くようにするため。

### products

SKU マスタ。

| 列                          | 型             | 備考                               |
| --------------------------- | -------------- | ---------------------------------- |
| `sku`                       | text UNIQUE    | 伝票・CSV・外部モールとの突合キー  |
| `unit_price` / `cost_price` | integer        | **円単位の整数**（後述）           |
| `stock_quantity`            | integer        | 台帳の集計キャッシュ。直接更新禁止 |
| `low_stock_threshold`       | integer        | この値**以下**で警告               |
| `status`                    | product_status | `active` / `archived`              |

**SKU の一意制約に `status` を含めない**理由: 取り扱い終了した商品の SKU を再利用できてしまうと、過去の伝票と現在の商品が同じ SKU を指しながら別物になる。突合が壊れるので、終了後も SKU は占有し続ける。

**`low_stock_threshold = 0` の意味**: 「警告しない」ではなく「在庫切れ（0）のときだけ警告する」。在庫切れは常に知る必要があるため。

### customers

Phase 2 で本格的に使うが、`orders` から参照する外部キーを後から追加するとデータ移行が必要になるため、Phase 1 の時点でテーブルだけ作ってある。

メールは NULL 可（電話のみの顧客がいる）。入っている場合だけ大小文字を無視して一意にする部分索引を張っている。

```sql
create unique index customers_email_key on customers (lower(email)) where email is not null;
```

### orders

注文ヘッダ。

| 列                 | 型           | 備考                                          |
| ------------------ | ------------ | --------------------------------------------- |
| `order_number`     | text UNIQUE  | `SD-20260921-0001` 形式。人が読み上げる識別子 |
| `customer_id`      | uuid NULL    | 顧客削除時は `SET NULL`（注文履歴は残す）     |
| `customer_name` 他 | text         | **顧客情報のスナップショット**                |
| `status`           | order_status | 遷移規則は RPC が強制                         |
| `ordered_at`       | timestamptz  | 実際の注文日時。`created_at` とは別           |
| `total_amount`     | integer      | 明細合計 + 送料の集計キャッシュ               |
| `stock_committed`  | boolean      | 在庫引き当て済みフラグ（冪等性の要）          |
| `channel`          | text         | Phase 3 の複数チャネル統合の受け皿            |

**UUID とは別に `order_number` を持つ理由**: 顧客からの電話問い合わせで UUID は使えない。業務上の識別子と技術的な主キーは役割が違う。

**番号が飛ぶことについて**: 採番は `order_number_seq` から取るため、在庫不足などで注文作成がロールバックしても消費した番号は戻らない（`SD-...-0006` の次が `SD-...-0008` になりうる）。これは許容する。欠番を無くすには採番を直列化する必要があり、注文作成の同時実行性を落としてまで得るものではないと判断した。連番の欠落が問題になる会計要件が出てきたら、そのときは採番専用テーブルを別に設ける。

**`ordered_at` と `created_at` を分ける理由**: Phase 2 の CSV インポートや Phase 3 のモール連携では、「実際に注文が入った日時」と「このシステムに取り込んだ日時」が食い違う。売上集計は前者で行う必要がある。

**顧客情報をスナップショットする理由**: 顧客が引っ越したときに過去の伝票の宛先まで書き換わると、誤出荷や返送の原因になる。伝票は発行時点の内容で固定されるべき。

### order_items

注文明細。

| 列                                    | 型        | 備考                                  |
| ------------------------------------- | --------- | ------------------------------------- |
| `product_id`                          | uuid NULL | 商品削除時は `SET NULL`               |
| `sku` / `product_name` / `unit_price` | —         | **発注時点のスナップショット**        |
| `quantity`                            | integer   | `> 0`                                 |
| `subtotal`                            | integer   | **生成列**（`unit_price * quantity`） |

**スナップショットの理由**: 商品マスタの価格改定が過去の注文金額を書き換えてはならない。3月に 1,480 円で売った注文は、4月に値上げしても 1,480 円のまま残る必要がある。売上集計の正しさが直接これに依存する。

`product_id` を `SET NULL` にしているのは、商品が削除されても明細だけで伝票を再現できるため。スナップショット列があるので、参照が切れても情報は失われない。

**`subtotal` を生成列にする理由**: 単価 × 数量と食い違う小計が物理的に存在しえなくなる。アプリ側で計算して保存すると、計算箇所が増えるたびにずれる余地が生まれる。

### stock_movements

在庫増減の台帳。**追記専用**。

| 列               | 型                    | 備考                     |
| ---------------- | --------------------- | ------------------------ |
| `delta`          | integer               | 符号付き。`<> 0`         |
| `quantity_after` | integer               | 増減後の残高（非正規化） |
| `reason`         | stock_movement_reason | 増減の理由               |
| `order_id`       | uuid NULL             | 注文由来の増減のみ入る   |

`reason` の値:

| 値                  | 符号 | 発生元                     |
| ------------------- | ---- | -------------------------- |
| `order_allocated`   | −    | 注文受付（RPC のみ）       |
| `order_cancelled`   | ＋   | 注文キャンセル（RPC のみ） |
| `purchase_received` | ＋   | 手動（入荷）               |
| `manual_adjustment` | ±    | 手動（棚卸）               |
| `return`            | ＋   | 手動（返品）               |

**`quantity_after` を持つ（非正規化する）理由**: 台帳だけを時系列に読めば当時の在庫が分かる。毎回先頭から合計を取り直さずに履歴画面を描けるし、「この時点で在庫がいくつだったか」を後から検証できる。

**自由記述の `note` とは別に `reason` を enum で持つ理由**: 台帳は後から集計・分析する。自由記述だけでは「注文でいくつ出たか」が数えられない。

---

## 不変条件と検査

**在庫の不変条件**:

```
products.stock_quantity = SUM(stock_movements.delta WHERE product_id = products.id)
```

これが崩れていれば、台帳を経由しない書き込みがあったことを意味する。検査:

```sql
select * from verify_stock_integrity();
```

不一致がある商品だけが返る（正常時は0行）。

この不変条件を保つために、二重の防御を掛けている。

1. **RLS** — `stock_movements` に INSERT / UPDATE / DELETE のポリシーを一切作らない
2. **列単位の GRANT** — `revoke update (stock_quantity) on products from authenticated`

在庫を動かせるのは `apply_stock_movement()`（SECURITY DEFINER）だけで、この関数は `authenticated` から EXECUTE を剥奪してある。外部に公開しているのは `adjust_stock()` / `create_order()` / `update_order_status()` の3つのみ。

---

## 金額の扱い

金額はすべて **integer（円）**。

- JPY に小数単位が無い
- 浮動小数を使うと集計で丸め誤差が出る（`0.1 + 0.2 !== 0.3`）
- `numeric` でも正しいが、円単位で扱う限り整数の方が単純で速い

将来 USD などを扱う場合は「最小単位の整数（セント）」に読み替えれば構造は変わらない。

TypeScript 側でも同じ規則を保つため、zod スキーマで `.int()` を要求している（小数入力を丸めて受け入れず、エラーにする）。

---

## RPC 関数

| 関数                          | 公開先                      | 役割                                         |
| ----------------------------- | --------------------------- | -------------------------------------------- |
| `create_order()`              | authenticated               | 注文作成 + 在庫引き当て（1トランザクション） |
| `update_order_status()`       | authenticated               | 遷移検証 + キャンセル時の在庫戻し            |
| `adjust_stock()`              | authenticated               | 手動の在庫調整（理由を手動系に限定）         |
| `verify_stock_integrity()`    | authenticated, service_role | 台帳とキャッシュの突合                       |
| `apply_stock_movement()`      | **非公開**                  | 在庫増減の唯一の実体                         |
| `is_valid_order_transition()` | authenticated               | 遷移規則の定義                               |

すべての公開 RPC は入口で `assert_authenticated()` を呼ぶ。SECURITY DEFINER 関数は RLS を迂回するため、認証確認を関数側で明示的に行う必要がある。定期処理（Cloudflare Workers）は service_role で接続するので、そちらも許可している。

### エラーの表現

DB からの例外は、メッセージ先頭に機械可読なコードを付けて返す。

```
INSUFFICIENT_STOCK: BLND-200 の在庫が不足しています（在庫 2 / 要求 5）
```

TypeScript 側（`packages/core/src/errors.ts`）がこれを型付きのエラーに変換し、画面に出す文言を決める。該当しないエラーは握り潰さず、元のメッセージを保ったまま返す（想定外の障害を「エラーが発生しました」に丸めると原因調査ができなくなるため）。

---

## 索引

| 索引                                                        | 用途                       |
| ----------------------------------------------------------- | -------------------------- |
| `products_sku_key` (unique)                                 | SKU 検索・一意性           |
| `products_status_idx`                                       | 取り扱い中の商品の絞り込み |
| `orders_status_idx`                                         | ステータス別の一覧         |
| `orders_ordered_at_idx` (desc)                              | 新しい順の一覧             |
| `order_items_order_idx`                                     | 注文詳細の明細取得         |
| `stock_movements_product_idx` (product_id, created_at desc) | 商品ごとの履歴             |

在庫アラート（`stock_quantity <= low_stock_threshold`）は列同士の比較になるため索引が効かない。Phase 1 では取り扱い中の商品を全件取得してアプリ側で絞っている。商品点数が数千を超えたら、この条件を持つビューか生成列 + 部分索引に切り替える。**その判断の分岐点は「表示のために全件取得が必要になったとき」**で、現時点では早すぎる最適化になる。
