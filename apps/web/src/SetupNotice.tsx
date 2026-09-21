/**
 * 接続先が未設定のときに出す案内。
 *
 * 環境変数が無いときに例外で落とすと、初めて触る人はコンソールを開くまで原因が分からない。
 * セットアップ手順そのものを画面に出す方が、README を探しに行くより早い。
 */
export function SetupNotice() {
  return (
    <div>
      <h1 className="text-lg font-bold text-slate-900">StockDesk のセットアップ</h1>
      <p className="mt-2 text-sm text-slate-600">
        Supabase への接続情報が設定されていません。以下の手順で <code>apps/web/.env</code>{' '}
        を作成してください。
      </p>

      <ol className="mt-4 space-y-3 text-sm text-slate-700">
        <li>
          <span className="font-medium">1. ローカルの Supabase を起動する</span>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-900 px-3 py-2 text-xs text-slate-100">
            pnpm db:start
          </pre>
        </li>
        <li>
          <span className="font-medium">2. スキーマとシードを流す</span>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-900 px-3 py-2 text-xs text-slate-100">
            pnpm db:reset
          </pre>
        </li>
        <li>
          <span className="font-medium">
            3. 起動時に表示された API URL と anon key を <code>apps/web/.env</code> に書く
          </span>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-900 px-3 py-2 text-xs text-slate-100">
            {'VITE_SUPABASE_URL=http://127.0.0.1:54321\nVITE_SUPABASE_ANON_KEY=<anon key>'}
          </pre>
        </li>
        <li>
          <span className="font-medium">4. 開発サーバーを再起動する</span>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-900 px-3 py-2 text-xs text-slate-100">
            pnpm dev
          </pre>
        </li>
      </ol>

      <p className="mt-4 text-xs text-slate-500">
        詳細は README.md を参照してください。service_role
        キーはブラウザ側の環境変数には設定しないでください。
      </p>
    </div>
  );
}
