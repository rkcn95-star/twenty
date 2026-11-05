'use client';

import { useQuery } from '@tanstack/react-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import { displayFieldOf, type ReportDefinition } from '@/lib/report';
import type { ReportResult } from '@/lib/types';

const NONE = '__none__';

export function useRelationOptions(targetObjectId: string | null) {
  const { workspaceId, metadata } = useWorkspace();
  const target = metadata.objects.find((object) => object.id === targetObjectId);
  const display = target ? displayFieldOf(target) : null;
  return useQuery({
    queryKey: ['relation-options', workspaceId, targetObjectId],
    enabled: Boolean(target),
    queryFn: async () => {
      const definition: ReportDefinition = {
        source: target!.namePlural,
        columns: [{ key: 'id', ref: { field: 'id' } }, ...(display ? [{ key: 'label', ref: { field: display } }] : [])],
        orderBy: display ? [{ key: 'label', direction: 'asc' }] : [{ key: 'id', direction: 'asc' }],
        limit: 200,
      };
      const result = await callTool<ReportResult>(workspaceId, 'run_report', { definition });
      return result.rows.map((row) => ({ id: String(row.id), label: String(row.label ?? String(row.id).slice(0, 8)) }));
    },
  });
}

export function RelationSelect({ targetObjectId, value, onChange, disabled }: { targetObjectId: string | null; value: string | null; onChange: (value: string | null) => void; disabled?: boolean }) {
  const options = useRelationOptions(targetObjectId);
  return (
    <Select value={value ?? NONE} onValueChange={(next) => onChange(next === NONE ? null : next)} disabled={disabled}>
      <SelectTrigger className="w-full"><SelectValue placeholder="None" /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>None</SelectItem>
        {options.data?.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
