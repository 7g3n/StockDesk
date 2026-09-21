/**
 * DB スキーマに対応する型。
 *
 * 本来は `pnpm db:types`（supabase gen types typescript --local）で生成する。
 * ここに手書きで置いてあるのは、ローカル Supabase を起動していない環境でも
 * 型チェックとテストが通るようにするため。スキーマを変更したら必ず再生成すること。
 *
 * 生成物と同じ形（Row / Insert / Update / Relationships / Enums / Functions）を保っている。
 * Relationships は supabase-js が `select('*, order_items(*)')` のような
 * 埋め込みクエリの戻り値を推論するために参照するので、省略できない。
 */

export type OrderStatusEnum = 'pending' | 'preparing' | 'shipped' | 'completed' | 'cancelled';
export type ProductStatusEnum = 'active' | 'archived';
export type UserRoleEnum = 'owner' | 'staff' | 'viewer';
export type StockMovementReasonEnum =
  'order_allocated' | 'order_cancelled' | 'purchase_received' | 'manual_adjustment' | 'return';

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string;
          role: UserRoleEnum;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name?: string;
          role?: UserRoleEnum;
        };
        Update: {
          display_name?: string;
          role?: UserRoleEnum;
        };
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          sku: string;
          name: string;
          description: string;
          unit_price: number;
          cost_price: number;
          stock_quantity: number;
          low_stock_threshold: number;
          status: ProductStatusEnum;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          sku: string;
          name: string;
          description?: string;
          unit_price: number;
          cost_price?: number;
          low_stock_threshold?: number;
          status?: ProductStatusEnum;
        };
        // stock_quantity を Update に含めないのは意図的。
        // 台帳を経由しない在庫更新を型の段階で防ぐ（DB 側でも列単位の GRANT で拒否される）。
        Update: {
          sku?: string;
          name?: string;
          description?: string;
          unit_price?: number;
          cost_price?: number;
          low_stock_threshold?: number;
          status?: ProductStatusEnum;
        };
        Relationships: [];
      };
      customers: {
        Row: {
          id: string;
          name: string;
          email: string | null;
          phone: string;
          postal_code: string;
          address: string;
          note: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          email?: string | null;
          phone?: string;
          postal_code?: string;
          address?: string;
          note?: string;
        };
        Update: {
          name?: string;
          email?: string | null;
          phone?: string;
          postal_code?: string;
          address?: string;
          note?: string;
        };
        Relationships: [];
      };
      orders: {
        Row: {
          id: string;
          order_number: string;
          customer_id: string | null;
          customer_name: string;
          customer_email: string;
          shipping_address: string;
          status: OrderStatusEnum;
          ordered_at: string;
          shipping_fee: number;
          total_amount: number;
          stock_committed: boolean;
          channel: string;
          note: string;
          shipped_at: string | null;
          completed_at: string | null;
          cancelled_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          // 外部EC/モールの注文番号。CSV 取り込みの重複判定に使う（Phase 2）。
          external_order_id: string | null;
        };
        // 注文の作成とステータス変更は RPC（create_order / update_order_status）経由。
        // 在庫と不可分なので、直接の INSERT は型としても塞いでおく。
        Insert: Record<string, never>;
        Update: {
          note?: string;
          shipping_address?: string;
          customer_email?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'orders_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id'];
          },
        ];
      };
      order_items: {
        Row: {
          id: string;
          order_id: string;
          product_id: string | null;
          sku: string;
          product_name: string;
          unit_price: number;
          quantity: number;
          subtotal: number;
          created_at: string;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [
          {
            foreignKeyName: 'order_items_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'order_items_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
        ];
      };
      stock_movements: {
        Row: {
          id: string;
          product_id: string;
          delta: number;
          quantity_after: number;
          reason: StockMovementReasonEnum;
          order_id: string | null;
          note: string;
          created_by: string | null;
          created_at: string;
        };
        // 台帳は追記専用。書き込みは apply_stock_movement()（SECURITY DEFINER）だけが行う。
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [
          {
            foreignKeyName: 'stock_movements_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'stock_movements_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    // 集計ビュー（Phase 2）。読み取り専用。
    // 集計を DB 側に置く理由は supabase/migrations/..._phase2_sales_and_import.sql を参照。
    Views: {
      daily_sales: {
        Row: {
          sales_date: string;
          order_count: number;
          total_amount: number;
          shipping_amount: number;
          item_amount: number;
        };
        Relationships: [];
      };
      monthly_sales: {
        Row: {
          month_start: string;
          order_count: number;
          total_amount: number;
          shipping_amount: number;
          item_amount: number;
        };
        Relationships: [];
      };
      product_sales: {
        Row: {
          sku: string;
          product_name: string;
          product_id: string | null;
          quantity: number;
          amount: number;
          order_count: number;
          last_ordered_at: string | null;
        };
        Relationships: [];
      };
      customer_summary: {
        Row: {
          customer_id: string;
          name: string;
          email: string | null;
          phone: string;
          order_count: number;
          total_amount: number;
          first_ordered_at: string | null;
          last_ordered_at: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      create_order: {
        Args: {
          p_customer_name: string;
          p_items: { product_id: string; quantity: number }[];
          p_customer_id?: string | null;
          p_customer_email?: string;
          p_shipping_address?: string;
          p_shipping_fee?: number;
          p_note?: string;
          p_ordered_at?: string;
          p_channel?: string;
        };
        Returns: string;
      };
      update_order_status: {
        Args: {
          p_order_id: string;
          p_next_status: OrderStatusEnum;
          p_note?: string;
        };
        Returns: Database['public']['Tables']['orders']['Row'];
      };
      adjust_stock: {
        Args: {
          p_product_id: string;
          p_delta: number;
          p_reason: StockMovementReasonEnum;
          p_note?: string;
        };
        Returns: number;
      };
      import_orders: {
        Args: {
          p_orders: unknown[];
        };
        Returns: {
          created: number;
          skipped: number;
          order_numbers: string[];
        };
      };
      verify_stock_integrity: {
        Args: Record<never, never>;
        Returns: {
          product_id: string;
          sku: string;
          cached_quantity: number;
          ledger_quantity: number;
        }[];
      };
    };
    Enums: {
      order_status: OrderStatusEnum;
      product_status: ProductStatusEnum;
      user_role: UserRoleEnum;
      stock_movement_reason: StockMovementReasonEnum;
    };
    CompositeTypes: Record<never, never>;
  };
};

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type ProductRow = Tables<'products'>;
export type CustomerRow = Tables<'customers'>;
export type OrderRow = Tables<'orders'>;
export type OrderItemRow = Tables<'order_items'>;
export type StockMovementRow = Tables<'stock_movements'>;
export type ProfileRow = Tables<'profiles'>;

export type Views<T extends keyof Database['public']['Views']> =
  Database['public']['Views'][T]['Row'];

export type DailySalesView = Views<'daily_sales'>;
export type MonthlySalesView = Views<'monthly_sales'>;
export type ProductSalesView = Views<'product_sales'>;
export type CustomerSummaryView = Views<'customer_summary'>;
