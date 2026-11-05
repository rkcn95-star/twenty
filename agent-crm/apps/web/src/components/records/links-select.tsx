'use client';

import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useRelationOptions } from './relation-select';

export function LinksSelect({ targetObjectId, value, onChange, disabled, id }: { targetObjectId: string | null; value: string[]; onChange: (value: string[]) => void; disabled?: boolean; id?: string }) {
  const options = useRelationOptions(targetObjectId);
  const label = (recordId: string) => options.data?.find((option) => option.id === recordId)?.label ?? recordId.slice(0, 8);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" disabled={disabled} className="h-auto min-h-7 w-full justify-between py-1 font-normal">
          <span className="flex flex-wrap gap-1">
            {value.length === 0 ? <span className="text-muted-foreground">None</span> : value.map((recordId) => <Badge key={recordId} variant="secondary" className="rounded-[4px] bg-blue-soft font-normal text-blue">{label(recordId)}</Badge>)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-64 w-[260px] overflow-y-auto p-1">
        {options.data?.length === 0 ? <p className="p-2 text-muted-foreground">Nothing to link to yet.</p> : null}
        {options.data?.map((option) => (
          <label key={option.id} className="flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1 hover:bg-accent">
            <Checkbox
              checked={value.includes(option.id)}
              onCheckedChange={(checked) => onChange(checked ? [...value, option.id] : value.filter((item) => item !== option.id))}
            />
            <span className="truncate">{option.label}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}
