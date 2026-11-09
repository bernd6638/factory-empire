import type { ReactNode } from 'react';

export const CHART = {
  brand: '#818cf8',
  violet: '#c084fc',
  green: '#34d399',
  yellow: '#fbbf24',
  red: '#f87171',
  blue: '#38bdf8',
  grid: '#232733',
  axis: '#6b7286',
};

export const PALETTE = [CHART.brand, CHART.violet, CHART.green, CHART.yellow, CHART.blue, CHART.red, '#f472b6', '#a3e635'];

export const axisProps = {
  stroke: CHART.axis,
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

/** Einheitlicher Tooltip für alle Diagramme. */
export function ChartTooltip({ active, payload, label, labelFormatter, valueFormatter }: { active?: boolean; payload?: any[]; label?: any; labelFormatter?: (l: any) => ReactNode; valueFormatter?: (v: number, name: string) => ReactNode }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line-strong bg-panel-2 px-3 py-2 text-xs shadow-2xl">
      {label !== undefined && <div className="mb-1.5 font-medium text-fg">{labelFormatter ? labelFormatter(label) : label}</div>}
      <div className="space-y-1">
        {payload.map((p) => (
          <div key={p.dataKey ?? p.name} className="flex items-center gap-2 text-fg-muted">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />
            <span>{p.name}</span>
            <span className="ml-auto pl-4 font-semibold text-fg tabular-nums">{valueFormatter ? valueFormatter(p.value, p.name) : Number(p.value).toLocaleString('de-DE')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GradientDefs({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity={0.35} />
        <stop offset="100%" stopColor={color} stopOpacity={0} />
      </linearGradient>
    </defs>
  );
}
