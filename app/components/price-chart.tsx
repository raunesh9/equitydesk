'use client';
import { useState } from 'react';
import { money, percent, pointsFor, type Stock } from '@/lib/stocks';
const colors = ['#00a855', '#5a70ca', '#b97b2e'];
export function PriceChart({
  stocks,
  range,
  normalized = false,
}: {
  stocks: Stock[];
  range: string;
  normalized?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  let series = stocks.map((s) => ({ stock: s, points: pointsFor(s, range) }));
  if (normalized && series.length) {
    const sets = series.map((s) => new Set(s.points.map((p) => p.date)));
    series = series.map((s) => ({
      ...s,
      points: s.points.filter((p) => sets.every((d) => d.has(p.date))),
    }));
  }
  const dates = [
    ...new Set(series.flatMap((s) => s.points.map((p) => p.date))),
  ].sort();
  const plotted = series.map((s) => ({
    ...s,
    points: s.points.map((p) => ({
      date: p.date,
      value: normalized ? (p.close / s.points[0].close - 1) * 100 : p.close,
    })),
  }));
  const values = plotted.flatMap((s) => s.points.map((p) => p.value));
  if (values.length < 2 || dates.length < 2)
    return (
      <div className="chart-empty">
        No price history available for this period.
      </div>
    );
  const lo = Math.min(...values),
    hi = Math.max(...values),
    pad = Math.max((hi - lo) * 0.15, 1),
    min = lo - pad,
    max = hi + pad;
  const x = (d: string) => 64 + (dates.indexOf(d) / (dates.length - 1)) * 800,
    y = (v: number) => 235 - ((v - min) / (max - min)) * 205;
  const selected =
    hover == null
      ? null
      : dates[Math.max(0, Math.min(dates.length - 1, hover))];
  return (
    <div className="chart-wrap">
      <svg
        viewBox="0 0 900 290"
        role="img"
        aria-label={
          normalized
            ? 'Price change on shared trading dates'
            : 'Historical closing prices'
        }
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(
            Math.round(
              ((((e.clientX - r.left) / r.width) * 900 - 64) / 800) *
                (dates.length - 1),
            ),
          );
        }}
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors[0]} stopOpacity=".06" />
            <stop offset="100%" stopColor={colors[0]} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => {
          const v = min + ((max - min) * i) / 4;
          return (
            <g key={i}>
              <line
                x1="64"
                x2="864"
                y1={y(v)}
                y2={y(v)}
                stroke="#edf1ed"
                strokeDasharray="3 6"
              />
              <text x="0" y={y(v) + 4} fill="#68766d" fontSize="13">
                {normalized ? v.toFixed(0) + '%' : v.toFixed(0)}
              </text>
            </g>
          );
        })}
        {plotted
          .filter((s) => s.points.length)
          .map(({ stock, points }, idx) => {
            const path = points
              .map(
                (p, i) =>
                  (i ? 'L' : 'M') +
                  x(p.date).toFixed(1) +
                  ',' +
                  y(p.value).toFixed(1),
              )
              .join(' ');
            return (
              <g key={stock.symbol}>
                {!normalized && (
                  <path
                    d={path + ' L864,235 L64,235 Z'}
                    fill="url(#chart-fill)"
                  />
                )}
                <path
                  d={path}
                  fill="none"
                  stroke={colors[idx]}
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                />
                <circle
                  cx={x(points[points.length - 1].date)}
                  cy={y(points[points.length - 1].value)}
                  r="4"
                  fill={colors[idx]}
                />
              </g>
            );
          })}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const d = dates[Math.round((dates.length - 1) * t)];
          return (
            <text
              key={t}
              x={64 + 800 * t}
              y="275"
              textAnchor={t === 0 ? 'start' : t === 1 ? 'end' : 'middle'}
              fill="#68766d"
              fontSize="13"
            >
              {new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC',
              })}
            </text>
          );
        })}
        {selected && (
          <line
            x1={x(selected)}
            x2={x(selected)}
            y1="20"
            y2="240"
            stroke="#8a9aa5"
            strokeDasharray="4 4"
          />
        )}
      </svg>
      {selected && (
        <div className="chart-tooltip">
          <strong>{selected}</strong>
          {plotted.map((s, i) => {
            const p = s.points.find((p) => p.date === selected);
            return (
              <span key={s.stock.symbol} style={{ color: colors[i] }}>
                {s.stock.symbol}{' '}
                {p
                  ? normalized
                    ? percent(p.value)
                    : money(p.value, stocks[0]?.currency)
                  : 'Not available'}
              </span>
            );
          })}
        </div>
      )}
      {normalized && (
        <div className="chart-legend">
          {plotted.map((s, i) => (
            <span key={s.stock.symbol}>
              <i style={{ background: colors[i] }} />
              {s.stock.symbol}{' '}
              <strong>
                {s.points.length
                  ? percent(s.points[s.points.length - 1].value)
                  : 'Not available'}
              </strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
