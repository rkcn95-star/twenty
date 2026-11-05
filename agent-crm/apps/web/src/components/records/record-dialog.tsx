'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import { singularLabel } from '@/lib/labels';
import { initialFieldValue, toPayloadValue, type RecordRow } from '@/lib/record-values';
import type { MetaObject } from '@/lib/types';
import { FieldInput } from './field-input';

export type { RecordRow };

type LinksResult = { links: Record<string, { id: string; label: string }[]> };

export function RecordDialog({ object, record, open, onOpenChange, onSaved }: { object: MetaObject; record?: RecordRow; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { workspaceId } = useWorkspace();
  const fields = object.fields;
  const linkFields = fields.filter((field) => field.type === 'many_to_many');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [initialLinks, setInitialLinks] = useState<Record<string, string[]>>({});
  const editing = Boolean(record);
  const canWrite = editing ? object.access.update : object.access.create;

  const links = useQuery({
    queryKey: ['record-links', workspaceId, object.namePlural, record?.id],
    enabled: open && editing && linkFields.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        linkFields.map(async (field) => {
          const result = await callTool<LinksResult>(workspaceId, 'list_links_batch', { object: object.namePlural, field: field.name, ids: [record!.id] });
          return [field.name, (result.links[String(record!.id)] ?? []).map((entry) => entry.id)] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });

  useEffect(() => {
    if (open) setValues(Object.fromEntries(fields.map((field) => [field.name, initialFieldValue(field, record)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record]);

  useEffect(() => {
    if (!links.data) return;
    setInitialLinks(links.data);
    setValues((state) => ({ ...state, ...links.data }));
  }, [links.data]);

  const save = useMutation({
    mutationFn: async () => {
      const data: Record<string, unknown> = {};
      for (const field of fields) {
        if (field.readOnly || field.type === 'many_to_many') continue;
        const next = values[field.name];
        const before = initialFieldValue(field, record);
        if (editing && JSON.stringify(next) === JSON.stringify(before)) continue;
        if (!editing && (next === '' || next === false || (Array.isArray(next) && next.length === 0))) continue;
        data[field.name] = toPayloadValue(field, next);
      }
      const saved = editing
        ? Object.keys(data).length
          ? await callTool<RecordRow>(workspaceId, `update_one_${object.nameSingular}`, { id: record!.id, data })
          : record!
        : await callTool<RecordRow>(workspaceId, `create_one_${object.nameSingular}`, { data });
      for (const field of linkFields) {
        const next = (values[field.name] as string[]) ?? [];
        const before = initialLinks[field.name] ?? [];
        if (JSON.stringify([...next].sort()) === JSON.stringify([...before].sort())) continue;
        await callTool(workspaceId, 'set_links', { object: object.namePlural, id: saved.id, field: field.name, targetIds: next });
      }
    },
    onSuccess: () => {
      toast.success(editing ? 'Saved' : `${singularLabel(object)} created`);
      onSaved();
      onOpenChange(false);
    },
    onError: (error) => toast.error(error instanceof SyntaxError ? 'A JSON field is not valid JSON' : error.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-[440px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${singularLabel(object).toLowerCase()}` : `New ${singularLabel(object).toLowerCase()}`}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
          {fields.length === 0 ? <p className="text-muted-foreground">This object has no fields yet. Add some in the data model.</p> : null}
          {fields.map((field) => (
            <FormField key={field.id} label={field.label} htmlFor={`f-${field.name}`}>
              <FieldInput
                id={`f-${field.name}`}
                field={field}
                value={values[field.name]}
                disabled={field.readOnly || !canWrite || (field.type === 'many_to_many' && !object.access.update)}
                onChange={(next) => setValues((state) => ({ ...state, [field.name]: next }))}
              />
            </FormField>
          ))}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{canWrite ? 'Cancel' : 'Close'}</Button>
            {canWrite ? <Button type="submit" disabled={save.isPending}>{editing ? 'Save' : 'Create'}</Button> : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
