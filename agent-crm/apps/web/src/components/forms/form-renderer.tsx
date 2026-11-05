'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { FieldInput } from '@/components/records/field-input';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/components/workspace-context';
import {
  buildInitialState, buildSubmission, fieldOf, objectByPlural, rowDefaults, validateState, type FormDefinition, type FormFieldDef, type FormState, type RowValues,
} from '@/lib/form';
import { humanize } from '@/lib/labels';
import type { MetaObject } from '@/lib/types';

function FieldsBlock({ object, fields, values, onChange, disabled, idPrefix }: { object: MetaObject | undefined; fields: FormFieldDef[]; values: RowValues; onChange: (name: string, value: unknown) => void; disabled: boolean; idPrefix: string }) {
  if (!object) return <p className="text-destructive">This form uses an object you cannot access.</p>;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {fields.map((definition) => {
        const field = fieldOf(object, definition.name);
        if (!field) return null;
        const id = `${idPrefix}-${field.name}`;
        return (
          <FormField key={field.name} label={`${definition.label ?? field.label}${definition.required ? ' *' : ''}`} htmlFor={id}>
            <FieldInput id={id} field={field} value={values[field.name]} disabled={disabled || definition.readOnly || field.readOnly} onChange={(value) => onChange(field.name, value)} />
          </FormField>
        );
      })}
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-3">
      <h3 className="mb-0.5 text-[13px] font-medium">{title}</h3>
      {subtitle ? <p className="mb-2 text-xs text-muted-foreground">{subtitle}</p> : <div className="mb-2" />}
      {children}
    </section>
  );
}

export type FormRendererProps = {
  definition: FormDefinition;
  mode: 'preview' | 'run';
  initial?: Partial<FormState>;
  recordId?: string;
  onSubmit?: (submission: object) => Promise<void>;
};

export function FormRenderer({ definition, mode, initial, recordId, onSubmit }: FormRendererProps) {
  const { metadata } = useWorkspace();
  const [state, setState] = useState<FormState>(() => buildInitialState(definition, metadata, initial));
  const [pending, setPending] = useState(false);
  const preview = mode === 'preview';

  const setRow = (scope: 'single' | 'parent', name: string, value: unknown) => setState((current) => ({ ...current, [scope]: { ...current[scope], [name]: value } }));
  const setSection = (key: string, name: string, value: unknown) => setState((current) => ({ ...current, sections: { ...current.sections, [key]: { ...current.sections[key], [name]: value } } }));
  const setChild = (key: string, index: number, name: string, value: unknown) =>
    setState((current) => ({ ...current, children: { ...current.children, [key]: current.children[key]!.map((row, position) => (position === index ? { ...row, values: { ...row.values, [name]: value } } : row)) } }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (preview || !onSubmit) return;
    const problem = validateState(definition, metadata, state);
    if (problem) return void toast.error(problem);
    setPending(true);
    try {
      await onSubmit(buildSubmission(definition, metadata, state, recordId));
      if (!recordId) setState(buildInitialState(definition, metadata));
    } catch (error) {
      toast.error(error instanceof SyntaxError ? 'A JSON field is not valid JSON' : (error as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {definition.kind === 'single' ? (
        <Card title={objectByPlural(metadata, definition.object)?.label ?? definition.object}>
          <FieldsBlock object={objectByPlural(metadata, definition.object)} fields={definition.fields} values={state.single} disabled={false} idPrefix="single" onChange={(name, value) => setRow('single', name, value)} />
        </Card>
      ) : null}

      {definition.kind === 'multi'
        ? definition.sections.map((section) => (
            <Card key={section.key} title={humanize(section.key)} subtitle={section.link ? `Linked to ${humanize(section.link.parent)} through ${humanize(section.link.field)}` : undefined}>
              <FieldsBlock object={objectByPlural(metadata, section.object)} fields={section.fields} values={state.sections[section.key] ?? {}} disabled={false} idPrefix={section.key} onChange={(name, value) => setSection(section.key, name, value)} />
            </Card>
          ))
        : null}

      {definition.kind === 'parent_child' ? (
        <>
          <Card title={objectByPlural(metadata, definition.parent.object)?.label ?? definition.parent.object}>
            <FieldsBlock object={objectByPlural(metadata, definition.parent.object)} fields={definition.parent.fields} values={state.parent} disabled={false} idPrefix="parent" onChange={(name, value) => setRow('parent', name, value)} />
          </Card>
          {definition.children.map((child) => {
            const object = objectByPlural(metadata, child.object);
            const rows = state.children[child.key] ?? [];
            const columns = `repeat(${Math.max(child.fields.length, 1)}, minmax(110px, 1fr)) 28px`;
            return (
              <Card key={child.key} title={humanize(child.key)} subtitle={[child.minRows ? `At least ${child.minRows}` : '', child.maxRows ? `at most ${child.maxRows}` : ''].filter(Boolean).join(', ') || undefined}>
                <div className="flex flex-col gap-1.5">
                  <div className="grid gap-2 text-xs text-muted-foreground" style={{ gridTemplateColumns: columns }}>
                    {child.fields.map((definitionField) => <span key={definitionField.name}>{definitionField.label ?? fieldOf(object, definitionField.name)?.label}{definitionField.required ? ' *' : ''}</span>)}
                    <span />
                  </div>
                  {rows.map((row, index) => (
                    <div key={row.id ?? index} className="grid items-start gap-2" style={{ gridTemplateColumns: columns }} data-testid={`${child.key}-row`}>
                      {child.fields.map((definitionField) => {
                        const field = fieldOf(object, definitionField.name);
                        return field ? (
                          <FieldInput key={field.name} id={`${child.key}-${index}-${field.name}`} field={field} value={row.values[field.name]} disabled={definitionField.readOnly || field.readOnly} onChange={(value) => setChild(child.key, index, field.name, value)} />
                        ) : <span key={definitionField.name} />;
                      })}
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${humanize(child.key)} row ${index + 1}`} disabled={rows.length <= (child.minRows ?? 0)} onClick={() => setState((current) => ({ ...current, children: { ...current.children, [child.key]: current.children[child.key]!.filter((_, position) => position !== index) } }))}><Trash2 /></Button>
                    </div>
                  ))}
                  <div>
                    <Button type="button" size="sm" variant="outline" disabled={Boolean(child.maxRows) && rows.length >= child.maxRows!} onClick={() => setState((current) => ({ ...current, children: { ...current.children, [child.key]: [...(current.children[child.key] ?? []), { values: rowDefaults(object, child.fields) }] } }))}>
                      <Plus /> Add row
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={preview || pending}>{recordId ? 'Save changes' : 'Submit'}</Button>
      </div>
    </form>
  );
}
