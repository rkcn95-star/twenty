'use client';

import { BarChart3, Boxes, Table2 } from 'lucide-react';
import Link from 'next/link';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { useWorkspace } from '@/components/workspace-context';

function Tile({ href, icon, title, text }: { href: string; icon: React.ReactNode; title: string; text: string }) {
  return (
    <Link href={href} className="flex flex-col gap-1 rounded-lg border p-3 hover:bg-muted">
      <span className="flex items-center gap-2 font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">{icon}{title}</span>
      <span className="text-muted-foreground">{text}</span>
    </Link>
  );
}

export default function WorkspaceHome() {
  const { workspaceId, me, metadata } = useWorkspace();
  const base = `/w/${workspaceId}`;
  const readable = metadata.objects.filter((object) => object.access.read);

  return (
    <>
      <PageHeader title="Home" />
      <PageBody className="p-4">
        <h1 className="text-lg font-semibold">Welcome, {me.user.name}</h1>
        <p className="mt-1 text-muted-foreground">
          {readable.length === 0 ? 'Start by describing your data: create an object and add fields.' : `${readable.length} object${readable.length === 1 ? '' : 's'} in this workspace.`}
        </p>
        <div className="mt-4 grid max-w-3xl grid-cols-1 gap-2 sm:grid-cols-3">
          <Tile href={`${base}/settings/data-model`} icon={<Boxes />} title="Data model" text="Create objects and fields" />
          <Tile href={`${base}/reports`} icon={<BarChart3 />} title="Reports" text="Build a query visually" />
          {readable[0] ? <Tile href={`${base}/o/${readable[0].namePlural}`} icon={<Table2 />} title={readable[0].label} text="Browse and edit records" /> : null}
        </div>
      </PageBody>
    </>
  );
}
