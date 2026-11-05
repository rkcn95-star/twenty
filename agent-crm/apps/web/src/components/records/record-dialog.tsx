'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import { singularLabel } from '@/lib/labels';
import { hasColumn } from '@/lib/report';
import type { MetaField, MetaObject } from '@/lib/types';
import { RelationSelect } from './relation-select';

export type RecordRow = Record<string, unknown>;

const NONE = '__none__';

// Table rows carry relation ids under `<name>__id`; the form edits the id and the table shows the label.
const initialValue = (field: MetaField, record?: RecordRow): unknown => {
  if (!record) return field.type === 'boolean' ? false : field.type === 'multi_select' ? [] : '';
  const raw = field.type === 'relation' ? (record[`${field.name}__id`] ?? record[field.name]) : record[field.name];
  if (raw === null || raw === undefined) return field.type === 'boolean' ? false : field.type === 'multi_select' ? [] : '';
  if (field.type === 'datetime') return new Date(String(raw)).toISOString().slice(0, 16);
  if (field.type === 'date') return String(raw).slice(0, 10);
  if (field.type === 'json') return JSON.stringify(raw, null, 2);
  return raw;
};

const toPayloadValue = (field: MetaField, value: unknown): unknown => {
  if (value === '' || value === undefined) return null;
  switch (field.type) {
    case 'number':
    case 'numeric': return Number(value);
    case 'datetime': return new Date(String(value)).toISOString();
    case 'json': return JSON.parse(String(value));
    default: return value;
  }
};

export function RecordDialog({ object, record, open, onOpenChange, onSaved }: { object: MetaObject; record?: RecordRow; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { workspaceId } = useWorkspace();
  const fields = object.fields.filter(hasColumn);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const editing = Boolean(record);
  const canWrite = editing ? object.access.update : object.access.create;

  useEffect(() => {
    if (open) setValues(Object.fromEntries(fields.map((field) => [field.name, initialValue(field, record)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record]);

  const save = useMutation({
    mutationFn: async () => {
      const data: Record<string, unknown> = {};
      for (const field of fields) {
        if (field.readOnly) continue;
        const next = values[field.name];
        const before = initialValue(field, record);
        if (editing && JSON.stringify(next) === JSON.stringify(before)) continue;
        if (!editing && (next === '' || next === false || (Array.isArray(next) && next.length === 0))) continue;
        data[field.name] = toPayloadValue(field, next);
      }
      return editing
        ? callTool(workspaceId, `update_one_${object.nameSingular}`, { id: record!.id, data })
        : callTool(workspaceId, `create_one_${object.nameSingular}`, { data });
    },
    onSuccess: () => {
      toast.success(editing ? 'Saved' : `${singularLabel(object)} created`);
      onSaved();
      onOpenChange(false);
    },
    onError: (error) => toast.error(error instanceof SyntaxError ? 'A JSON field is not valid JSON' : error.message),
  });

  const set = (name: string, value: unknown) => setValues((state) => ({ ...state, [name]: value }));

  const input = (field: MetaField) => {
    const value = values[field.name];
    const disabled = field.readOnly || !canWrite;
    const id = `f-${field.name}`;
    switch (field.type) {
      case 'boolean':
        return <Checkbox id={id} checked={Boolean(value)} disabled={disabled} onCheckedChange={(checked) => set(field.name, checked === true)} />;
      case 'number':
      case 'numeric':
        return <Input id={id} type="number" step="any" value={String(value ?? '')} disabled={disabled} onChange={(event) => set(field.name, event.target.value)} />;
      case 'date':
        return <Input id={id} type="date" value={String(value ?? '')} disabled={disabled} onChange={(event) => set(field.name, event.target.value)} />;
      case 'datetime':
        return <Input id={id} type="datetime-local" value={String(value ?? '')} disabled={disabled} onChange={(event) => set(field.name, event.target.value)} />;
      case 'json':
        return <Textarea id={id} value={String(value ?? '')} disabled={disabled} className="font-mono text-xs" onChange={(event) => set(field.name, event.target.value)} />;
      case 'select':
        return (
          <Select value={String(value || NONE)} disabled={disabled} onValueChange={(next) => set(field.name, next === NONE ? '' : next)}>
            <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {field.options?.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
            </SelectContent>
          </Select>
        );
      case 'multi_select':
        return (
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {field.options?.map((option) => {
              const selected = (value as string[]).includes(option);
              return (
                <label key={option} className="flex items-center gap-1.5">
                  <Checkbox
                    checked={selected}
                    disabled={disabled}
                    onCheckedChange={(checked) => set(field.name, checked ? [...(value as string[]), option] : (value as string[]).filter((item) => item !== option))}
                  />
                  {option}
                </label>
              );
            })}
          </div>
        );
      case 'relation':
        return <RelationSelect targetObjectId={field.relationObjectId} value={(value as string) || null} disabled={disabled} onChange={(next) => set(field.name, next ?? '')} />;
      default:
        return <Input id={id} value={String(value ?? '')} disabled={disabled} onChange={(event) => set(field.name, event.target.value)} />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-[440px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${singularLabel(object).toLowerCase()}` : `New ${singularLabel(object).toLowerCase()}`}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {fields.length === 0 ? <p className="text-muted-foreground">This object has no fields yet. Add some in the data model.</p> : null}
          {fields.map((field) => (
            <FormField key={field.id} label={field.label} htmlFor={`f-${field.name}`}>{input(field)}</FormField>
          ))}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{canWrite ? 'Cancel' : 'Close'}</Button>
            {canWrite ? <Button type="submit" disabled={save.isPending}>{editing ? 'Save' : 'Create'}</Button> : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
