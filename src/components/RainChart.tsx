import { useMemo, useState } from 'react';
import type { DailyPoint, HourlyPoint, VelocityPoint } from '../types/telemetry.ts';
import { formatMm } from '../utils/formatters.ts';

export type ChartMode = '24h' | 'weekly' | 'monthly' | 'velocity';

interface NormalizedPoint {
  key: string;
  label: string;
  tooltipTitle: string;
  primaryValue: number;
  secondaryValue?: number;
  pulses: number;
}

interface RainChartProps {
  mode: ChartMode;
  hourly24h: HourlyPoint[];
  weekly7d: DailyPoint[];
  monthly30d: DailyPoint[];
  velocity2h: VelocityPoint[];
  showCumulative?: boolean;
  showPulses?: boolean;
  height?: number;
}

export function RainChart({
  mode,
  hourly24h,
  weekly7d,
  monthly30d,
  velocity2h,
  showCumulative = true,
  showPulses = false,
  height = 290,
}: RainChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const points: NormalizedPoint[] = useMemo(() => {
    if (mode === '24h') {
      return hourly24h.map((p) => ({
        key: p.key,
        label: p.label,
        tooltipTitle: p.fullLabel,
        primaryValue: p.mm,
        secondaryValue: p.cumulativeMm,
        pulses: p.pulses,
      }));
    }
    if (mode === 'weekly') {
      return weekly7d.map((p) => ({
        key: p.key,
        label: p.label,
        tooltipTitle: p.fullDate,
        primaryValue: p.mm,
        secondaryValue: p.cumulativeMm,
        pulses: p.pulses,
      }));
    }
    if (mode === 'monthly') {
      return monthly30d.map((p) => ({
        key: p.key,
        label: p.label,
        tooltipTitle: p.fullDate,
        primaryValue: p.mm,
        secondaryValue: p.cumulativeMm,
        pulses: p.pulses,
      }));
    }
    return velocity2h.map((p) => ({
      key: p.key,
      label: p.label,
      tooltipTitle: `Janela até ${p.label}`,
      primaryValue: p.mmPerHour,
      secondaryValue: p.mm,
      pulses: p.pulses,
    }));
  }, [mode, hourly24h, weekly7d, monthly30d, velocity2h]);

  const width = 880;
  const padLeft = 48;
  const padRight = showCumulative && mode !== 'velocity' ? 48 : 20;
  const padTop = 20;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const maxPrimary = useMemo(() => {
    const rawMax = Math.max(...points.map((p) => p.primaryValue), 0);
    if (rawMax <= 0) return mode === 'velocity' ? 10 : 5;
    if (rawMax <= 2) return 2.5;
    if (rawMax <= 5) return 6;
    if (rawMax <= 10) return 12;
    return Math.ceil((rawMax * 1.15) / 5) * 5;
  }, [points, mode]);

  const maxCumulative = useMemo(() => {
    if (!showCumulative || mode === 'velocity') return 1;
    const rawMax = Math.max(...points.map((p) => p.secondaryValue ?? 0), 0);
    return rawMax <= 0 ? 5 : Math.ceil((rawMax * 1.1) / 5) * 5;
  }, [points, showCumulative, mode]);

  const count = Math.max(points.length, 1);
  const slotW = plotW / count;
  const barW = Math.max(4, Math.min(34, slotW * 0.62));

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    ratio,
    y: padTop + plotH - ratio * plotH,
    value: maxPrimary * ratio,
    cumValue: maxCumulative * ratio,
  }));

  const labelStep = count > 20 ? 3 : count > 12 ? 2 : 1;

  const linePath = useMemo(() => {
    if (points.length === 0) return '';
    return points
      .map((p, idx) => {
        const x = padLeft + idx * slotW + slotW / 2;
        const val =
          mode === 'velocity'
            ? p.primaryValue / maxPrimary
            : (p.secondaryValue ?? 0) / maxCumulative;
        const y = padTop + plotH - Math.min(1, Math.max(0, val)) * plotH;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [points, slotW, padLeft, padTop, plotH, mode, maxPrimary, maxCumulative]);

  const areaPath = useMemo(() => {
    if (mode !== 'velocity' || points.length === 0) return '';
    const firstX = padLeft + slotW / 2;
    const lastX = padLeft + (points.length - 1) * slotW + slotW / 2;
    const baseY = padTop + plotH;
    return `${linePath} L ${lastX.toFixed(1)} ${baseY.toFixed(1)} L ${firstX.toFixed(1)} ${baseY.toFixed(1)} Z`;
  }, [mode, points.length, linePath, padLeft, slotW, padTop, plotH]);

  const activePoint = hoverIndex !== null ? points[hoverIndex] : null;
  const activeX =
    hoverIndex !== null ? padLeft + hoverIndex * slotW + slotW / 2 : null;

  const unit = mode === 'velocity' ? 'mm/h' : 'mm';

  return (
    <div className="relative w-full select-none">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto overflow-visible"
        role="img"
        aria-label="Gráfico de precipitação pluviométrica"
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Horizontal Gridlines */}
        {yTicks.map((tick) => (
          <g key={tick.ratio}>
            <line
              x1={padLeft}
              y1={tick.y}
              x2={padLeft + plotW}
              y2={tick.y}
              className="stroke-slate-200 dark:stroke-slate-800"
              strokeWidth={1}
              strokeDasharray={tick.ratio === 0 ? undefined : '3 3'}
            />
            <text
              x={padLeft - 8}
              y={tick.y + 4}
              textAnchor="end"
              className="fill-slate-400 dark:fill-slate-500 font-mono text-[10px]"
            >
              {formatMm(tick.value, tick.value < 10 ? 1 : 0)}
            </text>
            {showCumulative && mode !== 'velocity' && (
              <text
                x={padLeft + plotW + 8}
                y={tick.y + 4}
                textAnchor="start"
                className="fill-sky-600/80 dark:fill-sky-400/80 font-mono text-[10px]"
              >
                {formatMm(tick.cumValue, tick.cumValue < 10 ? 1 : 0)}
              </text>
            )}
          </g>
        ))}

        {/* Unit labels */}
        <text
          x={padLeft - 8}
          y={10}
          textAnchor="end"
          className="fill-slate-400 dark:fill-slate-500 font-mono text-[10px]"
        >
          {unit}
        </text>
        {showCumulative && mode !== 'velocity' && (
          <text
            x={padLeft + plotW + 8}
            y={10}
            textAnchor="start"
            className="fill-sky-600/80 dark:fill-sky-400/80 font-mono text-[10px]"
          >
            acum.
          </text>
        )}

        {/* Velocity Threshold Reference (2.5 mm/h & 10 mm/h) */}
        {mode === 'velocity' &&
          [
            { threshold: 2.5, text: 'Fraca 2,5' },
            { threshold: 10, text: 'Moderada 10' },
          ]
            .filter((ref) => ref.threshold <= maxPrimary)
            .map((ref) => {
              const y = padTop + plotH - (ref.threshold / maxPrimary) * plotH;
              return (
                <g key={ref.threshold}>
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={padLeft + plotW}
                    y2={y}
                    className="stroke-amber-400/70 dark:stroke-amber-500/50"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                  />
                  <text
                    x={padLeft + 4}
                    y={y - 4}
                    className="fill-amber-600 dark:fill-amber-400 font-mono text-[9px]"
                  >
                    {ref.text} mm/h
                  </text>
                </g>
              );
            })}

        {/* Bars for 24h / Weekly / Monthly */}
        {mode !== 'velocity' &&
          points.map((p, idx) => {
            const xCenter = padLeft + idx * slotW + slotW / 2;
            const barH = (p.primaryValue / maxPrimary) * plotH;
            const y = padTop + plotH - barH;
            const isHovered = hoverIndex === idx;

            return (
              <g key={p.key}>
                <rect
                  x={xCenter - barW / 2}
                  y={p.primaryValue > 0 ? Math.min(y, padTop + plotH - 2) : padTop + plotH - 1}
                  width={barW}
                  height={p.primaryValue > 0 ? Math.max(barH, 2) : 1}
                  rx={2}
                  className={
                    p.primaryValue === 0
                      ? 'fill-slate-200 dark:fill-slate-800 transition-colors'
                      : isHovered
                        ? 'fill-sky-500 dark:fill-sky-400 transition-colors'
                        : 'fill-sky-600/85 dark:fill-sky-500/85 transition-colors'
                  }
                />
              </g>
            );
          })}

        {/* Velocity Area + Line OR Cumulative Line */}
        {mode === 'velocity' && areaPath && (
          <path
            d={areaPath}
            className="fill-sky-500/15 dark:fill-sky-400/15"
          />
        )}

        {(mode === 'velocity' || showCumulative) && linePath && (
          <path
            d={linePath}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={
              mode === 'velocity'
                ? 'stroke-sky-600 dark:stroke-sky-400'
                : 'stroke-slate-700/80 dark:stroke-slate-300/80'
            }
          />
        )}

        {/* Dots on Velocity line */}
        {mode === 'velocity' &&
          points.map((p, idx) => {
            const x = padLeft + idx * slotW + slotW / 2;
            const y =
              padTop +
              plotH -
              Math.min(1, p.primaryValue / maxPrimary) * plotH;
            const isHovered = hoverIndex === idx;
            return (
              <circle
                key={p.key}
                cx={x}
                cy={y}
                r={isHovered ? 4.5 : p.primaryValue > 0 ? 3 : 1.5}
                className={
                  isHovered
                    ? 'fill-sky-600 dark:fill-sky-300 stroke-white dark:stroke-slate-900'
                    : p.primaryValue > 0
                      ? 'fill-sky-600 dark:fill-sky-400'
                      : 'fill-slate-300 dark:fill-slate-700'
                }
                strokeWidth={isHovered ? 2 : 0}
              />
            );
          })}

        {/* Crosshair guide */}
        {activeX !== null && (
          <line
            x1={activeX}
            y1={padTop}
            x2={activeX}
            y2={padTop + plotH}
            className="stroke-slate-400/60 dark:stroke-slate-500/60"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        )}

        {/* X Axis Labels */}
        {points.map((p, idx) => {
          const isLast = idx === points.length - 1;
          if (idx % labelStep !== 0 && !isLast) return null;
          const x = padLeft + idx * slotW + slotW / 2;
          return (
            <text
              key={`lbl-${p.key}`}
              x={x}
              y={height - 10}
              textAnchor="middle"
              className="fill-slate-500 dark:fill-slate-400 font-mono text-[10px]"
            >
              {p.label}
            </text>
          );
        })}

        {/* Invisible hover hit zones */}
        {points.map((p, idx) => (
          <rect
            key={`hit-${p.key}`}
            x={padLeft + idx * slotW}
            y={padTop}
            width={slotW}
            height={plotH + padBottom}
            fill="transparent"
            className="cursor-crosshair"
            onMouseEnter={() => setHoverIndex(idx)}
            onTouchStart={() => setHoverIndex(idx)}
          />
        ))}
      </svg>

      {/* Interactive Crosshair Tooltip */}
      {activePoint && activeX !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-md border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-3 py-2 text-xs shadow-sm backdrop-blur-xs"
          style={{
            left: `${Math.min(76, Math.max(8, (activeX / width) * 100))}%`,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
            {activePoint.tooltipTitle}
          </div>
          <div className="mt-1 flex items-center gap-3 font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
            <span>
              <strong className="text-sky-600 dark:text-sky-400">
                {formatMm(activePoint.primaryValue)}
              </strong>{' '}
              {unit}
            </span>
            {mode !== 'velocity' && activePoint.secondaryValue !== undefined && (
              <span>
                Acum: <strong>{formatMm(activePoint.secondaryValue)}</strong> mm
              </span>
            )}
            {mode === 'velocity' && activePoint.secondaryValue !== undefined && (
              <span>
                Lâmina: <strong>{formatMm(activePoint.secondaryValue)}</strong> mm
              </span>
            )}
            {showPulses && <span>{activePoint.pulses}p</span>}
          </div>
        </div>
      )}
    </div>
  );
}
