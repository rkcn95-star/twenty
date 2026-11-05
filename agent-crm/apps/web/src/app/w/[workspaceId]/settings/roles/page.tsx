'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, Shield, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { FormField } from '@/components/form-field';
import { ValueInput } from '@/components/records/filter-popover';
import { RequireAccessAdmin } from '@/components/settings/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useWorkspace } from '@/components/workspace-context';
import { manage } from '@/lib/api';
import type { Role } from '@/lib/manage-types';
import { OPERATOR_LABELS, hasColumn, type Operator } from '@/lib/report';
import type { MetaObject } from '@/lib/types';

const RIGHTS = ['read', 'create', 'update', 'delete'] as const;
const PREDICATE_OPERATORS: Operator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_null'];
const SYSTEM_PREDICATE_FIELDS = [{ name: 'created_by', label: 'Created by' }];

function useRoleMutation<TArgs>(run: (args: TArgs) => Promise<unknown>, success?: string) {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['roles', workspaceId] });
      if (success) toast.success(success);
    },
    onError: (error) => toast.error(error.message),
  });
}

function NewRoleDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) {
  const { workspaceId } = useWorkspace();
  const [name, setName] = useState('');
  const create = useRoleMutation(async () => {
    const created = await manage<{ id: string }>(workspaceId, '/roles', { body: { name } });
    onCreated(created.id);
    onOpenChange(false);
    setName('');
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[360px]">
        <DialogHeader><DialogTitle>New role</DialogTitle></DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); create.mutate(undefined); }}>
          <FormField label="Name" htmlFor="role-name" hint="A new role grants nothing until you set permissions."><Input id="role-name" value={name} onChange={(event) => setName(event.target.value)} required /></FormField>
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={!name || create.isPending}>Create role</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldOverrides({ role, object }: { role: Role; object: MetaObject }) {
  const { workspaceId } = useWorkspace();
  const save = useRoleMutation(async ({ fieldId, read, write }: { fieldId: string; read: boolean; write: boolean }) =>
    read && write
      ? manage(workspaceId, `/roles/${role.id}/fields/${fieldId}`, { method: 'DELETE' })
      : manage(workspaceId, `/roles/${role.id}/fields/${fieldId}`, { method: 'PUT', body: { read, write } }),
  );
  return (
    <tr>
      <td colSpan={5} className="border-b bg-muted/50 px-3 py-2">
        <p className="mb-1 text-xs text-muted-foreground">Field access on {object.label}. Unchecked boxes hide a field or make it read-only for this role.</p>
        <div className="grid grid-cols-[1fr_60px_60px] gap-x-3 gap-y-1">
          <span /> <span className="text-xs text-muted-foreground">See</span> <span className="text-xs text-muted-foreground">Edit</span>
          {object.fields.filter(hasColumn).map((field) => {
            const current = role.fields.find((entry) => entry.fieldId === field.id) ?? { read: true, write: true };
            return (
              <div key={field.id} className="contents">
                <span>{field.label}</span>
                <Checkbox aria-label={`See ${field.label}`} checked={current.read} disabled={role.allObjectsAccess} onCheckedChange={(checked) => save.mutate({ fieldId: field.id, read: checked === true, write: checked === true ? current.write : false })} />
                <Checkbox aria-label={`Edit ${field.label}`} checked={current.write} disabled={role.allObjectsAccess || !current.read} onCheckedChange={(checked) => save.mutate({ fieldId: field.id, read: current.read, write: checked === true })} />
              </div>
            );
          })}
        </div>
      </td>
    </tr>
  );
}

function RowRules({ role, objects }: { role: Role; objects: MetaObject[] }) {
  const { workspaceId } = useWorkspace();
  const [objectId, setObjectId] = useState(objects[0]?.id ?? '');
  const [fieldName, setFieldName] = useState('created_by');
  const [operator, setOperator] = useState<Operator>('eq');
  const [value, setValue] = useState('');
  const [currentUser, setCurrentUser] = useState(true);
  const object = objects.find((candidate) => candidate.id === objectId);
  const fieldOptions = [...SYSTEM_PREDICATE_FIELDS, ...(object?.fields.filter(hasColumn) ?? []).map((field) => ({ name: field.name, label: field.label }))];
  const meta = object?.fields.find((field) => field.name === fieldName);

  const add = useRoleMutation(async () => {
    const typed = meta?.type === 'number' || meta?.type === 'numeric' ? Number(value) : meta?.type === 'boolean' ? value === 'true' : value;
    return manage(workspaceId, `/roles/${role.id}/predicates`, {
      body: { objectId, fieldName, operator, ...(operator === 'is_null' ? { value: true } : { value: currentUser && fieldName === 'created_by' ? '$principal' : typed }) },
    });
  }, 'Row rule added');
  const remove = useRoleMutation((predicateId: string) => manage(workspaceId, `/roles/${role.id}/predicates/${predicateId}`, { method: 'DELETE' }));

  return (
    <div className="flex flex-col gap-2">
      {role.predicates.length === 0 ? <p className="text-muted-foreground">No row rules. This role sees every row it has access to.</p> : null}
      {role.predicates.map((predicate) => {
        const target = objects.find((candidate) => candidate.id === predicate.objectId);
        return (
          <div key={predicate.id} className="flex items-center justify-between rounded-[4px] border px-2 py-1">
            <span>{target?.label ?? 'Object'} · <code className="text-xs">{predicate.fieldName}</code> {OPERATOR_LABELS[predicate.operator as Operator] ?? predicate.operator} <code className="text-xs">{predicate.value === '$principal' ? 'the current user' : JSON.stringify(predicate.value)}</code></span>
            <Button size="icon-sm" variant="ghost" aria-label="Remove row rule" onClick={() => remove.mutate(predicate.id)}><X /></Button>
          </div>
        );
      })}
      <div className="grid grid-cols-[1fr_1fr_100px] gap-1.5">
        <Select value={objectId} onValueChange={(next) => { setObjectId(next); setFieldName('created_by'); }}>
          <SelectTrigger className="w-full" aria-label="Rule object"><SelectValue placeholder="Object" /></SelectTrigger>
          <SelectContent>{objects.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={fieldName} onValueChange={setFieldName}>
          <SelectTrigger className="w-full" aria-label="Rule field"><SelectValue /></SelectTrigger>
          <SelectContent>{fieldOptions.map((field) => <SelectItem key={field.name} value={field.name}>{field.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={operator} onValueChange={(next) => setOperator(next as Operator)}>
          <SelectTrigger className="w-full" aria-label="Rule operator"><SelectValue /></SelectTrigger>
          <SelectContent>{PREDICATE_OPERATORS.map((candidate) => <SelectItem key={candidate} value={candidate}>{OPERATOR_LABELS[candidate]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        {fieldName === 'created_by' && operator !== 'is_null' ? (
          <label className="flex items-center gap-1.5"><Checkbox checked={currentUser} onCheckedChange={(checked) => setCurrentUser(checked === true)} /> The current user</label>
        ) : null}
        {!(fieldName === 'created_by' && currentUser) && operator !== 'is_null' ? (
          <div className="flex-1"><ValueInput field={meta} operator={operator} value={value} onChange={setValue} /></div>
        ) : <span className="flex-1" />}
        <Button size="sm" disabled={!objectId || add.isPending} onClick={() => add.mutate(undefined)}><Plus /> Add rule</Button>
      </div>
    </div>
  );
}

function RoleEditor({ role }: { role: Role }) {
  const { workspaceId, metadata } = useWorkspace();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useRoleMutation((patch: Partial<Role>) => manage(workspaceId, `/roles/${role.id}`, { method: 'PATCH', body: patch }));
  const remove = useRoleMutation(() => manage(workspaceId, `/roles/${role.id}`, { method: 'DELETE' }), 'Role deleted');
  const setAccess = useRoleMutation(({ objectId, grants }: { objectId: string; grants: Record<string, boolean> }) => manage(workspaceId, `/roles/${role.id}/objects/${objectId}`, { method: 'PUT', body: grants }));
  const flags: { key: 'canManageSchema' | 'canManageAccess' | 'allObjectsAccess' | 'canBypassAuth'; label: string; hint: string }[] = [
    { key: 'allObjectsAccess', label: 'Full access to all data', hint: 'Every current and future object, every field. Skips the matrix below.' },
    { key: 'canManageSchema', label: 'Build', hint: 'Change the data model and save forms, grids and reports.' },
    { key: 'canManageAccess', label: 'Manage access', hint: 'Roles, members, API keys, sign-in methods and the audit log.' },
    { key: 'canBypassAuth', label: 'Bypass disabled sign-in methods', hint: 'Safety net when a sign-in method is switched off.' },
  ];

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{role.name}</h2>
        <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete role</Button>
      </div>

      <section>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Capabilities</h3>
        <div className="rounded-lg border px-3">
          {flags.map((flag) => (
            <div key={flag.key} className="flex items-center justify-between gap-6 border-b py-2 last:border-b-0">
              <div><p className="font-medium">{flag.label}</p><p className="text-muted-foreground">{flag.hint}</p></div>
              <Switch aria-label={flag.label} checked={role[flag.key]} onCheckedChange={(checked) => update.mutate({ [flag.key]: checked })} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Object access</h3>
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-[13px]">
            <thead><tr className="h-8 bg-muted/60 text-xs text-muted-foreground"><th className="px-3 text-left font-normal">Object</th>{RIGHTS.map((right) => <th key={right} className="w-16 text-left font-normal capitalize">{right}</th>)}<th className="w-8" /></tr></thead>
            <tbody>
              {metadata.objects.map((object) => {
                const entry = role.objects.find((candidate) => candidate.objectId === object.id);
                const grants = { read: entry?.read ?? false, create: entry?.create ?? false, update: entry?.update ?? false, delete: entry?.delete ?? false };
                return (
                  <FragmentRows key={object.id}>
                    <tr className="h-8 border-t">
                      <td className="px-3">{object.label}</td>
                      {RIGHTS.map((right) => (
                        <td key={right}>
                          <Checkbox
                            aria-label={`${right} ${object.label}`}
                            checked={role.allObjectsAccess || grants[right]}
                            disabled={role.allObjectsAccess}
                            onCheckedChange={(checked) => setAccess.mutate({ objectId: object.id, grants: { ...grants, [right]: checked === true } })}
                          />
                        </td>
                      ))}
                      <td><Button size="icon-sm" variant="ghost" aria-label={`Fields of ${object.label}`} onClick={() => setExpanded(expanded === object.id ? null : object.id)}>{expanded === object.id ? <ChevronDown /> : <ChevronRight />}</Button></td>
                    </tr>
                    {expanded === object.id ? <FieldOverrides role={role} object={object} /> : null}
                  </FragmentRows>
                );
              })}
              {metadata.objects.length === 0 ? <tr><td colSpan={6} className="py-4 text-center text-muted-foreground">Create objects in the data model first.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Row rules</h3>
        <RowRules role={role} objects={metadata.objects} />
      </section>

      <Confirm open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete ${role.name}?`} description="Everyone who holds this role loses its access. At least one admin must remain." actionLabel="Delete role" onConfirm={() => remove.mutate(undefined)} />
    </div>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Roles() {
  const { workspaceId } = useWorkspace();
  const roles = useQuery({ queryKey: ['roles', workspaceId], queryFn: () => manage<{ roles: Role[] }>(workspaceId, '/roles') });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const list = roles.data?.roles ?? [];
  const selected = list.find((role) => role.id === selectedId) ?? list[0];

  return (
    <>
      <PageHeader title="Roles" icon={<Shield />} actions={<Button size="sm" onClick={() => setNewOpen(true)}><Plus /> New role</Button>} />
      <div className="flex min-h-0 flex-1">
        <div className="w-[200px] shrink-0 overflow-y-auto border-r p-2">
          {list.map((role) => (
            <button key={role.id} onClick={() => setSelectedId(role.id)} className={`flex h-7 w-full items-center rounded-[4px] px-2 text-left hover:bg-accent ${selected?.id === role.id ? 'bg-accent font-medium' : ''}`}>
              <span className="truncate">{role.name}</span>
            </button>
          ))}
        </div>
        <PageBody>{selected ? <RoleEditor key={selected.id} role={selected} /> : <EmptyState title="No roles yet" />}</PageBody>
      </div>
      <NewRoleDialog open={newOpen} onOpenChange={setNewOpen} onCreated={setSelectedId} />
    </>
  );
}

export default function RolesPage() {
  return <RequireAccessAdmin><Roles /></RequireAccessAdmin>;
}
