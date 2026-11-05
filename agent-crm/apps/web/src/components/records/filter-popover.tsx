'use client';

import { Filter, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { OPERATORS_BY_TYPE, OPERATOR_LABELS, isFilterable, type Operator, type TableFilter } from '@/lib/report';
import type { MetaField, MetaObject } from '@/lib/types';
import { RelationSelect } from './relation-select';

export function ValueInput({ field, operator, value, onChange }: { field: MetaField | undefined; operator: Operator; value: string; onChange: (value: string) => void }) {
  if (operator === 'is_null') return <span className="px-1 text-muted-foreground">—</span>;
  switch (field?.type) {
    case 'boolean':
      return (
        <Select value={value || 'true'} onValueChange={onChange}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="true">Yes</SelectItem><SelectItem value="false">No</SelectItem></SelectContent>
        </Select>
      );
    case 'select':
      return (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
          <SelectContent>{field.options?.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
        </Select>
      );
    case 'relation':
      return <RelationSelect targetObjectId={field.relationObjectId} value={value || null} onChange={(next) => onChange(next ?? '')} />;
    case 'number':
    case 'numeric':
      return <Input type="number" step="any" value={value} onChange={(event) => onChange(event.target.value)} />;
    case 'date':
      return <Input type="date" value={value} onChange={(event) => onChange(event.target.value)} />;
    case 'datetime':
      return <Input type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} />;
    default:
      return <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder="Value" />;
  }
}

export function FilterPopover({ object, filters, onApply }: { object: MetaObject; filters: TableFilter[]; onApply: (filters: TableFilter[]) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TableFilter[]>(filters);
  const filterable = object.fields.filter(isFilterable);

  const update = (index: number, patch: Partial<TableFilter>) => setDraft((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  const add = () => {
    const first = filterable[0];
    if (first) setDraft((rows) => [...rows, { field: first.name, operator: OPERATORS_BY_TYPE[first.type]![0]!, value: '' }]);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(filters);
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className={filters.length ? 'text-blue' : ''}>
          <Filter /> Filter{filters.length ? ` · ${filters.length}` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[460px] p-2">
        <div className="flex flex-col gap-1.5">
          {draft.length === 0 ? <p className="px-1 py-2 text-muted-foreground">No filters. Records are shown unfiltered.</p> : null}
          {draft.map((row, index) => {
            const field = filterable.find((candidate) => candidate.name === row.field);
            return (
              <div key={index} className="grid grid-cols-[120px_110px_1fr_24px] items-center gap-1.5">
                <Select
                  value={row.field}
                  onValueChange={(name) => {
                    const next = filterable.find((candidate) => candidate.name === name)!;
                    update(index, { field: name, operator: OPERATORS_BY_TYPE[next.type]![0]!, value: '' });
                  }}
                >
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{filterable.map((candidate) => <SelectItem key={candidate.id} value={candidate.name}>{candidate.label}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={row.operator} onValueChange={(operator) => update(index, { operator: operator as Operator, value: '' })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{OPERATORS_BY_TYPE[field!.type]!.map((operator) => <SelectItem key={operator} value={operator}>{OPERATOR_LABELS[operator]}</SelectItem>)}</SelectContent>
                </Select>
                <ValueInput field={field} operator={row.operator} value={row.value} onChange={(value) => update(index, { value })} />
                <Button size="icon-sm" variant="ghost" aria-label="Remove filter" onClick={() => setDraft((rows) => rows.filter((_, position) => position !== index))}><X /></Button>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex items-center justify-between border-t pt-2">
          <Button size="sm" variant="ghost" onClick={add} disabled={filterable.length === 0}><Plus /> Add filter</Button>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => { onApply([]); setOpen(false); }}>Clear</Button>
            <Button
              size="sm"
              onClick={() => {
                onApply(draft.filter((row) => row.operator === 'is_null' || row.value !== ''));
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
