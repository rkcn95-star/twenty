'use client';

import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { FieldInput } from '@/components/records/field-input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FormFieldDef } from '@/lib/form';
import { isEmptyValue } from '@/lib/record-values';
import type { MetaObject } from '@/lib/types';

const NO_DEFAULT_TYPES = new Set(['json', 'many_to_many']);

export function FieldListEditor({ object, fields, onChange, exclude = [] }: { object: MetaObject; fields: FormFieldDef[]; onChange: (fields: FormFieldDef[]) => void; exclude?: string[] }) {
  const remaining = object.fields.filter((field) => !fields.some((entry) => entry.name === field.name) && !exclude.includes(field.name));
  const update = (index: number, patch: Partial<FormFieldDef>) => onChange(fields.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
  const move = (index: number, delta: number) => {
    const next = [...fields];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved!);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {fields.length === 0 ? <p className="text-muted-foreground">Add the fields people should fill in.</p> : null}
      {fields.map((entry, index) => {
        const field = object.fields.find((candidate) => candidate.name === entry.name);
        if (!field) return null;
        return (
          <div key={entry.name} className="flex flex-col gap-1.5 rounded-[4px] border p-1.5">
            <div className="flex items-center gap-1.5">
              <Input aria-label={`Label for ${field.label}`} value={entry.label ?? ''} placeholder={field.label} onChange={(event) => update(index, { label: event.target.value || undefined })} />
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${field.label} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${field.label} down`} disabled={index === fields.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${field.label}`} onClick={() => onChange(fields.filter((_, position) => position !== index))}><X /></Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono">{field.name}</span>
              <label className="flex items-center gap-1"><Checkbox checked={Boolean(entry.required)} onCheckedChange={(checked) => update(index, { required: checked === true || undefined })} /> Required</label>
              <label className="flex items-center gap-1"><Checkbox checked={Boolean(entry.readOnly)} onCheckedChange={(checked) => update(index, { readOnly: checked === true || undefined })} /> Read-only</label>
            </div>
            {!NO_DEFAULT_TYPES.has(field.type) ? (
              <div className="flex items-center gap-2">
                <span className="w-[58px] shrink-0 text-xs text-muted-foreground">Default</span>
                <div className="flex-1">
                  <FieldInput id={`default-${object.namePlural}-${field.name}`} field={field} value={entry.defaultValue ?? (field.type === 'boolean' ? false : field.type === 'multi_select' ? [] : '')} onChange={(value) => update(index, { defaultValue: isEmptyValue(value) ? undefined : value })} />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      <Select value="" onValueChange={(name) => onChange([...fields, { name }])}>
        <SelectTrigger className="w-full" aria-label="Add a field" disabled={remaining.length === 0}>
          <span className="flex items-center gap-1.5 text-muted-foreground"><Plus className="size-3.5" /> <SelectValue placeholder="Add a field" /></span>
        </SelectTrigger>
        <SelectContent>{remaining.map((field) => <SelectItem key={field.id} value={field.name}>{field.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}
