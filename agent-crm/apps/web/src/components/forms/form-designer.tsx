'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, Save, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import { FORM_KIND_LABELS, objectByPlural, type FormChildDef, type FormDefinition, type FormKind, type FormSectionDef } from '@/lib/form';
import type { MetaField, MetaObject } from '@/lib/types';
import { cn, toSnakeCase } from '@/lib/utils';
import { FieldListEditor } from './field-list-editor';
import { FormRenderer } from './form-renderer';

const NONE = '__none__';

function Block({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex h-6 items-center justify-between"><h3 className="text-xs font-medium text-muted-foreground">{title}</h3>{action}</div>
      {children}
    </section>
  );
}

function ObjectSelect({ value, onChange, label }: { value: string; onChange: (plural: string) => void; label: string }) {
  const { metadata } = useWorkspace();
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label={label}><SelectValue placeholder="Choose an object" /></SelectTrigger>
      <SelectContent>{metadata.objects.filter((object) => object.access.read).map((object) => <SelectItem key={object.id} value={object.namePlural}>{object.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}

const uniqueKey = (base: string, taken: string[]) => {
  let key = toSnakeCase(base) || 'section';
  for (let index = 2; taken.includes(key); index += 1) key = `${toSnakeCase(base)}_${index}`.slice(0, 40);
  return key;
};

const relationsTo = (object: MetaObject | undefined, targetId: string | undefined): MetaField[] =>
  object?.fields.filter((field) => field.type === 'relation' && field.relationObjectId === targetId) ?? [];

const emptyDefinition = (kind: FormKind, firstObject: string): FormDefinition =>
  kind === 'single' ? { kind, object: firstObject, fields: [] }
  : kind === 'multi' ? { kind, sections: [{ key: uniqueKey(firstObject, []), object: firstObject, fields: [] }] }
  : { kind, parent: { object: firstObject, fields: [] }, children: [] };

export const isFormComplete = (definition: FormDefinition, metadata: ReturnType<typeof useWorkspace>['metadata']): boolean => {
  const ok = (object: string, fields: unknown[]) => Boolean(objectByPlural(metadata, object)) && fields.length > 0;
  if (definition.kind === 'single') return ok(definition.object, definition.fields);
  if (definition.kind === 'multi') return definition.sections.length >= 2 && definition.sections.every((section) => ok(section.object, section.fields));
  return ok(definition.parent.object, definition.parent.fields) && definition.children.length > 0 && definition.children.every((child) => ok(child.object, child.fields) && child.relationField !== '');
};

export function FormDesigner({ initialName, initialDefinition }: { initialName: string; initialDefinition?: FormDefinition }) {
  const { workspaceId, metadata } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const firstObject = metadata.objects.find((object) => object.access.read)?.namePlural ?? '';
  const [name, setName] = useState(initialName);
  const [definition, setDefinition] = useState<FormDefinition>(initialDefinition ?? emptyDefinition('single', firstObject));
  const complete = isFormComplete(definition, metadata);

  const save = useMutation({
    mutationFn: () => callTool(workspaceId, 'save_form', { name, definition }),
    onSuccess: async () => {
      toast.success('Form saved');
      await queryClient.invalidateQueries({ queryKey: ['definitions', workspaceId] });
      await queryClient.invalidateQueries({ queryKey: ['definition', workspaceId, 'form', name] });
      if (name !== initialName) router.replace(`/w/${workspaceId}/forms/${name}/edit`);
    },
    onError: (error) => toast.error(error.message),
  });

  const setSections = (sections: FormSectionDef[]) => setDefinition({ kind: 'multi', sections });
  const setChildren = (children: FormChildDef[]) => definition.kind === 'parent_child' && setDefinition({ ...definition, children });

  return (
    <>
      <PageHeader
        icon={<FileText />}
        title={<Input aria-label="Form name" value={name} placeholder="form_name" onChange={(event) => setName(toSnakeCase(event.target.value))} className="h-6 w-[220px] border-transparent bg-transparent px-1 text-[13px] font-medium hover:border-input focus:border-input" />}
        actions={metadata.canBuild ? <Button size="sm" disabled={!name || !complete || save.isPending} onClick={() => save.mutate()}><Save /> Save</Button> : <span className="text-muted-foreground">You cannot save forms.</span>}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[400px] shrink-0 flex-col gap-4 overflow-y-auto border-r p-3">
          <Block title="Kind of form">
            <div className="flex flex-col gap-1.5">
              {(Object.keys(FORM_KIND_LABELS) as FormKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={definition.kind === kind}
                  onClick={() => definition.kind !== kind && setDefinition(emptyDefinition(kind, firstObject))}
                  className={cn('rounded-[4px] border p-2 text-left hover:bg-accent', definition.kind === kind && 'border-blue bg-blue-soft')}
                >
                  <span className="block font-medium">{FORM_KIND_LABELS[kind].title}</span>
                  <span className="text-xs text-muted-foreground">{FORM_KIND_LABELS[kind].text}</span>
                </button>
              ))}
            </div>
          </Block>

          {definition.kind === 'single' ? (
            <>
              <Block title="Object"><ObjectSelect label="Form object" value={definition.object} onChange={(object) => setDefinition({ kind: 'single', object, fields: [] })} /></Block>
              <Block title="Fields">
                {objectByPlural(metadata, definition.object) ? <FieldListEditor object={objectByPlural(metadata, definition.object)!} fields={definition.fields} onChange={(fields) => setDefinition({ ...definition, fields })} /> : null}
              </Block>
            </>
          ) : null}

          {definition.kind === 'multi' ? (
            <>
              {definition.sections.map((section, index) => {
                const object = objectByPlural(metadata, section.object);
                const earlier = definition.sections.slice(0, index);
                const parent = earlier.find((candidate) => candidate.key === section.link?.parent);
                const linkFields = relationsTo(object, objectByPlural(metadata, parent?.object ?? '')?.id);
                const update = (patch: Partial<FormSectionDef>) => setSections(definition.sections.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
                return (
                  <Block key={section.key} title={`Section ${index + 1}`} action={<Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove section ${index + 1}`} disabled={definition.sections.length <= 1} onClick={() => setSections(definition.sections.filter((_, position) => position !== index))}><Trash2 /></Button>}>
                    <div className="flex flex-col gap-2 rounded-lg border p-2">
                      <ObjectSelect label={`Section ${index + 1} object`} value={section.object} onChange={(plural) => update({ object: plural, key: uniqueKey(plural, definition.sections.filter((_, position) => position !== index).map((entry) => entry.key)), fields: [], link: undefined })} />
                      {earlier.length ? (
                        <div className="grid grid-cols-2 gap-1.5">
                          <Select value={section.link?.parent ?? NONE} onValueChange={(value) => update({ link: value === NONE ? undefined : { parent: value, field: '' } })}>
                            <SelectTrigger className="w-full" aria-label={`Section ${index + 1} link to`}><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value={NONE}>Not linked</SelectItem>{earlier.map((entry) => <SelectItem key={entry.key} value={entry.key}>Link to {entry.key}</SelectItem>)}</SelectContent>
                          </Select>
                          {section.link ? (
                            <Select value={section.link.field || undefined} onValueChange={(field) => update({ link: { parent: section.link!.parent, field }, fields: section.fields.filter((entry) => entry.name !== field) })}>
                              <SelectTrigger className="w-full" aria-label={`Section ${index + 1} link field`}><SelectValue placeholder="Through field" /></SelectTrigger>
                              <SelectContent>{linkFields.map((field) => <SelectItem key={field.id} value={field.name}>{field.label}</SelectItem>)}</SelectContent>
                            </Select>
                          ) : <span />}
                        </div>
                      ) : null}
                      {object ? <FieldListEditor object={object} fields={section.fields} exclude={section.link?.field ? [section.link.field] : []} onChange={(fields) => update({ fields })} /> : null}
                    </div>
                  </Block>
                );
              })}
              <Button type="button" size="sm" variant="outline" onClick={() => setSections([...definition.sections, { key: uniqueKey(firstObject, definition.sections.map((entry) => entry.key)), object: firstObject, fields: [] }])}><Plus /> Add section</Button>
            </>
          ) : null}

          {definition.kind === 'parent_child' ? (
            <>
              <Block title="Header object">
                <ObjectSelect label="Parent object" value={definition.parent.object} onChange={(object) => setDefinition({ kind: 'parent_child', parent: { object, fields: [] }, children: [] })} />
                {objectByPlural(metadata, definition.parent.object) ? <FieldListEditor object={objectByPlural(metadata, definition.parent.object)!} fields={definition.parent.fields} onChange={(fields) => setDefinition({ ...definition, parent: { ...definition.parent, fields } })} /> : null}
              </Block>
              {definition.children.map((child, index) => {
                const object = objectByPlural(metadata, child.object);
                const parentObject = objectByPlural(metadata, definition.parent.object);
                const relations = relationsTo(object, parentObject?.id);
                const update = (patch: Partial<FormChildDef>) => setChildren(definition.children.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
                return (
                  <Block key={child.key} title={`Rows ${index + 1}`} action={<Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove rows ${index + 1}`} onClick={() => setChildren(definition.children.filter((_, position) => position !== index))}><Trash2 /></Button>}>
                    <div className="flex flex-col gap-2 rounded-lg border p-2">
                      <ObjectSelect label={`Rows ${index + 1} object`} value={child.object} onChange={(plural) => { const candidate = relationsTo(objectByPlural(metadata, plural), parentObject?.id)[0]; update({ object: plural, key: uniqueKey(plural, definition.children.filter((_, position) => position !== index).map((entry) => entry.key)), relationField: candidate?.name ?? '', fields: [] }); }} />
                      <Select value={child.relationField || undefined} onValueChange={(relationField) => update({ relationField, fields: child.fields.filter((entry) => entry.name !== relationField) })}>
                        <SelectTrigger className="w-full" aria-label={`Rows ${index + 1} relation`}><SelectValue placeholder={relations.length ? 'Relation to the header' : 'No relation to the header object'} /></SelectTrigger>
                        <SelectContent>{relations.map((field) => <SelectItem key={field.id} value={field.name}>{field.label}</SelectItem>)}</SelectContent>
                      </Select>
                      <div className="grid grid-cols-2 gap-1.5">
                        <Input aria-label={`Rows ${index + 1} minimum`} type="number" min={0} max={100} placeholder="Min rows" value={child.minRows ?? ''} onChange={(event) => update({ minRows: event.target.value === '' ? undefined : Number(event.target.value) })} />
                        <Input aria-label={`Rows ${index + 1} maximum`} type="number" min={1} max={100} placeholder="Max rows" value={child.maxRows ?? ''} onChange={(event) => update({ maxRows: event.target.value === '' ? undefined : Number(event.target.value) })} />
                      </div>
                      {object ? <FieldListEditor object={object} fields={child.fields} exclude={child.relationField ? [child.relationField] : []} onChange={(fields) => update({ fields })} /> : null}
                    </div>
                  </Block>
                );
              })}
              <Button type="button" size="sm" variant="outline" onClick={() => {
                const candidate = metadata.objects.find((object) => relationsTo(object, objectByPlural(metadata, definition.parent.object)?.id).length > 0);
                if (!candidate) return void toast.info('No object has a relation to the header object. Add a relation field in the data model first.');
                setChildren([...definition.children, { key: uniqueKey(candidate.namePlural, definition.children.map((entry) => entry.key)), object: candidate.namePlural, relationField: relationsTo(candidate, objectByPlural(metadata, definition.parent.object)?.id)[0]!.name, fields: [], minRows: 1 }]);
              }}><Plus /> Add rows</Button>
            </>
          ) : null}
        </div>

        <Tabs defaultValue="preview" className="min-w-0 flex-1 gap-0">
          <div className="flex h-9 shrink-0 items-center border-b px-3"><TabsList className="h-7"><TabsTrigger value="preview">Preview</TabsTrigger><TabsTrigger value="definition">Definition</TabsTrigger></TabsList></div>
          <PageBody>
            <TabsContent value="preview" className="m-0 p-4">
              {complete ? (
                <div className="mx-auto max-w-2xl"><FormRenderer key={JSON.stringify(definition)} definition={definition} mode="preview" /></div>
              ) : <p className="p-6 text-center text-muted-foreground">Choose an object and add fields to see the form.</p>}
            </TabsContent>
            <TabsContent value="definition" className="m-0 p-3"><pre className="overflow-auto rounded-[4px] border bg-muted p-3 font-mono text-xs leading-5">{JSON.stringify(definition, null, 2)}</pre></TabsContent>
          </PageBody>
        </Tabs>
      </div>
    </>
  );
}
