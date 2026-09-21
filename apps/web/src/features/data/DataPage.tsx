import {
  formatNumber,
  summarizeImport,
  toDisplayMessage,
  type ImportParseResult,
} from '@stockdesk/core';
import { useRef, useState } from 'react';

import { PageHeader } from '@/components/AppShell';
import { Button, Card, CardHeader, InlineError, Td, Th } from '@/components/ui';
import { useCan } from '@/features/auth/permissions';

import {
  exportCustomersCsv,
  exportOrdersCsv,
  exportProductsCsv,
  parseOrderImportFile,
  readCsvFile,
  useImportOrders,
  type ImportResult,
} from './api';

const SAMPLE_CSV = `注文番号,注文日時,顧客名,メールアドレス,住所,SKU,数量,単価,送料
EC-1001,2026-09-10 10:30,山田 太郎,taro@example.com,東京都新宿区1-1-1,BLND-200,2,1480,550
EC-1001,2026-09-10 10:30,山田 太郎,taro@example.com,東京都新宿区1-1-1,FLTR-100,1,680,550
EC-1002,2026-09-11 09:15,鈴木 花子,hanako@example.com,大阪府大阪市西区2-2-2,DRIP-10,1,2200,550`;

function ExportRow({
  title,
  description,
  onExport,
}: {
  title: string;
  description: string;
  onExport: () => Promise<number>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const count = await onExport();
      setResult(`${formatNumber(count)} 行を書き出しました`);
    } catch (caught) {
      setError(toDisplayMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">{title}</p>
        <p className="text-xs text-slate-500">{description}</p>
        {result && <p className="mt-1 text-xs text-emerald-700">{result}</p>}
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
      <Button onClick={() => void run()} loading={busy}>
        CSV を書き出す
      </Button>
    </div>
  );
}

/**
 * CSV の取り込みと書き出し。
 *
 * 取り込みは「読む → 確認する → 実行する」の3段にしている。
 * ファイルを選んだ瞬間に取り込む作りにすると、列を間違えたファイルが
 * そのまま在庫を動かしてしまう。件数と内容を見てから実行できることが要件。
 */
export function DataPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importOrders = useImportOrders();
  // 取り込みは1回で大量の在庫が動くため管理者のみ。書き出しは全員に開く。
  const canImport = useCan('data:import');

  const [fileName, setFileName] = useState<string | null>(null);
  const [encoding, setEncoding] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ImportParseResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFileName(null);
    setEncoding(null);
    setParsed(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onFileSelected = async (file: File) => {
    setError(null);
    setResult(null);
    try {
      const { text, encoding: detected } = await readCsvFile(file);
      setFileName(file.name);
      setEncoding(detected);
      setParsed(parseOrderImportFile(text));
    } catch (caught) {
      setError(toDisplayMessage(caught));
    }
  };

  const runImport = async () => {
    if (!parsed) return;
    setError(null);
    try {
      const imported = await importOrders.mutateAsync(parsed.orders);
      setResult(imported);
      setParsed(null);
    } catch (caught) {
      setError(toDisplayMessage(caught));
    }
  };

  const summary = parsed ? summarizeImport(parsed.orders) : null;
  const hasIssues = (parsed?.issues.length ?? 0) > 0;

  return (
    <>
      <PageHeader
        title="データ入出力"
        description="既存ECサイトからの注文取り込みと、各種データの書き出しを行います。"
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="注文の取り込み"
              description="1行1明細の CSV を読み込みます。同じ注文番号の行はまとめて1件の注文になります。"
            />

            <div className="space-y-4 px-5 py-4">
              {!canImport && (
                <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  注文の取り込みは管理者のみが行えます。書き出しは全員が利用できます。
                </p>
              )}
              <div>
                <input
                  ref={fileInputRef}
                  disabled={!canImport}
                  type="file"
                  accept=".csv,text/csv"
                  aria-label="取り込む CSV ファイル"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void onFileSelected(file);
                  }}
                  className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                />
                {fileName && (
                  <p className="mt-2 text-xs text-slate-500">
                    {fileName}
                    {encoding && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5">{encoding}</span>
                    )}
                  </p>
                )}
              </div>

              {summary && (
                <div className="rounded-md bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-900">取り込み内容の確認</p>
                  <dl className="mt-2 grid grid-cols-3 gap-3 text-center">
                    <div>
                      <dt className="text-xs text-slate-500">注文</dt>
                      <dd className="tabular text-xl font-bold text-slate-900">
                        {formatNumber(summary.orderCount)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">明細</dt>
                      <dd className="tabular text-xl font-bold text-slate-900">
                        {formatNumber(summary.itemCount)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">総数量</dt>
                      <dd className="tabular text-xl font-bold text-slate-900">
                        {formatNumber(summary.totalQuantity)}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs text-slate-500">
                    対象 SKU: {summary.skus.join('、') || '—'}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    取り込むと、これらの商品の在庫が自動的に引き当てられます。
                  </p>
                </div>
              )}

              {hasIssues && (
                <div role="alert" className="rounded-md bg-red-50 p-3">
                  <p className="text-sm font-medium text-red-800">
                    取り込めない行が {formatNumber(parsed!.issues.length)} 件あります
                  </p>
                  <p className="mt-1 text-xs text-red-700">
                    CSV を修正してから取り込んでください。行番号はファイルの行番号です。
                  </p>
                  <div className="mt-2 max-h-48 overflow-y-auto">
                    <table className="min-w-full text-xs">
                      <tbody className="divide-y divide-red-100">
                        {parsed!.issues.slice(0, 50).map((issue, index) => (
                          <tr key={`${issue.line}-${index}`}>
                            <td className="py-1 pr-3 font-mono text-red-700">{issue.line} 行目</td>
                            <td className="py-1 pr-3 text-red-700">{issue.column ?? ''}</td>
                            <td className="py-1 text-red-800">{issue.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <InlineError message={error} />

              {result && (
                <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
                  <p className="font-medium">
                    {formatNumber(result.created)} 件の注文を取り込みました
                  </p>
                  {result.skipped > 0 && (
                    <p className="mt-1 text-xs">
                      {formatNumber(result.skipped)} 件は取り込み済みのため飛ばしました
                    </p>
                  )}
                  {result.order_numbers.length > 0 && (
                    <p className="mt-1 font-mono text-xs">
                      {result.order_numbers.slice(0, 5).join('、')}
                      {result.order_numbers.length > 5 && ' ほか'}
                    </p>
                  )}
                </div>
              )}

              {parsed && (
                <div className="flex justify-end gap-2">
                  <Button onClick={reset}>やり直す</Button>
                  <Button
                    variant="primary"
                    loading={importOrders.isPending}
                    disabled={hasIssues || parsed.orders.length === 0}
                    onClick={() => void runImport()}
                  >
                    {formatNumber(parsed.orders.length)} 件を取り込む
                  </Button>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="CSV の形式" description="列名は代表的な表記ゆれを受け付けます。" />
            <div className="px-5 py-4">
              <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
                {SAMPLE_CSV}
              </pre>
              <table className="mt-4 min-w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200">
                    <Th>列</Th>
                    <Th>必須</Th>
                    <Th>補足</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <tr>
                    <Td>注文番号</Td>
                    <Td>必須</Td>
                    <Td className="text-slate-500">同じ番号の行は1件の注文にまとまります</Td>
                  </tr>
                  <tr>
                    <Td>注文日時</Td>
                    <Td>必須</Td>
                    <Td className="text-slate-500">
                      タイムゾーンが無い場合は日本時間として扱います
                    </Td>
                  </tr>
                  <tr>
                    <Td>顧客名</Td>
                    <Td>必須</Td>
                    <Td className="text-slate-500">—</Td>
                  </tr>
                  <tr>
                    <Td>SKU / 数量</Td>
                    <Td>必須</Td>
                    <Td className="text-slate-500">未登録の SKU があると取り込みません</Td>
                  </tr>
                  <tr>
                    <Td>単価</Td>
                    <Td className="text-slate-400">任意</Td>
                    <Td className="text-slate-500">
                      指定があればその価格で記録します（値引き販売の実績を保つため）
                    </Td>
                  </tr>
                  <tr>
                    <Td>メールアドレス</Td>
                    <Td className="text-slate-400">任意</Td>
                    <Td className="text-slate-500">同じメールの顧客に自動で紐付けます</Td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="データの書き出し"
            description="Excel でそのまま開ける形式（UTF-8 BOM 付き）で出力します。"
          />
          <div className="divide-y divide-slate-100">
            <ExportRow
              title="注文"
              description="1行1明細。取り込みと同じ形式なので、書き出したファイルを取り込み直せます。"
              onExport={exportOrdersCsv}
            />
            <ExportRow
              title="商品・在庫"
              description="SKU ごとの価格と在庫数。棚卸の作業表としても使えます。"
              onExport={exportProductsCsv}
            />
            <ExportRow
              title="顧客"
              description="注文数と累計購入額を含む一覧。"
              onExport={exportCustomersCsv}
            />
          </div>
        </Card>
      </div>
    </>
  );
}
