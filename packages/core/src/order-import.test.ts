import { describe, expect, it } from 'vitest';

import { parseCsvWithHeader } from './csv.js';
import { parseOrderCsvRows, parseOrderedAt, summarizeImport } from './order-import.js';

function parse(csv: string) {
  return parseOrderCsvRows(parseCsvWithHeader(csv));
}

const HEADER = '注文番号,注文日時,顧客名,メールアドレス,SKU,数量,単価,送料';

describe('注文日時の解釈', () => {
  it('タイムゾーンが無い表記は JST とみなす', () => {
    // 日本のECのエクスポートはタイムゾーンを持たず、日本時間で出力される。
    // UTC と誤解すると9時間ずれ、日別売上が前日に計上される形で静かに壊れる。
    expect(parseOrderedAt('2026-09-01 10:30')).toBe('2026-09-01T01:30:00.000Z');
  });

  it('スラッシュ区切りも読む', () => {
    expect(parseOrderedAt('2026/9/1 10:30')).toBe('2026-09-01T01:30:00.000Z');
  });

  it('日付だけなら JST の 0 時', () => {
    expect(parseOrderedAt('2026-09-01')).toBe('2026-08-31T15:00:00.000Z');
  });

  it('秒まで指定できる', () => {
    expect(parseOrderedAt('2026-09-01 10:30:45')).toBe('2026-09-01T01:30:45.000Z');
  });

  it('オフセットが明示されていればそれを尊重する', () => {
    expect(parseOrderedAt('2026-09-01T10:30:00Z')).toBe('2026-09-01T10:30:00.000Z');
    expect(parseOrderedAt('2026-09-01T10:30:00+09:00')).toBe('2026-09-01T01:30:00.000Z');
  });

  it('存在しない日付は拒否する', () => {
    // Date は 2月31日を3月3日に繰り上げてしまう。黙って別の日として取り込まない。
    expect(parseOrderedAt('2026-02-31')).toBeNull();
    expect(parseOrderedAt('2026-13-01')).toBeNull();
  });

  it('解釈できない文字列と空文字は null', () => {
    expect(parseOrderedAt('令和8年9月1日')).toBeNull();
    expect(parseOrderedAt('')).toBeNull();
  });
});

describe('注文CSVの取り込み変換', () => {
  it('1行1明細の CSV を注文単位にまとめる', () => {
    const result = parse(
      `${HEADER}
EC-1001,2026-09-01 10:30,山田 太郎,taro@example.com,BLND-200,2,1480,550
EC-1001,2026-09-01 10:30,山田 太郎,taro@example.com,FLTR-100,1,680,550
EC-1002,2026-09-02 09:00,鈴木 花子,hanako@example.com,DRIP-10,3,2200,550`,
    );

    expect(result.issues).toHaveLength(0);
    expect(result.orders).toHaveLength(2);
    expect(result.orders[0]?.externalOrderId).toBe('EC-1001');
    expect(result.orders[0]?.items).toHaveLength(2);
    expect(result.orders[1]?.items).toHaveLength(1);
  });

  it('CSV の単価をそのまま保持する', () => {
    // 取り込むのは「実際にその価格で売れた」履歴。
    // マスタの現在価格で上書きすると、値引き販売が消えて売上が実績と食い違う。
    const result = parse(`${HEADER}\nEC-1,2026-09-01,山田,,BLND-200,1,980,0`);
    expect(result.orders[0]?.items[0]?.unitPrice).toBe(980);
  });

  it('単価が空なら null（マスタ価格を使わせる）', () => {
    const result = parse(`${HEADER}\nEC-1,2026-09-01,山田,,BLND-200,1,,0`);
    expect(result.orders[0]?.items[0]?.unitPrice).toBeNull();
  });

  it('送料が空なら 0 として扱う', () => {
    const result = parse(`${HEADER}\nEC-1,2026-09-01,山田,,BLND-200,1,1480,`);
    expect(result.orders[0]?.shippingFee).toBe(0);
  });

  it('桁区切りのカンマが入った数値を読む', () => {
    // 引用符で囲まれていれば "1,480" はひとつの値として渡ってくる。
    const result = parse(`${HEADER}\nEC-1,2026-09-01,山田,,BLND-200,1,"1,480",550`);
    expect(result.orders[0]?.items[0]?.unitPrice).toBe(1480);
  });

  it('列名の表記ゆれを受け入れる', () => {
    const result = parse(
      '受注番号,受注日時,購入者名,メール,商品コード,個数\nEC-1,2026-09-01,山田,a@example.com,BLND-200,1',
    );
    expect(result.issues).toHaveLength(0);
    expect(result.orders[0]?.externalOrderId).toBe('EC-1');
  });

  it('必要な列が無ければ何も取り込まずに理由を返す', () => {
    const result = parse('注文番号,顧客名\nEC-1,山田');
    expect(result.orders).toHaveLength(0);
    expect(result.issues[0]?.message).toContain('注文日時');
    expect(result.issues[0]?.message).toContain('SKU');
    expect(result.issues[0]?.line).toBe(1);
  });

  it('販売チャネルが空なら imported を既定にする', () => {
    const result = parse(`${HEADER}\nEC-1,2026-09-01,山田,,BLND-200,1,1480,0`);
    expect(result.orders[0]?.channel).toBe('imported');
  });
});

describe('取り込みエラーの報告', () => {
  it('行番号は CSV の行番号（ヘッダーを1行目）で返す', () => {
    // 利用者は Excel で開いて直す。配列の添字ではなく画面に見える行番号を返す。
    const result = parse(
      `${HEADER}
EC-1,2026-09-01,山田,,BLND-200,1,1480,0
EC-2,2026-09-02,鈴木,,DRIP-10,ゼロ,2200,0`,
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.line).toBe(3);
    expect(result.issues[0]?.column).toBe('数量');
  });

  it('数量が 0 や負の行を拒否する', () => {
    const result = parse(
      `${HEADER}
EC-1,2026-09-01,山田,,BLND-200,0,1480,0
EC-2,2026-09-02,鈴木,,DRIP-10,-1,2200,0`,
    );
    expect(result.issues).toHaveLength(2);
    expect(result.orders).toHaveLength(0);
  });

  it('注文番号・SKU・顧客名・注文日時の欠落を報告する', () => {
    const result = parse(
      `${HEADER}
,2026-09-01,山田,,BLND-200,1,1480,0
EC-2,2026-09-01,山田,,,1,1480,0
EC-3,2026-09-01,,,BLND-200,1,1480,0
EC-4,,山田,,BLND-200,1,1480,0`,
    );
    expect(result.issues.map((issue) => issue.column)).toEqual([
      '注文番号',
      'SKU',
      '顧客名',
      '注文日時',
    ]);
  });

  it('同じ注文番号で送料が食い違う行を報告する', () => {
    // 黙って片方を採用すると、送料が二重に入ったファイルを見逃す。
    const result = parse(
      `${HEADER}
EC-1,2026-09-01,山田,,BLND-200,1,1480,550
EC-1,2026-09-01,山田,,FLTR-100,1,680,550
EC-1,2026-09-01,山田,,DRIP-10,1,2200,800`,
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.column).toBe('送料');
    expect(result.issues[0]?.line).toBe(4);
    // 問題の行だけが落ち、正しい2行は残る。
    expect(result.orders[0]?.items).toHaveLength(2);
  });

  it('同じ注文番号で注文日時が食い違う行を報告する', () => {
    const result = parse(
      `${HEADER}
EC-1,2026-09-01 10:00,山田,,BLND-200,1,1480,0
EC-1,2026-09-02 10:00,山田,,FLTR-100,1,680,0`,
    );
    expect(result.issues[0]?.column).toBe('注文日時');
  });

  it('完全な空行は黙って飛ばす', () => {
    // Excel は末尾に空行を残すことがある。それを毎回エラーにすると使い物にならない。
    const result = parse(`${HEADER}\nEC-1,2026-09-01,山田,,BLND-200,1,1480,0\n,,,,,,,`);
    expect(result.issues).toHaveLength(0);
    expect(result.orders).toHaveLength(1);
  });

  it('同じ商品が複数行に分かれていても両方を明細として残す', () => {
    // 合算せずそのまま渡す。在庫の充足は DB 側が合計で判定する。
    const result = parse(
      `${HEADER}
EC-1,2026-09-01,山田,,BLND-200,2,1480,0
EC-1,2026-09-01,山田,,BLND-200,3,1480,0`,
    );
    expect(result.orders[0]?.items).toHaveLength(2);
    expect(summarizeImport(result.orders).totalQuantity).toBe(5);
  });
});

describe('取り込み前の集計', () => {
  it('注文数・明細数・総数量・対象SKUを返す', () => {
    const result = parse(
      `${HEADER}
EC-1,2026-09-01,山田,,BLND-200,2,1480,0
EC-1,2026-09-01,山田,,FLTR-100,1,680,0
EC-2,2026-09-02,鈴木,,BLND-200,3,1480,0`,
    );
    expect(summarizeImport(result.orders)).toEqual({
      orderCount: 2,
      itemCount: 3,
      totalQuantity: 6,
      skus: ['BLND-200', 'FLTR-100'],
    });
  });
});
