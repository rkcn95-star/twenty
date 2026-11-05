'use client';

import {
  BarChart3, Boxes, Check, ChevronsUpDown, FileText, History, Home, KeyRound, LayoutGrid, LogOut, Plus, Shield, ShieldCheck, Table2, Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/theme-toggle';
import { useWorkspace } from '@/components/workspace-context';

function NavItem({ href, icon, children, exact = false }: { href: string; icon: React.ReactNode; children: React.ReactNode; exact?: boolean }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={cn(
        'flex h-7 items-center gap-2 rounded-[4px] px-2 text-[13px] text-muted-foreground hover:bg-black/5',
        active && 'bg-black/[0.06] font-medium text-foreground',
      )}
    >
      <span className="[&_svg]:size-4">{icon}</span>
      <span className="truncate">{children}</span>
    </Link>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 flex flex-col gap-0.5">
      <p className="px-2 pb-1 text-xs text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

export function Sidebar() {
  const { workspaceId, me, metadata } = useWorkspace();
  const router = useRouter();
  const base = `/w/${workspaceId}`;
  const current = me.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
  const readable = metadata.objects.filter((object) => object.access.read);

  return (
    <aside className="flex w-[220px] shrink-0 flex-col p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 w-full justify-between px-2 hover:bg-black/5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-primary text-xs font-semibold text-primary-foreground">
                {(current?.name ?? '?').slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate font-medium">{current?.name ?? 'Workspace'}</span>
            </span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[204px]">
          <DropdownMenuLabel>{me.user.email}</DropdownMenuLabel>
          {me.workspaces.map((workspace) => (
            <DropdownMenuItem key={workspace.workspaceId} onSelect={() => router.push(`/w/${workspace.workspaceId}`)}>
              <span className="flex-1 truncate">{workspace.name}</span>
              {workspace.workspaceId === workspaceId ? <Check className="size-3.5" /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => router.push('/w/new')}>
            <Plus className="size-3.5" /> New workspace
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={async () => {
              await authClient.signOut();
              router.push('/sign-in');
            }}
          >
            <LogOut className="size-3.5" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <nav className="mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto">
        <NavItem href={base} icon={<Home />} exact>Home</NavItem>

        <Section label="Objects">
          {readable.length === 0 ? <p className="px-2 text-muted-foreground">No objects yet</p> : null}
          {readable.map((object) => (
            <NavItem key={object.id} href={`${base}/o/${object.namePlural}`} icon={<Table2 />}>{object.label}</NavItem>
          ))}
        </Section>

        <Section label="Build and run">
          <NavItem href={`${base}/reports`} icon={<BarChart3 />}>Reports</NavItem>
          <NavItem href={`${base}/forms`} icon={<FileText />}>Forms</NavItem>
          <NavItem href={`${base}/grids`} icon={<LayoutGrid />}>Data grids</NavItem>
        </Section>

        <Section label="Settings">
          <NavItem href={`${base}/settings/data-model`} icon={<Boxes />}>Data model</NavItem>
          {metadata.canManageAccess ? (
            <>
              <NavItem href={`${base}/settings/members`} icon={<Users />}>Members and keys</NavItem>
              <NavItem href={`${base}/settings/roles`} icon={<Shield />}>Roles</NavItem>
              <NavItem href={`${base}/settings/sign-in`} icon={<ShieldCheck />}>Sign-in methods</NavItem>
              <NavItem href={`${base}/settings/audit-log`} icon={<History />}>Audit log</NavItem>
            </>
          ) : null}
        </Section>
      </nav>
      <ThemeToggle />
      {metadata.tenancy === 'shared' ? (
        <p className="flex items-center gap-1.5 px-2 pt-2 text-xs text-muted-foreground"><KeyRound className="size-3" /> Shared data model</p>
      ) : null}
    </aside>
  );
}
