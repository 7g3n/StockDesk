import { describe, expect, it } from 'vitest';

import { UTF8_BOM, parseCsv, parseCsvWithHeader, toCsv, toCsvWithHeader } from './csv.js';

describe('CSV の解析', () => {
  it('単純な行と列を読む', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('引用符の中のカンマは区切りではない', () => {
    // ここを取り違えると列がずれたまま取り込まれる。CSV で最も多い壊れ方。
    expect(parseCsv('name,address\n山田,"東京都渋谷区神宮前1-2-3, 202号室"')).toEqual([
      ['name', 'address'],
      ['山田', '東京都渋谷区神宮前1-2-3, 202号室'],
    ]);
  });

  it('引用符の中の改行はデータとして扱う', () => {
    expect(parseCsv('note\n"1行目\n2行目"')).toEqual([['note'], ['1行目\n2行目']]);
  });

  it('引用符の中の "" は引用符1文字', () => {
    expect(parseCsv('name\n"""特選"" ブレンド"')).toEqual([['name'], ['"特選" ブレンド']]);
  });

  it('CRLF を1つの改行として扱う', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('CR だけの改行も読む', () => {
    expect(parseCsv('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('BOM を取り除く', () => {
    // Excel が保存した UTF-8 CSV には BOM が付く。
    // 取り除かないと最初の列名が一致せず「必要な列がありません」になる。
    expect(parseCsvWithHeader(`${UTF8_BOM}注文番号,数量\nEC-1,2`).headers).toEqual([
      '注文番号',
      '数量',
    ]);
  });

  it('末尾の改行で空行を作らない', () => {
    expect(parseCsv('a\n1\n')).toEqual([['a'], ['1']]);
  });

  it('空文字列は空の結果', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('空のフィールドを保持する', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });
});

describe('ヘッダー付きの解析', () => {
  it('ヘッダー名をキーにした行を返す', () => {
    const table = parseCsvWithHeader('SKU,数量\nBLND-200,2');
    expect(table.rows).toEqual([{ SKU: 'BLND-200', 数量: '2' }]);
  });

  it('ヘッダーと値の前後の空白を落とす', () => {
    // Excel 経由のファイルには余分な空白が混入しやすい。
    const table = parseCsvWithHeader(' SKU , 数量 \n BLND-200 , 2 ');
    expect(table.headers).toEqual(['SKU', '数量']);
    expect(table.rows[0]).toEqual({ SKU: 'BLND-200', 数量: '2' });
  });

  it('列が足りない行は空文字で埋める', () => {
    const table = parseCsvWithHeader('a,b,c\n1,2');
    expect(table.rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('ヘッダーだけのファイルは 0 行', () => {
    expect(parseCsvWithHeader('a,b,c').rows).toHaveLength(0);
  });
});

describe('CSV の生成', () => {
  it('Excel 対策の BOM を付ける', () => {
    // BOM が無いと Excel は UTF-8 CSV を CP932 として開き、日本語が文字化けする。
    expect(toCsv([['商品名']]).startsWith(UTF8_BOM)).toBe(true);
  });

  it('カンマ・引用符・改行を含む値だけ引用符で囲む', () => {
    const csv = toCsv([['普通', 'カンマ,あり', '引用"符', '改行\nあり']]);
    expect(csv).toContain('普通,"カンマ,あり","引用""符","改行\nあり"');
  });

  it('null と undefined は空文字にする', () => {
    expect(toCsv([[null, undefined, 0]])).toContain(',,0');
  });

  it('改行は CRLF にする', () => {
    expect(toCsv([['a'], ['b']])).toBe(`${UTF8_BOM}a\r\nb\r\n`);
  });

  it('生成した CSV を解析すると元に戻る', () => {
    // 往復で壊れないことが、エクスポートしたファイルを再取り込みできる条件。
    const original = [
      ['注文番号', '住所', '備考'],
      ['EC-1', '東京都渋谷区1-2-3, 202', 'のし"希望"'],
      ['EC-2', '', '改行\nあり'],
    ];
    expect(parseCsv(toCsv(original))).toEqual(original);
  });

  it('列定義の順にヘッダーと値を並べる', () => {
    const csv = toCsvWithHeader(
      [
        { key: 'sku', label: 'SKU' },
        { key: 'name', label: '商品名' },
      ],
      [{ sku: 'BLND-200', name: 'ブレンド' }],
    );
    expect(parseCsv(csv)).toEqual([
      ['SKU', '商品名'],
      ['BLND-200', 'ブレンド'],
    ]);
  });
});
