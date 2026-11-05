import { cn } from '@/lib/utils';

export function PageHeader({ title, icon, actions, className }: { title: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <header className={cn('flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3', className)}>
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
        {icon ? <span className="text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
        <span className="truncate">{title}</span>
      </div>
      <div className="flex items-center gap-1.5">{actions}</div>
    </header>
  );
}

export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('min-h-0 flex-1 overflow-auto', className)}>{children}</div>;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-16 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      {description ? <p className="max-w-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
