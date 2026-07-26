"use client";

import { useMemo, useRef, useState } from "react";

export interface SeriesPoint {
  x: number; // epoch ms
  y: number | null;
}

export interface Series {
  device: string;
  colorVar: string; // e.g. "--series-3"
  points: SeriesPoint[];
}

interface Props {
  title: string;
  unit: string;
  series: Series[];
  height?: number;
  decimals?: number;
}

const WIDTH = 900;
const MARGIN = { top: 12, right: 16, bottom: 20, left: 44 };

function formatTick(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatTickFull(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function LineChart({ title, unit, series, height = 220, decimals = 1 }: Props) {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const allPoints = series.flatMap((s) => s.points);
  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.filter((p): p is { x: number; y: number } => p.y !== null).map((p) => p.y);

  const hasData = xs.length > 0;
  const xMin = hasData ? Math.min(...xs) : 0;
  const xMax = hasData ? Math.max(...xs) : 1;
  const yMinRaw = ys.length ? Math.min(...ys) : 0;
  const yMaxRaw = ys.length ? Math.max(...ys) : 1;
  const pad = (yMaxRaw - yMinRaw) * 0.1 || Math.abs(yMaxRaw) * 0.1 || 1;
  const yMin = yMinRaw - pad;
  const yMax = yMaxRaw + pad;

  const xScale = (x: number) =>
    xMax === xMin ? MARGIN.left + plotW / 2 : MARGIN.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const yScale = (y: number) =>
    yMax === yMin ? MARGIN.top + plotH / 2 : MARGIN.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

  const linePaths = useMemo(() => {
    return series.map((s) => {
      const sorted = [...s.points].sort((a, b) => a.x - b.x);
      let d = "";
      let open = false;
      let last: { x: number; y: number } | null = null;
      for (const p of sorted) {
        if (p.y === null) {
          open = false;
          continue;
        }
        d += `${open ? "L" : "M"}${xScale(p.x).toFixed(2)},${yScale(p.y).toFixed(2)} `;
        open = true;
        last = { x: p.x, y: p.y };
      }
      return { device: s.device, colorVar: s.colorVar, d, last };
    });
    // xScale/yScale are pure functions of xMin/xMax/yMin/yMax, already listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, xMin, xMax, yMin, yMax]);

  const tickCount = 4;
  const tickValues = Array.from({ length: tickCount + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / tickCount);

  const frameXs = useMemo(() => Array.from(new Set(xs)).sort((a, b) => a - b), [xs]);

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || frameXs.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const userX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const dataX = xMin + ((userX - MARGIN.left) / plotW) * (xMax - xMin);
    let nearest = frameXs[0];
    let best = Infinity;
    for (const fx of frameXs) {
      const diff = Math.abs(fx - dataX);
      if (diff < best) {
        best = diff;
        nearest = fx;
      }
    }
    setHoverX(nearest);
  }

  function nearestValueFor(s: Series, targetX: number): number | null {
    let best: number | null = null;
    let bestDiff = Infinity;
    for (const p of s.points) {
      if (p.y === null) continue;
      const diff = Math.abs(p.x - targetX);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = p.y;
      }
    }
    return best;
  }

  const showLegend = series.length > 1;

  return (
    <div className="chartCard">
      <div className="chartHeader">
        <h3>{title}</h3>
        <span className="chartUnit">{unit}</span>
      </div>

      {showLegend && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.device} className="legendItem">
              <span className="legendSwatch" style={{ background: `var(${s.colorVar})` }} />
              {s.device}
            </span>
          ))}
        </div>
      )}

      {!hasData ? (
        <p className="latestCaption">No data for this range.</p>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${height}`}
          preserveAspectRatio="none"
          className="chartSvg"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverX(null)}
        >
          {tickValues.map((t, i) => (
            <g key={i}>
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={yScale(t)} y2={yScale(t)} className="gridline" />
              <text x={MARGIN.left - 8} y={yScale(t)} className="tickLabel" textAnchor="end" dominantBaseline="middle">
                {t.toFixed(decimals)}
              </text>
            </g>
          ))}

          <line x1={MARGIN.left} x2={MARGIN.left} y1={MARGIN.top} y2={height - MARGIN.bottom} className="axisLine" />

          {linePaths.map((lp) => (
            <path
              key={lp.device}
              d={lp.d}
              fill="none"
              stroke={`var(${lp.colorVar})`}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {linePaths.map(
            (lp) =>
              lp.last && (
                <circle
                  key={`${lp.device}-end`}
                  cx={xScale(lp.last.x)}
                  cy={yScale(lp.last.y)}
                  r={4}
                  fill={`var(${lp.colorVar})`}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              )
          )}

          {hoverX !== null && (
            <line
              x1={xScale(hoverX)}
              x2={xScale(hoverX)}
              y1={MARGIN.top}
              y2={height - MARGIN.bottom}
              className="crosshair"
            />
          )}

          <text x={MARGIN.left} y={height - 4} className="tickLabel" textAnchor="start">
            {formatTick(xMin)}
          </text>
          <text x={WIDTH - MARGIN.right} y={height - 4} className="tickLabel" textAnchor="end">
            {formatTick(xMax)}
          </text>
        </svg>
      )}

      {hoverX !== null && (
        <div className="tooltip">
          <div className="tooltipTime">{formatTickFull(hoverX)}</div>
          {series.map((s) => {
            const v = nearestValueFor(s, hoverX);
            return (
              <div key={s.device} className="tooltipRow">
                <span className="legendSwatchLine" style={{ background: `var(${s.colorVar})` }} />
                <span className="tooltipValue">{v === null ? "—" : v.toFixed(decimals)}</span>
                {showLegend && <span className="tooltipDevice">{s.device}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
