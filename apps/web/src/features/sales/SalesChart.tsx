import { formatJpy, niceAxisMax, type SalesPoint } from '@stockdesk/core';
import { useId, useState } from 'react';

/**
 * 売上推移の棒グラフ。
 *
 * グラフライブラリを入れず SVG で描く判断:
 *   必要なのは「1系列の棒グラフ」だけで、ライブラリの持つ多機能はほぼ使わない。
 *   数十 KB を足して得られるのが目盛りの自動計算程度なら、
 *   その計算（niceAxisMax）を core に置いてテストする方が確かめやすい。
 *
 * 描き方の方針:
 *   - 系列は1本なので単色。色で系列を区別する必要がないため凡例を出さない。
 *   - 縦軸は1本だけ。売上と注文数を1枚に重ねない（尺度が違うものを並べると読み違える）。
 *   - 横軸（時間）には縦の目盛り線を引かない。棒そのものが位置を示すため二重になる。
 *   - 売上が無かった日も棒の位置を空けて残す（系列の生成は core が担当）。
 */
export function SalesChart({ points, label }: { points: SalesPoint[]; label: string }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const titleId = useId();

  const width = 720;
  const height = 240;
  const padding = { top: 16, right: 8, bottom: 28, left: 64 };

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const axisMax = niceAxisMax(Math.max(...points.map((point) => point.totalAmount), 0));

  // 棒が太くなりすぎると「量」ではなく「面」に見える。24px を上限にする。
  const slotWidth = plotWidth / Math.max(points.length, 1);
  const barWidth = Math.min(24, Math.max(2, slotWidth * 0.62));

  // 目盛りは 0・中間・最大の3本。線を増やしても読み取りは良くならない。
  const gridValues = [0, axisMax / 2, axisMax];

  // ラベルが重なるときは間引く。全部描いて潰れるより、読める数だけ出す。
  const labelStep = Math.ceil(points.length / 12);

  const hovered = hoverIndex === null ? null : points[hoverIndex];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-labelledby={titleId}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <title id={titleId}>{label}</title>

        {gridValues.map((value) => {
          const y = padding.top + plotHeight - (value / axisMax) * plotHeight;
          return (
            <g key={value}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                className="stroke-slate-200"
                strokeWidth={1}
              />
              <text
                x={padding.left - 8}
                y={y + 4}
                textAnchor="end"
                className="tabular fill-slate-400 text-[11px]"
              >
                {value === 0 ? '0' : `${Math.round(value / 1000).toLocaleString('ja-JP')}k`}
              </text>
            </g>
          );
        })}

        {points.map((point, index) => {
          const barHeight =
            point.totalAmount === 0 ? 0 : (point.totalAmount / axisMax) * plotHeight;
          const x = padding.left + index * slotWidth + (slotWidth - barWidth) / 2;
          const y = padding.top + plotHeight - barHeight;
          const radius = Math.min(4, barWidth / 2, barHeight);

          return (
            <g key={point.key}>
              {/* 棒が細い日でも触れるよう、当たり判定は区画いっぱいに取る */}
              <rect
                x={padding.left + index * slotWidth}
                y={padding.top}
                width={slotWidth}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(index)}
              />
              {barHeight > 0 && (
                <path
                  // 上端だけ丸める。下端は軸に接するので角のままにする。
                  d={
                    `M ${x} ${y + barHeight}` +
                    ` L ${x} ${y + radius}` +
                    ` Q ${x} ${y} ${x + radius} ${y}` +
                    ` L ${x + barWidth - radius} ${y}` +
                    ` Q ${x + barWidth} ${y} ${x + barWidth} ${y + radius}` +
                    ` L ${x + barWidth} ${y + barHeight} Z`
                  }
                  className={hoverIndex === index ? 'fill-brand-700' : 'fill-brand-500'}
                  pointerEvents="none"
                />
              )}
              {index % labelStep === 0 && (
                <text
                  x={padding.left + index * slotWidth + slotWidth / 2}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-slate-400 text-[11px]"
                  pointerEvents="none"
                >
                  {point.label}
                </text>
              )}
            </g>
          );
        })}

        {/* 基準線。0 の位置を明示しないと、短い棒が浮いて見える */}
        <line
          x1={padding.left}
          x2={width - padding.right}
          y1={padding.top + plotHeight}
          y2={padding.top + plotHeight}
          className="stroke-slate-300"
          strokeWidth={1}
        />
      </svg>

      {hovered && (
        <div className="pointer-events-none absolute right-0 top-0 rounded-md bg-slate-900 px-3 py-2 text-xs text-white shadow-lg">
          <p className="font-medium">{hovered.label}</p>
          <p className="tabular mt-0.5">{formatJpy(hovered.totalAmount)}</p>
          <p className="tabular text-slate-300">{hovered.orderCount} 件</p>
        </div>
      )}
    </div>
  );
}
