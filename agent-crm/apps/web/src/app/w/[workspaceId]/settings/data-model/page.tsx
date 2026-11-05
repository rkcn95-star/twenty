'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Info, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { EmptyState, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import { humanize } from '@/lib/labels';
import { FIELD_TYPE_LABELS, type FieldType, type MetaObject } from '@/lib/types';
import { pluralize, toSnakeCase } from '@/lib/utils';

const CREATABLE_TYPES: FieldType[] = ['text', 'number', 'numeric', 'boolean', 'date', 'datetime', 'select', 'multi_select', 'json', 'relation', 'many_to_many'];

function useSchemaMutation<TArgs extends object>(tool: string, onDone: () => void) {
  const { workspaceId, refreshMetadata } = useWorkspace();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) => callTool<{ id: string }>(workspaceId, tool, args),
    onSuccess: async () => {
      await refreshMetadata();
      await queryClient.invalidateQueries({ queryKey: ['records'] });
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
}

function NewObjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (name: string) => void }) {
  const [singular, setSingular] = useState('');
  const [plural, setPlural] = useState('');
  const [label, setLabel] = useState('');
  const [touched, setTouched] = useState({ plural: false, label: false });
  const create = useSchemaMutation<{ nameSingular: string; namePlural: string; label: string }>('create_object', () => {
    onCreated(plural);
    onOpenChange(false);
    setSingular(''); setPlural(''); setLabel(''); setTouched({ plural: false, label: false });
  });

  const onSingular = (value: string) => {
    const name = toSnakeCase(value);
    setSingular(name);
    if (!touched.plural) setPlural(pluralize(name));
    if (!touched.label) setLabel(humanize(pluralize(name)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader><DialogTitle>New object</DialogTitle></DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({ nameSingular: singular, namePlural: plural, label });
          }}
        >
          <FormField label="Singular name" htmlFor="singular" hint="Lowercase letters, digits and underscores. Becomes create_one_<name>.">
            <Input id="singular" value={singular} onChange={(event) => onSingular(event.target.value)} placeholder="deal" required />
          </FormField>
          <FormField label="Plural name" htmlFor="plural">
            <Input id="plural" value={plural} onChange={(event) => { setTouched((state) => ({ ...state, plural: true })); setPlural(toSnakeCase(event.target.value)); }} placeholder="deals" required />
          </FormField>
          <FormField label="Display label" htmlFor="label">
            <Input id="label" value={label} onChange={(event) => { setTouched((state) => ({ ...state, label: true })); setLabel(event.target.value); }} placeholder="Deals" required />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || !singular || !plural || !label}>Create object</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewFieldDialog({ object, open, onOpenChange }: { object: MetaObject; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { metadata } = useWorkspace();
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [type, setType] = useState<FieldType>('text');
  const [options, setOptions] = useState('');
  const [target, setTarget] = useState('');
  const create = useSchemaMutation<object>('create_field', () => {
    onOpenChange(false);
    setLabel(''); setName(''); setNameTouched(false); setType('text'); setOptions(''); setTarget('');
  });
  const needsOptions = type === 'select' || type === 'multi_select';
  const needsTarget = type === 'relation' || type === 'many_to_many';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader><DialogTitle>Add a field to {object.label}</DialogTitle></DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({
              objectId: object.id, name, label, type,
              ...(needsOptions ? { options: options.split(',').map((option) => option.trim()).filter(Boolean) } : {}),
              ...(needsTarget ? { relationObjectId: target } : {}),
            });
          }}
        >
          <FormField label="Label" htmlFor="field-label">
            <Input id="field-label" value={label} onChange={(event) => { setLabel(event.target.value); if (!nameTouched) setName(toSnakeCase(event.target.value)); }} placeholder="Amount" required />
          </FormField>
          <FormField label="Name" htmlFor="field-name" hint="Used in the API. Cannot end with _id.">
            <Input id="field-name" value={name} onChange={(event) => { setNameTouched(true); setName(toSnakeCase(event.target.value)); }} required />
          </FormField>
          <FormField label="Type">
            <Select value={type} onValueChange={(value) => setType(value as FieldType)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CREATABLE_TYPES.map((candidate) => <SelectItem key={candidate} value={candidate}>{FIELD_TYPE_LABELS[candidate]}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormField>
          {needsOptions ? (
            <FormField label="Options" htmlFor="field-options" hint="Comma separated, for example new, won, lost.">
              <Input id="field-options" value={options} onChange={(event) => setOptions(event.target.value)} required />
            </FormField>
          ) : null}
          {needsTarget ? (
            <FormField label="Links to">
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Choose an object" /></SelectTrigger>
                <SelectContent>
                  {metadata.objects.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || !name || !label || (needsTarget && !target)}>Add field</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function DataModelPage() {
  const { metadata } = useWorkspace();
  const [selectedPlural, setSelectedPlural] = useState<string | null>(null);
  const [newObjectOpen, setNewObjectOpen] = useState(false);
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const selected = metadata.objects.find((object) => object.namePlural === selectedPlural) ?? metadata.objects[0];
  const editable = metadata.canManageSchema;
  const nameOf = (id: string | null) => metadata.objects.find((object) => object.id === id)?.label ?? '';

  return (
    <>
      <PageHeader
        title="Data model"
        icon={<Boxes />}
        actions={editable ? <Button size="sm" onClick={() => setNewObjectOpen(true)}><Plus /> New object</Button> : null}
      />
      {!editable ? (
        <div className="flex items-start gap-2 border-b bg-muted px-3 py-2 text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {metadata.tenancy === 'shared'
            ? 'This workspace uses a shared data model that the platform operator maintains. You can still build forms, grids and reports on it.'
            : 'You need the schema permission to change the data model.'}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="w-[200px] shrink-0 overflow-y-auto border-r p-2">
          {metadata.objects.map((object) => (
            <button
              key={object.id}
              onClick={() => setSelectedPlural(object.namePlural)}
              className={`flex h-7 w-full items-center rounded-[4px] px-2 text-left text-[13px] hover:bg-accent ${selected?.id === object.id ? 'bg-accent font-medium' : ''}`}
            >
              <span className="truncate">{object.label}</span>
            </button>
          ))}
          {metadata.objects.length === 0 ? <p className="px-2 py-1 text-muted-foreground">No objects yet</p> : null}
        </div>
        <PageBody>
          {selected ? (
            <div className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold">{selected.label}</h2>
                  <p className="mt-0.5 text-muted-foreground">
                    <code className="rounded-[3px] bg-muted px-1">{selected.namePlural}</code> · tools like <code className="rounded-[3px] bg-muted px-1">create_one_{selected.nameSingular}</code>
                  </p>
                </div>
                {editable ? <Button size="sm" variant="outline" onClick={() => setNewFieldOpen(true)}><Plus /> Add field</Button> : null}
              </div>
              <div className="mt-4 overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="h-8 bg-muted/60 hover:bg-muted/60">
                      <TableHead className="h-8">Label</TableHead>
                      <TableHead className="h-8">Name</TableHead>
                      <TableHead className="h-8">Type</TableHead>
                      <TableHead className="h-8">Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selected.fields.map((field) => (
                      <TableRow key={field.id} className="h-8">
                        <TableCell className="py-1">{field.label}</TableCell>
                        <TableCell className="py-1"><code className="text-xs text-muted-foreground">{field.name}</code></TableCell>
                        <TableCell className="py-1">{FIELD_TYPE_LABELS[field.type]}</TableCell>
                        <TableCell className="py-1">
                          <div className="flex flex-wrap gap-1">
                            {field.options?.map((option) => <Badge key={option} variant="secondary" className="rounded-[4px] font-normal">{option}</Badge>)}
                            {field.relationObjectId ? <span className="text-muted-foreground">→ {nameOf(field.relationObjectId)}</span> : null}
                            {field.readOnly ? <span className="text-muted-foreground">read-only</span> : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {selected.fields.length === 0 ? (
                      <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">No fields yet</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
              <NewFieldDialog object={selected} open={newFieldOpen} onOpenChange={setNewFieldOpen} />
            </div>
          ) : (
            <EmptyState title="No objects yet" description="An object is a kind of record you track, like a deal, an employee or an invoice." action={editable ? <Button size="sm" onClick={() => setNewObjectOpen(true)}><Plus /> New object</Button> : undefined} />
          )}
        </PageBody>
      </div>
      <NewObjectDialog open={newObjectOpen} onOpenChange={setNewObjectOpen} onCreated={setSelectedPlural} />
    </>
  );
}
