'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import type { Me } from '@/lib/types';

export function WorkspacePicker({ forceNew = false }: { forceNew?: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => request<Me>('/v1/me') });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 403) router.replace('/sign-in');
    if (me.data?.workspaces.length === 1 && !forceNew) router.replace(`/w/${me.data.workspaces[0]!.workspaceId}`);
  }, [me.data, me.error, router]);

  const create = useMutation({
    mutationFn: (name: string) => request<{ workspaceId: string }>('/v1/workspaces', { body: { name } }),
    onSuccess: async ({ workspaceId }) => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      router.push(`/w/${workspaceId}`);
    },
    onError: (error) => toast.error(error.message),
  });

  if (!me.data || (me.data.workspaces.length === 1 && !forceNew)) return null;

  return (
    <AuthCard
      title={forceNew ? 'Create a workspace' : me.data.workspaces.length ? 'Choose a workspace' : 'Create your workspace'}
      description={me.data.workspaces.length ? undefined : `Welcome, ${me.data.user.name}. A workspace holds your data model and your team.`}
    >
      <div className="flex flex-col gap-1">
        {me.data.workspaces.map((workspace) => (
          <Button key={workspace.workspaceId} variant="outline" className="justify-between" onClick={() => router.push(`/w/${workspace.workspaceId}`)}>
            {workspace.name}
            <span className="text-xs text-muted-foreground">{workspace.tenancy}</span>
          </Button>
        ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
          if (name) create.mutate(name);
        }}
      >
        <Input name="name" placeholder="New workspace name" required />
        <Button type="submit" disabled={create.isPending}>Create</Button>
      </form>
    </AuthCard>
  );
}
