'use client';

import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CellValue } from '@/components/records/cell-value';
import type { Visualization } from '@/lib/report';
import type { FieldType, ReportResult } from '@/lib/types';

const COLORS = ['#4662d5', '#55a271', '#e57333', '#9b6bd0', '#d45452'];

const asFieldType = (type: string): FieldType => (['number', 'datetime', 'date', 'boolean', 'text'].includes(type) ? (type as FieldType) : 'text');

const shortDate = (value: unknown) => {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

const isNumeric = (result: ReportResult, key: string) => result.columns.find((column) => column.key === key)?.type === 'number';

export function ResultTable({ result }: { result: ReportResult }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-[13px]">
      <thead className="sticky top-0 bg-background">
        <tr>
          {result.columns.map((column) => <th key={column.key} className="h-8 border-b border-r px-2 text-left text-xs font-normal text-muted-foreground last:border-r-0">{column.key}</th>)}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, index) => (
          <tr key={index} className="hover:bg-muted/70">
            {result.columns.map((column) => (
              <td key={column.key} className="h-8 border-b border-r px-2 last:border-r-0">
                <CellValue type={asFieldType(column.type)} value={row[column.key]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ResultView({ result, visualization }: { result: ReportResult; visualization?: Visualization }) {
  if (result.rows.length === 0) return <p className="p-6 text-center text-muted-foreground">No rows match this report.</p>;
  const type = visualization?.type ?? 'table';
  const x = visualization?.x ?? result.columns.find((column) => !isNumeric(result, column.key))?.key ?? result.columns[0]!.key;
  const y = visualization?.y?.length ? visualization.y : result.columns.filter((column) => column.key !== x && isNumeric(result, column.key)).map((column) => column.key);
  const temporal = result.columns.find((column) => column.key === x)?.type === 'datetime';
  const data = result.rows.map((row) => ({ ...row, [x]: temporal ? shortDate(row[x]) : row[x] === null ? '—' : row[x] }));

  if (type === 'table' || y.length === 0) return <ResultTable result={result} />;

  if (type === 'kpi') {
    const value = Number(result.rows[0]?.[y[0]!] ?? 0);
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-14">
        <span className="text-[40px] font-semibold tabular-nums">{value.toLocaleString()}</span>
        <span className="text-muted-foreground">{y[0]}</span>
      </div>
    );
  }

  return (
    <div className="h-[340px] w-full p-3">
      <ResponsiveContainer width="100%" height="100%">
        {type === 'pie' ? (
          <PieChart>
            <Pie data={data} dataKey={y[0]!} nameKey={x} outerRadius={110} label>
              {data.map((_, index) => <Cell key={index} fill={COLORS[index % COLORS.length]} />)}
            </Pie>
            <Tooltip />
          </PieChart>
        ) : type === 'line' ? (
          <LineChart data={data}>
            <CartesianGrid stroke="#ebebeb" vertical={false} />
            <XAxis dataKey={x} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            {y.map((key, index) => <Line key={key} dataKey={key} stroke={COLORS[index % COLORS.length]} strokeWidth={2} dot={false} />)}
          </LineChart>
        ) : (
          <BarChart data={data}>
            <CartesianGrid stroke="#ebebeb" vertical={false} />
            <XAxis dataKey={x} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip cursor={{ fill: '#f1f1f1' }} />
            {y.map((key, index) => <Bar key={key} dataKey={key} fill={COLORS[index % COLORS.length]} radius={[3, 3, 0, 0]} />)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
