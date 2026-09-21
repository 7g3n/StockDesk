/**
 * CSV の解析と生成。
 *
 * ライブラリを使わず自前で持つ判断:
 *   CSV は「カンマで split すればよい」と思われがちだが、実際の業務データでは
 *   引用符の中にカンマ・改行・引用符そのものが入る。そこを取り違えると
 *   列がずれたまま取り込まれ、しかも一見成功したように見えるという最悪の壊れ方をする。
 *   規則自体は RFC4180 として短く決まっているので、依存を増やすより
 *   規則をテストで固定する方が、壊れ方を把握できる。
 *
 * このモジュールは文字列しか扱わない。
 * 文字コードの判定（日本のECは CP932 出力が多い）はブラウザ側の責務として分離している
 * （TextDecoder を使う。apps/web/src/features/import-export/ を参照）。
 */

/** Excel が UTF-8 CSV を正しく開くために必要な BOM。 */
export const UTF8_BOM = '﻿';

/**
 * CSV 文字列を行×列の二次元配列に解析する。
 *
 * 対応する規則（RFC4180）:
 *   - 引用符で囲まれたフィールドの中のカンマ・改行はデータとして扱う
 *   - 引用符の中の "" は " 一文字を表す
 *   - 改行は LF / CRLF / CR のいずれでもよい
 *   - 先頭の BOM は取り除く
 *
 * 末尾の空行は無視する（多くの CSV は改行で終わるため）。
 */
export function parseCsv(input: string): string[][] {
  const text = input.startsWith(UTF8_BOM) ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };

  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        // 連続する引用符はエスケープされた引用符1文字。
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      endField();
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      endRow();
      // CRLF を2行として数えない。
      index += char === '\r' && text[index + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // 最後の行に改行が無い場合を拾う。
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  // 末尾の空行（改行で終わるファイル）を落とす。
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell === '')) {
    rows.pop();
  }

  return rows;
}

export type CsvTable = {
  /** ヘッダー行（前後の空白を取り除いたもの）。 */
  headers: string[];
  /** ヘッダー名をキーにしたデータ行。 */
  rows: Record<string, string>[];
};

/**
 * 1行目をヘッダーとして解釈する。
 *
 * ヘッダーの前後の空白を落とすのは、Excel 経由のファイルで全角空白や
 * 余分な空白が混入することがあり、列名の一致だけで失敗させたくないため。
 * 列の過不足は呼び出し側（検証）で扱う。
 */
export function parseCsvWithHeader(input: string): CsvTable {
  const rows = parseCsv(input);
  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0]!.map((header) => header.trim());

  const dataRows = rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, columnIndex) => {
      record[header] = (cells[columnIndex] ?? '').trim();
    });
    return record;
  });

  return { headers, rows: dataRows };
}

/** 引用符が必要な場合だけ囲む。不要な引用は差分を読みにくくするだけなので付けない。 */
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * 二次元配列を CSV 文字列にする。
 *
 * 改行を CRLF にし、BOM を付けるのは Excel のため。
 * BOM が無いと Excel は UTF-8 の CSV を CP932 として開き、日本語が文字化けする。
 * 受け取った人が「壊れたファイル」と判断してしまうので、既定で付ける。
 */
export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const body = rows
    .map((row) => row.map((cell) => escapeCsvField(cell == null ? '' : String(cell))).join(','))
    .join('\r\n');

  return `${UTF8_BOM}${body}\r\n`;
}

/** ヘッダーとオブジェクト配列から CSV を作る。列順はヘッダーの定義順に従う。 */
export function toCsvWithHeader<T extends Record<string, unknown>>(
  columns: readonly { key: keyof T & string; label: string }[],
  records: readonly T[],
): string {
  const header = columns.map((column) => column.label);
  const body = records.map((record) =>
    columns.map((column) => {
      const value = record[column.key];
      return value == null ? '' : String(value);
    }),
  );
  return toCsv([header, ...body]);
}
