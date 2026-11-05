'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';
import type { Me } from '@/lib/types';

function AcceptInvitation() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const token = useSearchParams().get('token');
  const me = useQuery({ queryKey: ['me'], queryFn: () => request<Me>('/v1/me') });
  const signedOut = me.error instanceof ApiError && me.error.status === 403;

  useEffect(() => {
    if (signedOut && token) router.replace(`/sign-in?next=${encodeURIComponent(`/accept-invitation?token=${token}`)}`);
  }, [signedOut, token, router]);

  const accept = useMutation({
    mutationFn: () => request<{ workspaceId: string }>('/v1/invitations/accept', { body: { token } }),
    onSuccess: async ({ workspaceId }) => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      router.replace(`/w/${workspaceId}`);
    },
  });

  if (!token) return <AuthCard title="Invitation link is incomplete"><p className="text-muted-foreground">Open the link from your invitation email again.</p></AuthCard>;
  if (!me.data) return null;

  return (
    <AuthCard title="Join a workspace" description={`You are signed in as ${me.data.user.email}. The invitation must have been sent to this address.`}>
      {accept.error ? <p role="alert" className="mb-3 text-destructive">{accept.error.message}</p> : null}
      <Button className="w-full" disabled={accept.isPending} onClick={() => accept.mutate()}>{accept.isPending ? 'Joining…' : 'Accept invitation'}</Button>
      <p className="mt-3 text-muted-foreground">Wrong account? <Link className="text-blue hover:underline" href="/w">Go to your workspaces</Link></p>
    </AuthCard>
  );
}

export default function AcceptInvitationPage() {
  return <Suspense><AcceptInvitation /></Suspense>;
}
