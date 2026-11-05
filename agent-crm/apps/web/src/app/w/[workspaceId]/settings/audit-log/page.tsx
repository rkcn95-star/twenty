'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useState } from 'react';
import { RequireAccessAdmin } from '@/components/settings/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWorkspace } from '@/components/workspace-context';
import { manage } from '@/lib/api';
import type { AuditEntry, Member } from '@/lib/manage-types';

const ALL = '__all__';

function AuditLog() {
  const { workspaceId } = useWorkspace();
  const [outcome, setOutcome] = useState(ALL);
  const [tool, setTool] = useState('');
  const members = useQuery({ queryKey: ['members', workspaceId], queryFn: () => manage<{ members: Member[] }>(workspaceId, '/members') });
  const names = new Map(members.data?.members.map((member) => [member.id, member.name]));

  const log = useInfiniteQuery({
    queryKey: ['audit-log', workspaceId, outcome, tool],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (outcome !== ALL) params.set('outcome', outcome);
      if (tool) params.set('tool', tool);
      if (pageParam) params.set('before', String(pageParam));
      return manage<{ entries: AuditEntry[]; nextBefore: number | null }>(workspaceId, `/audit-log?${params}`);
    },
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  const entries = log.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        icon={<History />}
        actions={
          <>
            <Input aria-label="Filter by tool" className="w-[180px]" placeholder="Tool name" value={tool} onChange={(event) => setTool(event.target.value.trim())} />
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger className="w-[110px]" aria-label="Outcome"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>All</SelectItem><SelectItem value="ok">Succeeded</SelectItem><SelectItem value="error">Failed</SelectItem></SelectContent>
            </Select>
          </>
        }
      />
      <PageBody>
        {log.error ? <EmptyState title="Could not load the audit log" description={log.error.message} /> : null}
        {!log.isPending && entries.length === 0 ? <EmptyState title="Nothing logged yet" description="Every tool call by a person, key or agent is recorded here." /> : null}
        {entries.length ? (
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="sticky top-0 bg-background">
              <tr>{['When', 'Who', 'Tool', 'Result', 'Rows', 'Detail'].map((heading) => <th key={heading} className="h-8 border-b px-3 text-left text-xs font-normal text-muted-foreground">{heading}</th>)}</tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-muted/70">
                  <td className="h-8 whitespace-nowrap border-b px-3 text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</td>
                  <td className="h-8 border-b px-3">{names.get(entry.principalId) ?? entry.principalId.slice(0, 8)}</td>
                  <td className="h-8 border-b px-3"><code className="text-xs">{entry.tool}</code></td>
                  <td className="h-8 border-b px-3">
                    <Badge variant="secondary" className={`rounded-[4px] font-normal ${entry.outcome === 'ok' ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400' : 'bg-red-50 text-destructive dark:bg-red-950'}`}>{entry.outcome === 'ok' ? 'Succeeded' : 'Failed'}</Badge>
                  </td>
                  <td className="h-8 border-b px-3 tabular-nums text-muted-foreground">{entry.rowCount ?? '—'}</td>
                  <td className="h-8 max-w-[320px] truncate border-b px-3 text-muted-foreground" title={entry.detail ?? undefined}>{entry.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {log.hasNextPage ? <div className="p-3 text-center"><Button size="sm" variant="outline" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>Load more</Button></div> : null}
      </PageBody>
    </>
  );
}

export default function AuditLogPage() {
  return <RequireAccessAdmin><AuditLog /></RequireAccessAdmin>;
}
