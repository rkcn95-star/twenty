'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { MetaField } from '@/lib/types';
import { LinksSelect } from './links-select';
import { RelationSelect } from './relation-select';

const NONE = '__none__';

export function FieldInput({ field, value, onChange, disabled, id }: { field: MetaField; value: unknown; onChange: (value: unknown) => void; disabled?: boolean; id: string }) {
  switch (field.type) {
    case 'boolean':
      return <Checkbox id={id} checked={Boolean(value)} disabled={disabled} onCheckedChange={(checked) => onChange(checked === true)} />;
    case 'number':
    case 'numeric':
      return <Input id={id} type="number" step="any" value={String(value ?? '')} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
    case 'date':
      return <Input id={id} type="date" value={String(value ?? '')} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
    case 'datetime':
      return <Input id={id} type="datetime-local" value={String(value ?? '')} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
    case 'json':
      return <Textarea id={id} value={String(value ?? '')} disabled={disabled} className="font-mono text-xs" onChange={(event) => onChange(event.target.value)} />;
    case 'select':
      return (
        <Select value={String(value || NONE)} disabled={disabled} onValueChange={(next) => onChange(next === NONE ? '' : next)}>
          <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {field.options?.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
          </SelectContent>
        </Select>
      );
    case 'multi_select': {
      const selected = (value as string[]) ?? [];
      return (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {field.options?.map((option) => (
            <label key={option} className="flex items-center gap-1.5">
              <Checkbox
                checked={selected.includes(option)}
                disabled={disabled}
                onCheckedChange={(checked) => onChange(checked ? [...selected, option] : selected.filter((item) => item !== option))}
              />
              {option}
            </label>
          ))}
        </div>
      );
    }
    case 'relation':
      return <RelationSelect targetObjectId={field.relationObjectId} value={(value as string) || null} disabled={disabled} onChange={(next) => onChange(next ?? '')} />;
    case 'many_to_many':
      return <LinksSelect id={id} targetObjectId={field.relationObjectId} value={(value as string[]) ?? []} disabled={disabled} onChange={onChange} />;
    default:
      return <Input id={id} value={String(value ?? '')} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
  }
}
