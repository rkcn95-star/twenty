'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { FieldInput } from '@/components/records/field-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/components/workspace-context';
import { callTool, request } from '@/lib/api';
import { ACTION_KIND_LABELS, type GridAction, type GridActionKind } from '@/lib/grid';
import { toPayloadValue } from '@/lib/record-values';
import type { MetaObject } from '@/lib/types';
import { toSnakeCase } from '@/lib/utils';

const uniqueKey = (label: string, taken: string[]) => {
  const base = toSnakeCase(label) || 'action';
  let key = base;
  for (let index = 2; taken.includes(key); index += 1) key = `${base}_${index}`.slice(0, 40);
  return key;
};

function SetFieldsEditor({ object, value, onChange }: { object: MetaObject; value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  const editable = object.fields.filter((field) => !field.readOnly && field.type !== 'many_to_many' && field.type !== 'json');
  const free = editable.filter((field) => !(field.name in value));
  return (
    <div className="flex flex-col gap-1.5">
      {Object.entries(value).map(([name, current]) => {
        const field = editable.find((candidate) => candidate.name === name);
        if (!field) return null;
        return (
          <div key={name} className="grid grid-cols-[90px_1fr_24px] items-center gap-1.5">
            <span className="truncate text-xs text-muted-foreground">{field.label}</span>
            <FieldInput id={`set-${object.namePlural}-${name}`} field={field} value={current === null ? '' : current} onChange={(next) => onChange({ ...value, [name]: toPayloadValue(field, next) })} />
            <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${field.label}`} onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([key]) => key !== name)))}><Trash2 /></Button>
          </div>
        );
      })}
      <Select value="" onValueChange={(name) => onChange({ ...value, [name]: toPayloadValue(editable.find((field) => field.name === name)!, '') })}>
        <SelectTrigger className="w-full" aria-label="Field to set" disabled={free.length === 0}><span className="flex items-center gap-1.5 text-muted-foreground"><Plus className="size-3.5" /><SelectValue placeholder="Set a field" /></span></SelectTrigger>
        <SelectContent>{free.map((field) => <SelectItem key={field.id} value={field.name}>{field.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

function RunToolEditor({ action, onChange }: { action: GridAction; onChange: (patch: Partial<GridAction>) => void }) {
  const { workspaceId } = useWorkspace();
  const tools = useQuery({ queryKey: ['tool-names', workspaceId], queryFn: () => request<{ tools: { name: string }[] }>('/v1/tools', { workspaceId }) });
  const [text, setText] = useState(JSON.stringify(action.tool?.arguments ?? { id: '{{id}}' }, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <Select value={action.tool?.name || undefined} onValueChange={(name) => onChange({ tool: { name, arguments: action.tool?.arguments ?? {} } })}>
        <SelectTrigger className="w-full" aria-label="Tool"><SelectValue placeholder="Choose a tool" /></SelectTrigger>
        <SelectContent>{tools.data?.tools.map((tool) => <SelectItem key={tool.name} value={tool.name}>{tool.name}</SelectItem>)}</SelectContent>
      </Select>
      <Textarea aria-label="Tool arguments" className="font-mono text-xs" value={text} onChange={(event) => {
        setText(event.target.value);
        try { onChange({ tool: { name: action.tool?.name ?? '', arguments: JSON.parse(event.target.value) } }); setError(null); } catch { setError('Not valid JSON yet'); }
      }} />
      <p className="text-xs text-muted-foreground">{error ?? 'Use {{id}} where the record id belongs. The tool runs once per selected record, as the person clicking.'}</p>
    </div>
  );
}

export function ActionEditor({ object, actions, onChange, allowOpenForm = true }: { object: MetaObject; actions: GridAction[]; onChange: (actions: GridAction[]) => void; allowOpenForm?: boolean }) {
  const { workspaceId } = useWorkspace();
  const forms = useQuery({ queryKey: ['definitions', workspaceId, 'form'], queryFn: () => callTool<{ name: string }[]>(workspaceId, 'list_definitions', { kind: 'form' }) });
  const update = (index: number, patch: Partial<GridAction>) => onChange(actions.map((action, position) => (position === index ? { ...action, ...patch } : action)));

  return (
    <div className="flex flex-col gap-2">
      {actions.map((action, index) => (
        <div key={action.key} className="flex flex-col gap-1.5 rounded-[4px] border p-1.5">
          <div className="grid grid-cols-[1fr_24px] gap-1.5">
            <Input aria-label={`Action ${index + 1} label`} value={action.label} placeholder="Button label" onChange={(event) => update(index, { label: event.target.value, key: action.key.startsWith('action') || action.key === toSnakeCase(action.label) ? uniqueKey(event.target.value, actions.filter((_, position) => position !== index).map((entry) => entry.key)) : action.key })} />
            <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove action ${index + 1}`} onClick={() => onChange(actions.filter((_, position) => position !== index))}><Trash2 /></Button>
          </div>
          <Select value={action.kind} onValueChange={(kind) => update(index, { kind: kind as GridActionKind, set: undefined, form: undefined, tool: undefined })}>
            <SelectTrigger className="w-full" aria-label={`Action ${index + 1} kind`}><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(ACTION_KIND_LABELS) as GridActionKind[]).filter((kind) => allowOpenForm || kind !== 'open_form').map((kind) => <SelectItem key={kind} value={kind}>{ACTION_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
          </Select>
          {action.kind === 'set_fields' ? <SetFieldsEditor object={object} value={action.set ?? {}} onChange={(set) => update(index, { set })} /> : null}
          {action.kind === 'open_form' ? (
            <Select value={action.form || undefined} onValueChange={(form) => update(index, { form })}>
              <SelectTrigger className="w-full" aria-label={`Action ${index + 1} form`}><SelectValue placeholder="Choose a saved form" /></SelectTrigger>
              <SelectContent>{forms.data?.map((form) => <SelectItem key={form.name} value={form.name}>{form.name}</SelectItem>)}</SelectContent>
            </Select>
          ) : null}
          {action.kind === 'run_tool' ? <RunToolEditor action={action} onChange={(patch) => update(index, patch)} /> : null}
          {action.kind !== 'open_form' ? <Input aria-label={`Action ${index + 1} confirmation`} value={action.confirm ?? ''} placeholder="Ask before running (optional)" onChange={(event) => update(index, { confirm: event.target.value || undefined })} /> : null}
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={() => onChange([...actions, { key: uniqueKey('action', actions.map((entry) => entry.key)), label: '', kind: 'set_fields' }])}><Plus /> Add action</Button>
    </div>
  );
}
