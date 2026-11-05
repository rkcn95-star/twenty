'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, MoreHorizontal, Plus, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { FormField } from '@/components/form-field';
import { RequireAccessAdmin } from '@/components/settings/guard';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWorkspace } from '@/components/workspace-context';
import { manage } from '@/lib/api';
import type { Member, Role } from '@/lib/manage-types';

const KIND_LABELS = { user: 'Person', api_key: 'API key', agent: 'Agent' } as const;
const EXPIRY_OPTIONS = [{ value: 'never', label: 'Never expires' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '1 year' }];

const statusOf = (member: Member): { label: string; tone: string } => {
  if (member.revokedAt) return { label: 'Revoked', tone: 'bg-red-50 text-destructive' };
  if (member.expiresAt && new Date(member.expiresAt) < new Date()) return { label: 'Expired', tone: 'bg-orange-50 text-orange-700' };
  return { label: 'Active', tone: 'bg-green-50 text-green-700' };
};

function RoleChecklist({ roles, selected, onChange }: { roles: Role[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {roles.map((role) => (
        <label key={role.id} className="flex items-center gap-2">
          <Checkbox checked={selected.includes(role.id)} onCheckedChange={(checked) => onChange(checked ? [...selected, role.id] : selected.filter((id) => id !== role.id))} />
          {role.name}
        </label>
      ))}
    </div>
  );
}

function SecretDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={Boolean(secret)} onOpenChange={(open) => { if (!open) { setCopied(false); onClose(); } }}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Copy your API key</DialogTitle>
          <DialogDescription>This is the only time the key is shown. Store it somewhere safe.</DialogDescription>
        </DialogHeader>
        <code data-testid="api-key" className="block break-all rounded-[4px] border bg-muted p-2 text-xs">{secret}</code>
        <DialogFooter>
          <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(secret ?? ''); setCopied(true); }}>{copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}</Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewKeyDialog({ open, onOpenChange, roles, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; roles: Role[]; onCreated: (secret: string) => void }) {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'api_key' | 'agent'>('api_key');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('never');
  const create = useMutation({
    mutationFn: () =>
      manage<{ apiKey: string }>(workspaceId, '/api-keys', {
        body: { name, kind, roleIds, ...(expiry === 'never' ? {} : { expiresAt: new Date(Date.now() + Number(expiry) * 86_400_000).toISOString() }) },
      }),
    onSuccess: async ({ apiKey }) => {
      await queryClient.invalidateQueries({ queryKey: ['members', workspaceId] });
      onOpenChange(false);
      setName(''); setRoleIds([]); setExpiry('never');
      onCreated(apiKey);
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader><DialogTitle>New API key</DialogTitle><DialogDescription>For scripts, integrations and AI agents. It gets only the roles you choose.</DialogDescription></DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
          <FormField label="Name" htmlFor="key-name"><Input id="key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Zapier sync" required /></FormField>
          <FormField label="Type">
            <Select value={kind} onValueChange={(value) => setKind(value as 'api_key' | 'agent')}>
              <SelectTrigger className="w-full" aria-label="Key type"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="api_key">API key</SelectItem><SelectItem value="agent">Agent</SelectItem></SelectContent>
            </Select>
          </FormField>
          <FormField label="Expires">
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger className="w-full" aria-label="Expiry"><SelectValue /></SelectTrigger>
              <SelectContent>{EXPIRY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          <FormField label="Roles"><RoleChecklist roles={roles} selected={roleIds} onChange={setRoleIds} /></FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name || roleIds.length === 0 || create.isPending}>Create key</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({ open, onOpenChange, roles }: { open: boolean; onOpenChange: (open: boolean) => void; roles: Role[] }) {
  const { workspaceId } = useWorkspace();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const invite = useMutation({
    mutationFn: () => manage(workspaceId, '/invitations', { body: { email, roleIds: [roleId] } }),
    onSuccess: () => { toast.success(`Invitation sent to ${email}`); onOpenChange(false); setEmail(''); setRoleId(''); },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader><DialogTitle>Invite a person</DialogTitle><DialogDescription>They get an email with a link. They must sign in with this address.</DialogDescription></DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); invite.mutate(); }}>
          <FormField label="Email" htmlFor="invite-email"><Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></FormField>
          <FormField label="Role">
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger className="w-full" aria-label="Invite role"><SelectValue placeholder="Choose a role" /></SelectTrigger>
              <SelectContent>{roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!email || !roleId || invite.isPending}>Send invitation</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditRolesDialog({ member, roles, onClose }: { member: Member | null; roles: Role[]; onClose: () => void }) {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [seen, setSeen] = useState<string | null>(null);
  if (member && seen !== member.id) { setSeen(member.id); setSelected(member.roleIds); }
  const save = useMutation({
    mutationFn: () => manage(workspaceId, `/members/${member!.id}/roles`, { method: 'PUT', body: { roleIds: selected } }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['members', workspaceId] }); toast.success('Roles updated'); onClose(); },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog open={Boolean(member)} onOpenChange={(open) => { if (!open) { setSeen(null); onClose(); } }}>
      <DialogContent className="max-w-[380px]">
        <DialogHeader><DialogTitle>Roles for {member?.name}</DialogTitle></DialogHeader>
        <RoleChecklist roles={roles} selected={selected} onChange={setSelected} />
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Members() {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ['members', workspaceId], queryFn: () => manage<{ members: Member[] }>(workspaceId, '/members') });
  const roles = useQuery({ queryKey: ['roles', workspaceId], queryFn: () => manage<{ roles: Role[] }>(workspaceId, '/roles') });
  const roleName = new Map(roles.data?.roles.map((role) => [role.id, role.name]));

  const [keyOpen, setKeyOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [confirm, setConfirm] = useState<{ member: Member; action: 'remove' | 'revoke' } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members', workspaceId] });
  const rotate = useMutation({
    mutationFn: (member: Member) => manage<{ apiKey: string }>(workspaceId, `/api-keys/${member.id}/rotate`, { body: {} }),
    onSuccess: async ({ apiKey }) => { await refresh(); setSecret(apiKey); },
    onError: (error) => toast.error(error.message),
  });
  const act = useMutation({
    mutationFn: ({ member, action }: { member: Member; action: 'remove' | 'revoke' }) =>
      action === 'remove' ? manage(workspaceId, `/members/${member.id}`, { method: 'DELETE' }) : manage(workspaceId, `/api-keys/${member.id}/revoke`, { body: {} }),
    onSuccess: async () => { await refresh(); toast.success('Done'); },
    onError: (error) => toast.error(error.message),
  });
  const list = roles.data?.roles ?? [];

  return (
    <>
      <PageHeader
        title="Members and keys"
        icon={<Users />}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)}><UserPlus /> Invite person</Button>
            <Button size="sm" onClick={() => setKeyOpen(true)}><Plus /> New API key</Button>
          </>
        }
      />
      <PageBody>
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 bg-background">
            <tr>{['Name', 'Type', 'Roles', 'Status', 'Last used', ''].map((heading, index) => <th key={index} className="h-8 border-b px-3 text-left text-xs font-normal text-muted-foreground">{heading}</th>)}</tr>
          </thead>
          <tbody>
            {members.data?.members.map((member) => {
              const status = statusOf(member);
              return (
                <tr key={member.id} className="hover:bg-muted/70">
                  <td className="h-9 border-b px-3">
                    <div className="flex items-center gap-1.5">{member.kind !== 'user' ? <KeyRound className="size-3.5 text-muted-foreground" /> : null}<span className="font-medium">{member.name}</span></div>
                    {member.email ? <div className="text-xs text-muted-foreground">{member.email}</div> : null}
                  </td>
                  <td className="h-9 border-b px-3">{KIND_LABELS[member.kind]}</td>
                  <td className="h-9 border-b px-3"><div className="flex flex-wrap gap-1">{member.roleIds.map((id) => <Badge key={id} variant="secondary" className="rounded-[4px] font-normal">{roleName.get(id) ?? 'Unknown'}</Badge>)}</div></td>
                  <td className="h-9 border-b px-3"><Badge variant="secondary" className={`rounded-[4px] font-normal ${status.tone}`}>{status.label}</Badge>{member.expiresAt && !member.revokedAt ? <span className="ml-1.5 text-xs text-muted-foreground">until {new Date(member.expiresAt).toLocaleDateString()}</span> : null}</td>
                  <td className="h-9 border-b px-3 text-muted-foreground">{member.lastUsedAt ? new Date(member.lastUsedAt).toLocaleString() : 'Never'}</td>
                  <td className="h-9 w-8 border-b px-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`Actions for ${member.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing(member)}>Edit roles</DropdownMenuItem>
                        {member.kind !== 'user' ? <DropdownMenuItem onSelect={() => rotate.mutate(member)}>Rotate key</DropdownMenuItem> : null}
                        {member.kind !== 'user' && !member.revokedAt ? <DropdownMenuItem className="text-destructive" onSelect={() => setConfirm({ member, action: 'revoke' })}>Revoke key</DropdownMenuItem> : null}
                        <DropdownMenuItem className="text-destructive" onSelect={() => setConfirm({ member, action: 'remove' })}>Remove</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </PageBody>
      <NewKeyDialog open={keyOpen} onOpenChange={setKeyOpen} roles={list} onCreated={setSecret} />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={list} />
      <EditRolesDialog member={editing} roles={list} onClose={() => setEditing(null)} />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
      <Confirm
        open={Boolean(confirm)}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.action === 'revoke' ? `Revoke ${confirm?.member.name}?` : `Remove ${confirm?.member.name}?`}
        description={confirm?.action === 'revoke' ? 'Anything using this key stops working immediately.' : 'They lose access to this workspace. This cannot be undone.'}
        actionLabel={confirm?.action === 'revoke' ? 'Revoke' : 'Remove'}
        onConfirm={() => confirm && act.mutate(confirm)}
      />
    </>
  );
}

export default function MembersPage() {
  return <RequireAccessAdmin><Members /></RequireAccessAdmin>;
}
