import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ComparisonResponse } from '@clinic/schemas';
import { formatDate } from '../clinicalApi';

type Chart = ComparisonResponse['chart'];
type Series = Chart['series'][number];

/** OD solid navy, OS dark grey, OU and labs teal; the marker shape also differs, so colour is not the only cue. */
const COLOR: Record<Series['marker'], string> = { circle: '#1d4a85', square: '#4b5563', diamond: '#0f766e' };

function Dot({ cx, cy, marker, stroke }: { cx?: number; cy?: number; marker: Series['marker']; stroke: string }) {
  if (cx === undefined || cy === undefined) return null;
  if (marker === 'square') return <rect x={cx - 4} y={cy - 4} width={8} height={8} fill={stroke} />;
  if (marker === 'diamond') return <polygon points={`${cx},${cy - 5} ${cx + 5},${cy} ${cx},${cy + 5} ${cx - 5},${cy}`} fill={stroke} />;
  return <circle cx={cx} cy={cy} r={4} fill={stroke} />;
}

/**
 * Line chart of numeric rows from the comparison endpoint. Each point keeps its
 * date; gaps (no value that day) are bridged so a missed visit doesn't break the line.
 */
export default function TrendChart({
  chart,
  series = chart.series,
  height = 220,
  label,
}: {
  chart: Chart;
  series?: Series[];
  height?: number;
  label: string;
}) {
  if (series.length === 0 || chart.data.length === 0) return <p className="muted">No values to chart yet.</p>;
  const unit = series[0]?.unit ?? '';
  // Whole-number readings (mmHg, mg/dL) get whole-number ticks; logMAR and % keep decimals.
  const values = chart.data.flatMap((d) => series.map((s) => d[s.dataKey])).filter((v): v is number => typeof v === 'number');
  const whole = values.every(Number.isInteger);
  return (
    <figure className="chart" aria-label={label}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chart.data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="date" tickFormatter={(d: string) => formatDate(d, false)} tick={{ fontSize: 12 }} />
          <YAxis
            domain={whole ? [(min: number) => Math.floor(min) - 1, (max: number) => Math.ceil(max) + 1] : ['auto', 'auto']}
            allowDecimals={!whole}
            width={44}
            tick={{ fontSize: 12 }}
          />
          <Tooltip
            labelFormatter={(d: string) => formatDate(d)}
            formatter={(v: number, name: string) => [`${v} ${unit}`, name]}
          />
          <Legend wrapperStyle={{ fontSize: 13 }} />
          {series.map((s) => (
            <Line
              key={s.dataKey}
              type="linear"
              dataKey={s.dataKey}
              name={s.name}
              stroke={COLOR[s.marker]}
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
              dot={(p: { cx?: number; cy?: number; key?: string }) => (
                <Dot key={p.key} cx={p.cx} cy={p.cy} marker={s.marker} stroke={COLOR[s.marker]} />
              )}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <figcaption className="muted small">Each point is shown with its date and unit ({unit}).</figcaption>
    </figure>
  );
}
