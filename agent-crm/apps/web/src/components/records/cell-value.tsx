import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { FieldType } from '@/lib/types';

const Empty = () => <span className="text-muted-foreground/60">—</span>;

export function CellValue({ type, value }: { type: FieldType; value: unknown }) {
  if (value === null || value === undefined || value === '') return <Empty />;
  switch (type) {
    case 'boolean':
      return value ? <Check className="size-3.5 text-green-600" aria-label="Yes" /> : <span className="text-muted-foreground">No</span>;
    case 'select':
      return <Badge variant="secondary" className="rounded-[4px] bg-blue-soft font-normal text-blue">{String(value)}</Badge>;
    case 'multi_select':
      return (
        <span className="flex gap-1">
          {(value as string[]).map((item) => <Badge key={item} variant="secondary" className="rounded-[4px] bg-blue-soft font-normal text-blue">{item}</Badge>)}
        </span>
      );
    case 'date':
      return <span>{new Date(String(value)).toLocaleDateString(undefined, { timeZone: 'UTC' })}</span>;
    case 'datetime':
      return <span className="text-muted-foreground">{new Date(String(value)).toLocaleString()}</span>;
    case 'number':
    case 'numeric':
      return <span className="tabular-nums">{Number(value).toLocaleString()}</span>;
    case 'json':
      return <code className="text-xs text-muted-foreground">{JSON.stringify(value)}</code>;
    default:
      return <span className="truncate">{String(value)}</span>;
  }
}
