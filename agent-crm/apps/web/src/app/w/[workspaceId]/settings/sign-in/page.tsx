'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { RequireAccessAdmin } from '@/components/settings/guard';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Switch } from '@/components/ui/switch';
import { useWorkspace } from '@/components/workspace-context';
import { manage } from '@/lib/api';
import type { AuthSettings } from '@/lib/manage-types';

function Row({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b py-3 last:border-b-0">
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-muted-foreground">{description}</p>
      </div>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SignInMethods() {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['auth-settings', workspaceId], queryFn: () => manage<AuthSettings>(workspaceId, '/auth-settings') });
  const update = useMutation({
    mutationFn: (patch: Partial<AuthSettings>) => manage<AuthSettings>(workspaceId, '/auth-settings', { method: 'PATCH', body: patch }),
    onSuccess: (next) => queryClient.setQueryData(['auth-settings', workspaceId], next),
    onError: (error) => toast.error(error.message),
  });
  const value = settings.data;
  const set = (patch: Partial<AuthSettings>) => update.mutate(patch);

  return (
    <>
      <PageHeader title="Sign-in methods" icon={<ShieldCheck />} />
      <PageBody className="p-4">
        <div className="max-w-xl">
          <p className="mb-2 text-muted-foreground">Choose how people can sign in to this workspace. API keys are not affected.</p>
          {value ? (
            <div className="rounded-lg border px-3">
              <Row label="Email and password" description="People sign in with a verified email address and a password." checked={value.passwordAuthEnabled} onChange={(checked) => set({ passwordAuthEnabled: checked })} />
              <Row label="Google" description="People sign in with their Google account." checked={value.googleAuthEnabled} onChange={(checked) => set({ googleAuthEnabled: checked })} />
              <Row label="Admins can bypass disabled email and password" description="Admins with the bypass flag can still use a disabled method, so a misconfiguration cannot lock everyone out." checked={value.passwordAuthBypassEnabled} onChange={(checked) => set({ passwordAuthBypassEnabled: checked })} />
              <Row label="Admins can bypass disabled Google" description="The same safety net for Google sign-in." checked={value.googleAuthBypassEnabled} onChange={(checked) => set({ googleAuthBypassEnabled: checked })} />
            </div>
          ) : null}
          <p className="mt-3 text-muted-foreground">At least one method must stay enabled.</p>
        </div>
      </PageBody>
    </>
  );
}

export default function SignInPage() {
  return <RequireAccessAdmin><SignInMethods /></RequireAccessAdmin>;
}
